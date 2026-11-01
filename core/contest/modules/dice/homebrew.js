// dice.homebrew — the chat's own roll (plans/combat-modules.md 4.3): a
// formula (default "1d20+mod", `mod` = the oracle's modifier) against the
// oracle's DC, with tier margins from the ruleset options: DC + crit margin
// = critical, DC = success, up to `graze` under = partial, `fumble` margin or
// more under = fumble. With "natural" on, every die showing its max is a
// critical and every die showing 1 a fumble. Advantage rolls twice and keeps
// the better total.

import { rollExpr } from "../../rng.js";
import { oracleResolve } from "./oracle.js";
import { diceSigned, diceOutcome, sampledOdds, diceRollRules, diceFiveTierRule } from "./common.js";
import { d20OracleExample } from "./d20.js";

const HOMEBREW_DEFAULT_FORMULA = "1d20+mod";

export function homebrewOpts(opts) {
    const o = opts?.["dice.homebrew"] || {};
    const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? "").trim() !== "" && Number(v) >= 0 ? Math.trunc(Number(v)) : d);
    const formula = String(o.formula || "").trim().slice(0, 60) || HOMEBREW_DEFAULT_FORMULA;
    return { formula, crit: num(o.crit, 10), graze: num(o.graze, 2), fumble: num(o.fumble, 10), natural: o.natural !== "off" };
}

// The formula with the oracle's numbers in: "2d10+mod" -> "2d10+(3)".
export function homebrewExpr(formula, mod) {
    return String(formula).replace(/\bmod\b/gi, `(${Math.trunc(Number(mod) || 0)})`);
}

// One roll of the formula -> { total, rolls } | null (a formula rollExpr
// rejects falls back to 1d20 + mod, so a typo never stalls a fight).
function homebrewRoll(rng, formula, mod, evalMath) {
    return rollExpr(homebrewExpr(formula, mod), rng, evalMath) || rollExpr(homebrewExpr(HOMEBREW_DEFAULT_FORMULA, mod), rng, evalMath);
}

export function homebrewKey(rolled, dc, o, impossible) {
    const faces = (rolled.rolls || []).flatMap(x => x.values);
    const sides = (rolled.rolls || []).flatMap(x => x.values.map(() => Number(/[dD](\d+)/.exec(x.token)?.[1]) || 0));
    const allMax = faces.length > 0 && faces.every((f, i) => f === sides[i]);
    const allOne = faces.length > 0 && faces.every(f => f === 1);
    if (impossible) return allOne ? "fumble" : "miss";
    if (o.natural && allMax) return "crit";
    if (o.natural && allOne) return "fumble";
    const total = rolled.value;
    if (total >= dc + o.crit) return "crit";
    if (total >= dc) return "hit";
    if (total >= dc - o.graze) return "graze";
    if (total <= dc - o.fumble) return "fumble";
    return "miss";
}

function homebrewUsable(r) {
    return !!r && (r.impossible || Number.isFinite(r.dc));
}

export function homebrewResolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!homebrewUsable(r)) return oracleResolve(ctx, group);
    const o = homebrewOpts(ctx.opts);
    const evalMath = ctx.ops?.evalMath;
    const adv = Math.max(-1, Math.min(1, (Number(r.adv) || 0) + (Number(roll.adv) || 0)));
    const bonus = Math.trunc(Number(roll.bonus) || 0);
    let rolled = homebrewRoll(ctx.rng, o.formula, r.mod, evalMath);
    if (!rolled) return oracleResolve(ctx, group);
    const tries = [rolled];
    if (adv) {
        const other = homebrewRoll(ctx.rng, o.formula, r.mod, evalMath);
        if (other) {
            tries.push(other);
            if (adv > 0 ? other.value > rolled.value : other.value < rolled.value) rolled = other;
        }
    }
    const result = { ...rolled, value: Math.round(rolled.value) + bonus };
    const key = homebrewKey(result, r.dc, o, r.impossible);
    const faces = (rolled.rolls || []).flatMap(x => x.values);
    const shown = `${o.formula}: ${tries.map(t => Math.round(t.value)).join("/")}${adv > 0 ? " adv" : adv < 0 ? " dis" : ""}`;
    const detail = r.impossible ? `${shown}, impossible` : `${shown}${bonus ? ` ${diceSigned(bonus)}` : ""} = ${result.value} vs DC ${r.dc}`;
    return diceOutcome(group, key, { roll: result.value, faces, face: faces[0] ?? null, mod: Math.trunc(Number(r.mod) || 0), bonus, dc: r.dc, adv, detail });
}

export function homebrewAnnotate(group, opts, evalMath) {
    const r = group?.roll;
    if (!homebrewUsable(r) || typeof evalMath !== "function") return;
    const o = homebrewOpts(opts);
    const adv = Math.max(-1, Math.min(1, Number(r.adv) || 0));
    const odds = sampledOdds(group, rng => {
        let a = homebrewRoll(rng, o.formula, r.mod, evalMath);
        if (!a) return "miss";
        if (adv) {
            const b = homebrewRoll(rng, o.formula, r.mod, evalMath);
            if (b && (adv > 0 ? b.value > a.value : b.value < a.value)) a = b;
        }
        return homebrewKey({ ...a, value: Math.round(a.value) }, r.dc, o, r.impossible);
    }, `hb${JSON.stringify(o)}`);
    if (odds) group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

// The DC scale follows the formula, so the oracle is told what is rolled.
function homebrewOracleRules(opts) {
    const o = homebrewOpts(opts);
    return diceRollRules(
        `HARD ROLL RULES — the engine rolls ${o.formula} for the FIRST side of each group (mod = your modifier) against your DC; you set the numbers:`,
        `- Every group carries ONE <roll actor="First side's actor" mod="+N" dc="N" adv="false">reason</roll>. mod = the actor's relevant attribute/skill bonus plus passives and statuses. dc = what the opposition makes it, on the scale of ${o.formula}: an easy feat succeeds most of the time, a hard one rarely. adv="true" when circumstances clearly favor the roll, "dis" when they hinder it. The reason cites the sheet entries, in a few words.`,
        "the engine then always fails it",
    );
}

function homebrewTierRule(opts) {
    const o = homebrewOpts(opts);
    return diceFiveTierRule(
        `${o.fumble}+ under the DC${o.natural ? ", or every die showing 1" : ""}`,
        "under the DC",
        `up to ${o.graze} under: it half-works, at a cost`,
        "meets the DC",
        `${o.crit}+ over the DC${o.natural ? ", or every die at its max" : ""}`,
    );
}

export const diceHomebrew = {
    id: "dice.homebrew",
    label: "Homebrew formula",
    hint: "Your own roll formula and tier margins against the oracle's DC.",
    icon: "fa-dice-d20",
    sides: 20,
    options: [
        { key: "formula", label: "Roll formula", type: "text", default: HOMEBREW_DEFAULT_FORMULA, hint: "Dice and arithmetic; mod = the oracle's modifier. Example: 3d6+mod, 2d10+mod." },
        { key: "crit", label: "Critical: DC +", type: "number", min: 0, max: 50, default: 10 },
        { key: "graze", label: "Partial: DC -", type: "number", min: 0, max: 20, default: 2 },
        { key: "fumble", label: "Fumble: DC -", type: "number", min: 0, max: 50, default: 10 },
        { key: "natural", label: "Natural max / 1s", type: "select", default: "on", choices: [["on", "Every die max = critical, every die 1 = fumble"], ["off", "Margins only"]] },
    ],
    resolve: homebrewResolve,
    annotate: homebrewAnnotate,
    oracle: { rules: homebrewOracleRules, tierRule: homebrewTierRule, example: d20OracleExample },
};
