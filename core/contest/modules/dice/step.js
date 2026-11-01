// dice.step — step dice (plans/combat-modules.md 4.3): stats are die sizes
// (d4 weak ... d12 superb, d20 legendary). The oracle sets the first side's
// die and the opposition's; both roll, a max face explodes (rolls again and
// adds), and the margin decides: 6+ ahead = critical, ahead = success, a tie
// = partial, behind = failure, behind on a natural 1 = fumble. A group with
// no opposing die rolls against a d6. Advantage rolls the first side's die
// twice and keeps the better.

import { oracleResolve } from "./oracle.js";
import { diceSigned, rollExploding, diceOutcome, sampledOdds, diceRollRules, diceFiveTierRule, diceExample } from "./common.js";

const STEP_EXPLODE_CAP = 3;

export function stepKey(mine, theirs, impossible) {
    const margin = mine.total - theirs.total;
    const natOne = mine.faces[0] === 1;
    if (impossible) return natOne ? "fumble" : "miss";
    if (margin >= 6) return "crit";
    if (margin >= 1) return "hit";
    if (margin === 0) return "graze";
    return natOne ? "fumble" : "miss";
}

function stepUsable(r) {
    return !!r && (r.impossible || Number.isFinite(r.die));
}

// The first side's roll, with advantage (best of two) and a flat bonus.
function stepMine(rng, die, adv, bonus) {
    let best = rollExploding(rng, die, true, STEP_EXPLODE_CAP);
    if (adv) {
        const other = rollExploding(rng, die, true, STEP_EXPLODE_CAP);
        if (adv > 0 ? other.total > best.total : other.total < best.total) best = other;
    }
    return { ...best, total: best.total + bonus };
}

export function stepResolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!stepUsable(r)) return oracleResolve(ctx, group);
    const die = r.die || 6;
    const vs = r.vs || 6;
    const adv = Math.max(-1, Math.min(1, (Number(r.adv) || 0) + (Number(roll.adv) || 0)));
    const bonus = Math.trunc(Number(roll.bonus) || 0);
    const mine = stepMine(ctx.rng, die, adv, bonus);
    const theirs = rollExploding(ctx.rng, vs, true, STEP_EXPLODE_CAP);
    const key = stepKey(mine, theirs, r.impossible);
    const detail = `d${die} ${mine.faces.join("+")}${bonus ? ` ${diceSigned(bonus)}` : ""}${adv > 0 ? " adv" : adv < 0 ? " dis" : ""} = ${mine.total} vs d${vs} ${theirs.total}${r.impossible ? ", impossible" : ""}`;
    return diceOutcome(group, key, { roll: mine.total - theirs.total, faces: mine.faces, face: mine.faces[0], die, vs, adv, detail });
}

export function stepAnnotate(group) {
    const r = group?.roll;
    if (!stepUsable(r)) return;
    const die = r.die || 6;
    const vs = r.vs || 6;
    const adv = Math.max(-1, Math.min(1, Number(r.adv) || 0));
    const odds = sampledOdds(group, rng => stepKey(stepMine(rng, die, adv, 0), rollExploding(rng, vs, true, STEP_EXPLODE_CAP), r.impossible), "step");
    if (odds) group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

const STEP_ORACLE_RULES = diceRollRules(
    "HARD ROLL RULES — the engine rolls opposed step dice: the FIRST side of each group rolls `die`, the opposition rolls `vs`, a max face explodes, the higher total wins; you set the dice sizes:",
    '- Every group carries ONE <roll actor="First side\'s actor" die="d8" vs="d6" adv="false">reason</roll>. Sizes: d4 weak or untrained, d6 average, d8 trained, d10 expert, d12 superb, d20 legendary — from the relevant attribute and skill, stepped up or down by passives and statuses. vs = the opposing side\'s defending die the same way, or the difficulty of an unopposed feat (d4 easy, d6 solid, d8 hard, d12 heroic). The reason cites the sheet entries, in a few words.',
    "the engine then always fails it",
);

const STEP_ORACLE_TIER_RULE = diceFiveTierRule(
    "behind on a natural 1",
    "behind",
    "a tie: it half-works, at a cost",
    "ahead",
    "6 or more ahead",
);

function stepOracleExample(stakes) {
    return diceExample(stakes, '<roll actor="Kael" die="d10" vs="d6" adv="false">Strength d8, Cleave mastery steps it to d10; Goblin A\'s Nimble d6</roll>');
}

export const diceStep = {
    id: "dice.step",
    label: "Step dice",
    hint: "Stats are die sizes (d4-d12); opposed rolls, a max face explodes.",
    icon: "fa-dice-d6",
    sides: 12,
    resolve: stepResolve,
    annotate: stepAnnotate,
    oracle: { rules: STEP_ORACLE_RULES, tierRule: STEP_ORACLE_TIER_RULE, example: stepOracleExample },
};
