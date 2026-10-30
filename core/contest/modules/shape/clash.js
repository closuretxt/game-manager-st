// shape.clash — fights, duels, brawls, debates, interrogations
// (plans/combat-modules.md 4.1). Sides: party vs enemies. Stakes: one
// resource per sheet (Health by default, any name per chat: Composure,
// Morale, Grip...). Ends when one side has nobody left standing.
//
// ctx.participants: [{ name, side }] — everyone in the contest this round.

import { contestKey, outStateOf } from "../../effects.js";

const CLASH_STAKES_FALLBACK = "Health";

// The stakes resource on a sheet: the configured name (matchName aliases
// HP/Health/Vida), else nothing — a sheet without it never falls by default.
export function clashStakes(ctx, sheet) {
    const name = String(ctx?.opts?.stakes || CLASH_STAKES_FALLBACK);
    return ctx.ops.match(sheet?.resources || [], name) || null;
}

const CLASH_OUT_WORDS = { dead: "dead", ko: "knocked out", down: "down", fled: "fled", yielded: "yielded", out: "out of the fight" };

// Condition in words for the story LLM — never a number.
export function clashCondition(ctx, sheet) {
    const mode = outStateOf(ctx, sheet.name);
    if (mode) return CLASH_OUT_WORDS[mode] || mode;
    const stakes = clashStakes(ctx, sheet);
    if (!stakes) return "in the fight";
    const max = ctx.ops.max(sheet, stakes);
    const min = Number.isFinite(+stakes.min) ? +stakes.min : 0;
    if (!Number.isFinite(max) || max <= min) return "in the fight";
    const ratio = ((Number(stakes.value) || 0) - min) / (max - min);
    if (ratio >= 0.95) return "unhurt";
    if (ratio >= 0.7) return "lightly hurt";
    if (ratio >= 0.4) return "hurt";
    if (ratio >= 0.15) return "badly hurt";
    return "barely standing";
}

export function clashStanding(ctx) {
    const seen = new Set();
    const parts = [];
    for (const p of ctx.participants || []) {
        const key = contestKey(p.name);
        if (seen.has(key)) continue;
        seen.add(key);
        const found = ctx.ops.sheet(p.name);
        if (!found) continue;
        parts.push(`${found.sheet.name}: ${clashCondition(ctx, found.sheet)}`);
    }
    return parts.join(" · ");
}

// Over when a side has nobody left standing (a side with no participants at
// all never ends the contest by itself).
export function clashIsOver(ctx) {
    const standing = { party: 0, enemy: 0 };
    const present = { party: 0, enemy: 0 };
    for (const p of ctx.participants || []) {
        if (!(p.side in present)) continue;
        present[p.side]++;
        if (!outStateOf(ctx, p.name)) standing[p.side]++;
    }
    return (present.enemy > 0 && standing.enemy === 0) || (present.party > 0 && standing.party === 0);
}

const CLASH_RESULT_WORDS = { crit: "lands with full force", hit: "lands", graze: "barely lands", miss: "misses", fumble: "goes badly wrong" };

// Templated lines replace the oracle's prose whenever the round's order
// invalidated part of a group, so prose never contradicts an earlier group.
export function clashInterruptedLine(actor, action, mode) {
    const why = CLASH_OUT_WORDS[mode] || "out of the fight";
    return `${actor} is ${why} before ${action ? `the ${action}` : "acting"} can happen.`;
}

export function clashResultLine(actor, action, key, versus) {
    const verb = CLASH_RESULT_WORDS[key] || "happens";
    return `${actor}'s ${action || "action"}${versus ? ` against ${versus}` : ""} ${verb}.`;
}

export const shapeClash = {
    id: "shape.clash",
    label: "Clash",
    storyTag: "combat_round",
    lineTag: "clash",
    rule: "These results are final: narrate them, and add no hits, injuries, deaths or escapes beyond them.",
    stakes: clashStakes,
    standing: clashStanding,
    isOver: clashIsOver,
    interruptedLine: clashInterruptedLine,
    resultLine: clashResultLine,
};
