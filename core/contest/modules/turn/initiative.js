// turn.initiative — initiative once, fixed order (plans/combat-modules.md
// 4.2). Everyone rolls d20 + speed the first time they act in the contest and
// keeps that number until it ends (newcomers roll on arrival), so the order
// holds round after round. Stored in contest.initiative (d.contest: snapshot
// rollbacks cover it). A group acts at its best side's initiative; ties keep
// the oracle's order.

import { rollDie } from "../../rng.js";
import { contestKey } from "../../effects.js";

export function initiativeOf(ctx, side) {
    const c = ctx.contest;
    if (!c.initiative || typeof c.initiative !== "object") c.initiative = {};
    const key = contestKey(side?.actor);
    if (!key) return -Infinity;
    if (!Object.prototype.hasOwnProperty.call(c.initiative, key)) {
        const face = rollDie(ctx.rng, 20);
        const bonus = Math.max(0, Math.trunc(Number(side.speed) || 0));
        c.initiative[key] = face + bonus;
        (ctx.initRolls = ctx.initRolls || []).push({ name: side.actor, face, bonus, total: face + bonus });
    }
    return c.initiative[key];
}

export function initiativeQueue(ctx, groups) {
    const order = (groups || [])
        .map((g, i) => ({ i, init: Math.max(-Infinity, ...(g?.sides || []).map(sd => initiativeOf(ctx, sd))) }))
        .sort((a, b) => (b.init - a.init) || (a.i - b.i))
        .map(x => x.i);
    // New rolls this round go to the results message, never the story.
    if (ctx.initRolls?.length) {
        const rolls = [...ctx.initRolls].sort((a, b) => b.total - a.total)
            .map(r => `${r.name} ${r.face}${r.bonus ? ` +${r.bonus}` : ""} = ${r.total}`);
        (ctx.notes = ctx.notes || []).push(`Initiative: ${rolls.join(" · ")}`);
        ctx.initRolls = [];
    }
    return order;
}

export const turnInitiative = {
    id: "turn.initiative",
    label: "Initiative (fixed order)",
    hint: "Everyone rolls d20 + speed once when the fight starts and keeps that order.",
    queue: initiativeQueue,
};
