// mut.limit — limit gauges (plans/combat-modules.md 4.5): each party member
// fills a gauge (default 10) when hurt (+2 per stakes hit, +3 on an enemy
// critical), when their own roll fails (+1), and in races / scored contests
// for every round they end behind the leader (+1). A full gauge unlocks an
// ultimate: an action named Ultimate / Limit break / Finisher / Overdrive
// rolls with advantage and +3, then empties the gauge. The oracle sees the
// gauges and treats an ultimate without a full gauge as impossible.

import { contestKey, contestSide } from "../../effects.js";
import { raceOrder } from "../shape/race.js";
import { scoresRanking } from "../shape/scores.js";

const LIMIT_ULT_RE = /\b(ultimate|limit break|finisher|overdrive|final (?:strike|spurt|form|move)|trump card)\b/i;

function limitMax(ctx) {
    const n = Number(ctx?.opts?.["mut.limit"]?.max);
    return Number.isFinite(n) && n >= 2 ? Math.min(30, Math.trunc(n)) : 10;
}

function limitGauges(ctx) {
    const m = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    if (!m.limit || typeof m.limit !== "object") m.limit = {};
    return m.limit;
}

function limitFill(ctx, name, n) {
    const g = limitGauges(ctx);
    const k = contestKey(name);
    g[k] = Math.min(limitMax(ctx), (Number(g[k]) || 0) + n);
}

export function limitIsUltimate(action) {
    return LIMIT_ULT_RE.test(String(action ?? ""));
}

export function limitBeforeRoll(ctx, group, roll) {
    const a = group?.sides?.[0];
    if (!a || !roll || contestSide(ctx, a.actor) !== "party" || !limitIsUltimate(a.action)) return;
    const g = limitGauges(ctx);
    const k = contestKey(a.actor);
    const max = limitMax(ctx);
    if ((Number(g[k]) || 0) < max) {
        roll.notes.push(`Ultimate not charged yet (${Number(g[k]) || 0}/${max})`);
        return;
    }
    g[k] = 0;
    roll.adv += 1;
    roll.bonus += 3;
    roll.notes.push("Ultimate unleashed!");
    (ctx.limitSpent = ctx.limitSpent || new Set()).add(k);
}

export function limitAfterAction(ctx, group, res) {
    for (const r of res?.records || []) {
        if (r.kind !== "resource" || r.status !== "applied" || r.side !== "party" || !(r.applied < 0)) continue;
        if (contestKey(r.by) === contestKey(r.target)) continue;
        const found = ctx.ops.sheet(r.target);
        const stakes = found && ctx.stakes ? ctx.stakes(found.sheet) : null;
        if (!stakes || contestKey(stakes.name) !== contestKey(r.name)) continue;
        const enemyCrit = res.outcome?.key === "fumble" && contestSide(ctx, group.sides[0]?.actor) === "party";
        limitFill(ctx, r.target, enemyCrit ? 3 : 2);
    }
    const a = group?.sides?.[0];
    const key = res?.outcome?.key;
    if (a && contestSide(ctx, a.actor) === "party" && (key === "miss" || key === "fumble") && !ctx.limitSpent?.has(contestKey(a.actor))) {
        limitFill(ctx, a.actor, 1);
    }
}

// Races and scored contests: ending a round behind fills the gauge.
export function limitRoundEnd(ctx) {
    const id = ctx.shape?.id;
    if (id !== "shape.race" && id !== "shape.scores") return;
    const order = id === "shape.race" ? raceOrder(ctx) : scoresRanking(ctx);
    const lead = order.find(r => !r.out);
    for (const r of order) {
        if (r.out || r.side !== "party" || r === lead) continue;
        if ((id === "shape.race" ? r.progress < lead.progress : r.score < lead.score)) limitFill(ctx, r.name, 1);
    }
}

function limitRows(ctx) {
    const g = limitGauges(ctx);
    const max = limitMax(ctx);
    const seen = new Set();
    const rows = [];
    for (const p of ctx.participants || []) {
        const k = contestKey(p.name);
        if (p.side !== "party" || seen.has(k)) continue;
        seen.add(k);
        rows.push({ name: p.name, value: Math.max(0, Number(g[k]) || 0), max });
    }
    return rows;
}

export function limitOracleState(ctx) {
    const rows = limitRows(ctx);
    if (!rows.length) return [];
    return [`Limit gauges: ${rows.map(r => `${r.name} ${r.value >= r.max ? "FULL (an ultimate is allowed)" : `${r.value}/${r.max}`}`).join(" · ")}`];
}

export function limitHud(ctx) {
    const rows = limitRows(ctx);
    if (!rows.length) return null;
    const top = Math.max(...rows.map(r => r.value));
    return { label: "Limit", value: top, max: limitMax(ctx), text: rows.map(r => `${r.name} ${r.value}/${r.max}`).join(" · ") };
}

const LIMIT_ORACLE_RULES = [
    "LIMIT GAUGES: an action named Ultimate, Limit break, Finisher or Overdrive is only possible for a party member whose gauge is FULL in <contest_state>; for anyone else treat it like an unknown ability. A full-gauge ultimate is the actor's strongest move: its success tiers hit harder than any normal skill.",
];

export const mutLimit = {
    id: "mut.limit",
    label: "Limit gauge",
    hint: "Getting hurt or falling behind fills a gauge; full, it unlocks an Ultimate.",
    options: [{ key: "max", label: "Gauge size", type: "number", min: 2, max: 30, default: 10 }],
    beforeRoll: limitBeforeRoll,
    afterAction: limitAfterAction,
    roundEnd: limitRoundEnd,
    oracleState: limitOracleState,
    oracleRules: LIMIT_ORACLE_RULES,
    hud: limitHud,
};
