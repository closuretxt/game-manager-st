// ORACLE — the universal resolution call (plans/combat-modules.md 3.5, 3.8),
// successor of core/clashResolver.js. It sees both sides' actions and every
// actor's full sheet, pairs the actions into groups and, per group, writes
// the tier chances (same harsh, sheet-earned rules as before) and for EACH
// tier a short outcome line plus the structured <effect> list that tier
// commits. Code then rolls the tiers in order and applies the effects
// (core/contest/engine.js) — the oracle adjudicates, code keeps the books.

// Two folders below the extension root: one more ../ than core/*.
import { getContext } from "../../../../../extensions.js";
import { substituteParams } from "../../../../../../script.js";
import { gmSettings } from "../features.js";
import { logDebug } from "../debug.js";
import { stateManager, playerLabel, charLabel } from "../stateManager.js";
import { escAttr } from "../toolParser.js";
import { sheetXml as renderSheet } from "../sheetXml.js";
import { valueGuidelines } from "../valueGuidelines.js";
import { resolveDiceProfile, sendRequestViaProfile } from "../../util/connectionService.js";
import { buildDeepContext } from "../../util/loreContext.js";
import { scenarioBriefBlock } from "../scenarioBrief.js";
import { recentMessages, sceneContextBlock } from "../../util/chatStore.js";
import { parseOracleGroups, sanitizeOracleGroups } from "./parse.js";
import { diceOracle } from "./modules/dice/oracle.js";

const MAX_CONTEXT_MESSAGES = 8;

// The dice module decides what the oracle is asked for (chances, or mod + DC
// ...) and supplies its rules, tier rule and example group (3.5).
function systemPrompt(stakes, dice) {
    const ask = dice?.oracle || diceOracle.oracle;
    return [
        "You are the ORACLE of a tabletop-style roleplay game system: you adjudicate one round of a contest. You turn both sides' declared actions into opposed groups, judge each group's odds from the sheets, and write exactly what each tier DOES as structured effects. The game engine then rolls each group in turn order and applies your effects to the sheets — your effects ARE the results, so they must be exact. REALISM FIRST: odds are EARNED from the sheets, never generous by default.",
        "",
        "WHAT YOU RECEIVE:",
        "- <scene_context>: the last few messages — PAST context only, already tracked (specific note inside the block). The round you adjudicate is defined ENTIRELY by <party_actions>/<enemy_actions>.",
        "- <party_actions> / <enemy_actions>: what each side does this round, with initiative speeds.",
        `- <sheets>: resources (current values!), attributes, skills (damage terms, costs, cooldown markers), passives, statuses and items of EVERY actor in the round. The stakes resource of this contest is "${stakes}" (or the sheet's equivalent): an actor whose ${stakes} reaches its minimum is out of the fight.`,
        "",
        ...ask.rules,
        "",
        "OUTPUT FORMAT — ONLY XML, no markdown fences, no prose:",
        "<clashes>",
        ...ask.example(stakes),
        "</clashes>",
        "",
        "GROUPING RULES:",
        "- Pair each party action with the enemy action that opposes or targets it; one enemy action opposes at most one party action. An action with no opponent becomes a SINGLE-SIDED group (one <side>).",
        "- Independent actions stay separate: never force unrelated actions into one group. Every declared action appears in exactly one group.",
        ask.tierRule,
        "",
        "OUTCOME LINES:",
        "- One short third-person sentence per tier naming every actor (never \"you\"/\"I\"), stating what happens IN THIS GROUP ONLY — never what other groups do, never a later action or reaction. No hedging (\"may\", \"tries to\"): the tier IS the result.",
        "- Plausible against the sheets: weigh the attacker's damage term against the target's CURRENT stakes value. A full-health target does not die to a normal hit; a near-death target can drop to a solid one.",
        "",
        "EFFECTS — every tier lists, as <effect/> tags inside the tier, EVERYTHING that tier changes on the sheets, for both sides of the group:",
        `- resource: <effect by="Actor" target="Name" resource="Exact resource name" delta="-(expr)"/>. Damage = the attacker's sheet damage term plus its stated stat scaling as ONE arithmetic/dice expression (the engine rolls dice with true RNG — never pre-roll). Generic moves with no sheet term follow NO SHEET BASIS (see the numeric guidelines). Healing is a positive delta. value="N" sets an absolute value.`,
        "- costs: an attempted skill's cost (mana, stamina, ammo...) is paid in EVERY tier where the skill is attempted, unless its sheet says otherwise — as a resource effect on the actor itself.",
        '- skill: <effect by="Actor" target="Actor" skill="Exact skill name"/> in every tier where a tracked skill is used (the engine starts its cooldown).',
        '- status: <effect by="Actor" target="Name" status="Dazed" modifiers="Aim -2" turns="1"/>; remove="true" clears one.',
        '- item: <effect by="Actor" target="Actor" item="Exact item name" qty="-1"/> for consumed ammo/potions (positive qty = gained).',
        '- state: <effect by="Actor" target="Name" state="dead|ko|fled|yielded"/> only when the tier itself decides it (a lethal crit per the lethality rules, a successful escape, a surrender). When a stakes resource simply reaches its minimum the engine knocks out party members and takes enemies down on its own — no state tag needed.',
        "- Names EXACTLY as on the sheets. Effects only for this round's actions: no looting, no healing after the fight, no mood changes. A tier where nothing changes (a clean dodge, a passive that negates the hit) simply carries no effect for it.",
        "- Sheet specifics always apply: passives that negate, reduce or amplify damage, conditional bonuses, resistances, armor — reflect them in the deltas you write.",
        valueGuidelines(),
    ].join("\n");
}

function collectContext(partyActions, enemyActions) {
    const history = recentMessages(MAX_CONTEXT_MESSAGES)
        .map(m => `${m.is_user ? playerLabel() : charLabel(m.name)}: ${String(m.mes ?? "")}`);
    const d = stateManager.getData();
    const actionXml = a => `<action actor="${escAttr(a.actor)}" speed="${Math.max(0, Math.trunc(Number(a.speed) || 0))}">${escAttr(a.action)}</action>`;
    // Only actors in the round pay tokens for a full sheet.
    const names = new Set([...partyActions, ...enemyActions].map(a => String(a.actor).toLowerCase()));
    const sheets = [
        ...(d.characters || []).filter(c => names.has(String(c.name).toLowerCase())).map(c => renderSheet(c, { tag: "actor", attrs: { side: "party" } })),
        ...(d.enemies || []).filter(e => names.has(String(e.name).toLowerCase())).map(e => renderSheet(e, { tag: "actor", attrs: { side: "enemy" } })),
    ];
    return [
        "<oracle_context>",
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
        "</oracle_context>",
        "Reminder: deliver the groups inside <clashes>...</clashes>, every tier with its <effect/> tags — that block is what the system reads.",
    ].join("\n");
}

// Runs the oracle. `onStream(groups)` fires with partial groups for the
// bubble. Returns sanitized groups, or null when the call failed — the caller
// then degrades to effect-less generic tiers.
export async function adjudicateRound({ playerAction = "", partyActions = [], enemyActions = [], stakes = "Health", dice = null, onStream = null } = {}) {
    const s = gmSettings();
    if (!partyActions.length && !enemyActions.length) return null;
    try {
        const st = getContext();
        // Same routing as the dice roller (Dice Rolls profile -> pre-master chain).
        const profileId = resolveDiceProfile(st, s.dice_profile, s.premaster_profile, s.connection_profile);
        let systemContent = systemPrompt(stakes, dice);
        const brief = scenarioBriefBlock();
        if (brief) systemContent += `\n\n${brief}`;
        if (s.deep_context_engines) {
            const deep = await buildDeepContext(String(playerAction || ""));
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
        }
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
            { role: "user", content: collectContext(partyActions, enemyActions) },
        ];
        let streamed = "";
        const reply = await sendRequestViaProfile(profileId, messages, {
            stream: !!onStream,
            onChunk: (partial) => {
                streamed = partial;
                if (onStream) onStream(parseOracleGroups(partial));
            },
        });
        const groups = sanitizeOracleGroups(parseOracleGroups(reply || streamed));
        if (!groups.length) {
            logDebug("oracle: no usable groups in reply — degrading to generic tiers");
            return null;
        }
        logDebug(`oracle: ${groups.length} group(s), ${groups.reduce((n, g) => n + g.tiers.reduce((k, t) => k + t.effects.length, 0), 0)} effect(s)`);
        return groups;
    } catch (e) {
        console.error("[Game Manager] oracle pass failed:", e);
        return null;
    }
}
