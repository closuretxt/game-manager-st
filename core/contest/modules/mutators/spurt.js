// mut.spurt — the final-stretch burst (plans/combat-modules.md 4.5). A
// runner whose action is a spurt (sprint, kick, all-out...) in the final
// stretch spends ALL remaining stamina for extra progress, scaled by how much
// was left and by the rolled tier, and ends Exhausted. Once per runner per
// race. Outside the final stretch a spurt is just an action like any other.

import { contestKey } from "../../effects.js";
import { racePhase } from "../shape/race.js";

const SPURT_RE = /\b(spurt|sprint|kick|burst|all[- ]?out|final push|everything (?:i|she|he|they) (?:have|has|got))\b/i;
const SPURT_FLIP = { crit: "fumble", hit: "miss", graze: "graze", miss: "hit", fumble: "crit" };

// Extra segments: up to 3 for a full tank, +1 on a crit, nothing on a fumble.
export function spurtBonus(ratio, key) {
    const base = Math.max(1, Math.round(3 * Math.max(0, Math.min(1, ratio))));
    if (key === "crit") return base + 1;
    if (key === "hit") return base;
    if (key === "graze") return Math.max(1, base - 1);
    return 0;
}

export function spurtBeforeApply(ctx, group, outcome, effects, notes) {
    if (!outcome || racePhase(ctx) !== "final stretch") return;
    const meters = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    const spent = meters.spurts = meters.spurts && typeof meters.spurts === "object" ? meters.spurts : {};
    (group?.sides || []).forEach((sd, i) => {
        if (!SPURT_RE.test(String(sd.action || ""))) return;
        const key = contestKey(sd.actor);
        if (spent[key]) return;
        const found = ctx.ops.sheet(sd.actor);
        const st = found && ctx.stakes ? ctx.stakes(found.sheet) : null;
        let ratio = 0.5;
        if (st) {
            const max = ctx.ops.max(found.sheet, st);
            const min = Number.isFinite(+st.min) ? +st.min : 0;
            const value = Number(st.value) || 0;
            if (value <= min) {
                notes?.push(`${sd.actor} has nothing left to spurt`);
                return;
            }
            ratio = Number.isFinite(max) && max > min ? (value - min) / (max - min) : 0.5;
        }
        spent[key] = true;
        const tier = i === 0 ? outcome.key : SPURT_FLIP[outcome.key];
        const bonus = spurtBonus(ratio, tier);
        const name = found?.sheet?.name || sd.actor;
        if (bonus) effects.push({ kind: "track", by: name, target: name, name: "progress", delta: `+${bonus}` });
        if (st) effects.push({ kind: "resource", by: name, target: name, name: st.name, value: String(Number.isFinite(+st.min) ? +st.min : 0) });
        if (found && !found.sheet.pseudo) effects.push({ kind: "status", by: name, target: name, name: "Exhausted", modifiers: "Pace -2", effect: "until the race ends" });
        notes?.push(bonus ? `${name} sprints: +${bonus} progress` : `${name} sprints but gains nothing`);
    });
}

export const mutSpurt = {
    id: "mut.spurt",
    label: "Final spurt",
    hint: "In the final stretch a spurt burns all remaining stamina for extra progress; the runner ends Exhausted.",
    shapes: ["race"],
    beforeApply: spurtBeforeApply,
};
