// ALLY AI pass — the friendly side of Combat Mode (Text).
// When the pre-pass emits <combat/> and the player's action does not cover
// every party member, this pre-master call invents actions for the
// uncommanded allies. Unlike the ENEMY AI, allies ARE friendly: they see the
// player's action and may coordinate with it. Their output is treated exactly
// like player-side actions downstream. On failure the caller degrades to
// "allies hold position".

import { extension_settings, getContext } from "../../../../extensions.js";
import { substituteParams } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel, charLabel } from "./stateManager.js";
import { parseAttrs, escAttr, decodeEntities } from "./toolParser.js";
import { sheetXml as renderSheet, sharedXml } from "./sheetXml.js";
import { valueGuidelines } from "./valueGuidelines.js";
import { resolveCombatProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { getPreviousPrePassRaw } from "./prePass.js";

import { recentMessages, sceneContextBlock } from "../util/chatStore.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the ALLY AI of a tabletop-style roleplay game system: when the player does not command every member of their party, you decide what the uncommanded allies do this combat round.",
    "",
    "WHAT YOU RECEIVE:",
    "- <scene_context>: the last few messages of the roleplay — PAST context only, already tracked (specific note inside the block). The round you decide happens NOW, right after the scene ends; never act on it. The ONLY current-round instruction is <player_action>.",
    "- <party_sheets>: full stats of every tracked party member (resources, attributes, skills, statuses).",
    "- <enemy_presence>: the hostile side's names and visible state.",
    "- <player_action>: what the player themselves is doing. Allies are FRIENDLY — they may coordinate with it, cover the player, or follow its lead.",
    "- GM NOTES (optional): the pre-pass router's notes for this turn.",
    "",
    "YOUR OBJECTIVE:",
    "Decide ONE action for each party member whose behavior the player's action does NOT already cover. Members the player clearly commanded (named, ordered, protected...) get NOTHING — never override the player's orders. Actions are NOT mandatory: read the scene and statuses first; dazed, stunned, unconscious or otherwise compromised allies are skipped, and allies may also hold back when the scene justifies it. If the player's action covers everyone (or nobody can act), respond with an empty <ally_actions/>.",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML — no markdown fences, no prose:",
    '<ally_actions>',
    '<action char="<party member name>" speed="<initiative, 0 if unknown>" title="<short action title>"><short intent line, under 20 words></action>',
    '</ally_actions>',
    "",
    "RULES:",
    "- speed is initiative judged from that ally's attributes/statuses (Dexterity, Haste...); 0 when unknown.",
    "- title is a short third-person action title (\"Cover the flank\").",
    "- The intent line says WHAT the ally attempts and AT WHOM (or for whom) — the clash engine needs a concrete target to pair actions against.",
    "- Any kind of action is valid: attacking, dodging, shielding the player, healing, using a skill — choose what a loyal ally would do given its stats and the scene.",
    "- USE SKILLS ACTIVELY. Skills are the ally's signature moves: when a ready skill (no * marker) fits the scene, PREFER it over a plain attack — a fire mage should cast, a healer should heal. Name the skill explicitly in the intent line. Never use a skill marked * (on cooldown), and never invent skills that are not on the sheet.",
    "- Skill costs are real: a skill's cost=\"...\" is paid when used — only pick it when the ally can afford it (check current resources).",
    "- Skip allies whose statuses/scene prevent acting (Dazed, Stunned, Unconscious...) — a skipped ally gets no <action> entry. Physical restraints (grappled, tangled in roots, buried in debris) don't force a skip: the ally may act to break free.",
    "- Never act for the player themselves; never invent party members that are not in the sheets or in the scene.",
    "- UNCERTAIN NUMBERS go in dice notation: when the intent carries variable damage or a random effect, write it as a die (\"slashes for 2d6+2\", \"50% chance to stagger: 1d2\") — the engine rolls TRUE random dice when the tracker applies it; never invent a fixed average yourself.",
    valueGuidelines(),
].join("\n");

//

function collectContext(playerAction) {
    // Always ends at the AI's last reply (trailing user action excluded).
    // No char cap — messages stay intact; the message count bounds the size.
    const history = recentMessages(MAX_CONTEXT_MESSAGES)
        .map(m => `${m.is_user ? playerLabel() : charLabel(m.name)}: ${String(m.mes ?? "")}`);

    const d = stateManager.getData();

    // Own sheet via the global renderer (core/sheetXml.js) — ALL sections in
    // full detail (the ally should know its own boosts and gear).
    const sheetXml = c => renderSheet(c, { tag: "char" });

    // Visible state only: the ally AI never sees full enemy sheets.
    const enemyXml = e => renderSheet(e, { tag: "enemy", sections: ["resources", "statuses"], descriptions: false });

    const blocks = [
        "<ally_ai_context>",
        // The whole scene window is one <scene_context> block: past context,
        // already tracked — the specific note INSIDE the block says so next to
        // the data, not only in the system prompt.
        sceneContextBlock(history),
        "<party_sheets>",
        ...(d.characters || []).filter(c => !c.state).map(sheetXml),
        "</party_sheets>",
        // Party purse: an ally may act on shared supplies ("grab a ration").
        ...(d.sharedResources || []).length ? [
            "<shared_resources>",
            ...d.sharedResources.map(r => sharedXml(r)),
            "</shared_resources>",
        ] : [],
        "<enemy_presence>",
        ...(d.enemies || []).map(enemyXml),
        "</enemy_presence>",
        `<player_action>${escAttr(playerAction)}</player_action>`,
        "</ally_ai_context>",
        // Router notes for this turn — after the context, read as fresh info.
        ...(String(getPreviousPrePassRaw() || "").trim() ? [
            "GM NOTES (the pre-pass router's output for this turn):",
            "<gm_notes>",
            getPreviousPrePassRaw().trim(),
            "</gm_notes>",
        ] : []),
        // Closing recency anchor at the VERY bottom of the full prompt.
        "Reminder: whatever else you write, deliver the actions inside <ally_actions>...</ally_actions> — that block is what the system reads.",
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
            text: decodeEntities(String(m[2] || "")).replace(/\s+/g, " ").trim().slice(0, 200),
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
    // Solo party: nobody besides the player to command — skip the request.
    if ((d.characters || []).length < 2) return null;

    try {
        const st = getContext();
        const profileId = resolveCombatProfile(st, s.combat_profile, s.premaster_profile, s.connection_profile);
        let systemContent = SYSTEM_PROMPT;
        if (s.deep_context_engines) {
            const deep = await buildDeepContext(String(playerAction || ""));
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
        }

        // User's standing instructions for the pre-master engines — at the END
        // of the system message, after the deep context (same layout as the
        // dice roller/clash resolver). Injected whenever non-empty, regardless
        // of the deep context toggle. Full ST macro parsing via substituteParams.
        const custom = String(s.custom_instructions?.pre || "").trim();
        if (custom) {
            let rendered = custom;
            try {
                const charName = st.characters?.[st.characterId]?.name;
                rendered = substituteParams(rendered, { name2Override: charName });
            } catch (e) {
                console.warn("[Game Manager] custom instruction macro substitution failed:", e);
            }
            systemContent += `\n\n<custom>\n${rendered}\n</custom>`;
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
