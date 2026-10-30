// runRound: order -> validate -> roll -> apply, ONE GROUP AT A TIME
// (plans/combat-modules.md 2, 3.3). The round is causal by construction: an
// actor taken out by an earlier group never lands its later action
// (Interrupted), and effects on someone who already left are Wasted. Pure: the
// modules and the state adapter come in through ctx.
//
// ctx = { rng, ops, shape, turn, dice, consequence, mutators, contest,
//         participants, opts, stakes(sheet), out: {} }
// groups = the oracle's groups: [{ title, sides: [{ actor, action, speed, who }],
//          tiers: [{ name, chance, outcome, effects: [...] }] }]

import { applyEffect, applyLethality, contestKey, outStateOf } from "./effects.js";

const CONTEST_KEY_LABELS = { crit: "Critical Success", hit: "Success", graze: "Partial Success", miss: "Failure", fumble: "Critical Failure" };
const CONTEST_KEY_FLIP = { crit: "fumble", hit: "miss", graze: "graze", miss: "hit", fumble: "crit" };

function callMutators(ctx, hook, ...args) {
    for (const m of ctx.mutators || []) {
        if (typeof m?.[hook] !== "function") continue;
        try {
            m[hook](ctx, ...args);
        } catch (e) {
            if (ctx.log) ctx.log(`mutator ${m.id} ${hook} failed: ${e?.message || e}`);
        }
    }
}

// Lines the story LLM gets for one resolved group, in the shape's words.
// Prose comes from the oracle only when nothing in the group was invalidated;
// otherwise the shape's templates speak, so a line can never describe an
// action that did not happen.
function groupLines(ctx, g, res) {
    const shape = ctx.shape;
    const fellAttr = res.fell.length ? res.fell.map(f => `${f.name}: ${f.word}`).join(", ") : "";
    const statusAttr = res.records
        .filter(r => r.kind === "status" && r.status === "applied" && !r.remove)
        .map(r => `${r.target}: ${r.name}`).join(", ");
    const lines = [];
    const first = g.sides[0];
    if (res.status === "interrupted" || res.invalid.length) {
        for (const inv of res.invalid) {
            lines.push({ actor: inv.actor, action: inv.action, versus: "", result: "Interrupted", text: shape.interruptedLine(inv.actor, inv.action, inv.mode), fell: "", status: "" });
        }
        if (res.status !== "interrupted") {
            g.sides.forEach((sd, i) => {
                if (res.invalid.some(x => contestKey(x.actor) === contestKey(sd.actor))) return;
                // Tiers read from the first side's point of view: an
                // opposing survivor wins when the first side fails.
                const key = i === 0 ? res.outcome.key : CONTEST_KEY_FLIP[res.outcome.key];
                const versus = g.sides.find(o => o !== sd)?.actor || "";
                lines.push({ actor: sd.actor, action: sd.action, versus, result: CONTEST_KEY_LABELS[key] || res.outcome.name, text: shape.resultLine(sd.actor, sd.action, key, versus), fell: fellAttr, status: statusAttr });
            });
        }
        return lines;
    }
    const tier = g.tiers[res.outcome.tierIndex] || {};
    lines.push({
        actor: first.actor,
        action: first.action,
        versus: g.sides[1]?.actor || "",
        result: res.outcome.name,
        text: tier.outcome || shape.resultLine(first.actor, first.action, res.outcome.key, g.sides[1]?.actor || ""),
        fell: fellAttr,
        status: statusAttr,
    });
    return lines;
}

const CONTEST_FELL_WORDS = { dead: "dead", ko: "knocked out", down: "down", fled: "fled", yielded: "yielded", out: "out" };

function resolveGroup(ctx, g, index) {
    const sides = Array.isArray(g.sides) ? g.sides : [];
    const invalid = [];
    for (const sd of sides) {
        const mode = outStateOf(ctx, sd.actor);
        if (mode) invalid.push({ actor: sd.actor, action: sd.action, mode });
    }
    const res = { index, title: g.title, sides, status: "resolved", outcome: null, invalid, records: [], dropped: [], fell: [], lines: [] };
    if (!sides.length || invalid.length === sides.length) {
        res.status = "interrupted";
        res.lines = groupLines(ctx, g, res);
        return res;
    }
    callMutators(ctx, "beforeRoll", g);
    res.outcome = ctx.dice.resolve(ctx, g);
    callMutators(ctx, "afterRoll", g, res.outcome);
    let effects = ctx.consequence.effects(ctx, g, res.outcome) || [];
    for (const e of effects) if (!e.by) e.by = sides[0].actor;
    callMutators(ctx, "beforeApply", g, res.outcome, effects);
    // Only the invalidated side's own effects are dropped; the survivor's
    // effects in the rolled tier stand (3.3, paired groups).
    const invalidKeys = new Set(invalid.map(x => contestKey(x.actor)));
    res.dropped = effects.filter(e => invalidKeys.has(contestKey(e.by)));
    effects = effects.filter(e => !invalidKeys.has(contestKey(e.by)));
    // Mode per key before the group: a downed actor finished off later in
    // the round (down -> dead) is reported again.
    const outBefore = Object.fromEntries(Object.entries(ctx.out || {}).map(([k, o]) => [k, o.mode]));
    for (const e of effects) res.records.push(applyEffect(ctx, e));
    applyLethality(ctx, res.records);
    for (const [key, o] of Object.entries(ctx.out || {})) {
        if (outBefore[key] === o.mode) continue;
        res.fell.push({ name: o.name, side: o.side, mode: o.mode, word: CONTEST_FELL_WORDS[o.mode] || o.mode });
    }
    callMutators(ctx, "afterAction", g, res);
    res.lines = groupLines(ctx, g, res);
    return res;
}

// Resolves a whole round. Returns { order, groups (resolution order),
// standing, over, out }.
export function runRound(ctx, groups) {
    ctx.out = ctx.out || {};
    const list = Array.isArray(groups) ? groups : [];
    const order = ctx.turn.queue(ctx, list);
    const results = order.map(i => resolveGroup(ctx, list[i], i));
    callMutators(ctx, "roundEnd", results);
    return {
        order,
        groups: results,
        standing: ctx.shape.standing(ctx),
        over: !!ctx.shape.isOver(ctx),
        out: ctx.out,
    };
}
