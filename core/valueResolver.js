// VALUE RESOLVER — the single modular gate for every LLM-reported numeric
// value: arithmetic expressions ("15-9+2", "(18/2)-3", "2*4") and TRUE-RNG
// dice notation ("1d20", "2d6+3", "(2d10)*2", "8/1d2" for 50% triggers).
//
// Built as a REGISTRY so future value features plug in by type and source
// without touching any call site: registerValueResolver({ id, sources, test,
// resolve }) — resolveValue(raw, { source }) walks the registry, filtered by
// where the value came from (tool tags, enemy blocks, transactions...), and
// falls back to Number() exactly like before. Pure math never rolls; only
// expressions containing at least one die do — each roll fires an onDiceRoll
// event (subscribers: notifications, so the player sees every true roll).
//
// The parser never imports UI: consumers subscribe to events instead.

// Shared with the other LLM-output parsers (prePass, setupWizard) via
// toolParser — kept verbatim from the original toolParser implementation.
const EXPR_RE = /^[+\-*/().\s\d]+$/;
const EXPR_DEPTH_MAX = 50;
export function resolveNumericExpr(raw) {
    const s = String(raw ?? "").trim();
    if (!s || !EXPR_RE.test(s)) return null;
    let pos = 0;
    let depth = 0;
    const peek = () => s[pos];
    const skip = () => { while (pos < s.length && s[pos] === " ") pos++; };
    const parseExpr = () => {
        let v = parseTerm();
        for (;;) {
            skip();
            const c = peek();
            if (c === "+" || c === "-") { pos++; const r = parseTerm(); v = c === "+" ? v + r : v - r; }
            else return v;
        }
    };
    const parseTerm = () => {
        let v = parseFactor();
        for (;;) {
            skip();
            const c = peek();
            if (c === "*" || c === "/") { pos++; const r = parseFactor(); v = c === "*" ? v * r : (r === 0 ? NaN : v / r); }
            else return v;
        }
    };
    const parseFactor = () => {
        skip();
        if (peek() === "+") { pos++; return parseFactor(); }
        if (peek() === "-") { pos++; return -parseFactor(); }
        if (peek() === "(") {
            if (++depth > EXPR_DEPTH_MAX) { pos = s.length; return NaN; }
            pos++;
            const v = parseExpr();
            skip();
            if (peek() !== ")") { pos = s.length; return NaN; }
            pos++;
            depth--;
            return v;
        }
        const start = pos;
        while (pos < s.length && /[\d.]/.test(s[pos])) pos++;
        return start === pos ? NaN : Number(s.slice(start, pos));
    };
    const result = parseExpr();
    skip();
    if (pos !== s.length || !Number.isFinite(result)) return null;
    return result;
}

//

// Dice notation: NdM or dM (1 die implied), case-insensitive, no spaces
// inside a token ("2d6", "d20", "3D8"). Guards keep absurd LLM output from
// rolling forever; anything out of bounds rejects the whole expression so it
// falls through the usual malformed-value path.
const DICE_TOKEN_RE = /\b(\d*)[dD](\d+)\b/g;
const DICE_EXPR_RE = /^[+\-*/().\s\d dD]+$/; // math charset + the die letter
const DICE_MAX_DICE = 200;
const DICE_MAX_SIDES = 1000;

// Rolls every NdM token in the string, returning the expression with each
// token substituted by its rolled total plus the per-token roll detail —
// or null when a token is malformed/out of bounds (never throws).
function rollDiceTokens(s) {
    const rolls = [];
    let rolled;
    try {
        rolled = s.replace(DICE_TOKEN_RE, (token, nStr, sidesStr) => {
            const n = nStr === "" ? 1 : Number(nStr);
            const sides = Number(sidesStr);
            if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 1 || n > DICE_MAX_DICE || sides > DICE_MAX_SIDES) throw new Error("dice-out-of-bounds");
            // True RNG — one Math.random() per die, values kept for the popup.
            const values = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
            const total = values.reduce((a, b) => a + b, 0);
            rolls.push({ token, values, total });
            return String(total);
        });
    } catch (e) {
        return null;
    }
    return rolls.length ? { rolled, rolls } : null;
}

//

// Dice-roll event bus — subscribers (notifications) render the popup; the
// resolver stays UI-agnostic.
const diceRollHandlers = new Set();

export function onDiceRoll(handler) {
    diceRollHandlers.add(handler);
    return () => diceRollHandlers.delete(handler);
}

function emitDiceRoll(event) {
    for (const handler of diceRollHandlers) {
        try {
            handler(event);
        } catch (e) {
            console.error("[Game Manager] dice-roll listener failed:", e);
        }
    }
}

//

// Resolver registry — ordered; the first resolver whose test passes (and
// whose sources include the value's origin, or "global") wins. resolve()
// returns { value, ...meta } or null to defer to the next resolver / the
// Number() fallback.
const resolvers = [];

export function registerValueResolver({ id, sources = ["global"], test, resolve }) {
    if (typeof id !== "string" || typeof test !== "function" || typeof resolve !== "function") return null;
    const entry = { id, sources, test, resolve };
    resolvers.push(entry);
    return entry;
}

// DICE resolver — any expression containing at least one NdM token: rolls
// true dice, substitutes the totals and evaluates the remaining pure math.
registerValueResolver({
    id: "dice",
    sources: ["global"],
    test: s => DICE_EXPR_RE.test(s) && /\d*[dD]\d+/.test(s),
    resolve: (s, { source }) => {
        const rolled = rollDiceTokens(s);
        if (!rolled) return null;
        const value = resolveNumericExpr(rolled.rolled);
        if (value === null) return null;
        // Popup detail: "4+4" per multi-dice token; hidden when the whole
        // expression is a single plain token (1d20 → 17 needs no echo).
        const detail = (rolled.rolls.length === 1 && s.replace(/\s/g, "").toLowerCase() === rolled.rolls[0].token.toLowerCase())
            ? ""
            : rolled.rolls.map(r => r.values.join("+")).join(", ");
        emitDiceRoll({ expr: s, total: value, detail, source, rolls: rolled.rolls });
        return { value };
    },
});

// MATH resolver — the original pure-arithmetic parser (no dice letters).
registerValueResolver({
    id: "math",
    sources: ["global"],
    test: s => /^[+\-*/().\s\d]+$/.test(s) && /\d/.test(s),
    resolve: s => {
        const value = resolveNumericExpr(s);
        return value === null ? null : { value };
    },
});

//

// Resolves an LLM-reported numeric value: registry resolvers filtered by the
// value's source ("tool_action", "enemy", "shared", "exp", "transaction" —
// or "global" when the origin is irrelevant), then the plain Number()
// fallback whose NaN propagates to the caller's existing NaN handling.
// Undefined/null/empty pass through untouched.
export function resolveValue(raw, { source = "global" } = {}) {
    if (raw === undefined || raw === null || raw === "") return raw;
    const s = String(raw).trim();
    for (const resolver of resolvers) {
        if (!resolver.sources.includes("global") && !resolver.sources.includes(source)) continue;
        if (!resolver.test(s)) continue;
        const out = resolver.resolve(s, { source });
        if (out !== null && out !== undefined && Number.isFinite(out.value)) return out.value;
    }
    return Number(s);
}
