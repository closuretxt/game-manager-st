// mut.momentum — a party meter (plans/combat-modules.md 4.5): +1 on a party
// hit, +2 on a crit, capped (default 5). Until the HUD lets the player choose
// (decision 3, "Auto-pick"), it spends itself: a party roll that misses or
// fumbles rerolls once for `cost` (default 3). Kept in contest.meters
// (d.contest: snapshot rollbacks cover it); reported in the results message
// only.

import { contestSide } from "../../effects.js";

function momentumOpts(ctx) {
    const o = ctx?.opts?.["mut.momentum"] || {};
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : d);
    return { max: num(o.max, 5), cost: Math.max(1, num(o.cost, 3)) };
}

export function momentumAfterRoll(ctx, group, outcome, roll) {
    const first = group?.sides?.[0];
    if (!first || !outcome || contestSide(ctx, first.actor) !== "party") return;
    const { max, cost } = momentumOpts(ctx);
    const meters = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    const have = Math.max(0, Math.trunc(Number(meters.momentum) || 0));
    if (roll && !roll.rerolled && (outcome.key === "miss" || outcome.key === "fumble") && have >= cost) {
        meters.momentum = have - cost;
        roll.reroll = true;
        roll.notes.push(`Momentum -${cost}: rerolled ${outcome.name}`);
        return;
    }
    const gain = outcome.key === "crit" ? 2 : outcome.key === "hit" ? 1 : 0;
    if (!gain) return;
    meters.momentum = Math.min(max, have + gain);
    if (meters.momentum > have) roll?.notes.push(`Momentum +${meters.momentum - have} (${meters.momentum}/${max})`);
}

export const mutMomentum = {
    id: "mut.momentum",
    label: "Momentum",
    afterRoll: momentumAfterRoll,
};
