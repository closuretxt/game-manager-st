// mut.momentum — a party meter (plans/combat-modules.md 4.5): +1 on a party
// hit, +2 on a crit, capped (default 5). With spend "auto" a party roll that
// misses or fumbles may reroll once for `cost` (default 3): it is asked as a
// question (engine.js `roll.asks`; the ruleset's "Ask me" shows it, auto-pick
// rerolls); "never" keeps it a meter. Kept in contest.meters (d.contest:
// snapshot rollbacks cover it); reported in the results message only.

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
        const spendIt = () => {
            meters.momentum = have - cost;
            roll.reroll = true;
            roll.notes.push(`Spent ${cost} momentum to reroll a ${outcome.name}`);
        };
        if (!Array.isArray(roll.asks)) return spendIt();
        roll.asks.push({
            id: "momentum",
            actor: first.actor,
            text: `${first.actor} got a ${outcome.name}${outcome.plain ? ` (${outcome.plain})` : ""}. Spend ${cost} of your ${have} momentum to roll again?`,
            choices: [
                { id: "reroll", label: `Roll again (-${cost} momentum)` },
                { id: "keep", label: "Keep the result" },
            ],
            auto: "reroll",
            apply: pick => { if (pick === "reroll") spendIt(); },
        });
        return;
    }
    const gain = outcome.key === "crit" ? 2 : outcome.key === "hit" ? 1 : 0;
    if (!gain) return;
    meters.momentum = Math.min(max, have + gain);
    if (meters.momentum > have) roll?.notes.push(`Momentum ${meters.momentum}/${max} (hits fill it, spend it to reroll a miss)`);
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
