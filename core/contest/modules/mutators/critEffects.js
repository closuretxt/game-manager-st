// mut.crit_effects — crit / fumble tables by action tag (plans/combat-modules.md
// 4.5). On top of the oracle's tier effects: a critical hit leaves the target
// with a one-turn status, a fumble leaves the actor with one. Read from the
// first side's roll (the side the tiers belong to). The status rides in the
// story's status attribute, so the narration shows it.

import { contestKey } from "../../effects.js";

export const CRIT_TABLES = {
    melee: {
        crit: { status: "Staggered", modifiers: "Defense -2" },
        fumble: { status: "Off-balance", modifiers: "Defense -2" },
    },
    ranged: {
        crit: { status: "Pinned", modifiers: "Speed -2" },
        fumble: { status: "Fumbled Shot", modifiers: "Aim -2" },
    },
    spell: {
        crit: { status: "Overwhelmed", modifiers: "Will -2" },
        fumble: { status: "Backlash", modifiers: "Focus -2" },
    },
};

// Ranged first: "fire an arrow" is a shot, "Fireball" is a spell.
const CRIT_TAGS = [
    ["ranged", /\b(bows?|arrows?|shoot\w*|shot|throw\w*|sling|crossbow|gun|pistol|rifle|darts?|javelins?|volley)\b/i],
    ["spell", /\b(spells?|cast\w*|magic\w*|hex|curse|ward\w*|bolt|fire\w*|frost|ice|lightning|arcane|holy|smite|blast|incant\w*)\b/i],
];

export function critTag(action) {
    const text = String(action ?? "");
    for (const [tag, re] of CRIT_TAGS) if (re.test(text)) return tag;
    return "melee";
}

// The crit's victim: whoever the actor's own effects hit, else the opposing side.
function critTarget(group, effects) {
    const actor = group.sides[0].actor;
    const key = contestKey(actor);
    const hit = (effects || []).find(e => contestKey(e.by || actor) === key && contestKey(e.target) !== key && (e.kind === "resource" || e.kind === "status"));
    return hit?.target || group.sides[1]?.actor || "";
}

export function critBeforeApply(ctx, group, outcome, effects) {
    const key = outcome?.key;
    if (key !== "crit" && key !== "fumble") return;
    const first = group?.sides?.[0];
    if (!first) return;
    const tables = ctx?.opts?.["mut.crit_effects"]?.tables || CRIT_TABLES;
    const tag = critTag(first.action);
    const entry = tables[tag]?.[key];
    if (!entry?.status) return;
    const target = key === "crit" ? critTarget(group, effects) : first.actor;
    if (!target) return;
    effects.push({ kind: "status", by: first.actor, target, name: entry.status, modifiers: entry.modifiers || "", turns: 1 });
}

export const mutCritEffects = {
    id: "mut.crit_effects",
    label: "Crit effects",
    hint: "Critical hits stagger the target and fumbles the attacker, for one turn.",
    beforeApply: critBeforeApply,
};
