// mut.judges — a judge panel scores each performance (plans/combat-modules.md
// 4.5). The rolled tier sets each judge's band (a crit earns 8-10, a fumble
// 1-3); every judge rolls a mark in it with the round's seed, and the
// performance scores the panel's average. Replaces the oracle's own score
// effects for that performer, so the visible marks are the score.

import { contestKey } from "../../effects.js";
import { rollDie } from "../../rng.js";

const JUDGE_BANDS = { crit: [8, 10], hit: [6, 8], graze: [4, 6], miss: [3, 5], fumble: [1, 3] };
const JUDGE_FLIP = { crit: "fumble", hit: "miss", graze: "graze", miss: "hit", fumble: "crit" };

export function judgesCount(ctx) {
    const n = Math.trunc(Number(ctx?.opts?.["mut.judges"]?.count));
    return Number.isFinite(n) && n >= 1 ? Math.min(7, n) : 3;
}

export function judgeMarks(rng, key, count) {
    const [lo, hi] = JUDGE_BANDS[key] || JUDGE_BANDS.graze;
    return Array.from({ length: count }, () => lo + rollDie(rng, hi - lo + 1) - 1);
}

export function judgesBeforeApply(ctx, group, outcome, effects, notes) {
    if (!outcome) return;
    const count = judgesCount(ctx);
    (group?.sides || []).forEach((sd, i) => {
        const key = contestKey(sd.actor);
        const name = ctx.ops.sheet(sd.actor)?.sheet?.name || sd.actor;
        // The performer's own score effects give way to the panel's marks.
        for (let k = effects.length - 1; k >= 0; k--) {
            const e = effects[k];
            if (e.kind === "track" && contestKey(e.name) === "score" && contestKey(e.target) === key) effects.splice(k, 1);
        }
        const marks = judgeMarks(ctx.rng, i === 0 ? outcome.key : JUDGE_FLIP[outcome.key], count);
        const score = Math.round(marks.reduce((a, b) => a + b, 0) / marks.length);
        effects.push({ kind: "track", by: name, target: name, name: "score", delta: `+${score}` });
        notes?.push(`Judges ${name}: ${marks.join(" · ")}`);
    });
}

export function judgesOracleState(ctx) {
    return [`A panel of ${judgesCount(ctx)} judges scores each performance from the rolled tier: you need not write score effects, but every tier must still describe the performance.`];
}

export const mutJudges = {
    id: "mut.judges",
    label: "Judge panel",
    hint: "Each judge gives a visible mark from the rolled tier; the score is their average.",
    shapes: ["scores"],
    options: [{ key: "count", label: "Judges", type: "number", min: 1, max: 7, default: 3 }],
    oracleState: judgesOracleState,
    beforeApply: judgesBeforeApply,
};
