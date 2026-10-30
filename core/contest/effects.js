// Effects: the universal result format of a contest round
// (plans/combat-modules.md 3.3). The oracle writes them per tier; the engine
// applies the rolled tier's effects in resolution order. Pure: every state
// access goes through `ctx.ops` (built over stateManager by contest.js, stubbed
// by the tests), so this file loads under node.
//
//   <effect by="Kael" target="Goblin A" resource="Health" delta="-(1d10+4)"/>
//   <effect by="Kael" target="Kael" skill="Cleave"/>
//   <effect by="Kael" target="Goblin A" status="Dazed" modifiers="Aim -2"/>
//   <effect by="Kael" target="Kael" item="Potion" qty="-1"/>
//   <effect by="Goblin B" target="Goblin B" state="fled"/>
//
// ctx.ops:
//   sheet(name) -> { sheet, side: "party" | "enemy" } | null
//   match(list, name) -> entry | null        (stateManager's matchName)
//   max(sheet, entry) -> number              (formula maxes resolved)
//   useSkill(sheet, name) / addItem(sheet, name, qty) / removeItem(sheet, name, qty)
//   setStatus(sheet, { name, modifiers, effect }) / clearStatus(sheet, name)
//   priorState(sheet) -> "dead" | "ko" | null (the sheet's own state slot)
//   evalMath(expr) -> number | null          (resolveNumericExpr)

import { rollExpr } from "./rng.js";

export const EFFECT_KINDS = ["resource", "status", "skill", "item", "track", "state"];
// Any of these takes an actor out of the round: its later actions are
// Interrupted.
export const OUT_STATES = ["dead", "ko", "down", "fled", "yielded", "out"];
// These also make the actor unreachable: effects aimed at them are Wasted.
// ko/down targets are still there (a heal or a finishing blow can land).
export const GONE_STATES = ["dead", "fled", "yielded", "out"];

export function contestKey(name) {
    return String(name ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function decodeXml(s) {
    return String(s ?? "")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function effectAttrs(raw) {
    const out = {};
    const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
    let m;
    while ((m = re.exec(String(raw ?? ""))) !== null) {
        out[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3] ?? m[4] ?? "");
    }
    return out;
}

const truthy = v => /^(true|yes|1)$/i.test(String(v ?? "").trim());

// One attribute map -> a normalized effect, or null when it names no known
// kind or no target. `by` may be empty: the engine binds it to the group's
// first side.
export function normalizeEffect(a) {
    const kind = EFFECT_KINDS.find(k => String(a?.[k] ?? "").trim() !== "");
    if (!kind) return null;
    const target = String(a.target ?? a.char ?? a.on ?? "").trim();
    if (!target) return null;
    const eff = {
        kind,
        by: String(a.by ?? "").trim(),
        target,
        name: String(a[kind]).trim().slice(0, 80),
    };
    if (kind === "resource" || kind === "track") {
        if (String(a.delta ?? "").trim() !== "") eff.delta = String(a.delta).trim().slice(0, 60);
        else if (String(a.value ?? "").trim() !== "") eff.value = String(a.value).trim().slice(0, 60);
        else if (!(kind === "track" && truthy(a.swap))) return null;
        if (kind === "track" && truthy(a.swap)) eff.swap = true;
    } else if (kind === "status") {
        if (truthy(a.remove) || truthy(a.clear)) eff.remove = true;
        if (a.modifiers) eff.modifiers = String(a.modifiers).slice(0, 120);
        if (a.effect) eff.effect = String(a.effect).slice(0, 200);
        if (a.turns) eff.turns = Math.max(0, Math.trunc(Number(a.turns) || 0));
    } else if (kind === "item") {
        eff.qty = Math.trunc(Number(a.qty ?? -1)) || -1;
    } else if (kind === "state") {
        const mode = eff.name.toLowerCase();
        if (!OUT_STATES.includes(mode)) return null;
        eff.name = mode;
        if (a.reason) eff.reason = String(a.reason).slice(0, 160);
    }
    return eff;
}

// Every <effect .../> tag in a text (a tier body).
export function parseEffects(text) {
    const out = [];
    const re = /<effect\b([^>]*?)\/?>/gi;
    let m;
    while ((m = re.exec(String(text ?? ""))) !== null) {
        const eff = normalizeEffect(effectAttrs(m[1]));
        if (eff) out.push(eff);
    }
    return out;
}

// A tier body without its effect tags = the prose outcome line.
export function stripEffects(text) {
    return String(text ?? "").replace(/<effect\b[^>]*?\/?>(?:\s*<\/effect>)?/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// "party" | "enemy" | null — from the sheet, never the oracle's who= (the
// oracle can mislabel a side; the sheets cannot).
export function contestSide(ctx, name) {
    return ctx.ops.sheet(name)?.side || null;
}

// The actor's out-state this round: set earlier in the round, carried by the
// contest (party members who fled), or the sheet's own state slot.
export function outStateOf(ctx, name) {
    const key = contestKey(name);
    if (ctx.out?.[key]) return ctx.out[key].mode;
    if (ctx.contest?.out?.[key]) return ctx.contest.out[key];
    const found = ctx.ops.sheet(name);
    return found ? (ctx.ops.priorState(found.sheet) || null) : null;
}

function setOut(ctx, found, mode, extra = {}) {
    const key = contestKey(found.sheet.name);
    ctx.out = ctx.out || {};
    ctx.out[key] = { name: found.sheet.name, side: found.side, mode, ...extra };
}

// Applies one effect. Returns a record for the ledger:
//   { ...effect, status: "applied" | "wasted" | "skipped", reason?, before?, after?, applied? }
// Wasted = the target already left the contest; skipped = unknown name or
// malformed value (logged by the caller, never thrown).
export function applyEffect(ctx, eff) {
    const rec = { ...eff };
    const found = ctx.ops.sheet(eff.target);
    if (!found) return { ...rec, status: "skipped", reason: "unknown target" };
    rec.target = found.sheet.name;
    rec.side = found.side;
    const targetState = outStateOf(ctx, found.sheet.name);
    if (targetState && GONE_STATES.includes(targetState)) return { ...rec, status: "wasted", reason: targetState };
    const sheet = found.sheet;

    switch (eff.kind) {
        case "resource": {
            const entry = ctx.ops.match(sheet.resources || [], eff.name);
            if (!entry) return { ...rec, status: "skipped", reason: "unknown resource" };
            const expr = eff.delta ?? eff.value;
            const rolled = rollExpr(expr, ctx.rng, ctx.ops.evalMath);
            if (!rolled) return { ...rec, status: "skipped", reason: "bad value" };
            const min = Number.isFinite(+entry.min) ? +entry.min : 0;
            const max = ctx.ops.max(sheet, entry);
            const before = Number(entry.value) || 0;
            let after = eff.delta !== undefined ? before + rolled.value : rolled.value;
            after = Math.round(after);
            if (Number.isFinite(max)) after = Math.min(max, after);
            after = Math.max(min, after);
            entry.value = after;
            return { ...rec, name: entry.name, status: "applied", before, after, applied: after - before, rolls: rolled.rolls, min };
        }
        case "status": {
            const ok = eff.remove
                ? ctx.ops.clearStatus(sheet, eff.name)
                : ctx.ops.setStatus(sheet, {
                    name: eff.name,
                    modifiers: eff.modifiers,
                    effect: eff.effect ?? (eff.turns ? `${eff.turns} turn${eff.turns === 1 ? "" : "s"}` : undefined),
                });
            return ok ? { ...rec, status: "applied" } : { ...rec, status: "skipped", reason: "status not applied" };
        }
        case "skill": {
            const ok = ctx.ops.useSkill(sheet, eff.name);
            return ok ? { ...rec, status: "applied" } : { ...rec, status: "skipped", reason: "unknown skill" };
        }
        case "item": {
            const ok = eff.qty > 0
                ? ctx.ops.addItem(sheet, eff.name, eff.qty)
                : ctx.ops.removeItem(sheet, eff.name, -eff.qty);
            return ok ? { ...rec, status: "applied" } : { ...rec, status: "skipped", reason: "unknown item" };
        }
        case "track": {
            ctx.contest.tracks = ctx.contest.tracks || {};
            const key = contestKey(sheet.name);
            const own = (ctx.contest.tracks[key] = ctx.contest.tracks[key] || {});
            const tname = contestKey(eff.name);
            if (eff.swap) return { ...rec, status: "applied", swap: true };
            const rolled = rollExpr(eff.delta ?? eff.value, ctx.rng, ctx.ops.evalMath);
            if (!rolled) return { ...rec, status: "skipped", reason: "bad value" };
            const before = Number(own[tname]) || 0;
            const after = eff.delta !== undefined ? before + rolled.value : rolled.value;
            own[tname] = after;
            return { ...rec, status: "applied", before, after, applied: after - before };
        }
        case "state": {
            if (targetState === eff.name) return { ...rec, status: "wasted", reason: targetState };
            setOut(ctx, found, eff.name, { by: eff.by, reason: eff.reason || "" });
            return { ...rec, status: "applied" };
        }
        default:
            return { ...rec, status: "skipped", reason: "unknown kind" };
    }
}

// Default lethality (3.3): a stakes resource at its minimum with no state
// effect from this group takes the actor out — party -> ko, enemy -> down.
// Returns the names that fell this way.
export function applyLethality(ctx, records) {
    const fell = [];
    const explicit = new Set(records.filter(r => r.kind === "state" && r.status === "applied").map(r => contestKey(r.target)));
    for (const r of records) {
        if (r.kind !== "resource" || r.status !== "applied" || !(r.applied < 0)) continue;
        const key = contestKey(r.target);
        if (explicit.has(key) || fell.includes(r.target)) continue;
        if (outStateOf(ctx, r.target)) continue;
        const found = ctx.ops.sheet(r.target);
        if (!found) continue;
        const stakes = ctx.stakes ? ctx.stakes(found.sheet) : null;
        if (!stakes || contestKey(stakes.name) !== contestKey(r.name)) continue;
        if (r.after > r.min) continue;
        setOut(ctx, found, found.side === "party" ? "ko" : "down", { by: r.by, reason: "" });
        fell.push(r.target);
    }
    return fell;
}
