// mut.deaths_door — roll to stay up (plans/combat-modules.md 4.5): the first
// time a party member is knocked out in a contest, they roll d20 against the
// target (default 10). Success keeps them standing at 1 above the stakes
// minimum, marked "Death's Door"; a death the tier itself decided (a lethal
// critical) is never saved. Once per actor per contest
// (contest.meters.deathsDoor).

import { contestKey } from "../../effects.js";
import { rollDie } from "../../rng.js";

function deathsDoorTarget(ctx) {
    const n = Number(ctx?.opts?.["mut.deaths_door"]?.target);
    return Number.isFinite(n) && n >= 2 ? Math.min(20, Math.trunc(n)) : 10;
}

export function deathsDoorAfterAction(ctx, group, res) {
    const m = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    if (!m.deathsDoor || typeof m.deathsDoor !== "object") m.deathsDoor = {};
    const target = deathsDoorTarget(ctx);
    for (const f of [...(res.fell || [])]) {
        const key = contestKey(f.name);
        if (f.side !== "party" || f.mode !== "ko" || m.deathsDoor[key]) continue;
        m.deathsDoor[key] = true;
        const face = rollDie(ctx.rng, 20);
        if (face < target) {
            res.notes.push(`${f.name} tries to hang on (rolled ${face}, needed ${target}) and falls`);
            continue;
        }
        delete ctx.out[key];
        res.fell.splice(res.fell.indexOf(f), 1);
        // The tier's own "ko" state record no longer stands.
        res.records = (res.records || []).filter(r => !(r.kind === "state" && r.status === "applied" && contestKey(r.target) === key));
        const found = ctx.ops.sheet(f.name);
        const entry = found && ctx.stakes ? ctx.stakes(found.sheet) : null;
        if (entry) {
            const min = Number.isFinite(+entry.min) ? +entry.min : 0;
            const before = Number(entry.value) || 0;
            entry.value = Math.max(before, min + 1);
            if (entry.value !== before) res.records.push({ kind: "resource", by: f.name, target: found.sheet.name, side: "party", name: entry.name, status: "applied", before, after: entry.value, applied: entry.value - before, min });
        }
        if (found && ctx.ops.setStatus(found.sheet, { name: "Death's Door", modifiers: "", effect: "Barely standing" })) {
            res.records.push({ kind: "status", by: f.name, target: found.sheet.name, side: "party", name: "Death's Door", status: "applied" });
        }
        res.notes.push(`${f.name} hangs on at death's door (rolled ${face}, needed ${target})`);
    }
}

export const mutDeathsDoor = {
    id: "mut.deaths_door",
    label: "Death's door",
    hint: "The first time a party member would be knocked out, a d20 roll can keep them standing.",
    shapes: ["clash"],
    options: [{ key: "target", label: "Roll needed (d20)", type: "number", min: 2, max: 20, default: 10 }],
    afterAction: deathsDoorAfterAction,
};
