// Seeded RNG for contest rounds (plans/combat-modules.md 3.9).
// Every roll of a round — tier picks AND the dice inside effect deltas — comes
// from one seed stored on the user message (gm_contest.seed), so a round can
// be audited or re-derived, and tests run with a fixed seed. Pure: no
// SillyTavern imports (the test harness loads this file as plain source).

// mulberry32: tiny, fast, good enough for game dice.
export function makeRng(seed) {
    let a = (Number(seed) >>> 0) || 1;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function newSeed() {
    return (Math.floor(Math.random() * 0xFFFFFFFF) >>> 0) || 1;
}

export function rollDie(rng, sides) {
    return 1 + Math.floor(rng() * sides);
}

// Same bounds as core/valueResolver.js: absurd LLM dice reject the whole
// expression instead of rolling forever.
const CONTEST_DICE_RE = /\b(\d*)[dD](\d+)\b/g;
const CONTEST_EXPR_RE = /^[+\-*/().\s\ddD]+$/;
const CONTEST_MAX_DICE = 200;
const CONTEST_MAX_SIDES = 1000;

// Evaluates an effect delta ("-(1d10+4)", "-8", "2d6+STR" is rejected) with
// the seeded RNG. `evalMath` is the shared pure-arithmetic parser
// (resolveNumericExpr). Returns { value, rolls } or null when malformed.
export function rollExpr(expr, rng, evalMath) {
    const s = String(expr ?? "").trim();
    if (!s || !CONTEST_EXPR_RE.test(s)) return null;
    const rolls = [];
    let bad = false;
    const replaced = s.replace(CONTEST_DICE_RE, (token, nStr, sidesStr) => {
        const n = nStr === "" ? 1 : Number(nStr);
        const sides = Number(sidesStr);
        if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 1 || n > CONTEST_MAX_DICE || sides > CONTEST_MAX_SIDES) {
            bad = true;
            return "0";
        }
        const values = Array.from({ length: n }, () => rollDie(rng, sides));
        const total = values.reduce((a, b) => a + b, 0);
        rolls.push({ token, values, total });
        return String(total);
    });
    if (bad) return null;
    const value = evalMath(replaced);
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    return { value, rolls };
}

// Weighted pick over `items` by `weightOf(item)`. All-zero weights fall back
// to a uniform pick. Returns { index, roll } where roll is the 1-100 point
// the pick landed on (shown in the results message).
export function weightedPick(items, weightOf, rng) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { index: -1, roll: 0 };
    const weights = list.map(it => Math.max(0, Number(weightOf(it)) || 0));
    const total = weights.reduce((a, b) => a + b, 0);
    const r = rng();
    if (total <= 0) {
        const index = Math.min(list.length - 1, Math.floor(r * list.length));
        return { index, roll: Math.floor(r * 100) + 1 };
    }
    let point = r * total;
    for (let i = 0; i < list.length; i++) {
        point -= weights[i];
        if (point < 0) return { index: i, roll: Math.floor(r * 100) + 1 };
    }
    return { index: list.length - 1, roll: 100 };
}
