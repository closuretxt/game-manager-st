// turn.ap — action points (plans/combat-modules.md 4.2): every actor has AP
// per round (default 3). Their action spends AP by weight (quick 1, normal
// 2, heavy 3); what is left is held as a reaction: when an opponent's group
// targets them, each held AP is -1 on that roll, once per round. Order as
// simultaneous. Only dice rules that read a roll bonus feel the reaction
// (not the oracle's odds).

import { contestKey, contestSide } from "../../effects.js";
import { simultaneousQueue } from "./simultaneous.js";
import { actionWeight } from "./timeline.js";

const AP_COST = { light: 1, normal: 2, heavy: 3 };

function apPerRound(ctx) {
    const n = Number(ctx?.opts?.["turn.ap"]?.ap);
    return Number.isFinite(n) && n >= 1 ? Math.min(6, Math.trunc(n)) : 3;
}

export function apQueue(ctx, groups) {
    const order = simultaneousQueue(ctx, groups);
    const per = apPerRound(ctx);
    const held = {};
    const notes = [];
    for (const i of order) {
        for (const sd of groups[i]?.sides || []) {
            const key = contestKey(sd.actor);
            if (!key || key in held) continue;
            const cost = Math.min(per, AP_COST[actionWeight(sd.action)]);
            held[key] = per - cost;
            notes.push(`${sd.actor} ${cost}/${per}${held[key] ? ` (${held[key]} held)` : ""}`);
        }
    }
    ctx.apHeld = held;
    if (notes.length) (ctx.notes = ctx.notes || []).push(`AP: ${notes.join(" · ")}`);
    return order;
}

// A defender with AP held reacts to the first opposing roll aimed at them.
export function apBeforeRoll(ctx, group, roll) {
    const sides = group?.sides || [];
    if (sides.length < 2 || !roll || !ctx.apHeld) return;
    const attackerSide = contestSide(ctx, sides[0].actor);
    for (const sd of sides.slice(1)) {
        const key = contestKey(sd.actor);
        const ap = ctx.apHeld[key] || 0;
        if (!ap || contestSide(ctx, sd.actor) === attackerSide) continue;
        roll.bonus -= ap;
        roll.notes.push(`${sd.actor} reacts with ${ap} AP (-${ap})`);
        ctx.apHeld[key] = 0;
    }
}

export const turnAp = {
    id: "turn.ap",
    label: "Action points",
    hint: "Actions spend AP by weight; unspent AP become a reaction against the next attack.",
    options: [{ key: "ap", label: "AP per round", type: "number", min: 1, max: 6, default: 3 }],
    queue: apQueue,
    beforeRoll: apBeforeRoll,
};
