// mut.drafting — slipstream (plans/combat-modules.md 4.5): a runner sitting
// right behind another (within one segment) pays half the stamina its own
// actions cost. Overtaking the runner ahead stays a contested action — the
// oracle is told so; code only refunds the drain after it is applied.

import { contestKey, outStateOf, trackValue } from "../../effects.js";

// The runner `name` is drafting behind (ahead by 1 segment at most), or null.
export function draftingBehind(ctx, name) {
    const own = trackValue(ctx.contest, name, "progress");
    const key = contestKey(name);
    for (const p of ctx.participants || []) {
        if (contestKey(p.name) === key || outStateOf(ctx, p.name)) continue;
        const gap = trackValue(ctx.contest, p.name, "progress") - own;
        if (gap > 0 && gap <= 1) return p.name;
    }
    return null;
}

export function draftingAfterAction(ctx, group, res) {
    for (const r of res?.records || []) {
        if (r.kind !== "resource" || r.status !== "applied" || !(r.applied < 0)) continue;
        if (contestKey(r.by) !== contestKey(r.target)) continue;
        const found = ctx.ops.sheet(r.target);
        const st = found && ctx.stakes ? ctx.stakes(found.sheet) : null;
        if (!st || contestKey(st.name) !== contestKey(r.name)) continue;
        const ahead = draftingBehind(ctx, r.target);
        if (!ahead) continue;
        const refund = Math.floor(-r.applied / 2);
        if (!refund) continue;
        const max = ctx.ops.max(found.sheet, st);
        const next = Number.isFinite(max) ? Math.min(max, (Number(st.value) || 0) + refund) : (Number(st.value) || 0) + refund;
        const gained = next - (Number(st.value) || 0);
        st.value = next;
        r.after += gained;
        r.applied += gained;
        res.notes.push(`${r.target} rides in ${ahead}'s slipstream: saves ${gained} ${st.name}`);
    }
}

export function draftingOracleState() {
    return ["Drafting is on: a runner right behind another saves stamina, and passing the runner directly ahead is a contested action against them."];
}

export const mutDrafting = {
    id: "mut.drafting",
    label: "Drafting",
    hint: "Running right behind someone halves your stamina cost; overtaking them is contested.",
    shapes: ["race"],
    oracleState: draftingOracleState,
    afterAction: draftingAfterAction,
};
