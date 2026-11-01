// OPPOSITION — the rivals' side of a race or scored contest
// (plans/combat-modules.md 3.7). Fights keep core/enemyAI.js; this call is
// its shape-neutral sibling: one call decides what every rival does this
// round, BLIND to the player's move like the enemy AI. Rivals are tracked
// enemies AND untracked runners/competitors the pre-pass named (no sheet:
// judged from the scene). Same output format as the enemy AI, so the same
// parser reads it; null = failed (the caller falls back to scripted styles).

// Two folders below the extension root: one more ../ than core/*.
import { getContext } from "../../../../../extensions.js";
import { substituteParams } from "../../../../../../script.js";
import { gmSettings } from "../features.js";
import { logDebug } from "../debug.js";
import { stateManager, playerLabel, charLabel } from "../stateManager.js";
import { escAttr } from "../toolParser.js";
import { sheetXml as renderSheet } from "../sheetXml.js";
import { parseEnemyActions } from "../enemyAI.js";
import { resolveCombatProfile, sendRequestViaProfile } from "../../util/connectionService.js";
import { scenarioBriefBlock } from "../scenarioBrief.js";
import { recentMessages, sceneContextBlock } from "../../util/chatStore.js";

const MAX_CONTEXT_MESSAGES = 8;

function oppositionPrompt(shape) {
    return [
        `You are the OPPOSITION AI of a tabletop-style roleplay game system: you decide what the RIVALS do in one round of a ${String(shape?.label || "contest").toLowerCase()}.`,
        "",
        "WHAT YOU RECEIVE:",
        "- <scene_context>: the last few messages — the PREVIOUS turn(s), already played out and tracked. Decide what the rivals do NEXT.",
        "- <contest_state>: the current standings with numbers (for you only).",
        "- <rivals>: every rival; tracked ones carry their sheet, untracked ones only a name — judge those from the scene.",
        "- <party_summary>: the player's side. You do NOT see the player's current action: decide WITHOUT knowing it.",
        "",
        "YOUR OBJECTIVE:",
        String(shape?.opposition || "Every rival picks ONE action for this round."),
        "A rival may also do nothing special when the scene justifies it. Never invent rivals that are not listed.",
        "",
        "OUTPUT FORMAT — ONLY XML, no markdown fences, no prose:",
        "<enemy_actions>",
        '<action enemy="<rival name>" speed="<initiative, 0 if unknown>" title="<short action title>"><intent line under 20 words></action>',
        "</enemy_actions>",
    ].join("\n");
}

function oppositionContext(shape, rivals, stateLines, maxActions) {
    const history = recentMessages(MAX_CONTEXT_MESSAGES)
        .map(m => `${m.is_user ? playerLabel() : charLabel(m.name)}: ${String(m.mes ?? "")}`);
    const d = stateManager.getData();
    const rivalXml = r => (r.sheet && !r.sheet.pseudo)
        ? renderSheet(r.sheet, { tag: "rival" })
        : `<rival name="${escAttr(r.name)}" untracked="true"/>`;
    const partyXml = c => renderSheet(c, { tag: "char", attrs: c.state?.mode ? { state: c.state.mode } : {}, sections: ["resources", "statuses"], descriptions: false });
    return [
        "<opposition_context>",
        sceneContextBlock(history),
        "<contest_state>",
        ...stateLines,
        "</contest_state>",
        "<rivals>",
        ...rivals.map(rivalXml),
        "</rivals>",
        "<party_summary>",
        ...(d.characters || []).filter(c => c.state?.mode !== "dead").map(partyXml),
        "</party_summary>",
        "</opposition_context>",
        `Decide the rivals' actions for this round (at most ${maxActions} <action> entries).`,
        "Reminder: deliver the actions inside <enemy_actions>...</enemy_actions> — that block is what the system reads.",
    ].join("\n");
}

// rivals: [{ name, sheet }]. Returns actions ({ enemy, speed, title, text }),
// [] for a deliberate no-op round, or null when the call failed.
export async function runOpposition({ shape, rivals = [], stateLines = [], maxActions = 6 } = {}) {
    const s = gmSettings();
    if (!rivals.length) return [];
    try {
        const st = getContext();
        const profileId = resolveCombatProfile(st, s.combat_profile, s.premaster_profile, s.connection_profile);
        let systemContent = oppositionPrompt(shape);
        const brief = scenarioBriefBlock();
        if (brief) systemContent += `\n\n${brief}`;
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
        const reply = await sendRequestViaProfile(profileId, [
            { role: "system", content: systemContent },
            { role: "user", content: oppositionContext(shape, rivals, stateLines, maxActions) },
        ]);
        const actions = parseEnemyActions(reply || "");
        if (actions === null) {
            logDebug("opposition: no usable actions in reply — scripted styles");
            return null;
        }
        logDebug(`opposition: ${actions.length} rival action(s)`);
        return actions.slice(0, maxActions);
    } catch (e) {
        console.error("[Game Manager] opposition pass failed:", e);
        return null;
    }
}
