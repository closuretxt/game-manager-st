// dice.pool — dice pools (plans/combat-modules.md 4.3): the oracle sets how
// many d6 the first side rolls and how many the opposition rolls back; every
// 5 or 6 is a success and the pools compare. Net 3+ = critical, net 1+ =
// success, a tie with successes = partial, fewer = failure; no success with
// half the dice showing 1 = fumble. Advantage adds a die, disadvantage
// removes one; a mutator bonus adds dice.

import { oracleResolve } from "./oracle.js";
import { rollExploding, diceOutcome, sampledOdds, diceRollRules, diceFiveTierRule, diceExample } from "./common.js";

const POOL_MAX = 25;

// -> { hits, ones, faces }
function poolRoll(rng, size, explode) {
    const faces = [];
    for (let i = 0; i < size; i++) faces.push(...rollExploding(rng, 6, explode).faces);
    return { hits: faces.filter(f => f >= 5).length, ones: faces.filter(f => f === 1).length, faces };
}

export function poolKey(mine, theirs, impossible) {
    const fumble = mine.hits === 0 && mine.faces.length > 0 && mine.ones * 2 >= mine.faces.length;
    if (impossible) return fumble ? "fumble" : "miss";
    if (fumble) return "fumble";
    const net = mine.hits - theirs.hits;
    if (net >= 3) return "crit";
    if (net >= 1) return "hit";
    if (net === 0 && mine.hits > 0) return "graze";
    return "miss";
}

function poolSizes(r, roll) {
    const adv = Math.max(-1, Math.min(1, (Number(r.adv) || 0) + (Number(roll?.adv) || 0)));
    const mine = Math.max(0, Math.min(POOL_MAX, (Number(r.pool) || 0) + adv + Math.trunc(Number(roll?.bonus) || 0)));
    return { mine, theirs: Math.max(0, Math.min(POOL_MAX, Number(r.opp) || 0)), adv };
}

function poolUsable(r) {
    return !!r && (r.impossible || Number.isFinite(r.pool));
}

export function poolResolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!poolUsable(r)) return oracleResolve(ctx, group);
    const { mine, theirs, adv } = poolSizes(r, roll);
    const a = poolRoll(ctx.rng, mine, !!roll.explode);
    const b = poolRoll(ctx.rng, theirs, false);
    const key = poolKey(a, b, r.impossible);
    const detail = `${mine}d6 ${a.hits} hit${a.hits === 1 ? "" : "s"}${theirs ? ` vs ${theirs}d6 ${b.hits}` : ""}${adv ? (adv > 0 ? " adv" : " dis") : ""}${r.impossible ? ", impossible" : ""}`;
    return diceOutcome(group, key, { roll: a.hits - b.hits, faces: a.faces, face: a.hits, pool: mine, opp: theirs, adv, detail });
}

export function poolAnnotate(group) {
    const r = group?.roll;
    if (!poolUsable(r)) return;
    const { mine, theirs } = poolSizes(r, null);
    const odds = sampledOdds(group, rng => poolKey(poolRoll(rng, mine, false), poolRoll(rng, theirs, false), r.impossible), "pool");
    if (odds) group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

const POOL_ORACLE_RULES = diceRollRules(
    "HARD ROLL RULES — the engine rolls dice pools: the FIRST side of each group rolls `pool` d6, the opposition rolls `opp` d6, every 5-6 is a hit and the hits compare; you set the pool sizes:",
    '- Every group carries ONE <roll actor="First side\'s actor" pool="N" opp="N" adv="false">reason</roll>. pool = the actor\'s relevant attribute + skill in dice (1-2 untrained or weak, 3-4 capable, 5-6 expert, 7+ legendary), plus passives and statuses. opp = the opposing side\'s defending attribute + skill the same way, or the difficulty of an unopposed feat (0 trivial, 2 solid, 4 hard). The reason cites the sheet entries, in a few words.',
    "the engine then always fails it",
);

const POOL_ORACLE_TIER_RULE = diceFiveTierRule(
    "no hits and half the dice show 1",
    "fewer hits than the opposition",
    "a tie: it half-works, at a cost",
    "more hits",
    "3 or more hits ahead",
);

function poolOracleExample(stakes) {
    return diceExample(stakes, '<roll actor="Kael" pool="5" opp="3" adv="false">Strength 3 + Cleave 2; Goblin A dodges with Agility 2 + Nimble 1</roll>');
}

export const dicePool = {
    id: "dice.pool",
    label: "Dice pools",
    hint: "Stats become pools of d6; 5-6 succeed and the opposed pools compare.",
    icon: "fa-dice",
    sides: 6,
    resolve: poolResolve,
    annotate: poolAnnotate,
    oracle: { rules: POOL_ORACLE_RULES, tierRule: POOL_ORACLE_TIER_RULE, example: poolOracleExample },
};
