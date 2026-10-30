// dice.d20 — d20 + modifier vs DC (plans/combat-modules.md 3.5, 4.3). The
// oracle reads the sheets and sets, per group, the first side's modifier, the
// DC and advantage, with a short reason; code rolls. Natural 20 = crit,
// natural 1 = fumble, missing the DC by up to `graze` (default 2) = graze.
// A group without a usable <roll> falls back to the oracle's chances: a sloppy
// reply degrades, never breaks.
//
// group.roll (core/contest/parse.js) = { actor, mod, dc, adv: -1|0|1, impossible, reason }
// roll (engine, per group) = { bonus, adv, notes } — mutators adjust it.

import { rollDie } from "../../rng.js";
import { oracleResolve, oracleTierKey } from "./oracle.js";

// When the oracle left a tier out, the die lands on the nearest one.
const D20_TIER_FALLBACK = {
    crit: ["crit", "hit"],
    hit: ["hit", "crit", "graze"],
    graze: ["graze", "miss"],
    miss: ["miss", "fumble"],
    fumble: ["fumble", "miss"],
};

export function d20TierIndex(tiers, key) {
    const keys = (tiers || []).map(t => oracleTierKey(t.name));
    for (const k of D20_TIER_FALLBACK[key] || [key]) {
        const i = keys.indexOf(k);
        if (i !== -1) return i;
    }
    return keys.length ? 0 : -1;
}

// An impossible action (unknown ability, skill on cooldown) never succeeds,
// natural 20 included.
export function d20Key(face, total, dc, graze, impossible) {
    if (impossible) return face <= 5 ? "fumble" : "miss";
    if (face === 20) return "crit";
    if (face === 1) return "fumble";
    if (total >= dc) return "hit";
    if (total >= dc - graze) return "graze";
    return "miss";
}

function d20Usable(r) {
    return !!r && (r.impossible || Number.isFinite(r.dc));
}

function d20Graze(opts) {
    const g = Number(opts?.["dice.d20"]?.graze);
    return Number.isFinite(g) && g >= 0 ? Math.trunc(g) : 2;
}

function signed(n) {
    return n >= 0 ? `+${n}` : `${n}`;
}

export function d20Resolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!d20Usable(r)) return oracleResolve(ctx, group);
    const adv = Math.max(-1, Math.min(1, (Number(r.adv) || 0) + (Number(roll.adv) || 0)));
    const faces = [rollDie(ctx.rng, 20)];
    if (adv) faces.push(rollDie(ctx.rng, 20));
    const face = adv > 0 ? Math.max(...faces) : adv < 0 ? Math.min(...faces) : faces[0];
    const mod = Math.trunc(Number(r.mod) || 0);
    const bonus = Math.trunc(Number(roll.bonus) || 0);
    const total = face + mod + bonus;
    const key = d20Key(face, total, r.dc, d20Graze(ctx.opts), r.impossible);
    const tierIndex = d20TierIndex(group.tiers, key);
    const tier = (group.tiers || [])[tierIndex] || null;
    const dieText = `d20 ${faces.join("/")}${adv > 0 ? " adv" : adv < 0 ? " dis" : ""}`;
    const detail = r.impossible
        ? `${dieText}, impossible`
        : `${dieText} ${signed(mod)}${bonus ? ` ${signed(bonus)}` : ""} = ${total} vs DC ${r.dc}`;
    return {
        tierIndex,
        name: tier?.name || "",
        // The landed tier's key (it differs from the die's when the oracle
        // left that tier out): lines and mutators follow what was applied.
        key: tier ? oracleTierKey(tier.name) : key,
        chance: Math.round(Number(tier?.chance) || 0),
        roll: total,
        faces,
        face,
        mod,
        bonus,
        dc: r.dc,
        adv,
        detail,
    };
}

// Per-tier odds in % for the bubble's bars (the die decides, but the player
// sees what they are up against). null when the group has no usable roll.
export function d20Odds(group, graze = 2) {
    const r = group?.roll;
    const tiers = group?.tiers || [];
    if (!d20Usable(r) || !tiers.length) return null;
    const pct = tiers.map(() => 0);
    const mod = Math.trunc(Number(r.mod) || 0);
    for (let face = 1; face <= 20; face++) {
        const p = r.adv > 0 ? (2 * face - 1) / 400 : r.adv < 0 ? (41 - 2 * face) / 400 : 1 / 20;
        const i = d20TierIndex(tiers, d20Key(face, face + mod, r.dc, graze, r.impossible));
        if (i >= 0) pct[i] += p * 100;
    }
    return pct.map(x => Math.round(x));
}

// Display only: fills each tier's chance from the odds so the bubble draws
// real bars. Leaves the group alone when the oracle gave no usable roll (its
// own chances, if any, then drive the fallback pick).
export function d20Annotate(group, opts) {
    const odds = d20Odds(group, d20Graze(opts));
    if (!odds) return;
    group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

const D20_ORACLE_RULES = [
    "HARD ROLL RULES — the engine rolls d20 + mod against the DC for the FIRST side of each group; you set the numbers:",
    '- Every group carries ONE <roll actor="First side\'s actor" mod="+N" dc="N" adv="false">reason</roll>. mod = the actor\'s relevant attribute/skill bonus plus passives and statuses. dc = what the opposition makes it: the target\'s defense or evasion, the opposing side\'s own skill, the difficulty of the feat — 10 easy, 15 solid, 20 hard, 25 heroic. adv="true" when the circumstances clearly favor the roll, "dis" when they hinder it, "false" otherwise. The reason cites the sheet entries that set mod and dc, in a few words.',
    '- UNKNOWN ABILITIES = IMPOSSIBLE. An action naming an ability/technique/spell NOT on the actor\'s sheet gets impossible="true" on its <roll> (the engine then always fails it); its failure tiers describe the misfire.',
    "- HEALTH CAPS PERFORMANCE. Below ~25% of their stakes resource, agile or demanding actions get disadvantage and a mod penalty of -4 or worse.",
    "- ATTRIBUTES & PASSIVES DECIDE. Match each action to its attribute and read passives/statuses — they must visibly move mod and dc. Large stat gaps show as a large gap between mod and dc: an outclassed actor should need 15 or more on the die.",
    '- Skills marked on cooldown (*) cannot be used: impossible="true".',
    "- Non-combat struggles (grapples, debates, arm wrestling, escapes) resolve the same way, judged by the relevant attributes.",
];

const D20_ORACLE_TIER_RULE = "- Tiers are read from the FIRST side's point of view. Write all five, WITHOUT chance attributes (the die decides): Critical Failure (natural 1), Failure, Partial Success (missed the DC by 1-2: it half-works, at a cost), Success, Critical Success (natural 20).";

function d20OracleExample(stakes) {
    return [
        '<clash title="Kael\'s Cleave vs Goblin A\'s Club">',
        '<side who="party" actor="Kael" speed="3" action="Cleave at Goblin A"/>',
        '<side who="enemy" actor="Goblin A" speed="2" action="Club swing at Kael"/>',
        '<roll actor="Kael" mod="+5" dc="13" adv="false">Strength +3, Cleave mastery +2; Goblin A\'s hide armor and Nimble set DC 13</roll>',
        '<tier name="Critical Failure">Kael\'s cleave goes wide and the club cracks his ribs.',
        `<effect by="Goblin A" target="Kael" resource="${stakes}" delta="-(1d6+4)"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Failure">Kael misses; the club clips his shoulder.',
        `<effect by="Goblin A" target="Kael" resource="${stakes}" delta="-(1d6)"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Partial Success">Kael\'s cleave nicks the goblin as the club glances off his guard.',
        `<effect by="Kael" target="Goblin A" resource="${stakes}" delta="-(1d6)"/><effect by="Goblin A" target="Kael" resource="${stakes}" delta="-2"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Success">Kael\'s cleave bites into the goblin before the club lands.',
        `<effect by="Kael" target="Goblin A" resource="${stakes}" delta="-(2d6+3)"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        '<tier name="Critical Success">Kael cleaves straight through the goblin\'s guard.',
        `<effect by="Kael" target="Goblin A" resource="${stakes}" delta="-(2d6+3)*2"/><effect by="Kael" target="Goblin A" state="dead"/><effect by="Kael" target="Kael" resource="Stamina" delta="-5"/></tier>`,
        "</clash>",
    ];
}

export const diceD20 = {
    id: "dice.d20",
    label: "d20 vs DC",
    resolve: d20Resolve,
    annotate: d20Annotate,
    oracle: { rules: D20_ORACLE_RULES, tierRule: D20_ORACLE_TIER_RULE, example: d20OracleExample },
};
