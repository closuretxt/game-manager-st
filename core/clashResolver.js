// CLASH RESOLVER — the third pass of Combat Mode (Text), and the only one
// that sees BOTH sides. It receives the party-side actions (player + ALLY AI)
// and the enemy-side actions (ENEMY AI, now unblinded), every actor's full
// stat sheet and the recent scene, and pairs them into clash groups with
// 4-tier chance sets. Output is XML (<clashes>), streamed so the combat
// bubble can render each group's tiers as they arrive.
//
// Grouping rules live in the system prompt: one enemy action opposes at most
// one party-side action per group; unopposed actions become single-sided
// groups; chances reflect the stat sheets fairly (dodging/shielding are
// first-class); speed decides initiative flavor in the outcome lines.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { parseAttrs } from "./toolParser.js";
import { hasConnectionProfile, resolvePremasterProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the CLASH RESOLVER of a tabletop-style roleplay game system: you turn both sides' combat actions into fair, opposed probability groups.",
    "",
    "WHAT YOU RECEIVE:",
    "- RECENT SCENE: the last few messages of the roleplay.",
    "- PARTY-SIDE ACTIONS: what the player (and any AI-commanded allies) are doing this round, with initiative speeds.",
    "- ENEMY-SIDE ACTIONS: what each enemy is doing this round, with initiative speeds.",
    "- ACTOR SHEETS: full stats (resources, attributes, skills, statuses) of EVERY actor in the round.",
    "",
    "YOUR OBJECTIVE:",
    "Pair the actions into clash groups and, for each group, provide exactly 4 ordered chance tiers (Critical Failure / Failure / Success / Critical Success) with short outcome lines. Chances are percentages of a 100% total and MUST reflect the stat sheets fairly: a dodging or shielding action with high Dexterity shifts tiers toward the defender; heavy armor shifts outcomes toward mitigation; a skilled attacker shifts them toward success. Higher speed acts first when both sides would succeed — reflect that in the outcome lines.",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML — no markdown fences, no prose:",
    '  <clashes>',
    '    <clash title="Knight\'s Slash vs Goblin A\'s Swing">',
    '      <side who="party" actor="Knight" speed="3" action="Slash at Goblin A"/>',
    '      <side who="enemy" actor="Goblin A" speed="2" action="Swing club"/>',
    '      <tier name="Critical Failure" chance="10">The knight\'s blade glances off; the club cracks her ribs</tier>',
    '      <tier name="Failure" chance="25">The knight misses; the goblin\'s swing connects</tier>',
    '      <tier name="Success" chance="50">The knight\'s slash lands before the goblin\'s club</tier>',
    '      <tier name="Critical Success" chance="15">The knight cleaves through the goblin\'s guard</tier>',
    '    </clash>',
    '  </clashes>',
    "",
    "GROUPING RULES:",
    "- Pair each party-side action with the MOST RELEVANT opposing enemy action (match targets from the action text). One enemy action opposes at most one party-side action per group.",
    "- An action with no sensible opponent becomes a SINGLE-SIDED group: one <side> entry and 4 tiers describing how well it goes.",
    "- Multiple enemies: one group per pair of actions — separate chances for each group of actions.",
    "- Tier outcome lines are short, vivid, and ALWAYS third person, referring to EVERY actor by name — including player characters (\"The knight's slash lands\"; \"The goblin's swing connects\"). Never use \"you\"/\"your\"/\"I\" in outcome lines, even for the player's own action.",
    "- Every action on either side must appear in exactly one group.",
].join("\n");

//

function collectContext(playerAction, partyActions, enemyActions) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1200)}`);

    const d = stateManager.getData();
    const sheetOf = c => ({
        name: c.name,
        resources: (c.resources || []).map(r => ({ name: r.name, value: r.value, max: r.max })),
        attributes: (c.attributes || []).map(a => ({ name: a.name, value: a.value })),
        skills: (c.skills || []).map(s => s.name),
        statuses: (c.statuses || []).map(s => ({ name: s.name, modifiers: s.modifiers || "" })),
    });

    // Only actors actually in the round pay tokens for a full sheet.
    const partyNames = new Set(partyActions.map(a => a.actor.toLowerCase()));
    const enemyNames = new Set(enemyActions.map(a => a.actor.toLowerCase()));
    const sheets = [
        ...(d.characters || []).filter(c => !c.state && partyNames.has(String(c.name).toLowerCase())).map(sheetOf),
        ...(d.enemies || []).filter(e => enemyNames.has(String(e.name).toLowerCase())).map(sheetOf),
    ];

    const blocks = [
        "RECENT SCENE:",
        ...history,
        "",
        "PARTY-SIDE ACTIONS:",
        JSON.stringify(partyActions),
        "",
        "ENEMY-SIDE ACTIONS:",
        JSON.stringify(enemyActions),
        "",
        "ACTOR SHEETS:",
        JSON.stringify(sheets),
    ];
    return blocks.join("\n");
}

// Incremental XML parse for streaming: returns the clash groups visible in a
// partial reply. An unterminated <clash> is included with the tiers closed so
// far, letting the bubble render groups live. Incomplete tiers are skipped.
export function extractStreamedClashes(partialText) {
    const groups = [];
    if (!partialText) return groups;
    const re = /<clash\b([^>]*?)>([\s\S]*?)(?:<\/clash>|$)/gi;
    let m;
    while ((m = re.exec(partialText)) !== null) {
        const attrs = parseAttrs(m[1]);
        const body = m[2] || "";
        const sides = [];
        const sideRe = /<side\b([^>]*?)\/>/gi;
        let s;
        while ((s = sideRe.exec(body)) !== null) {
            const a = parseAttrs(s[1]);
            sides.push({
                who: String(a.who || "party").toLowerCase() === "enemy" ? "enemy" : "party",
                actor: String(a.actor || ""),
                speed: Math.max(0, Math.trunc(Number(a.speed) || 0)),
                action: String(a.action || ""),
            });
        }
        const tiers = [];
        const tierRe = /<tier\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tier>)/gi;
        let t;
        while ((t = tierRe.exec(body)) !== null) {
            const a = parseAttrs(t[1]);
            tiers.push({
                name: String(a.name || ""),
                chance: Number(a.chance) || 0,
                outcome: String(t[2] || "").replace(/\s+/g, " ").trim(),
            });
        }
        groups.push({ title: String(attrs.title || "Clash").slice(0, 100), sides, tiers });
    }
    return groups;
}

// Sanitizes the final groups: every group needs at least one side and two
// usable tiers.
function sanitizeGroups(groups) {
    return (Array.isArray(groups) ? groups : [])
        .map(g => ({
            title: String(g?.title || "Clash").slice(0, 100),
            sides: (Array.isArray(g?.sides) ? g.sides : []).filter(s => s.actor),
            tiers: (Array.isArray(g?.tiers) ? g.tiers : [])
                .filter(t => t && t.name && t.outcome)
                .map(t => ({ name: String(t.name), chance: Number(t.chance) || 0, outcome: String(t.outcome) })),
        }))
        .filter(g => g.sides.length && g.tiers.length >= 2);
}

// Runs the CLASH RESOLVER pass. `onStream(groups)` fires with the partial
// group list as tiers arrive (for the combat bubble). Returns the sanitized
// groups, or null when disabled/failed — the caller then falls back to
// independent single-sided rolls.
export async function resolveClashes({ playerAction = "", partyActions = [], enemyActions = [], onStream = null } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_combat) return null;
    if (!partyActions.length && !enemyActions.length) return null;

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
            { role: "user", content: collectContext(playerAction, partyActions, enemyActions) },
        ];

        let streamed = "";
        const reply = await sendRequestViaProfile(profileId, messages, {
            stream: !!onStream,
            onChunk: (partial) => {
                streamed = partial;
                if (onStream) onStream(extractStreamedClashes(partial));
            },
        });

        const groups = sanitizeGroups(extractStreamedClashes(reply || streamed));
        if (!groups.length) {
            logDebug("clashResolver: no usable groups in reply — caller will fall back to single-sided rolls");
            return null;
        }
        logDebug(`clashResolver: ${groups.length} group(s) — ${groups.map(g => g.title).join(" | ")}`);
        return groups;
    } catch (e) {
        console.error("[Game Manager] clash resolver pass failed:", e);
        return null;
    }
}
