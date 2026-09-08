// CLASH RESOLVER — the third pass of Combat Mode (Text), and the only one
// that sees BOTH sides. It receives the party-side actions (player + ALLY AI)
// and the enemy-side actions (ENEMY AI, now unblinded), every actor's full
// stat sheet and the recent scene, and pairs them into clash groups with
// 4-tier chance sets. Output is XML (<clashes>), streamed so the combat
// bubble can render each group's tiers as they arrive.
//
// Grouping rules live in the system prompt: one enemy action opposes at most
// one party-side action per group; unopposed actions become single-sided
// groups; chances are earned harshly from the stat sheets (health, attributes,
// passives, statuses; unknown abilities are impossible); speed decides
// initiative flavor in the outcome lines. The resolver may also REWRITE a
// side's action text so a pair reads as one coherent exchange, and NEGATE an
// action outright when the opposing act shuts it down completely (the engine
// then skips the roll for that group).

import { extension_settings, getContext } from "../../../../extensions.js";
import { substituteParams } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel } from "./stateManager.js";
import { parseAttrs, escAttr, decodeEntities } from "./toolParser.js";
import { valueGuidelines } from "./valueGuidelines.js";
import { resolveDiceProfile, sendRequestViaProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

import { recentMessages, sceneContextBlock } from "../util/chatStore.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the CLASH RESOLVER of a tabletop-style roleplay game system: you turn both sides' combat actions into opposed probability groups. REALISM FIRST: chances are EARNED from the sheets, never generous by default. Every tier must be justifiable by a stat, skill, passive, status or resource — if nothing on the sheet supports a chance, lower it.",
    "",
    "WHAT YOU RECEIVE:",
    "- <scene_context>: the last few messages of the roleplay — PAST context only, already tracked (specific note inside the block). The round you resolve happens NOW and is defined ENTIRELY by <party_actions>/<enemy_actions>; never resolve or re-pair actions taken from the scene.",
    "- <party_actions> / <enemy_actions>: what each side is doing this round, with initiative speeds.",
    "- <sheets>: resources (current health!), attributes, skills, passives, statuses of EVERY actor in the round.",
    "",
    "HARD RESOLUTION RULES:",
    "- UNKNOWN ABILITIES = IMPOSSIBLE. If an action names an ability/technique/spell NOT on the actor's sheet, Success and Critical Success are 0%: only Failure/Critical Failure tiers describing the fumble (doesn't know the technique, move misfires, nothing happens). A swordsman without 'Dimensional Slash' cannot use it.",
    "- HEALTH CAPS PERFORMANCE. Check current resources: below ~25% health, agile/acrobatic actions are near-impossible and attack tiers shift hard toward Failure. Near-death actors cannot perform demanding maneuvers at all.",
    "- ATTRIBUTES & PASSIVES DECIDE. Match each action to its relevant attribute (Strength for melee, Dexterity for dodging...) and read passives/stat modifiers — they must visibly shift the tiers. Large stat gaps skew tiers strongly: the weaker side rarely exceeds ~30% Success.",
    "- STATUSES APPLY. Wounded, slowed, blinded, buffed — apply their modifiers to the chances.",
    "- Higher speed acts first when both sides would succeed — reflect that in the outcome lines.",
    "- Non-combat struggles (grappling, pinning, escapes, arm wrestling) resolve the same way, judged by the relevant attributes instead of weapons and armor.",
    "",
    "YOUR OBJECTIVE:",
    "Pair the actions into clash groups and, for each group, provide exactly 4 ordered chance tiers (Critical Failure / Failure / Success / Critical Success) with short outcome lines. Chances are percentages of a 100% total.",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML — no markdown fences, no prose:",
    
    '<clashes>',
    '<clash title="Knight\'s Slash vs Goblin A\'s Swing">',
    '<side who="party" actor="Knight" speed="3" action="Slash at Goblin A"/>',
    '<side who="enemy" actor="Goblin A" speed="2" action="Swing club"/>',
    '<tier name="Critical Failure" chance="10">The knight\'s blade glances off; the club cracks her ribs</tier>',
    '<tier name="Failure" chance="25">The knight misses; the goblin\'s swing connects</tier>',
    '<tier name="Success" chance="50">The knight\'s slash lands before the goblin\'s club</tier>',
    '<tier name="Critical Success" chance="15">The knight cleaves through the goblin\'s guard</tier>',
    '</clash>',
    '</clashes>',
    "",
    "GROUPING RULES:",
    "- Pair each party-side action with the MOST RELEVANT opposing enemy action (match targets from the action text). One enemy action opposes at most one party-side action per group.",
    "- An action with no sensible opponent becomes a SINGLE-SIDED group: one <side> entry and 4 tiers describing how well it goes.",
    "- Multiple enemies: one group per pair of actions — separate chances for each group of actions.",
    "- Tier outcome lines are EXPLICIT RESULTS, not teases: short, vivid, and ALWAYS third person, referring to EVERY actor by name — including player characters (\"The knight's slash lands\"; \"Goblin 2 swing connects\"). Never use \"you\"/\"your\"/\"I\" in outcome lines, even for the player's own action.",
    "- Each outcome line states exactly what the action DOES — lands or misses, where it lands, the concrete effect on the target (\"Kael's slash opens the goblin's shoulder; it staggers back\") — and NOTHING more: no invented reactions, follow-up actions or flavor embellishments (\"clutching the wound\") — the story engine narrates those. No hedging either: never \"may\", \"might\", \"perhaps\" or \"tries to\" — the tier IS the result.",
    "- Outcomes must be PLAUSIBLE against the sheets: before writing a result, weigh the attacker's skill/weapon damage term, the target's CURRENT health and its active statuses. A full-health target does not instantly die to a normal hit — such outcomes read as wounded, staggered or knocked back, and lethal results (decapitations, instant deaths) are only justified when the skill's damage (or a Critical Success against a near-death target) is actually enough to kill. Conversely, a target already near death CAN drop to a solid hit. Scale the described effect to the numbers: a graze, a solid hit and a devastating blow must read differently.",
    "- Every action on either side must appear in exactly one group.",
    "- TIER CHANCES are plain percentages — the engine weights them into a true random pick. When an action's text carries dice terms (variable damage, random effects), keep them in the outcome line as written (\"slashes for 2d6+2\"): the tracker rolls them with TRUE RNG when it applies the numbers.",
    "- ACTION REWRITES: you may rewrite the action text of any <side> so a paired clash reads as ONE coherent exchange — when the opposing action changes the situation mid-move, fold it in (\"Leap the chasm\" paired with \"Shoot arrow\" becomes \"Shoot the Scout as she leaps\"). Keep the actor, the intent and any dice terms intact: rewrite wording/context only, NEVER invent actions nobody declared.",
    "- NEGATION: when one action so completely shuts another down that no contest remains (a raised shield wall against a thrown pebble, a point-blank shot at someone still sheathing a weapon), mark the shut-down side with negated=\"true\". The group still carries 4 tiers describing the negating side's execution, and every outcome line makes clear the negated action never gets to matter. Use it SPARINGLY: a hard, contestable exchange is never a negation.",
    valueGuidelines(),
].join("\n");

// Optional instruction block — injected only when the "Deterministic Clashes"
// setting is on (settingsManager.js). Pushes the resolver from descriptive
// outcomes to COMMITTED NUMBERS: when the sheets justify them, the landing
// tiers carry the full damage expression plus costs/statuses, so the
// post-pass tracker (agentRunner) translates exact terms into sheet deltas
// instead of guessing from prose. This is the middle ground between feeding
// the STORY engine heavy state and leaving the tracker blind.
const DETERMINISTIC_GUIDELINES = [
    "DETERMINISTIC CLASH OUTCOMES — when you are CONFIDENT the sheets justify the numbers, COMMIT them in the tier outcome lines:",
    "- For a tier where an attack lands, write its damage as the sheet's damage term plus stat scaling as ONE arithmetic/dice expression, e.g. \"slashes for 18+4*3 damage\" — the tracker resolves it exactly (arithmetic and true-RNG dice rules apply).",
    "- Also commit what the exchange costs or applies: skill resource costs, ammo/stamina spend, statuses with their modifiers (\"leaves the goblin Wounded: Aim -2\").",
    "- Never invent numbers the sheets do not support — when a damage term is unknown, keep that outcome descriptive. Confidence comes from the sheets ONLY.",
].join("\n");

//

function collectContext(playerAction, partyActions, enemyActions) {
    // Always ends at the AI's last reply (trailing user action excluded).
    // No char cap — messages stay intact; the message count bounds the size.
    const history = recentMessages(MAX_CONTEXT_MESSAGES)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "")}`);

    const d = stateManager.getData();

    // One line per actor: resources as value/max; passives keep their
    // descriptions (chances are earned from them).
    const sheetXml = c => {
        const attrs = [`name="${escAttr(c.name)}"`];
        for (const r of c.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
        for (const a of c.attributes || []) attrs.push(`${escAttr(a.name)}="${a.value}"`);
        const skills = (c.skills || []).map(s => escAttr(s.name)).join(", ");
        if (skills) attrs.push(`skills="${skills}"`);
        const passives = (c.passives || []).map(p => `${escAttr(p.name)}${p.description ? `: ${escAttr(p.description)}` : ""}`).join("; ");
        if (passives) attrs.push(`passives="${passives}"`);
        const statuses = (c.statuses || []).map(s => `${escAttr(s.name)}${s.modifiers ? ` (${escAttr(s.modifiers)})` : ""}`).join(", ");
        if (statuses) attrs.push(`statuses="${statuses}"`);
        return `<actor ${attrs.join(" ")}/>`;
    };

    const actionXml = a => `<action actor="${escAttr(a.actor)}" speed="${Math.max(0, Math.trunc(Number(a.speed) || 0))}">${escAttr(a.action)}</action>`;

    // Only actors actually in the round pay tokens for a full sheet.
    const partyNames = new Set(partyActions.map(a => a.actor.toLowerCase()));
    const enemyNames = new Set(enemyActions.map(a => a.actor.toLowerCase()));
    const sheets = [
        ...(d.characters || []).filter(c => !c.state && partyNames.has(String(c.name).toLowerCase())).map(sheetXml),
        ...(d.enemies || []).filter(e => enemyNames.has(String(e.name).toLowerCase())).map(sheetXml),
    ];

    const blocks = [
        "<clash_context>",
        // The whole scene window is one <scene_context> block: past context,
        // already tracked — the specific note INSIDE the block says so next to
        // the data, not only in the system prompt.
        sceneContextBlock(history),
        "<party_actions>",
        ...partyActions.map(actionXml),
        "</party_actions>",
        "<enemy_actions>",
        ...enemyActions.map(actionXml),
        "</enemy_actions>",
        "<sheets>",
        ...sheets,
        "</sheets>",
        "</clash_context>",
        // Closing recency anchor at the VERY bottom of the full prompt.
        "Reminder: whatever else you write, deliver the clash groups inside <clashes>...</clashes> — that block is what the system reads.",
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
        // Tolerates both self-closing <side .../> and <side ...></side>.
        const sideRe = /<side\b([^>]*?)(?:\/>|>)/gi;
        let s;
        while ((s = sideRe.exec(body)) !== null) {
            const a = parseAttrs(s[1]);
            sides.push({
                who: String(a.who || "party").toLowerCase() === "enemy" ? "enemy" : "party",
                actor: String(a.actor || ""),
                speed: Math.max(0, Math.trunc(Number(a.speed) || 0)),
                action: String(a.action || ""),
                // Set when the opposing act shuts this one down outright —
                // the engine skips the roll for the whole group.
                negated: String(a.negated ?? "").toLowerCase() === "true",
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
                outcome: decodeEntities(String(t[2] || "")).replace(/\s+/g, " ").trim(),
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
            sides: (Array.isArray(g?.sides) ? g.sides : [])
                .map(s => ({ ...s, negated: s?.negated === true }))
                .filter(s => s.actor),
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
        // Chance engine: same routing as the dice roller (Dice Rolls profile,
        // falling back to the pre-master chain) — NOT the combat passes.
        const profileId = resolveDiceProfile(st, s.dice_profile, s.premaster_profile, s.connection_profile);
        let systemContent = SYSTEM_PROMPT;
        // Deterministic clashes (opt-in): urge the resolver to write committed,
        // sheet-derived damage/cost/status numbers into the outcome lines.
        if (s.deterministic_clashes) {
            systemContent += `\n\n${DETERMINISTIC_GUIDELINES}`;
        }
        if (s.deep_context_engines) {
            const deep = await buildDeepContext(String(playerAction || ""));
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
        }
        // User's standing instructions for the pre-master engines — at the END
        // of the system message, after the deep context (same layout as the
        // dice roller/pre-pass). Injected whenever non-empty, regardless of
        // the deep context toggle. Full ST macro parsing via substituteParams.
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
