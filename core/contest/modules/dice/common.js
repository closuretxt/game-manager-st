// Shared pieces of the dice modules that roll from oracle inputs (2d6 bands,
// pools, percentile, step dice, the deck, homebrew formulas): the outcome
// record, exploding dice, display odds by sampling and the oracle prompt
// lines every one of them repeats. Pure.

import { makeRng, rollDie } from "../../rng.js";
import { oracleTierKey } from "./oracle.js";
import { d20TierIndex } from "./d20.js";

export function diceSigned(n) {
    return n >= 0 ? `+${n}` : `${n}`;
}

// One die; with `explode`, a max face rolls again and adds (at most `cap`
// extra rolls, so a run of sixes can never loop).
export function rollExploding(rng, sides, explode, cap = 5) {
    const faces = [rollDie(rng, sides)];
    while (explode && faces[faces.length - 1] === sides && faces.length <= cap) faces.push(rollDie(rng, sides));
    return { total: faces.reduce((a, b) => a + b, 0), faces, exploded: faces.length > 1 };
}

// The shared Outcome for a rolled key: lands on the oracle's matching tier,
// or the nearest one it wrote (same fallback as d20).
export function diceOutcome(group, key, extra = {}) {
    const tierIndex = d20TierIndex(group?.tiers, key);
    const tier = (group?.tiers || [])[tierIndex] || null;
    return {
        tierIndex,
        name: tier?.name || "",
        key: tier ? oracleTierKey(tier.name) : key,
        chance: Math.round(Number(tier?.chance) || 0),
        faces: [],
        ...extra,
    };
}

// Display odds for the bubble's bars: `sample(rng)` rolls the group once and
// returns its key. A fixed seed keeps the bars steady while the reply
// streams. The stream re-parses every group per chunk, so the cache is keyed
// by the roll inputs, not the group object.
const DICE_ODDS_CACHE = new Map();

export function sampledOdds(group, sample, key = "", n = 800) {
    const tiers = group?.tiers || [];
    if (!tiers.length) return null;
    const sig = JSON.stringify([key, group.roll, tiers.map(t => t.name)]);
    if (DICE_ODDS_CACHE.has(sig)) return DICE_ODDS_CACHE.get(sig);
    const rng = makeRng(97);
    const pct = tiers.map(() => 0);
    for (let i = 0; i < n; i++) {
        const idx = d20TierIndex(tiers, sample(rng));
        if (idx >= 0) pct[idx] += 100 / n;
    }
    const out = pct.map(x => Math.round(x));
    if (DICE_ODDS_CACHE.size > 64) DICE_ODDS_CACHE.clear();
    DICE_ODDS_CACHE.set(sig, out);
    return out;
}

// The sheet-reading rules every roll-input module shares (they mirror
// dice.d20's), behind the module's own header and roll line.
export function diceRollRules(header, rollLine, impossibleNote) {
    return [
        header,
        rollLine,
        `- UNKNOWN ABILITIES = IMPOSSIBLE. An action naming an ability/technique/spell NOT on the actor's sheet gets impossible="true" on its <roll> (${impossibleNote}); its failure tiers describe the misfire.`,
        "- HEALTH CAPS PERFORMANCE. Below ~25% of their stakes resource, agile or demanding actions get adv=\"dis\" and clearly worse numbers.",
        "- ATTRIBUTES & PASSIVES DECIDE. Match each action to its attribute and read passives/statuses — they must visibly move the numbers you set. Large stat gaps show as large gaps.",
        '- Skills marked on cooldown (*) cannot be used: impossible="true".',
        "- Non-combat struggles (grapples, debates, arm wrestling, escapes) resolve the same way, judged by the relevant attributes.",
    ];
}

export function diceFiveTierRule(fumble, miss, graze, hit, crit) {
    return `- Tiers are read from the FIRST side's point of view. Write all five, WITHOUT chance attributes (the dice decide): Critical Failure (${fumble}), Failure (${miss}), Partial Success (${graze}), Success (${hit}), Critical Success (${crit}).`;
}

// The five-tier example group under a module's own <roll> line.
export function diceExample(stakes, rollLine) {
    return [
        '<clash title="Kael\'s Cleave vs Goblin A\'s Club">',
        '<side who="party" actor="Kael" speed="3" action="Cleave at Goblin A"/>',
        '<side who="enemy" actor="Goblin A" speed="2" action="Club swing at Kael"/>',
        rollLine,
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
