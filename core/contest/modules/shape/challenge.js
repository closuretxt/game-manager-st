// shape.challenge — climbs, heists, rituals, survival, crafting under
// pressure (plans/combat-modules.md 4.1). The party against the situation:
// two scene clocks, `progress` (the goal) and `danger` (what goes wrong).
// Ends when one fills. No opposing side: the situation pushes back through
// the tiers themselves (failures fill danger).

import { CONTEST_SCENE_KEY, outStateOf, trackValue } from "../../effects.js";

const CHALLENGE_DEFAULT_PROGRESS = 6;
const CHALLENGE_DEFAULT_DANGER = 6;

export function challengeLengths(ctx) {
    const o = ctx?.opts?.["shape.challenge"] || {};
    const num = (v, d) => {
        const n = Math.trunc(Number(v));
        return Number.isFinite(n) && n >= 2 ? Math.min(20, n) : d;
    };
    return { progress: num(o.progress, CHALLENGE_DEFAULT_PROGRESS), danger: num(o.danger, CHALLENGE_DEFAULT_DANGER) };
}

export function challengeClocks(ctx) {
    return {
        progress: trackValue(ctx?.contest, CONTEST_SCENE_KEY, "progress"),
        danger: trackValue(ctx?.contest, CONTEST_SCENE_KEY, "danger"),
    };
}

export function challengeStakes(ctx, sheet) {
    const name = String(ctx?.opts?.stakes || "Health");
    return ctx.ops.match(sheet?.resources || [], name) || null;
}

function challengeProgressWord(ratio) {
    if (ratio >= 1) return "done";
    if (ratio >= 2 / 3) return "nearly there";
    if (ratio >= 1 / 3) return "halfway";
    return ratio > 0 ? "under way" : "not started";
}

function challengeDangerWord(ratio) {
    if (ratio >= 1) return "disaster";
    if (ratio >= 2 / 3) return "critical";
    if (ratio >= 1 / 3) return "rising";
    return ratio > 0 ? "stirring" : "calm";
}

const CHALLENGE_OUT_WORDS = { dead: "dead", ko: "knocked out", down: "down", fled: "gone", yielded: "out", out: "out" };

export function challengeStanding(ctx) {
    const len = challengeLengths(ctx);
    const c = challengeClocks(ctx);
    const parts = [`The goal is ${challengeProgressWord(c.progress / len.progress)}`, `the danger is ${challengeDangerWord(c.danger / len.danger)}`];
    const out = (ctx?.participants || []).filter(p => outStateOf(ctx, p.name)).map(p => `${p.name} is ${CHALLENGE_OUT_WORDS[outStateOf(ctx, p.name)] || outStateOf(ctx, p.name)}`);
    return `${[...parts, ...out].join(", ")}.`;
}

// Over when a clock fills, or nobody in the party can still act.
export function challengeIsOver(ctx) {
    const len = challengeLengths(ctx);
    const c = challengeClocks(ctx);
    if (c.progress >= len.progress || c.danger >= len.danger) return true;
    const party = (ctx?.participants || []).filter(p => p.side === "party");
    return party.length > 0 && party.every(p => outStateOf(ctx, p.name));
}

export function challengeTrackBounds(ctx, track) {
    const len = challengeLengths(ctx);
    if (track === "progress") return { min: 0, max: len.progress };
    if (track === "danger") return { min: 0, max: len.danger };
    return null;
}

// Which clock filled (the summary word), or "" while running.
export function challengeOutcome(ctx) {
    const len = challengeLengths(ctx);
    const c = challengeClocks(ctx);
    if (c.progress >= len.progress) return "success";
    if (c.danger >= len.danger) return "failure";
    return "";
}

const CHALLENGE_RESULT_WORDS = { crit: "succeeds beautifully", hit: "works", graze: "works, at a price", miss: "fails", fumble: "makes things much worse" };

export function challengeInterruptedLine(actor, action) {
    return `${actor} cannot act any more before ${action ? `the ${action}` : "acting"} can happen.`;
}

export function challengeResultLine(actor, action, key) {
    return `${actor}'s ${action || "attempt"} ${CHALLENGE_RESULT_WORDS[key] || "happens"}.`;
}

export function challengeOracleState(ctx) {
    const len = challengeLengths(ctx);
    const c = challengeClocks(ctx);
    return [`Challenge clocks: progress ${c.progress}/${len.progress} (the goal is reached when it fills), danger ${c.danger}/${len.danger} (the attempt fails when it fills).`];
}

export function challengeHudRows(ctx) {
    const len = challengeLengths(ctx);
    const c = challengeClocks(ctx);
    return [
        { name: "Progress", side: "party", value: c.progress, max: len.progress, ratio: Math.min(1, c.progress / len.progress), out: null, text: `${c.progress}/${len.progress}` },
        { name: "Danger", side: "enemy", value: c.danger, max: len.danger, ratio: Math.min(1, c.danger / len.danger), out: null, text: `${c.danger}/${len.danger}` },
    ];
}

const CHALLENGE_ORACLE_RULES = [
    "THIS CONTEST IS A CHALLENGE — the party against the situation, with no opposing side:",
    "- Every party action is its own SINGLE-SIDED group (pair two only when one party member directly helps another's attempt).",
    "- Two scene clocks (see <contest_state>) move with track effects on target=\"scene\": <effect by=\"Name\" target=\"scene\" track=\"progress\" delta=\"+1\"/> and <effect by=\"Name\" target=\"scene\" track=\"danger\" delta=\"+1\"/>. Success moves progress 1 (a critical success 2); a partial success moves progress but also danger; failure moves danger 1, a critical failure 2.",
    "- The situation still bites: falls, burns, exhaustion and the like are resource effects on the actor, judged from the scene and the sheets.",
];

const CHALLENGE_BASIC_ACTIONS = [
    { id: "advance", label: "Push toward the goal", icon: "fa-solid fa-person-hiking" },
    { id: "careful", label: "Go carefully", icon: "fa-solid fa-shoe-prints" },
    { id: "help", label: "Help", icon: "fa-solid fa-handshake-angle", target: "party" },
    { id: "secure", label: "Reduce the danger", icon: "fa-solid fa-shield-heart" },
    { id: "item", label: "Use Item", icon: "fa-solid fa-flask" },
];

export const shapeChallenge = {
    id: "shape.challenge",
    label: "Challenge",
    basicActions: CHALLENGE_BASIC_ACTIONS,
    storyTag: "challenge_round",
    lineTag: "attempt",
    rule: "These results are final: narrate them, and decide no further successes, setbacks or injuries beyond them.",
    rivals: false,
    notesLabel: "Notes",
    sceneTracks: ["progress", "danger"],
    stakesDefault: "Health",
    options: [
        { key: "progress", label: "Goal clock (segments)", type: "number", min: 2, max: 20, default: CHALLENGE_DEFAULT_PROGRESS },
        { key: "danger", label: "Danger clock (segments)", type: "number", min: 2, max: 20, default: CHALLENGE_DEFAULT_DANGER },
    ],
    oracleRules: CHALLENGE_ORACLE_RULES,
    opposition: null,
    stakes: challengeStakes,
    standing: challengeStanding,
    isOver: challengeIsOver,
    trackBounds: challengeTrackBounds,
    oracleState: challengeOracleState,
    hudRows: challengeHudRows,
    interruptedLine: challengeInterruptedLine,
    resultLine: challengeResultLine,
};
