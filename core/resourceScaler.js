// RESOURCE SCALER — a resource's max is stored verbatim as a number OR a
// formula string ("100+(Level*10)", "80+(Endurance*25)"). This module is the
// single gate that resolves the EFFECTIVE max at read time: variables are
// substituted from the character's live sheet (Level + attribute names) and
// the remaining pure arithmetic is evaluated by the sandboxed value resolver.
//
// The stored value is NEVER mutated — formulas self-update on every level-up
// or attribute change with zero hooks. A failed/unknown formula falls back to
// the last valid result (cached on the entry), so a broken formula degrades
// but never bricks the sheet. Resource-to-resource references are not
// supported (no cycles); only Level and attribute names resolve.

import { resolveNumericExpr } from "./valueResolver.js";

// After substitution the string must be pure arithmetic before evaluation.
const SAFE_EXPR_RE = /^[+\-*/().\s\d]+$/;

// Substitution table for a character: Level (progression track) + every
// attribute value, matched case-insensitively by name.
export function resourceVars(char) {
    const vars = [
        { name: "level", value: Math.max(1, Math.trunc(Number(char?.progression?.level) || 1)) },
    ];
    for (const a of char?.attributes || []) {
        const name = String(a?.name || "").trim();
        if (name) vars.push({ name: name.toLowerCase(), value: Number(a.value) || 0 });
    }
    // Longest names first so "Iron Will" is never half-matched as "Will".
    return vars.sort((x, y) => y.name.length - x.name.length);
}

// Resolves the effective max of a resource entry for a character. Plain
// numbers pass through untouched; formulas are substituted, validated and
// evaluated. Missing max = no cap (Infinity); a BROKEN formula falls back to
// the last valid result, then min, then 0.
export function resolveResourceMax(char, entry) {
    const n = Number(entry?.max);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
    const raw = String(entry?.max ?? "").trim();
    if (!raw) return Number.POSITIVE_INFINITY;
    // Fallback chain: last valid result, then min, then 0.
    const fallback = () => {
        const last = Number(entry?._lastMax);
        if (Number.isFinite(last)) return Math.max(0, Math.round(last));
        const min = Number(entry?.min);
        return Number.isFinite(min) ? Math.max(0, Math.round(min)) : 0;
    };
    let expr = raw;
    for (const v of resourceVars(char)) {
        const src = v.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expr = expr.replace(new RegExp(`\\b${src}\\b`, "gi"), String(v.value));
    }
    const value = SAFE_EXPR_RE.test(expr) && /\d/.test(expr) ? resolveNumericExpr(expr) : null;
    if (value === null || !Number.isFinite(value)) return fallback();
    const resolved = Math.max(0, Math.round(value));
    entry._lastMax = resolved; // cached for fallback when the formula breaks
    return resolved;
}
