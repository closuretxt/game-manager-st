// mut.morale — opponents break and run (plans/combat-modules.md 4.5): an
// enemy tests its nerve the first time it drops below half its stakes, and
// every standing enemy tests when one of its side falls. d20 + the sheet's
// Morale/Courage/Nerve/Will (if numeric) against the target (default 10);
// a failure flees, or yields when too hurt to run (below a quarter). The
// result rides in the group's fell attribute, so the story shows it.

import { contestKey, outStateOf, applyEffect } from "../../effects.js";
import { rollDie } from "../../rng.js";

const MORALE_STAT_RE = /^(morale|courage|nerve|will|willpower|resolve|bravery)$/i;
const MORALE_WORDS = { fled: "fled", yielded: "yielded" };

function moraleTarget(ctx) {
    const n = Number(ctx?.opts?.["mut.morale"]?.target);
    return Number.isFinite(n) && n >= 1 ? Math.min(30, Math.trunc(n)) : 10;
}

function moraleBonus(sheet) {
    const stat = (sheet?.attributes || []).find(a => MORALE_STAT_RE.test(String(a?.name || "").trim()));
    const n = Number(stat?.value);
    return Number.isFinite(n) ? Math.max(-5, Math.min(10, Math.trunc(n))) : 0;
}

// The enemy's stakes share 0..1, or null without a stakes resource.
function moraleRatio(ctx, sheet) {
    const entry = ctx.stakes ? ctx.stakes(sheet) : null;
    if (!entry) return null;
    const max = ctx.ops.max(sheet, entry);
    const min = Number.isFinite(+entry.min) ? +entry.min : 0;
    if (!Number.isFinite(max) || max <= min) return null;
    return ((Number(entry.value) || 0) - min) / (max - min);
}

export function moraleAfterAction(ctx, group, res) {
    const m = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    if (!m.morale || typeof m.morale !== "object") m.morale = {};
    const testing = new Map();
    // Dropped below half this group (once per contest).
    for (const r of res.records || []) {
        if (r.kind !== "resource" || r.status !== "applied" || r.side !== "enemy" || !(r.applied < 0)) continue;
        const found = ctx.ops.sheet(r.target);
        if (!found || found.sheet.pseudo) continue;
        const stakes = ctx.stakes ? ctx.stakes(found.sheet) : null;
        if (!stakes || contestKey(stakes.name) !== contestKey(r.name)) continue;
        const ratio = moraleRatio(ctx, found.sheet);
        const k = contestKey(found.sheet.name);
        if (ratio !== null && ratio < 0.5 && !m.morale[k]) {
            m.morale[k] = 1;
            testing.set(k, { name: found.sheet.name, why: "hurt" });
        }
    }
    // One of their side fell: everyone still standing tests.
    if ((res.fell || []).some(f => f.side === "enemy")) {
        for (const p of ctx.participants || []) {
            if (p.side !== "enemy" || outStateOf(ctx, p.name)) continue;
            const k = contestKey(p.name);
            if (!testing.has(k)) testing.set(k, { name: p.name, why: "an ally fell" });
        }
    }
    const target = moraleTarget(ctx);
    for (const { name, why } of testing.values()) {
        const found = ctx.ops.sheet(name);
        if (!found || found.sheet.pseudo || found.side !== "enemy" || outStateOf(ctx, name)) continue;
        const face = rollDie(ctx.rng, 20);
        const total = face + moraleBonus(found.sheet);
        if (total >= target) {
            res.notes.push(`${found.sheet.name} keeps their nerve (${why}): rolled ${total}, needed ${target}`);
            continue;
        }
        const ratio = moraleRatio(ctx, found.sheet);
        const mode = ratio !== null && ratio < 0.25 ? "yielded" : "fled";
        const rec = applyEffect(ctx, { kind: "state", by: found.sheet.name, target: found.sheet.name, name: mode, reason: "morale" });
        if (rec.status !== "applied") continue;
        res.records.push(rec);
        res.fell.push({ name: found.sheet.name, side: "enemy", mode, word: MORALE_WORDS[mode] });
        res.notes.push(`${found.sheet.name} loses their nerve (${why}) and ${mode === "fled" ? "flees" : "gives up"}: rolled ${total}, needed ${target}`);
    }
}

export const mutMorale = {
    id: "mut.morale",
    label: "Morale",
    hint: "Enemies test their nerve when badly hurt or when an ally falls; failing, they flee or yield.",
    shapes: ["clash"],
    options: [{ key: "target", label: "Nerve target (d20)", type: "number", min: 1, max: 30, default: 10 }],
    afterAction: moraleAfterAction,
};
