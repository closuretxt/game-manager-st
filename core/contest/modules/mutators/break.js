// mut.break — toughness and weakness breaks (plans/combat-modules.md 4.5):
// every enemy with a weakness on its sheet ("Weak to fire", "Vulnerable:
// holy") carries toughness pips (default 3). A party hit whose action names
// a weakness breaks a pip (two on a critical). At zero the enemy is Broken:
// it loses its next action, rolls against it get +2, and its toughness
// refills after that round. Kept in contest.meters.toughness / .broken.

import { contestKey, contestSide, applyEffect } from "../../effects.js";

const BREAK_WEAK_RE = /(?:weak(?:ness|nesses)?|vulnerab\w*)\s*(?:to|against|vs\.?|:)?\s*([^.;()\n]+)/gi;

function breakPips(ctx) {
    const n = Number(ctx?.opts?.["mut.break"]?.pips);
    return Number.isFinite(n) && n >= 1 ? Math.min(9, Math.trunc(n)) : 3;
}

function breakMeters(ctx) {
    const m = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    if (!m.toughness || typeof m.toughness !== "object") m.toughness = {};
    if (!m.broken || typeof m.broken !== "object") m.broken = {};
    return m;
}

function breakRound(ctx) {
    return Number.isFinite(ctx.roundNo) ? ctx.roundNo : (Math.trunc(Number(ctx.contest?.round) || 0) + 1);
}

// Weakness words from the sheet's passives, details, statuses and notes.
export function breakWeaknesses(sheet) {
    const texts = [];
    for (const list of [sheet?.passives, sheet?.traits, sheet?.statuses, sheet?.attributes]) {
        for (const e of list || []) texts.push([e?.name, e?.value, e?.description, e?.effect].filter(Boolean).join(" "));
    }
    if (Array.isArray(sheet?.weaknesses)) texts.push(sheet.weaknesses.join(", "));
    else if (sheet?.weaknesses) texts.push(`weak to ${sheet.weaknesses}`);
    const words = new Set();
    for (const text of texts) {
        BREAK_WEAK_RE.lastIndex = 0;
        let m;
        while ((m = BREAK_WEAK_RE.exec(String(text))) !== null) {
            for (const w of m[1].split(/,|\/|\band\b|\bor\b/i)) {
                const word = w.trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
                if (word.length >= 3 && word.length <= 24) words.add(word);
            }
        }
    }
    return [...words];
}

export function breakHits(action, weaknesses) {
    const text = String(action ?? "").toLowerCase();
    return (weaknesses || []).some(w => text.includes(w));
}

function breakIsBroken(ctx, name) {
    const b = breakMeters(ctx).broken[contestKey(name)];
    return Number.isFinite(b) && b < breakRound(ctx);
}

// A Broken enemy's own effects never land: it loses this action. When it
// leads the group, the story line says so instead of the oracle's prose.
export function breakBeforeApply(ctx, group, outcome, effects, notes) {
    (group?.sides || []).forEach((sd, i) => {
        if (!breakIsBroken(ctx, sd.actor)) return;
        const key = contestKey(sd.actor);
        for (let j = effects.length - 1; j >= 0; j--) if (contestKey(effects[j].by) === key) effects.splice(j, 1);
        notes.push(`${sd.actor} is broken and loses the action`);
        const tier = (group.tiers || [])[outcome?.tierIndex];
        if (i === 0 && tier) tier.outcome = `${sd.actor} reels, broken, and cannot act.`;
    });
}

export function breakBeforeRoll(ctx, group, roll) {
    const sides = group?.sides || [];
    if (!roll || sides.length < 2) return;
    if (breakIsBroken(ctx, sides[1].actor) && contestSide(ctx, sides[0].actor) === "party") {
        roll.bonus += 2;
        roll.notes.push(`${sides[1].actor} is broken (+2)`);
    }
}

export function breakAfterAction(ctx, group, res) {
    const first = group?.sides?.[0];
    const key = res?.outcome?.key;
    if (!first || (key !== "hit" && key !== "crit") || contestSide(ctx, first.actor) !== "party") return;
    const hitRec = (res.records || []).find(r => r.status === "applied" && r.side === "enemy" && contestKey(r.by) === contestKey(first.actor));
    const targetName = hitRec?.target || group.sides[1]?.actor;
    const found = targetName ? ctx.ops.sheet(targetName) : null;
    if (!found || found.side !== "enemy" || found.sheet.pseudo) return;
    const weak = breakWeaknesses(found.sheet);
    if (!weak.length || !breakHits(first.action, weak)) return;
    const m = breakMeters(ctx);
    const tk = contestKey(found.sheet.name);
    if (Number.isFinite(m.broken[tk])) return;
    const full = breakPips(ctx);
    const left = Math.max(0, (Number.isFinite(m.toughness[tk]) ? m.toughness[tk] : full) - (key === "crit" ? 2 : 1));
    m.toughness[tk] = left;
    if (left > 0) {
        res.notes.push(`Weakness hit: ${found.sheet.name} toughness ${left}/${full}`);
        return;
    }
    m.broken[tk] = breakRound(ctx);
    res.records.push(applyEffect(ctx, { kind: "status", by: first.actor, target: found.sheet.name, name: "Broken", modifiers: "Defense -4", turns: 1 }));
    res.notes.push(`Break! ${found.sheet.name} is broken`);
}

// After the round a Broken enemy sat out, its toughness refills.
export function breakRoundEnd(ctx) {
    const m = breakMeters(ctx);
    const now = breakRound(ctx);
    for (const [k, b] of Object.entries(m.broken)) {
        if (Number.isFinite(b) && b < now) {
            delete m.broken[k];
            delete m.toughness[k];
        }
    }
}

export function breakOracleState(ctx) {
    const m = breakMeters(ctx);
    const full = breakPips(ctx);
    const parts = [];
    for (const p of ctx.participants || []) {
        if (p.side !== "enemy") continue;
        const found = ctx.ops.sheet(p.name);
        if (!found || found.sheet.pseudo) continue;
        const weak = breakWeaknesses(found.sheet);
        if (!weak.length) continue;
        const k = contestKey(found.sheet.name);
        if (breakIsBroken(ctx, found.sheet.name)) parts.push(`${found.sheet.name}: BROKEN (loses this action, defenses down)`);
        else parts.push(`${found.sheet.name}: toughness ${Number.isFinite(m.toughness[k]) ? m.toughness[k] : full}/${full}, weak to ${weak.join(", ")}`);
    }
    return parts.length ? [`Weakness break: ${parts.join(" · ")}`] : [];
}

export const mutBreak = {
    id: "mut.break",
    label: "Weakness break",
    hint: "Hitting an enemy's weakness breaks toughness pips; a broken enemy loses its next action.",
    shapes: ["clash"],
    options: [{ key: "pips", label: "Toughness pips", type: "number", min: 1, max: 9, default: 3 }],
    beforeRoll: breakBeforeRoll,
    beforeApply: breakBeforeApply,
    afterAction: breakAfterAction,
    roundEnd: breakRoundEnd,
    oracleState: breakOracleState,
};
