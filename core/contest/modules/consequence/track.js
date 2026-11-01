// cons.track — the oracle writes track movement (race progress, score points,
// clock segments) plus resource drain; code maps loose names onto the shape's
// tracks and the engine clamps them (plans/combat-modules.md 4.4). An oracle
// that writes resource="Distance" or track="points" still moves the right
// track; a real sheet resource of that name always wins.

import { contestKey } from "../../effects.js";

const TRACK_ALIASES = [
    ["progress", /^(progress|distance|ground|lead|lengths?|segments?|advance)$/],
    ["score", /^(score|points?|marks?|pts)$/],
    ["danger", /^(danger|alarm|threat|risk|heat|suspicion|peril)$/],
];

export function trackAlias(name, known) {
    const key = contestKey(name);
    if (known.includes(key)) return key;
    for (const [track, re] of TRACK_ALIASES) if (known.includes(track) && re.test(key)) return track;
    return null;
}

// The tracks this shape keeps, from its bounds and scene clocks.
function trackNames(ctx) {
    const shape = ctx?.shape || {};
    const out = new Set(shape.sceneTracks || []);
    if (typeof shape.trackBounds === "function") {
        for (const t of ["progress", "score", "danger"]) if (shape.trackBounds(ctx, t)) out.add(t);
    }
    return [...out];
}

export function trackEffects(ctx, group, outcome) {
    const tier = (group?.tiers || [])[outcome?.tierIndex];
    const known = trackNames(ctx);
    const list = Array.isArray(tier?.effects) ? tier.effects.map(e => ({ ...e })) : [];
    for (const e of list) {
        if (e.kind === "track") {
            const t = trackAlias(e.name, known);
            if (t) e.name = t;
            continue;
        }
        if (e.kind !== "resource") continue;
        const t = trackAlias(e.name, known);
        if (!t) continue;
        const sheet = ctx.ops.sheet(e.target)?.sheet;
        if (sheet && ctx.ops.match(sheet.resources || [], e.name)) continue;
        e.kind = "track";
        e.name = t;
    }
    return list;
}

export const consTrack = {
    id: "cons.track",
    label: "Tracks",
    hint: "The oracle's track moves (progress, score, clocks) land on the contest's own tracks, clamped.",
    shapes: ["race", "scores", "challenge"],
    effects: trackEffects,
};
