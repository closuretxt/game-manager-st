// dice.oracle — the universal default (plans/combat-modules.md 4.3): the
// oracle sets tier chances from the sheets, code makes the weighted pick.

import { weightedPick } from "../../rng.js";

// Oracle tier names -> the shared Outcome tiers.
const ORACLE_TIER_KEYS = [
    [/crit\w*\s+fail|fumble|disaster|botch/i, "fumble"],
    [/crit\w*\s+succ|critical|crit\b|triumph/i, "crit"],
    [/partial|graze|mixed|cost/i, "graze"],
    [/fail|miss/i, "miss"],
    [/succ|hit/i, "hit"],
];

export function oracleTierKey(name) {
    const n = String(name ?? "");
    for (const [re, key] of ORACLE_TIER_KEYS) if (re.test(n)) return key;
    return "hit";
}

// Outcome: { tierIndex, name, key, chance, roll, faces }.
export function oracleResolve(ctx, group) {
    const tiers = group?.tiers || [];
    const pick = weightedPick(tiers, t => t.chance, ctx.rng);
    const tier = tiers[pick.index] || null;
    return {
        tierIndex: pick.index,
        name: tier?.name || "",
        key: oracleTierKey(tier?.name),
        chance: Math.round(Number(tier?.chance) || 0),
        roll: pick.roll,
        faces: [],
    };
}

export const diceOracle = {
    id: "dice.oracle",
    label: "Oracle odds (%)",
    resolve: oracleResolve,
};
