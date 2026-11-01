// mut.clocks — side objectives as segmented clocks (plans/combat-modules.md
// 4.5): the ruleset lists them ("Reinforcements arrive: 4, The bridge
// collapses: 6"). Each ticks once per round on its own, and the oracle may
// hasten or delay one with a scene track effect. A clock that fills becomes
// an <event> in the story block (the fiction changes), once. Values live on
// the scene's tracks (contest.tracks.scene), filled ones in
// contest.meters.clocksDone.

import { contestKey, trackValue, CONTEST_SCENE_KEY } from "../../effects.js";

export function clocksList(ctx) {
    const raw = String(ctx?.opts?.["mut.clocks"]?.list || "");
    const out = [];
    for (const part of raw.split(/[,;\n]+/)) {
        const m = /^\s*(.+?)\s*(?::\s*(\d+))?\s*$/.exec(part);
        if (!m || !m[1]) continue;
        const name = m[1].slice(0, 60);
        const key = contestKey(name);
        if (!key || out.some(c => c.key === key)) continue;
        out.push({ name, key, size: Math.max(2, Math.min(12, Number(m[2]) || 4)) });
    }
    return out.slice(0, 4);
}

function clocksDone(ctx) {
    const m = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    if (!m.clocksDone || typeof m.clocksDone !== "object") m.clocksDone = {};
    return m.clocksDone;
}

// The oracle's clock effects land on the scene, whatever target it wrote.
export function clocksRoundStart(ctx) {
    ctx.sceneTracks = [...(ctx.sceneTracks || []), ...clocksList(ctx).map(c => c.key)];
}

export function clocksRoundEnd(ctx) {
    const done = clocksDone(ctx);
    ctx.contest.tracks = ctx.contest.tracks || {};
    const scene = (ctx.contest.tracks[CONTEST_SCENE_KEY] = ctx.contest.tracks[CONTEST_SCENE_KEY] || {});
    ctx.clockEvents = [];
    const parts = [];
    for (const c of clocksList(ctx)) {
        if (done[c.key]) continue;
        const value = Math.max(0, Math.min(c.size, trackValue(ctx.contest, CONTEST_SCENE_KEY, c.key) + 1));
        scene[c.key] = value;
        parts.push(`${c.name} ${value}/${c.size}`);
        if (value >= c.size) {
            done[c.key] = true;
            ctx.clockEvents.push(c.name);
        }
    }
    if (parts.length) ctx.notes.push(`Countdowns (something happens when one fills): ${parts.join(", ")}`);
}

export function clocksStoryEvents(ctx) {
    return (ctx.clockEvents || []).map(name => `${name.replace(/[.!]+$/, "")}.`);
}

export function clocksOracleState(ctx) {
    const done = clocksDone(ctx);
    const parts = clocksList(ctx).map(c => (done[c.key] ? `${c.name}: happened` : `${c.name} ${trackValue(ctx.contest, CONTEST_SCENE_KEY, c.key)}/${c.size}`));
    return parts.length ? [`Side clocks (each ticks once per round): ${parts.join(" · ")}`] : [];
}

export function clocksHud(ctx) {
    const done = clocksDone(ctx);
    const next = clocksList(ctx).find(c => !done[c.key]);
    if (!next) return null;
    const value = trackValue(ctx.contest, CONTEST_SCENE_KEY, next.key);
    return { label: next.name, value, max: next.size, text: `${value}/${next.size}` };
}

const CLOCKS_ORACLE_RULES = [
    'SIDE CLOCKS: <contest_state> lists the scene\'s side clocks; each ticks once per round on its own. A tier whose action clearly hastens or delays one writes <effect target="Scene" track="Clock name" delta="+1"/> (or -1).',
];

export const mutClocks = {
    id: "mut.clocks",
    label: "Side clocks",
    hint: "Side objectives tick each round; a full clock happens in the story.",
    options: [{ key: "list", label: "Clocks", type: "text", default: "", hint: "Name: segments, comma separated. Example: Reinforcements arrive: 4, The bridge collapses: 6" }],
    roundStart: clocksRoundStart,
    roundEnd: clocksRoundEnd,
    storyEvents: clocksStoryEvents,
    oracleState: clocksOracleState,
    oracleRules: CLOCKS_ORACLE_RULES,
    hud: clocksHud,
};
