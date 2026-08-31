// ALLY AI pass — the friendly side of Combat Mode (Text).
// When the pre-pass emits <combat/> and the player's action does not cover
// every party member, this pre-master call invents actions for the
// uncommanded allies. Unlike the ENEMY AI, allies ARE friendly: they see the
// player's action and may coordinate with it. Their output is treated exactly
// like player-side actions downstream. On failure the caller degrades to
// "allies hold position".

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { parseAttrs } from "./toolParser.js";
import { hasConnectionProfile, resolvePremasterProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the ALLY AI of a tabletop-style roleplay game system: when the player does not command every member of their party, you decide what the uncommanded allies do this combat round.",
    "",
    "WHAT YOU RECEIVE:",
    "- RECENT SCENE: the last few messages of the roleplay.",
    "- PARTY SHEETS: full stats of every tracked party member (resources, attributes, skills, statuses).",
    "- ENEMY PRESENCE: the hostile side's names and visible state.",
    "- PLAYER ACTION: what the player themselves is doing. Allies are FRIENDLY — they may coordinate with it, cover the player, or follow its lead.",
    "",
    "YOUR OBJECTIVE:",
    "Decide ONE action for each party member whose behavior the player's action does NOT already cover. Members the player clearly commanded (named, ordered, protected...) get NOTHING — never override the player's orders. If the player's action covers everyone, respond with an empty <ally_actions/>.",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML — no markdown fences, no prose:",
    '  <ally_actions>',
    '    <action char="<party member name>" speed="<initiative, 0 if unknown>" title="<short action title>"><short intent line, under 20 words></action>',
    '  </ally_actions>',
    "",
    "RULES:",
    "- speed is initiative judged from that ally's attributes/statuses (Dexterity, Haste...); 0 when unknown.",
    "- title is a short third-person action title (\"Cover the flank\").",
    "- The intent line says WHAT the ally attempts and AT WHOM (or for whom) — the clash engine needs a concrete target to pair actions against.",
    "- Any kind of action is valid: attacking, dodging, shielding the player, healing, using a skill — choose what a loyal ally would do given its stats and the scene.",
    "- Never act for the player themselves; never invent party members that are not in the sheets.",
].join("\n");

//

function collectContext(playerAction) {
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
        "PARTY SHEETS (you command the uncommanded):",
        JSON.stringify((d.characters || []).filter(c => !c.state).map(sheetOf)),
        "",
        "ENEMY PRESENCE (visible state only):",
        JSON.stringify((d.enemies || []).map(e => ({
            name: e.name,
            resources: (e.resources || []).map(r => ({ name: r.name, value: r.value, max: r.max })),
            statuses: (e.statuses || []).map(s => s.name),
        }))),
        "",
        `PLAYER ACTION (allies coordinate with this): ${playerAction}`,
    ];
    return blocks.join("\n");
}

// Tolerant parse of the <ally_actions> block. Returns an array of actions or
// null when nothing usable is present (an empty block is valid: no allies act).
export function parseAllyActions(text) {
    if (!text) return null;
    const blockM = text.match(/<ally_actions\s*\/>|<ally_actions>([\s\S]*?)<\/ally_actions>/i);
    if (!blockM) return null;
    const body = blockM[1] || "";
    const actions = [];
    const re = /<action\b([^>]*?)(?:\/>|>([\s\S]*?)<\/action>)/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        const a = parseAttrs(m[1]);
        const char = String(a.char || a.name || "").trim();
        if (!char) continue;
        actions.push({
            char,
            speed: Math.max(0, Math.trunc(Number(a.speed) || 0)),
            title: String(a.title || "Act").slice(0, 80),
            text: String(m[2] || "").replace(/\s+/g, " ").trim().slice(0, 200),
        });
    }
    return actions;
}

// Runs the ALLY AI pass. Returns an array of actions
// ({ char, speed, title, text }) — possibly empty — or null when disabled or
// failed (the caller then treats allies as holding position).
export async function runAllyAI({ playerAction = "" } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_combat || !s.feature_ally_ai) return null;

    const d = stateManager.getData();
    if (!(d.characters || []).length) return null;

    try {
        const st = getContext();
        const profileId = (s.combat_profile && hasConnectionProfile(st, s.combat_profile))
            ? s.combat_profile
            : resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        let systemContent = SYSTEM_PROMPT;
        if (s.deep_context_engines) {
            const deep = await buildDeepContext(String(playerAction || ""));
            if (deep) systemContent += `\n\nDEEP CONTEXT (card / persona / lore):\n${deep}`;
        }
        const messages = [
            { role: "system", content: systemContent },
            { role: "user", content: collectContext(playerAction) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        const actions = parseAllyActions(reply || "");
        if (actions === null) {
            logDebug("allyAI: no <ally_actions> block in reply — allies hold position");
            return null;
        }
        logDebug(`allyAI: ${actions.length} action(s) — ${actions.map(a => a.char).join(", ") || "none needed"}`);
        return actions;
    } catch (e) {
        console.error("[Game Manager] ally AI pass failed:", e);
        return null;
    }
}
