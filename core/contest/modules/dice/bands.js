// dice.bands_2d6 — 2d6 + modifier read in bands (plans/combat-modules.md
// 4.3): 6 or less fails (the opposition gets its move), 7-9 succeeds at a
// cost, 10+ succeeds clean, double six is a critical, double one a fumble.
// The oracle sets the modifier from the sheets (no DC: the bands are fixed).
// Advantage rolls 3d6 and keeps the best two (disadvantage the worst two).

import { rollDie } from "../../rng.js";
import { oracleResolve } from "./oracle.js";
import { diceSigned, rollExploding, diceOutcome, sampledOdds, diceRollRules, diceFiveTierRule, diceExample } from "./common.js";

export function bandsKey(a, b, total, impossible) {
    if (impossible) return a === 1 && b === 1 ? "fumble" : "miss";
    if (a === 6 && b === 6) return "crit";
    if (a === 1 && b === 1) return "fumble";
    if (total >= 10) return "hit";
    if (total >= 7) return "graze";
    return "miss";
}

// -> { kept: [a, b], all, extra }: `extra` = exploded pips on top of a six.
function bandsRoll(rng, adv, explode) {
    const all = Array.from({ length: adv ? 3 : 2 }, () => rollDie(rng, 6));
    const sorted = [...all].sort((x, y) => x - y);
    const kept = adv > 0 ? sorted.slice(-2) : adv < 0 ? sorted.slice(0, 2) : all;
    let extra = 0;
    if (explode) for (const f of kept) if (f === 6) extra += rollExploding(rng, 6, true).total;
    return { kept, all, extra };
}

function bandsAdv(r, roll) {
    return Math.max(-1, Math.min(1, (Number(r?.adv) || 0) + (Number(roll?.adv) || 0)));
}

export function bandsResolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!r) return oracleResolve(ctx, group);
    const adv = bandsAdv(r, roll);
    const { kept, all, extra } = bandsRoll(ctx.rng, adv, !!roll.explode);
    const mod = Math.trunc(Number(r.mod) || 0);
    const bonus = Math.trunc(Number(roll.bonus) || 0);
    const total = kept[0] + kept[1] + extra + mod + bonus;
    const key = bandsKey(kept[0], kept[1], total, r.impossible);
    const dice = `2d6 ${kept.join("+")}${extra ? ` +${extra} exploded` : ""}${adv ? ` (${all.join("/")} ${adv > 0 ? "adv" : "dis"})` : ""}`;
    const detail = r.impossible ? `${dice}, impossible` : `${dice} ${diceSigned(mod)}${bonus ? ` ${diceSigned(bonus)}` : ""} = ${total}`;
    return diceOutcome(group, key, { roll: total, faces: all, face: kept[0] + kept[1], mod, bonus, adv, detail });
}

export function bandsAnnotate(group) {
    const r = group?.roll;
    if (!r) return;
    const mod = Math.trunc(Number(r.mod) || 0);
    const odds = sampledOdds(group, rng => {
        const { kept, extra } = bandsRoll(rng, bandsAdv(r, null), false);
        return bandsKey(kept[0], kept[1], kept[0] + kept[1] + extra + mod, r.impossible);
    }, "bands");
    if (odds) group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

const BANDS_ORACLE_RULES = diceRollRules(
    "HARD ROLL RULES — the engine rolls 2d6 + mod for the FIRST side of each group and reads fixed bands (6 or less fails, 7-9 succeeds at a cost, 10+ succeeds); you set the modifier:",
    '- Every group carries ONE <roll actor="First side\'s actor" mod="+N" adv="false">reason</roll>. mod = how well the actor\'s attributes, skills, passives and statuses suit THIS action against THIS opposition, from -3 (hopeless) through 0 (even) to +3 (clearly superior); +4 only for overwhelming superiority. adv="true" when circumstances clearly favor the roll, "dis" when they hinder it, "false" otherwise. The reason cites the sheet entries, in a few words.',
    "the engine then always fails it",
);

const BANDS_ORACLE_TIER_RULE = diceFiveTierRule(
    "double one: it goes badly wrong",
    "6 or less: it fails AND the opposition gets its move — put the opponent's hit or the situation's blow in this tier",
    "7-9: it works, at a cost, a complication or a lesser effect",
    "10+: it works cleanly",
    "double six: it works brilliantly",
);

function bandsOracleExample(stakes) {
    return diceExample(stakes, '<roll actor="Kael" mod="+1" adv="false">Strength +3 against Goblin A\'s Nimble hide armor</roll>');
}

export const diceBands2d6 = {
    id: "dice.bands_2d6",
    label: "2d6 bands",
    hint: "2d6 + modifier: 6- fails (the opposition acts), 7-9 succeeds at a cost, 10+ succeeds.",
    icon: "fa-dice-six",
    sides: 6,
    resolve: bandsResolve,
    annotate: bandsAnnotate,
    oracle: { rules: BANDS_ORACLE_RULES, tierRule: BANDS_ORACLE_TIER_RULE, example: bandsOracleExample },
};
