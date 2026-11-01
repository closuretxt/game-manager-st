// dice.percentile — d100 roll-under (plans/combat-modules.md 4.3): the oracle
// sets the first side's chance in %; code rolls d100. Under a fifth of the
// chance, or doubles (11, 22...) under it = critical; under the chance =
// success; missing by up to `graze` (default 10) = partial; 96+ that misses
// = fumble. Each point of mutator bonus is worth 5%. Advantage rolls twice
// and keeps the lower.

import { rollDie } from "../../rng.js";
import { oracleResolve } from "./oracle.js";
import { diceOutcome, sampledOdds, diceRollRules, diceFiveTierRule, diceExample } from "./common.js";

export function percentileKey(face, target, graze, impossible) {
    if (impossible) return face >= 96 ? "fumble" : "miss";
    if (face <= target) {
        if (face <= Math.max(1, Math.floor(target / 5)) || (face % 11 === 0 && face < 100)) return "crit";
        return "hit";
    }
    if (face >= 96) return "fumble";
    if (face <= target + graze) return "graze";
    return "miss";
}

function percentileGraze(opts) {
    const g = Number(opts?.["dice.percentile"]?.graze);
    return Number.isFinite(g) && g >= 0 ? Math.trunc(g) : 10;
}

function percentileUsable(r) {
    return !!r && (r.impossible || Number.isFinite(r.target));
}

function percentileFace(rng, adv) {
    const faces = [rollDie(rng, 100)];
    if (adv) faces.push(rollDie(rng, 100));
    return { face: adv > 0 ? Math.min(...faces) : adv < 0 ? Math.max(...faces) : faces[0], faces };
}

export function percentileResolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!percentileUsable(r)) return oracleResolve(ctx, group);
    const adv = Math.max(-1, Math.min(1, (Number(r.adv) || 0) + (Number(roll.adv) || 0)));
    const bonus = Math.trunc(Number(roll.bonus) || 0);
    const target = Math.max(1, Math.min(99, (Number(r.target) || 0) + bonus * 5));
    const { face, faces } = percentileFace(ctx.rng, adv);
    const key = percentileKey(face, target, percentileGraze(ctx.opts), r.impossible);
    const dieText = `d100 ${faces.join("/")}${adv > 0 ? " adv" : adv < 0 ? " dis" : ""}`;
    const detail = r.impossible ? `${dieText}, impossible` : `${dieText} vs ${target}%${bonus ? ` (${bonus > 0 ? "+" : ""}${bonus * 5}%)` : ""}`;
    return diceOutcome(group, key, { roll: face, faces, face, target, adv, detail });
}

export function percentileAnnotate(group, opts) {
    const r = group?.roll;
    if (!percentileUsable(r)) return;
    const graze = percentileGraze(opts);
    const adv = Math.max(-1, Math.min(1, Number(r.adv) || 0));
    const odds = sampledOdds(group, rng => percentileKey(percentileFace(rng, adv).face, r.target || 1, graze, r.impossible), `pct${graze}`);
    if (odds) group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

const PERCENTILE_ORACLE_RULES = diceRollRules(
    "HARD ROLL RULES — the engine rolls d100 under the FIRST side's chance for each group; you set the chance:",
    '- Every group carries ONE <roll actor="First side\'s actor" target="N" adv="false">reason</roll>. target = the actor\'s chance in % (1-99) to pull THIS action off against THIS opposition: the actor\'s skill or attribute rating, raised by passives and favorable statuses, lowered by the opposition\'s skill, defenses and the difficulty. 50 = an even match; outclassed actors sit at 20 or less. The reason cites the sheet entries, in a few words.',
    "the engine then always fails it",
);

const PERCENTILE_ORACLE_TIER_RULE = diceFiveTierRule(
    "96-100 and over the chance",
    "over the chance",
    "just over the chance: it half-works, at a cost",
    "under the chance",
    "under a fifth of the chance, or doubles under it",
);

function percentileOracleExample(stakes) {
    return diceExample(stakes, '<roll actor="Kael" target="55" adv="false">Swords 65; Goblin A\'s Nimble -10</roll>');
}

export const dicePercentile = {
    id: "dice.percentile",
    label: "Percentile (d100)",
    hint: "The oracle sets a % chance; d100 under it succeeds, under a fifth is critical.",
    icon: "fa-percent",
    sides: 100,
    options: [{ key: "graze", label: "Partial success margin (%)", type: "number", min: 0, max: 30, default: 10 }],
    resolve: percentileResolve,
    annotate: percentileAnnotate,
    oracle: { rules: PERCENTILE_ORACLE_RULES, tierRule: PERCENTILE_ORACLE_TIER_RULE, example: percentileOracleExample },
};
