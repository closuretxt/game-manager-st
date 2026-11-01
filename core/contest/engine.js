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

import { applyEffect, applyLethality, contestKey, contestSide, outStateOf } from "./effects.js";
import { plainRoll } from "./ledger.js";

const CONTEST_KEY_LABELS = { crit: "Critical Success", hit: "Success", graze: "Partial Success", miss: "Failure", fumble: "Critical Failure" };
const CONTEST_KEY_FLIP = { crit: "fumble", hit: "miss", graze: "graze", miss: "hit", fumble: "crit" };

// The turn module may hook the round like a mutator (duel stances, held AP),
// and runs first so mutators see what it set. The dice module runs last, so
// its beforeRoll (the deck's hand) sees every bonus.
function callMutators(ctx, hook, ...args) {
    for (const m of [ctx.turn, ...(ctx.mutators || []), ctx.dice]) {
        if (typeof m?.[hook] !== "function") continue;
        try {
            m[hook](ctx, ...args);
        } catch (e) {
            if (ctx.log) ctx.log(`mutator ${m.id} ${hook} failed: ${e?.message || e}`);
        }
    }
}

// What an action did to the other side, in words (fights only, shape.landed):
// "Goblin A took Health damage" or "no damage". The story LLM otherwise
// reads "Partial Success" on an attack as half a hit and narrates one.
// Only lines aimed at the other side get it; a Defend on an ally does not.
function landedAttr(ctx, actor, versus, records) {
    if (!ctx.shape?.landed || !versus) return "";
    const mine = contestSide(ctx, actor);
    if (!mine || contestSide(ctx, versus) === mine) return "";
    const hit = [];
    for (const r of records) {
        if (r.status !== "applied" || r.kind !== "resource" || !(r.applied < 0)) continue;
        if (contestKey(r.by) !== contestKey(actor) || contestSide(ctx, r.target) === mine) continue;
        const what = `${r.target} took ${r.name} damage`;
        if (!hit.includes(what)) hit.push(what);
    }
    return hit.length ? hit.join(", ") : "no damage";
}

// Who a group is aimed at. One-sided groups (an attack the target does not
// contest) name no second side: the target is then the other-side sheet the
// actor's effects touched, else the participant named in the group title
// ("Aaru's Bullet vs Scout B"). Without it the story has to guess the target.
function groupVersus(ctx, g, records) {
    const first = g.sides?.[0];
    if (g.sides?.[1]?.actor) return g.sides[1].actor;
    if (!first) return "";
    const mine = contestSide(ctx, first.actor);
    const touched = records.find(r => contestKey(r.by) === contestKey(first.actor) && contestSide(ctx, r.target) && contestSide(ctx, r.target) !== mine);
    if (touched) return touched.target;
    const title = String(g.title || "").toLowerCase();
    const named = (ctx.participants || [])
        .filter(p => p.side !== mine && title.includes(String(p.name).toLowerCase()))
        .sort((a, b) => String(b.name).length - String(a.name).length)[0];
    return named?.name || "";
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
                lines.push({ actor: sd.actor, action: sd.action, versus, result: CONTEST_KEY_LABELS[key] || res.outcome.name, text: shape.resultLine(sd.actor, sd.action, key, versus), landed: landedAttr(ctx, sd.actor, versus, res.records), fell: fellAttr, status: statusAttr });
            });
        }
        return lines;
    }
    const tier = g.tiers[res.outcome.tierIndex] || {};
    const versus = groupVersus(ctx, g, res.records);
    lines.push({
        actor: first.actor,
        action: first.action,
        versus,
        result: res.outcome.name,
        text: tier.outcome || shape.resultLine(first.actor, first.action, res.outcome.key, versus),
        landed: landedAttr(ctx, first.actor, versus, res.records),
        fell: fellAttr,
        status: statusAttr,
    });
    return lines;
}

const CONTEST_FELL_WORDS = { dead: "dead", ko: "knocked out", down: "down", fled: "fled", yielded: "yielded", out: "out" };

// Questions a hook queued on roll.asks ("Ask me", decision 3): each is
// { id, actor, text, choices: [{ id, label, hint? }], auto, apply(pick) }.
// The driver answers (runRound: always `auto`; runRoundAsync: the player, or
// `auto` on a timeout); an unknown answer counts as `auto`.
function* askSteps(roll) {
    while (roll.asks.length) {
        const q = roll.asks.shift();
        const pick = yield { ask: q };
        const ok = (q.choices || []).some(c => c.id === pick) ? pick : q.auto;
        if (typeof q.apply === "function") q.apply(ok);
    }
}

function rollOutcome(ctx, g, roll) {
    const o = ctx.dice.resolve(ctx, g, roll);
    if (o && !o.plain) o.plain = plainRoll(o);
    return o;
}

function* resolveGroupSteps(ctx, g, index) {
    const sides = Array.isArray(g.sides) ? g.sides : [];
    const invalid = [];
    for (const sd of sides) {
        const mode = outStateOf(ctx, sd.actor);
        if (mode) invalid.push({ actor: sd.actor, action: sd.action, mode });
    }
    const res = { index, title: g.title, sides, status: "resolved", outcome: null, invalid, records: [], dropped: [], fell: [], lines: [], notes: [] };
    if (!sides.length || invalid.length === sides.length) {
        res.status = "interrupted";
        res.lines = groupLines(ctx, g, res);
        return res;
    }
    // Per-group roll adjustments: mutators add a bonus / advantage before the
    // roll and may ask for ONE reroll after it (momentum). Notes go to the
    // results message only.
    const roll = { bonus: 0, adv: 0, notes: res.notes, reroll: false, rerolled: false, asks: [] };
    callMutators(ctx, "beforeRoll", g, roll);
    yield* askSteps(roll);
    res.outcome = rollOutcome(ctx, g, roll);
    callMutators(ctx, "afterRoll", g, res.outcome, roll);
    yield* askSteps(roll);
    if (roll.reroll && !roll.rerolled) {
        roll.reroll = false;
        roll.rerolled = true;
        const first = res.outcome;
        res.outcome = rollOutcome(ctx, g, roll);
        res.outcome.rerolledFrom = { name: first.name, key: first.key, detail: first.detail || "", plain: first.plain || "" };
        callMutators(ctx, "afterRoll", g, res.outcome, roll);
        // A second question would offer a second reroll: none is allowed.
        roll.asks.length = 0;
    }
    let effects = ctx.consequence.effects(ctx, g, res.outcome) || [];
    for (const e of effects) if (!e.by) e.by = sides[0].actor;
    callMutators(ctx, "beforeApply", g, res.outcome, effects, res.notes);
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
// standing, over, out, notes }. `notes` = round-level mechanics for the
// results message (initiative rolls...), never the story.
// A generator: it yields { ask } (a question, answered by the next .next())
// and { group } (one group done, for the bubble's playback).
function* roundSteps(ctx, groups) {
    ctx.out = ctx.out || {};
    ctx.notes = ctx.notes || [];
    const list = Array.isArray(groups) ? groups : [];
    // roundStart sees every group before any resolves (flanking, clocks).
    callMutators(ctx, "roundStart", list);
    const order = ctx.turn.queue(ctx, list);
    const results = [];
    for (const i of order) {
        const res = yield* resolveGroupSteps(ctx, list[i], i);
        results.push(res);
        yield { group: res };
    }
    callMutators(ctx, "roundEnd", results);
    // Round-tag attributes (race phase...) and event lines (a side clock
    // filled) for the story: fiction, never numbers.
    const attrs = {};
    const events = [];
    for (const src of [ctx.shape, ctx.turn, ...(ctx.mutators || [])]) {
        try {
            if (typeof src?.storyAttrs === "function") Object.assign(attrs, src.storyAttrs(ctx) || {});
            if (typeof src?.storyEvents === "function") events.push(...(src.storyEvents(ctx) || []));
        } catch (e) {
            if (ctx.log) ctx.log(`${src.id} story hooks failed: ${e?.message || e}`);
        }
    }
    return {
        order,
        groups: results,
        standing: ctx.shape.standing(ctx),
        over: !!ctx.shape.isOver(ctx),
        out: ctx.out,
        notes: ctx.notes,
        notesLabel: ctx.shape?.notesLabel || "",
        attrs,
        events,
    };
}

// Every question auto-picked: tests, "Auto-pick" rulesets, replays.
export function runRound(ctx, groups) {
    const steps = roundSteps(ctx, groups);
    let s = steps.next();
    while (!s.done) s = steps.next(s.value?.ask ? s.value.ask.auto : undefined);
    return s.value;
}

// The live round: `ask(q)` resolves to a choice id (the player's, or q.auto
// on a timeout); `onGroup(res)` plays a finished group back. A failing UI
// never stops the round: the question falls back to its auto pick.
export async function runRoundAsync(ctx, groups, { ask, onGroup } = {}) {
    const steps = roundSteps(ctx, groups);
    let s = steps.next();
    while (!s.done) {
        let answer;
        if (s.value?.ask) {
            answer = s.value.ask.auto;
            if (typeof ask === "function") {
                try {
                    answer = await ask(s.value.ask);
                } catch (e) {
                    if (ctx.log) ctx.log(`ask failed: ${e?.message || e}`);
                }
            }
        } else if (s.value?.group && typeof onGroup === "function") {
            try {
                await onGroup(s.value.group);
            } catch (e) {
                if (ctx.log) ctx.log(`group playback failed: ${e?.message || e}`);
            }
        }
        s = steps.next(answer);
    }
    return s.value;
}
