// mut.phases — race phases (plans/combat-modules.md 4.5): start / middle /
// final stretch, from the leader's share of the course. Each phase shifts what
// the oracle weighs and what stamina costs; the story gets the phase as the
// round tag's attribute (fiction, not a number).

import { racePhase } from "../shape/race.js";

const PHASE_HINTS = {
    "start": "the start: positioning, wits and acceleration matter most; stamina costs are light.",
    "middle": "the long haul: stamina and endurance matter most; pushing costs the usual stamina.",
    "final stretch": "the final stretch: power and guts matter most; every push or overtake costs DOUBLE stamina, and a runner with stamina left can spurt.",
};

export function phasesOracleState(ctx) {
    return [`Race phase: ${PHASE_HINTS[racePhase(ctx)]}`];
}

export function phasesStoryAttrs(ctx) {
    return { phase: racePhase(ctx) };
}

// A results-message note when the race enters a new phase.
export function phasesRoundEnd(ctx) {
    const meters = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    const now = racePhase(ctx);
    if (meters.phase && meters.phase !== now) ctx.notes.push(`Phase: ${now}`);
    meters.phase = now;
}

export function phasesHud(ctx) {
    return { label: "Phase", value: 0, max: 0, text: racePhase(ctx) };
}

export const mutPhases = {
    id: "mut.phases",
    label: "Race phases",
    hint: "Start, middle and final stretch change which stats matter and what stamina costs.",
    shapes: ["race"],
    oracleState: phasesOracleState,
    storyAttrs: phasesStoryAttrs,
    roundEnd: phasesRoundEnd,
    hud: phasesHud,
};
