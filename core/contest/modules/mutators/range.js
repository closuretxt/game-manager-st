// mut.range — range bands (plans/combat-modules.md 4.5): each enemy is
// engaged, near or far from the party (contest.tracks[enemy].range: 0, 1,
// 2). New enemies start at `start`: "scene" (default) = unknown until the
// oracle or a move sets it — the story already placed them, so blows land
// and a landed melee blow means engaged; "near"/"far" = a fixed band.
// Melee needs engaged: a melee attack from further away spends the action
// closing in (one band) instead of landing. Advancing, charging or
// retreating moves a band; a charge from near closes AND attacks. The oracle
// reads the bands and may move them with track effects; when it moved an
// enemy's band in a group, the module adds no second move there.

import { contestKey, contestSide } from "../../effects.js";
import { critTag } from "./critEffects.js";

const RANGE_WORDS = ["engaged", "near", "far"];
// Resources whose cost marks an attack as a shot, whatever its name says.
const RANGE_AMMO_RE = /\b(ammo|ammunition|arrows?|bullets?|bolts?|shells?|rounds|darts?|quiver|magazine|cartridges?)\b/i;

function rangeWord(r) {
    return r === null ? "unset" : RANGE_WORDS[r];
}

// Melee = no ranged/spell word in the action and no ammo spent by the actor.
function rangeIsMelee(action, actor, effects) {
    if (critTag(action) !== "melee") return false;
    const me = contestKey(actor);
    return !effects.some(e => e.kind === "resource" && contestKey(e.target) === me && RANGE_AMMO_RE.test(String(e.name || "")));
}
const RANGE_CLOSE_RE = /\b(advanc\w*|close in|close the distance|charg\w*|rush\w*|approach\w*|step in|lunge\w*|leap at)\b/i;
const RANGE_BACK_RE = /\b(retreat\w*|back away|back off|fall back|disengag\w*|withdraw\w*|step back|kite|kiting)\b/i;
const RANGE_CHARGE_RE = /\b(charg\w*|lunge\w*|leap at)\b/i;

// null = "scene": unknown until something sets it.
function rangeStart(ctx) {
    const s = String(ctx?.opts?.["mut.range"]?.start || "scene");
    const i = RANGE_WORDS.indexOf(s);
    return i === -1 ? null : i;
}

// Unwritten range tracks start at the configured band (effects.js); an
// unset one counts from 0 there.
export function rangeTrackDefault(ctx, tname) {
    return tname === "range" ? rangeStart(ctx) ?? undefined : undefined;
}

// The enemy's band, or null while unset.
export function rangeOf(ctx, name) {
    const raw = ctx.contest?.tracks?.[contestKey(name)]?.range;
    const v = Number(raw);
    return raw !== undefined && raw !== null && Number.isFinite(v) ? Math.max(0, Math.min(2, Math.trunc(v))) : rangeStart(ctx);
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
    const enemyKey = contestKey(enemy);
    // The oracle already moved this enemy's band in this group (a dodge
    // backwards, an approach): its move stands, the module adds none.
    const oracleMoved = effects.some(e => e.kind === "track" && contestKey(e.name) === "range" && contestKey(e.target) === enemyKey);
    // No note: the range effect itself shows up in the results ("now in melee").
    const move = (to, line) => {
        if (!oracleMoved) effects.push({ kind: "track", by: first.actor, target: enemy, name: "range", value: String(to) });
        const tier = (group.tiers || [])[outcome?.tierIndex];
        if (line && tier) tier.outcome = line;
    };
    const mine = contestKey(first.actor);
    const mySide = contestSide(ctx, first.actor);
    const isBlow = e => contestKey(e.by) === mine && (e.kind === "resource" || e.kind === "status") && contestSide(ctx, e.target) && contestSide(ctx, e.target) !== mySide;
    const melee = rangeIsMelee(action, first.actor, effects);
    if (RANGE_BACK_RE.test(action)) {
        if (r === null || r < 2) move(r === null ? 2 : r + 1, "");
        return;
    }
    if (r === 0) return;
    // Unset: the story placed them. Blows land; a landed melee blow or an
    // approach means engaged from now on.
    if (r === null) {
        if ((melee && effects.some(isBlow)) || RANGE_CLOSE_RE.test(action)) move(0, "");
        return;
    }
    // A charge from near closes and still lands.
    if (RANGE_CHARGE_RE.test(action) && r === 1) {
        move(0, "");
        return;
    }
    // A melee attack from too far spends the action closing in: its blows
    // on the other side never land (its own costs still do).
    if (melee && effects.some(isBlow)) {
        for (let i = effects.length - 1; i >= 0; i--) if (isBlow(effects[i])) effects.splice(i, 1);
        move(r - 1, `${first.actor} closes in${mySide === "enemy" ? "" : ` on ${enemy}`} instead of striking.`);
        return;
    }
    if (RANGE_CLOSE_RE.test(action)) move(r - 1, "");
}

export function rangeOracleState(ctx) {
    const parts = (ctx.participants || [])
        .filter(p => p.side === "enemy")
        .map(p => `${p.name} ${rangeWord(rangeOf(ctx, p.name))}`);
    return parts.length ? [`Range bands (from the party): ${parts.join(" · ")}`] : [];
}

const RANGE_ORACLE_RULES = [
    'RANGE BANDS: each enemy is engaged, near, far or unset from the party (see <contest_state>). Unset = judge the distance from the scene: if they are already fighting hand to hand, melee lands. Melee needs engaged: a melee attack from near or far only closes in (the engine applies that, so write such a group\'s tiers as the approach). Ranged attacks and spells work at any band. A tier that changes the distance (or sets an unset one) writes <effect target="Enemy" track="range" value="0|1|2"/> (0 engaged, 1 near, 2 far).',
];

export const mutRange = {
    id: "mut.range",
    label: "Range bands",
    hint: "Engaged / near / far: melee from too far spends the action closing in.",
    shapes: ["clash"],
    options: [{ key: "start", label: "Enemies start", type: "select", default: "scene", choices: [["scene", "From the scene"], ["engaged", "Engaged"], ["near", "Near"], ["far", "Far"]] }],
    beforeApply: rangeBeforeApply,
    trackDefault: rangeTrackDefault,
    oracleState: rangeOracleState,
    oracleRules: RANGE_ORACLE_RULES,
};
