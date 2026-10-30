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

// What the oracle prompt asks for under this module (3.5): tier chances.
const ORACLE_DICE_RULES = [
    "HARD CHANCE RULES:",
    "- UNKNOWN ABILITIES = IMPOSSIBLE. An action naming an ability/technique/spell NOT on the actor's sheet gets 0% Success and Critical Success: only failure tiers describing the misfire.",
    "- HEALTH CAPS PERFORMANCE. Below ~25% of their stakes resource, agile or demanding actions are near-impossible and attack tiers shift hard toward Failure.",
    "- ATTRIBUTES & PASSIVES DECIDE. Match each action to its attribute and read passives/statuses — they must visibly shift the chances. Large stat gaps skew tiers strongly: the weaker side rarely exceeds ~30% Success.",
    "- Skills marked on cooldown (*) cannot be used: treat the attempt like an unknown ability.",
    "- Non-combat struggles (grapples, debates, arm wrestling, escapes) resolve the same way, judged by the relevant attributes.",
];

const ORACLE_DICE_TIER_RULE = "- Tiers are read from the FIRST side's point of view: Critical Failure / Failure / Success / Critical Success, chances summing to 100.";

function oracleDiceExample(stakes) {
    return [
        '<clash title="Kael\'s Cleave vs Goblin A\'s Club">',
        '<side who="party" actor="Kael" speed="3" action="Cleave at Goblin A"/>',
        '<side who="enemy" actor="Goblin A" speed="2" action="Club swing at Kael"/>',
        '<tier name="Critical Failure" chance="10">Kael\'s cleave goes wide and the club cracks his ribs.',
        `<effect by="Goblin A" target="Kael" resource="${stakes}" delta="-(1d6+4)"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Failure" chance="25">Kael misses; the club clips his shoulder.',
        `<effect by="Goblin A" target="Kael" resource="${stakes}" delta="-(1d6)"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Success" chance="50">Kael\'s cleave bites into the goblin before the club lands.',
        `<effect by="Kael" target="Goblin A" resource="${stakes}" delta="-(2d6+3)"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Critical Success" chance="15">Kael cleaves straight through the goblin\'s guard.',
        `<effect by="Kael" target="Goblin A" resource="${stakes}" delta="-(2d6+3)*2"/><effect by="Kael" target="Goblin A" state="dead"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        "</clash>",
    ];
}

export const diceOracle = {
    id: "dice.oracle",
    label: "Oracle odds (%)",
    resolve: oracleResolve,
    oracle: { rules: ORACLE_DICE_RULES, tierRule: ORACLE_DICE_TIER_RULE, example: oracleDiceExample },
};
