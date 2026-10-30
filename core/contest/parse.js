// Tolerant parsers for the contest LLM outputs. Pure (no SillyTavern
// imports) so the tests load them as plain source. Malformed tags are skipped,
// never thrown.

import { parseEffects, stripEffects } from "./effects.js";

function contestAttrs(raw) {
    const out = {};
    const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
    let m;
    while ((m = re.exec(String(raw ?? ""))) !== null) {
        out[m[1].toLowerCase()] = String(m[2] ?? m[3] ?? m[4] ?? "")
            .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    return out;
}

// Oracle reply (possibly partial, while streaming) -> groups. An unterminated
// <clash> is included with the tiers closed so far, so the bubble renders
// groups live; incomplete tiers are skipped.
export function parseOracleGroups(text) {
    const groups = [];
    if (!text) return groups;
    const re = /<clash\b([^>]*?)>([\s\S]*?)(?:<\/clash>|$)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const attrs = contestAttrs(m[1]);
        const body = m[2] || "";
        const sides = [];
        const sideRe = /<side\b([^>]*?)(?:\/>|>)/gi;
        let s;
        while ((s = sideRe.exec(body)) !== null) {
            const a = contestAttrs(s[1]);
            if (!String(a.actor || "").trim()) continue;
            sides.push({
                who: String(a.who || "party").toLowerCase() === "enemy" ? "enemy" : "party",
                actor: String(a.actor).trim(),
                speed: Math.max(0, Math.trunc(Number(a.speed) || 0)),
                action: String(a.action || "").trim().slice(0, 140),
            });
        }
        const tiers = [];
        const tierRe = /<tier\b([^>]*?)>([\s\S]*?)<\/tier>/gi;
        let t;
        while ((t = tierRe.exec(body)) !== null) {
            const a = contestAttrs(t[1]);
            tiers.push({
                name: String(a.name || "").trim(),
                chance: Math.max(0, Number(a.chance) || 0),
                outcome: stripEffects(t[2]).replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
                effects: parseEffects(t[2]),
            });
        }
        groups.push({ title: String(attrs.title || "Clash").slice(0, 100), sides, tiers });
    }
    return groups;
}

// Final groups: at least one side and two named tiers each.
export function sanitizeOracleGroups(groups) {
    return (Array.isArray(groups) ? groups : [])
        .map(g => ({
            title: String(g?.title || "Clash").slice(0, 100),
            sides: (g?.sides || []).filter(sd => sd?.actor),
            tiers: (g?.tiers || []).filter(t => t?.name && t.outcome),
        }))
        .filter(g => g.sides.length && g.tiers.length >= 2);
}

// Pre-pass ally acts: <act actor="Mara" speed="3" title="Cover Kael">intent</act>.
export function parseActs(text) {
    const out = [];
    const re = /<act\b([^>]*?)(?:\/>|>([\s\S]*?)<\/act>)/gi;
    let m;
    while ((m = re.exec(String(text ?? ""))) !== null) {
        const a = contestAttrs(m[1]);
        const actor = String(a.actor || a.char || "").trim();
        if (!actor) continue;
        const body = String(m[2] || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        const title = String(a.title || a.action || "").trim();
        out.push({
            actor,
            speed: Math.max(0, Math.trunc(Number(a.speed) || 0)),
            title: title.slice(0, 80),
            text: (body || title).slice(0, 200),
            target: String(a.target || "").trim().slice(0, 80),
        });
    }
    return out;
}
