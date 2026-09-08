// ENEMY AI pass — the hostile side of Combat Mode (Text).
// When the pre-pass emits <combat/>, this pre-master call decides what every
// tracked enemy does this round. By default it is deliberately BLIND to the
// player's action: the enemy side must not know what the party chose. A
// REACTIVE pre-pass judgment (<combat reactive="true"/>) flips this: the
// caller hands the declared move over and the enemies answer it instead of
// acting on their own. Output is XML (<enemy_actions>, one <action> per
// enemy), consumed by the clash resolver (core/clashResolver.js). On failure
// the caller degrades to generic attacks.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel } from "./stateManager.js";
import { parseAttrs, escAttr, decodeEntities } from "./toolParser.js";
import { valueGuidelines } from "./valueGuidelines.js";
import { getPreviousPrePassRaw } from "./prePass.js";
import { resolveCombatProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

import { recentMessages, sceneContextBlock } from "../util/chatStore.js";

const MAX_CONTEXT_MESSAGES = 8;

// Blind by default: the enemy side must not know what the party chose...
const BLIND_NOTE = "You do NOT see the player's current action — the enemy side must decide WITHOUT knowing what the party chose this round.";

// Reactive round: the pre-pass judged the enemies should answer the move...
const REACTIVE_NOTE = "REACTIVE ROUND: the pre-master judged the enemies should respond to the party instead of acting on their own. You DO see the player's declared move in <player_move> — build your actions as ANSWERS to it: counter it, dodge it, block it, intercept it, or exploit the commitment it implies. When nothing beats simply answering the move, hold back instead — never act on impulse while the party's action unfolds.";

function systemPrompt(playerAction) {
    return [
    "You are the ENEMY AI of a tabletop-style roleplay game system: you decide what the hostile side does each combat round.",
    "",
    "WHAT YOU RECEIVE:",
    "- <scene_context>: the last few messages of the roleplay — the PREVIOUS turn(s), already played out and tracked (specific note inside the block). The round you decide comes AFTER them: don't repeat, continue or answer what happened there — come up with what the enemies do NEXT, given how things stand now.",
    "- GM NOTES (optional): the pre-pass router's notes for this turn — on blind rounds ONLY its <rewrite>/<note> entries are included.",
    "- <enemy_sheets>: full stats of every tracked enemy (resources, attributes, skills, statuses).",
    "- <party_summary>: the opposing party's names and visible state. " + (playerAction ? REACTIVE_NOTE : BLIND_NOTE),
    "",
    "YOUR OBJECTIVE:",
    "Decide ONE action per enemy for this round — or none at all. Actions are NOT mandatory: read the scene and statuses first; dazed, stunned, unconscious or otherwise compromised enemies are skipped, and enemies may also hold back when the scene justifies it. Any kind of action is valid — attacking, dodging, shielding an ally, repositioning, fleeing, using a skill. An enemy may take more than one action ONLY if its sheet justifies it (an extra-action status or similar).",
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
    "- Never invent enemies that are not in the sheets or in the scene.",
    "- The scene is the PREVIOUS turn: whatever happened there (attacks, outcomes, who faced whom) is done. This round the enemies act on the NEW situation — fresh decisions, not echoes of the last exchange.",
    "- Skip enemies whose statuses/scene prevent acting (Dazed, Stunned, Unconscious...) — a skipped enemy gets no <action> entry. Physical restraints (grappled, tangled in roots, buried in debris) don't force a skip: the enemy may act to break free.",
    "- UNCERTAIN NUMBERS go in dice notation: when the intent carries variable damage or a random effect, write it as a die (\"clubs for 1d8+1\", \"20% chance to poison: 1d5\") — the engine rolls TRUE random dice when the tracker applies it; never invent a fixed average yourself.",
    valueGuidelines(),
].join("\n");
}

//

// GM notes: the pre-pass router's output for this action. On blind rounds
// ONLY <rewrite>/<note> entries pass through — no <skill>/<roll> or other
// party-move details; reactive rounds get the full raw output.
function gmNotes(playerAction) {
    const raw = String(getPreviousPrePassRaw() || "").trim();
    if (!raw) return null;
    if (playerAction) return raw;
    const picked = raw.match(/<(rewrite|note)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/gi);
    return picked ? picked.join("\n") : null;
}

function collectContext(maxActions, playerAction) {
    // Always ends at the AI's last reply (trailing user action excluded).
    // No char cap — messages stay intact; the message count bounds the size.
    const history = recentMessages(MAX_CONTEXT_MESSAGES)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "")}`);

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
        // The whole scene window is one <scene_context> block: past context,
        // already tracked — the specific note INSIDE the block says so next to
        // the data, not only in the system prompt.
        sceneContextBlock(history),
        "<enemy_sheets>",
        ...(d.enemies || []).map(sheetXml),
        "</enemy_sheets>",
        "<party_summary>",
        ...(d.characters || []).filter(c => c.state?.mode !== "dead").map(partyXml),
        "</party_summary>",
        // Only present on reactive rounds: the declared move the enemies
        // answer instead of acting on their own.
        ...(playerAction ? [
            "<player_move>",
            `The ${playerLabel()}'s declared action this round; the enemies already know it and act in RESPONSE but their action is way slower.`,
            String(playerAction).slice(0, 600),
            "</player_move>",
        ] : []),
        "</enemy_ai_context>",
        // Router notes for this turn — after the context, read as fresh info.
        ...(gmNotes(playerAction) ? [
            "GM NOTES (the pre-pass router's output for this turn):",
            "<gm_notes>",
            gmNotes(playerAction),
            "</gm_notes>",
        ] : []),
        "",
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
export async function runEnemyAI({ maxActions = 6, playerAction = null } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_combat) return null;

    const d = stateManager.getData();
    if (!(d.enemies || []).length) return null;

    try {
        const st = getContext();
        const profileId = resolveCombatProfile(st, s.combat_profile, s.premaster_profile, s.connection_profile);
        let systemContent = systemPrompt(playerAction);
        if (s.deep_context_engines) {
            const deep = await buildDeepContext("");
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
        }
        const messages = [
            { role: "system", content: systemContent },
            { role: "user", content: collectContext(maxActions, playerAction) },
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
