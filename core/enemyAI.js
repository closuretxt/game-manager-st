// ENEMY AI pass — the hostile side of Combat Mode (Text).
// When the pre-pass emits <combat/>, this pre-master call decides what every
// tracked enemy does this round. It is deliberately BLIND to the player's
// action: the enemy side must not know what the party chose. Output is XML
// (<enemy_actions>, one <action> per enemy), consumed by the clash resolver
// (core/clashResolver.js). On failure the caller degrades to generic attacks.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { parseAttrs } from "./toolParser.js";
import { hasConnectionProfile, resolvePremasterProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the ENEMY AI of a tabletop-style roleplay game system: you decide what the hostile side does each combat round.",
    "",
    "WHAT YOU RECEIVE:",
    "- RECENT SCENE: the last few messages of the roleplay.",
    "- ENEMY SHEETS: full stats of every tracked enemy (resources, attributes, skills, statuses).",
    "- PARTY SUMMARY: the opposing party's names and visible state. You do NOT see the player's current action — the enemy side must decide WITHOUT knowing what the party chose this round.",
    "",
    "YOUR OBJECTIVE:",
    "Decide ONE action per enemy for this round. Any kind of action is valid — attacking, dodging, shielding an ally, repositioning, fleeing, using a skill — choose what a competent hostile would do given its stats, statuses and the scene. An enemy may take more than one action ONLY if its sheet justifies it (an extra-action status or similar).",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML — no markdown fences, no prose:",
    '  <enemy_actions>',
    '    <action enemy="<enemy name>" speed="<initiative, 0 if unknown>" title="<short action title>"><short intent line, under 20 words></action>',
    '  </enemy_actions>',
    "",
    "RULES:",
    "- speed is initiative judged from that enemy's attributes/statuses (Dexterity, Haste...); 0 when unknown.",
    "- title is a short third-person action title (\"Swing club at the Knight\").",
    "- The intent line says WHAT the enemy attempts and AT WHOM — the clash engine needs a concrete target to pair actions against.",
    "- Never invent enemies that are not in the sheets; never skip an enemy that is in the sheets.",
].join("\n");

//

function collectContext(maxActions) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1200)}`);

    const d = stateManager.getData();
    const sheetOf = c => ({
        name: c.name,
        resources: (c.resources || []).map(r => ({ name: r.name, value: r.value, max: r.max })),
        attributes: (c.attributes || []).map(a => ({ name: a.name, value: a.value })),
        skills: (c.skills || []).map(s => {
            const skill = { name: s.name };
            if ((Number(s.cooldown_left) || 0) > 0) skill.on_cooldown = true;
            return skill;
        }),
        statuses: (c.statuses || []).map(s => ({ name: s.name, modifiers: s.modifiers || "" })),
    });

    const blocks = [
        "RECENT SCENE:",
        ...history,
        "",
        "ENEMY SHEETS (you control these):",
        JSON.stringify((d.enemies || []).map(sheetOf)),
        "",
        "PARTY SUMMARY (opposition, visible state only):",
        JSON.stringify((d.characters || []).filter(c => c.state?.mode !== "dead").map(c => ({
            name: c.name,
            // Special states stay visible (a downed fighter is scene
            // information) but the enemy AI must not target them as active.
            state: c.state?.mode || undefined,
            resources: (c.resources || []).map(r => ({ name: r.name, value: r.value, max: r.max })),
            statuses: (c.statuses || []).map(s => s.name),
        }))),
        "",
        `Decide the enemy actions for this round (at most ${maxActions} <action> entries).`,
    ];
    return blocks.join("\n");
}

// Tolerant parse of the <enemy_actions> block. Returns an array of actions or
// null when nothing usable is present.
export function parseEnemyActions(text) {
    if (!text) return null;
    const blockM = text.match(/<enemy_actions>([\s\S]*?)<\/enemy_actions>/i);
    const body = blockM ? blockM[1] : text;
    const actions = [];
    const re = /<action\b([^>]*?)(?:\/>|>([\s\S]*?)<\/action>)/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        const a = parseAttrs(m[1]);
        const enemy = String(a.enemy || a.name || "").trim();
        if (!enemy) continue;
        actions.push({
            enemy,
            speed: Math.max(0, Math.trunc(Number(a.speed) || 0)),
            title: String(a.title || "Attack").slice(0, 80),
            text: String(m[2] || "").replace(/\s+/g, " ").trim().slice(0, 200),
        });
    }
    return actions.length ? actions : null;
}

// Runs the ENEMY AI pass. Returns an array of actions
// ({ enemy, speed, title, text }) or null when disabled/failed — the caller
// then degrades to generic per-enemy attacks.
export async function runEnemyAI({ maxActions = 6 } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_combat) return null;

    const d = stateManager.getData();
    if (!(d.enemies || []).length) return null;

    try {
        const st = getContext();
        const profileId = (s.combat_profile && hasConnectionProfile(st, s.combat_profile))
            ? s.combat_profile
            : resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        let systemContent = SYSTEM_PROMPT;
        if (s.deep_context_engines) {
            const deep = await buildDeepContext("");
            if (deep) systemContent += `\n\nDEEP CONTEXT (card / persona / lore):\n${deep}`;
        }
        const messages = [
            { role: "system", content: systemContent },
            { role: "user", content: collectContext(maxActions) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        const actions = parseEnemyActions(reply || "");
        if (!actions) {
            logDebug("enemyAI: no usable actions in reply — caller will fall back to generic attacks");
            return null;
        }
        logDebug(`enemyAI: ${actions.length} action(s) — ${actions.map(a => a.enemy).join(", ")}`);
        return actions.slice(0, maxActions);
    } catch (e) {
        console.error("[Game Manager] enemy AI pass failed:", e);
        return null;
    }
}
