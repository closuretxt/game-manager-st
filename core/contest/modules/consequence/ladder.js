// cons.ladder — harm ladders instead of numbers (plans/combat-modules.md
// 4.4), for chats without numeric health. The oracle still writes its
// stakes damage as resource effects; this module turns each hit into steps
// down a ladder of statuses: Scratched -> Hurt -> Wounded -> Broken -> Out
// (Composure, Morale, Nerve...: Rattled -> Shaken -> Broken -> Out). One
// step per hit, two for a heavy one (a third of the sheet's max, or 15+
// without one), one more on the attacker's critical; healing climbs one
// step back. The rung lives in contest.tracks[actor].harm; past the last
// rung the actor is out (party knocked out, enemies down). Other effects
// land as written.

import { contestKey } from "../../effects.js";
import { rollExpr } from "../../rng.js";
import { oracleEffects } from "./oracle.js";

const LADDER_PHYSICAL = ["Scratched", "Hurt", "Wounded", "Broken"];
const LADDER_MENTAL = ["Rattled", "Shaken", "Broken"];
const LADDER_MENTAL_RE = /composure|morale|nerve|will|resolve|sanity|poise|spirit|stress|face/i;

export function ladderSteps(ctx) {
    const custom = String(ctx?.opts?.["cons.ladder"]?.steps || "").split(/[,;>]+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
    if (custom.length) return custom;
    return LADDER_MENTAL_RE.test(String(ctx?.opts?.stakes || "")) ? LADDER_MENTAL : LADDER_PHYSICAL;
}

function ladderIsStakes(ctx, name) {
    const stakes = String(ctx?.opts?.stakes || "Health");
    return !!ctx.ops.match([{ name: stakes }], name) || contestKey(name) === contestKey(stakes);
}

// Steps one stakes effect moves its target (negative = healing).
export function ladderStepCount(ctx, eff, sheet, crit) {
    const rolled = rollExpr(eff.delta ?? eff.value, ctx.rng, ctx.ops.evalMath);
    const value = rolled ? rolled.value : -1;
    if (value >= 0 && eff.delta !== undefined) return -1;
    const entry = ctx.ops.match(sheet?.resources || [], eff.name);
    const max = entry ? ctx.ops.max(sheet, entry) : NaN;
    const heavy = Number.isFinite(max) && max > 0 ? Math.abs(value) >= max / 3 : Math.abs(value) >= 15;
    return 1 + (heavy ? 1 : 0) + (crit ? 1 : 0);
}

export function ladderEffects(ctx, group, outcome) {
    const base = oracleEffects(ctx, group, outcome);
    const steps = ladderSteps(ctx);
    const firstKey = contestKey(group?.sides?.[0]?.actor);
    const rungs = {};
    const out = [];
    for (const e of base) {
        if (e.kind !== "resource" || !ladderIsStakes(ctx, e.name)) {
            out.push(e);
            continue;
        }
        const found = ctx.ops.sheet(e.target);
        if (!found || found.sheet.pseudo) {
            out.push(e);
            continue;
        }
        const key = contestKey(found.sheet.name);
        const by = e.by || group?.sides?.[0]?.actor || "";
        const crit = outcome?.key === "crit" && contestKey(by) === firstKey && key !== firstKey;
        const cur = key in rungs ? rungs[key] : Math.max(0, Math.trunc(Number(ctx.contest?.tracks?.[key]?.harm) || 0));
        const next = Math.max(0, Math.min(steps.length + 1, cur + ladderStepCount(ctx, e, found.sheet, crit)));
        if (next === cur) continue;
        rungs[key] = next;
        const target = found.sheet.name;
        if (cur >= 1 && cur <= steps.length) out.push({ kind: "status", by, target, name: steps[cur - 1], remove: true });
        if (next >= 1 && next <= steps.length) out.push({ kind: "status", by, target, name: steps[next - 1] });
        out.push({ kind: "track", by, target, name: "harm", value: String(next) });
        if (next > steps.length) out.push({ kind: "state", by, target, name: found.side === "party" ? "ko" : "down" });
    }
    return out;
}

// The standing's condition word: the actor's rung, lowercased.
export function ladderCondition(ctx, sheet) {
    const harm = Math.max(0, Math.trunc(Number(ctx?.contest?.tracks?.[contestKey(sheet?.name)]?.harm) || 0));
    const steps = ladderSteps(ctx);
    return harm >= 1 && harm <= steps.length ? steps[harm - 1].toLowerCase() : "unhurt";
}

export const consLadder = {
    id: "cons.ladder",
    label: "Harm ladder",
    hint: "Hits become steps down a ladder of statuses (Scratched → Hurt → Wounded → Broken → Out), no numbers.",
    shapes: ["clash"],
    options: [{ key: "steps", label: "Ladder steps", type: "text", default: "", hint: "Comma list, worst last (Out follows it). Empty = Scratched, Hurt, Wounded, Broken (Rattled, Shaken, Broken for Composure-like stakes)." }],
    effects: ladderEffects,
    condition: ladderCondition,
};
