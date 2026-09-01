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
import { parseAttrs, escAttr } from "./toolParser.js";
import { hasConnectionProfile, resolvePremasterProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the ALLY AI of a tabletop-style roleplay game system: when the player does not command every member of their party, you decide what the uncommanded allies do this combat round.",
    "",
    "WHAT YOU RECEIVE:",
    "- <scene>: the last few messages of the roleplay.",
    "- <party_sheets>: full stats of every tracked party member (resources, attributes, skills, statuses).",
    "- <enemy_presence>: the hostile side's names and visible state.",
    "- <player_action>: what the player themselves is doing. Allies are FRIENDLY — they may coordinate with it, cover the player, or follow its lead.",
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

    // One line per actor: resources as value/max, * = skill on cooldown.
    const sheetXml = c => {
        const attrs = [`name="${escAttr(c.name)}"`];
        for (const r of c.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
        for (const a of c.attributes || []) attrs.push(`${escAttr(a.name)}="${a.value}"`);
        const skills = (c.skills || []).map(s => `${escAttr(s.name)}${(Number(s.cooldown_left) || 0) > 0 ? "*" : ""}`).join(", ");
        if (skills) attrs.push(`skills="${skills}"`);
        const statuses = (c.statuses || []).map(s => `${escAttr(s.name)}${s.modifiers ? ` (${escAttr(s.modifiers)})` : ""}`).join(", ");
        if (statuses) attrs.push(`statuses="${statuses}"`);
        return `  <char ${attrs.join(" ")}/>`;
    };

    // Visible state only: the ally AI never sees full enemy sheets.
    const enemyXml = e => {
        const attrs = [`name="${escAttr(e.name)}"`];
        for (const r of e.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
        const statuses = (e.statuses || []).map(s => escAttr(s.name)).join(", ");
        if (statuses) attrs.push(`statuses="${statuses}"`);
        return `  <enemy ${attrs.join(" ")}/>`;
    };

    const blocks = [
        "<ally_ai_context>",
        "  <scene>",
        ...history.map(l => `  ${l}`),
        "  </scene>",
        "  <party_sheets>",
        ...(d.characters || []).filter(c => !c.state).map(sheetXml),
        "  </party_sheets>",
        "  <enemy_presence>",
        ...(d.enemies || []).map(enemyXml),
        "  </enemy_presence>",
        `  <player_action>${escAttr(playerAction)}</player_action>`,
        "</ally_ai_context>",
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
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
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
