// ENEMY AI pass — the hostile side of Combat Mode (Text).
// When the pre-pass emits <combat/>, this pre-master call decides what every
// tracked enemy does this round. It is deliberately BLIND to the player's
// action: the enemy side must not know what the party chose. Output is XML
// (<enemy_actions>, one <action> per enemy), consumed by the clash resolver
// (core/clashResolver.js). On failure the caller degrades to generic attacks.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel } from "./stateManager.js";
import { parseAttrs, escAttr, decodeEntities } from "./toolParser.js";
import { valueGuidelines } from "./valueGuidelines.js";
import { hasConnectionProfile, resolvePremasterProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the ENEMY AI of a tabletop-style roleplay game system: you decide what the hostile side does each combat round.",
    "",
    "WHAT YOU RECEIVE:",
    "- <scene>: the last few messages of the roleplay.",
    "- <enemy_sheets>: full stats of every tracked enemy (resources, attributes, skills, statuses).",
    "- <party_summary>: the opposing party's names and visible state. You do NOT see the player's current action — the enemy side must decide WITHOUT knowing what the party chose this round.",
    "",
    "YOUR OBJECTIVE:",
    "Decide what each enemy does this round — if anything. Actions are NOT mandatory: READ THE SCENE and each enemy's statuses first. An enemy that is dazed, stunned, unconscious, restrained, paralyzed or otherwise compromised CANNOT act and must be skipped. Enemies may also deliberately hold back, wait for an opening, or stay hidden when the scene justifies it. Any kind of action is valid — attacking, dodging, shielding an ally, repositioning, fleeing, using a skill — choose what a competent hostile would do given its stats, statuses and the scene. An enemy may take more than one action ONLY if its sheet justifies it (an extra-action status or similar).",
    "",
    "SKILLS:",
    "- USE SKILLS ACTIVELY. Skills are the enemy's signature moves: when a ready skill (no * marker) fits the scene, PREFER it over a plain attack — a spellcaster should cast, a brute should use its signature maneuver. Name the skill explicitly in the intent line. Never use a skill marked * (on cooldown), and never invent skills that are not on the sheet.",
    "- Skill costs are real: a skill's (cost: ...) is paid when used — only pick it when the enemy can afford it (check current resources).",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML — no markdown fences, no prose:",
    '<enemy_actions>',
    '<action enemy="<enemy name>" speed="<initiative, 0 if unknown>" title="<short action title>"><short intent line, under 20 words></action>',
    '</enemy_actions>',
    "If NO enemy can or should act this round (all dazed/stunned, ambush not sprung, etc.), respond with an EMPTY block: '<enemy_actions/>' — do not fabricate actions.",
    "",
    "RULES:",
    "- speed is initiative judged from that enemy's attributes/statuses (Dexterity, Haste...); 0 when unknown.",
    "- title is a short third-person action title (\"Swing club at the Knight\").",
    "- The intent line says WHAT the enemy attempts and AT WHOM — the clash engine needs a concrete target to pair actions against.",
    "- Never invent enemies that are not in the sheets; never invent actions for enemies that cannot act.",
    "- SKIP enemies whose statuses prevent acting (Dazed, Stunned, Unconscious, Paralyzed...) or that the scene shows as out of the fight. A skipped enemy simply has no <action> entry.",
    "- UNCERTAIN NUMBERS go in dice notation: when the intent carries variable damage or a random effect, write it as a die (\"clubs for 1d8+1\", \"20% chance to poison: 1d5\") — the engine rolls TRUE random dice when the tracker applies it; never invent a fixed average yourself.",
    valueGuidelines(),
].join("\n");

//

function collectContext(maxActions) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1200)}`);

    const d = stateManager.getData();

    // One line per actor: resources as value/max, skills as Name (cost),
    // * = skill on cooldown.
    const sheetXml = c => {
        const attrs = [`name="${escAttr(c.name)}"`];
        for (const r of c.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
        for (const a of c.attributes || []) attrs.push(`${escAttr(a.name)}="${a.value}"`);
        const skills = (c.skills || []).map(s => `${escAttr(s.name)}${String(s.cost || "").trim() ? ` (cost: ${escAttr(s.cost)})` : ""}${(Number(s.cooldown_left) || 0) > 0 ? "*" : ""}`).join(", ");
        if (skills) attrs.push(`skills="${skills}"`);
        const statuses = (c.statuses || []).map(s => `${escAttr(s.name)}${s.modifiers ? ` (${escAttr(s.modifiers)})` : ""}`).join(", ");
        if (statuses) attrs.push(`statuses="${statuses}"`);
        return `<enemy ${attrs.join(" ")}/>`;
    };

    // Visible state only: special states stay visible (a downed fighter is
    // scene information) but the enemy AI must not target them as active.
    const partyXml = c => {
        const attrs = [`name="${escAttr(c.name)}"`];
        if (c.state?.mode) attrs.push(`state="${c.state.mode}"`);
        for (const r of c.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
        const statuses = (c.statuses || []).map(s => escAttr(s.name)).join(", ");
        if (statuses) attrs.push(`statuses="${statuses}"`);
        return `<char ${attrs.join(" ")}/>`;
    };

    const blocks = [
        "<enemy_ai_context>",
        "<scene>",
        ...history,
        "</scene>",
        "<enemy_sheets>",
        ...(d.enemies || []).map(sheetXml),
        "</enemy_sheets>",
        "<party_summary>",
        ...(d.characters || []).filter(c => c.state?.mode !== "dead").map(partyXml),
        "</party_summary>",
        "</enemy_ai_context>",
        `Decide the enemy actions for this round (at most ${maxActions} <action> entries).`,
    ];
    return blocks.join("\n");
}

// Tolerant parse of the <enemy_actions> block. Returns an array of actions,
// an EMPTY array when the model deliberately declared a no-op round
// (<enemy_actions/>), or null when nothing usable is present.
export function parseEnemyActions(text) {
    if (!text) return null;
    const blockM = text.match(/<enemy_actions>([\s\S]*?)<\/enemy_actions>/i);
    // Self-closing <enemy_actions/> is a deliberate "nobody acts this round".
    if (!blockM && /<enemy_actions\s*\/>/i.test(text)) return [];
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
            text: decodeEntities(String(m[2] || "")).replace(/\s+/g, " ").trim().slice(0, 200),
        });
    }
    return actions;
}

// Runs the ENEMY AI pass. Returns an array of actions ({ enemy, speed, title,
// text }), an EMPTY array when the AI deliberately decided nobody acts this
// round, or null when disabled/failed — only null makes the caller degrade to
// generic per-enemy attacks.
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
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
        }
        const messages = [
            { role: "system", content: systemContent },
            { role: "user", content: collectContext(maxActions) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        const actions = parseEnemyActions(reply || "");
        if (actions === null) {
            logDebug("enemyAI: no usable actions in reply — caller will fall back to generic attacks");
            return null;
        }
        if (!actions.length) {
            logDebug("enemyAI: AI declared a no-op round (nobody acts)");
            return [];
        }
        logDebug(`enemyAI: ${actions.length} action(s) — ${actions.map(a => a.enemy).join(", ")}`);
        return actions.slice(0, maxActions);
    } catch (e) {
        console.error("[Game Manager] enemy AI pass failed:", e);
        return null;
    }
}
