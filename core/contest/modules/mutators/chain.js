// mut.chain — combo chains (plans/combat-modules.md 4.5): consecutive hits
// by the same actor on the same target stack +1 each on the next roll
// against it (max +3 by default); a miss or a new target resets the chain.
// Kept in contest.meters.chain, so chains run across rounds. Only dice rules
// that read a roll bonus feel it.

import { contestKey } from "../../effects.js";

function chainMax(ctx) {
    const n = Number(ctx?.opts?.["mut.chain"]?.max);
    return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.trunc(n)) : 3;
}

function chainMeters(ctx) {
    const m = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    if (!m.chain || typeof m.chain !== "object") m.chain = {};
    return m.chain;
}

export function chainBeforeRoll(ctx, group, roll) {
    const [a, b] = group?.sides || [];
    if (!a || !b || !roll) return;
    const c = chainMeters(ctx)[contestKey(a.actor)];
    if (!c || c.target !== contestKey(b.actor) || !(c.n > 0)) return;
    const bonus = Math.min(chainMax(ctx), c.n);
    roll.bonus += bonus;
    roll.notes.push(`+${bonus} combo: kept hitting the same target`);
}

export function chainAfterAction(ctx, group, res) {
    const a = group?.sides?.[0];
    if (!a || !res?.outcome) return;
    const chains = chainMeters(ctx);
    const ak = contestKey(a.actor);
    const hitRec = (res.records || []).find(r => r.status === "applied" && contestKey(r.by) === ak && contestKey(r.target) !== ak && r.kind === "resource");
    const target = contestKey(group.sides[1]?.actor || hitRec?.target || "");
    const landed = res.outcome.key === "hit" || res.outcome.key === "crit";
    if (!landed || !target) {
        delete chains[ak];
        return;
    }
    const prev = chains[ak];
    chains[ak] = { target, n: prev && prev.target === target ? prev.n + 1 : 1 };
}

export const mutChain = {
    id: "mut.chain",
    label: "Combo chains",
    hint: "Consecutive hits on the same target stack +1 each (rules that read a roll bonus).",
    shapes: ["clash"],
    options: [{ key: "max", label: "Max chain bonus", type: "number", min: 1, max: 10, default: 3 }],
    beforeRoll: chainBeforeRoll,
    afterAction: chainAfterAction,
};
