// mut.range — range bands (plans/combat-modules.md 4.5): each enemy is
// engaged, near or far from the party (contest.tracks[enemy].range: 0, 1,
// 2; new enemies start at `start`, default near). Melee needs engaged: a
// melee attack from further away spends the action closing in (one band)
// instead of landing. Advancing, charging or retreating moves a band; a
// charge from near closes AND attacks. The oracle reads the bands and may
// move them with track effects.

import { contestKey, contestSide } from "../../effects.js";
import { critTag } from "./critEffects.js";

const RANGE_WORDS = ["engaged", "near", "far"];
const RANGE_CLOSE_RE = /\b(advanc\w*|close in|close the distance|charg\w*|rush\w*|approach\w*|step in|lunge\w*|leap at)\b/i;
const RANGE_BACK_RE = /\b(retreat\w*|back away|back off|fall back|disengag\w*|withdraw\w*|step back|kite|kiting)\b/i;
const RANGE_CHARGE_RE = /\b(charg\w*|lunge\w*|leap at)\b/i;

function rangeStart(ctx) {
    const s = String(ctx?.opts?.["mut.range"]?.start || "near");
    const i = RANGE_WORDS.indexOf(s);
    return i === -1 ? 1 : i;
}

export function rangeOf(ctx, name) {
    const v = Number(ctx.contest?.tracks?.[contestKey(name)]?.range);
    return Number.isFinite(v) ? Math.max(0, Math.min(2, Math.trunc(v))) : rangeStart(ctx);
}

// The enemy the group's first side is dealing with (itself when it is one).
function rangeEnemy(ctx, group, effects) {
    const first = group.sides[0];
    if (contestSide(ctx, first.actor) === "enemy") return first.actor;
    const b = group.sides[1];
    if (b && contestSide(ctx, b.actor) === "enemy") return b.actor;
    const hit = effects.find(e => contestKey(e.by) === contestKey(first.actor) && contestSide(ctx, e.target) === "enemy");
    return hit?.target || null;
}

export function rangeBeforeApply(ctx, group, outcome, effects, notes) {
    const first = group?.sides?.[0];
    if (!first) return;
    const enemy = rangeEnemy(ctx, group, effects);
    if (!enemy) return;
    const r = rangeOf(ctx, enemy);
    const action = String(first.action || "");
    const move = (to, line) => {
        effects.push({ kind: "track", by: first.actor, target: enemy, name: "range", value: String(to) });
        notes.push(`Range: ${enemy} ${RANGE_WORDS[r]} → ${RANGE_WORDS[to]}`);
        const tier = (group.tiers || [])[outcome?.tierIndex];
        if (line && tier) tier.outcome = line;
    };
    if (RANGE_BACK_RE.test(action)) {
        if (r < 2) move(r + 1, "");
        return;
    }
    if (r === 0) return;
    // A charge from near closes and still lands.
    if (RANGE_CHARGE_RE.test(action) && r === 1) {
        move(0, "");
        return;
    }
    // A melee attack from too far spends the action closing in: its blows
    // on the other side never land (its own costs still do).
    const mine = contestKey(first.actor);
    const mySide = contestSide(ctx, first.actor);
    const isBlow = e => contestKey(e.by) === mine && (e.kind === "resource" || e.kind === "status") && contestSide(ctx, e.target) && contestSide(ctx, e.target) !== mySide;
    if (critTag(action) === "melee" && effects.some(isBlow)) {
        for (let i = effects.length - 1; i >= 0; i--) if (isBlow(effects[i])) effects.splice(i, 1);
        move(r - 1, `${first.actor} closes in${mySide === "enemy" ? "" : ` on ${enemy}`} instead of striking.`);
        return;
    }
    if (RANGE_CLOSE_RE.test(action)) move(r - 1, "");
}

export function rangeOracleState(ctx) {
    const parts = (ctx.participants || [])
        .filter(p => p.side === "enemy")
        .map(p => `${p.name} ${RANGE_WORDS[rangeOf(ctx, p.name)]}`);
    return parts.length ? [`Range bands (from the party): ${parts.join(" · ")}`] : [];
}

const RANGE_ORACLE_RULES = [
    'RANGE BANDS: each enemy is engaged, near or far from the party (see <contest_state>). Melee needs engaged: a melee attack from near or far only closes in (the engine applies that, so write such a group\'s tiers as the approach). Ranged attacks and spells work at any band. A tier that changes the distance writes <effect target="Enemy" track="range" value="0|1|2"/> (0 engaged, 1 near, 2 far).',
];

export const mutRange = {
    id: "mut.range",
    label: "Range bands",
    hint: "Engaged / near / far: melee from too far spends the action closing in.",
    shapes: ["clash"],
    options: [{ key: "start", label: "Enemies start", type: "select", default: "near", choices: [["engaged", "Engaged"], ["near", "Near"], ["far", "Far"]] }],
    beforeApply: rangeBeforeApply,
    oracleState: rangeOracleState,
    oracleRules: RANGE_ORACLE_RULES,
};
