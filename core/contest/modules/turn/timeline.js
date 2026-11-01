// turn.timeline — a tick timeline (plans/combat-modules.md 4.2): every actor
// sits at a tick in contest.timeline; the lowest tick acts first. Acting
// pushes the actor forward by its action's tempo: heavy actions (charges,
// big spells, rituals) cost more, quick ones (jabs, a step) less, and speed
// shaves it down. So a heavy blow this round means acting late next round,
// and a quick fighter keeps the initiative. Ticks are normalized each round.

import { contestKey } from "../../effects.js";

const TIMELINE_HEAVY_RE = /\b(heavy|charg\w*|ritual|channel\w*|ultimate|finisher|overhead|all[- ]out|big|massive|summon\w*|meteor|fireball|smash|slam)\b/i;
const TIMELINE_LIGHT_RE = /\b(quick|jab|flick|step|dodge|feint|snap|dart|light|parry|shove|duck)\b/i;

// heavy | light | normal — shared with turn.ap.
export function actionWeight(action) {
    const text = String(action ?? "");
    if (TIMELINE_HEAVY_RE.test(text)) return "heavy";
    if (TIMELINE_LIGHT_RE.test(text)) return "light";
    return "normal";
}

export function timelineCost(action, speed) {
    const base = { heavy: 9, normal: 6, light: 4 }[actionWeight(action)];
    return Math.max(1, base - Math.min(4, Math.max(0, Math.trunc(Number(speed) || 0))));
}

export function timelineQueue(ctx, groups) {
    const c = ctx.contest;
    if (!c.timeline || typeof c.timeline !== "object") c.timeline = {};
    const t = c.timeline;
    const known = Object.values(t).filter(Number.isFinite);
    // Newcomers join at the current front of the timeline.
    const front = known.length ? Math.min(...known) : 0;
    const tickOf = sd => {
        const key = contestKey(sd?.actor);
        if (!key) return Infinity;
        if (!Number.isFinite(t[key])) t[key] = front;
        return t[key];
    };
    const speedOf = g => Math.max(0, ...(g?.sides || []).map(sd => Math.trunc(Number(sd.speed) || 0)));
    const rows = (groups || []).map((g, i) => ({ i, tick: Math.min(Infinity, ...(g?.sides || []).map(tickOf)), speed: speedOf(g) }));
    const order = rows.sort((a, b) => (a.tick - b.tick) || (b.speed - a.speed) || (a.i - b.i)).map(r => r.i);
    // Everyone who acted moves on by their own action's tempo.
    const notes = [];
    for (const i of order) {
        for (const sd of groups[i]?.sides || []) {
            const key = contestKey(sd.actor);
            if (!key) continue;
            const cost = timelineCost(sd.action, sd.speed);
            notes.push(`${sd.actor} t${t[key]} (+${cost})`);
            t[key] += cost;
        }
    }
    const low = Math.min(...Object.values(t).filter(Number.isFinite));
    if (Number.isFinite(low) && low > 0) for (const k of Object.keys(t)) t[k] -= low;
    if (notes.length) (ctx.notes = ctx.notes || []).push(`Timeline: ${notes.join(" · ")}`);
    return order;
}

export const turnTimeline = {
    id: "turn.timeline",
    label: "Timeline (tempo)",
    hint: "Lowest tick acts first; heavy actions push you later, quick ones keep you early.",
    queue: timelineQueue,
};
