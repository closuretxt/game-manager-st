// mut.momentum — a party meter (plans/combat-modules.md 4.5): +1 on a party
// hit, +2 on a crit, capped (default 5). With spend "auto" (decision 3's
// "Auto-pick"; "Ask me" needs a mid-roll prompt, not built yet) it spends
// itself: a party roll that misses or fumbles rerolls once for `cost`
// (default 3); "never" keeps it a meter. Kept in contest.meters
// (d.contest: snapshot rollbacks cover it); reported in the results message
// only.

import { contestSide } from "../../effects.js";

function momentumOpts(ctx) {
    const o = ctx?.opts?.["mut.momentum"] || {};
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : d);
    return { max: num(o.max, 5), cost: Math.max(1, num(o.cost, 3)), spend: o.spend === "never" ? "never" : "auto" };
}

export function momentumAfterRoll(ctx, group, outcome, roll) {
    const first = group?.sides?.[0];
    if (!first || !outcome || contestSide(ctx, first.actor) !== "party") return;
    const { max, cost, spend } = momentumOpts(ctx);
    const meters = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    const have = Math.max(0, Math.trunc(Number(meters.momentum) || 0));
    if (spend === "auto" && roll && !roll.rerolled && (outcome.key === "miss" || outcome.key === "fumble") && have >= cost) {
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

export function momentumHud(ctx) {
    const { max } = momentumOpts(ctx);
    const value = Math.max(0, Math.trunc(Number(ctx?.contest?.meters?.momentum) || 0));
    return { label: "Momentum", value, max, text: `${value}/${max}` };
}

export const mutMomentum = {
    id: "mut.momentum",
    label: "Momentum",
    hint: "Party hits fill a meter; a full enough meter rerolls a party miss.",
    options: [
        { key: "max", label: "Meter size", type: "number", min: 1, max: 20, default: 5 },
        { key: "cost", label: "Reroll cost", type: "number", min: 1, max: 20, default: 3 },
        { key: "spend", label: "Spending", type: "select", default: "auto", choices: [["auto", "Auto-reroll a party miss"], ["never", "Never (meter only)"]] },
    ],
    afterRoll: momentumAfterRoll,
    hud: momentumHud,
};
