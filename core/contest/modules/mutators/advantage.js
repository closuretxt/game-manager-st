// mut.advantage — circumstances roll twice (plans/combat-modules.md 4.5): a
// hindering status on the actor (Dazed, Prone, Exhausted...) gives
// disadvantage, a helping one (Blessed, Hidden...) advantage; attacking a
// hindered target, or flanking it (two or more party members on the same
// enemy this round), gives advantage. Net one step either way, on top of
// the oracle's own adv. Only dice rules that roll with advantage feel it.

import { contestKey, contestSide } from "../../effects.js";

const ADV_BAD_RE = /\b(dazed|stunned|blind\w*|prone|off-balance|staggered|pinned|exhausted|frightened|terrified|poisoned|restrained|grappled|slowed|fumbled|backlash|overwhelmed|confused|shaken|broken|wounded)\b/i;
const ADV_GOOD_RE = /\b(blessed|hasted|inspired|hidden|invisible|focused|empowered|heroic|aided|guided)\b/i;

function advStatusWords(ctx, name) {
    const found = ctx.ops.sheet(name);
    return (found?.sheet?.statuses || []).map(s => String(s?.name || ""));
}

// Party groups per enemy this round: two or more = flanking.
export function advantageRoundStart(ctx, groups) {
    const flank = {};
    for (const g of groups || []) {
        const [a, b] = g?.sides || [];
        if (!a || !b || contestSide(ctx, a.actor) !== "party" || contestSide(ctx, b.actor) !== "enemy") continue;
        const k = contestKey(b.actor);
        flank[k] = (flank[k] || 0) + 1;
    }
    ctx.flank = flank;
}

export function advantageBeforeRoll(ctx, group, roll) {
    const [a, b] = group?.sides || [];
    if (!a || !roll) return;
    let delta = 0;
    const why = [];
    const own = advStatusWords(ctx, a.actor);
    const bad = own.find(s => ADV_BAD_RE.test(s));
    const good = own.find(s => ADV_GOOD_RE.test(s));
    if (bad) { delta--; why.push(`${a.actor} ${bad}`); }
    if (good) { delta++; why.push(`${a.actor} ${good}`); }
    if (b) {
        const hindered = advStatusWords(ctx, b.actor).find(s => ADV_BAD_RE.test(s));
        if (hindered) { delta++; why.push(`${b.actor} ${hindered}`); }
        if (contestSide(ctx, a.actor) === "party" && (ctx.flank?.[contestKey(b.actor)] || 0) >= 2) { delta++; why.push(`flanking ${b.actor}`); }
    }
    if (!delta) return;
    const step = delta > 0 ? 1 : -1;
    roll.adv += step;
    roll.notes.push(`${step > 0 ? "Advantage (rolled twice, kept the better)" : "Disadvantage (rolled twice, kept the worse)"}: ${why.join(", ")}`);
}

export const mutAdvantage = {
    id: "mut.advantage",
    label: "Advantage",
    hint: "Statuses and flanking make rolls roll twice, keeping the best or worst.",
    roundStart: advantageRoundStart,
    beforeRoll: advantageBeforeRoll,
};
