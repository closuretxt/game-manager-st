// shape.race — horse/foot/car races, chases, pursuit/escape, "who gets there
// first" (plans/combat-modules.md 4.1). Every runner has a `progress` track
// (0..length segments); positions are the progress order. Stamina (the stakes
// resource) drains but never takes anyone out (lethal: false). Ends when a
// runner reaches the finish, or nobody is left racing.
//
// Opponents are rivals: tracked enemies plus the untracked runners the
// pre-pass named (contest.rivals), so a race needs no statted field.

import { contestKey, outStateOf, trackValue } from "../../effects.js";

const RACE_DEFAULT_LENGTH = 10;

export function raceLength(ctx) {
    const n = Math.trunc(Number(ctx?.opts?.["shape.race"]?.length));
    return Number.isFinite(n) && n >= 3 ? Math.min(40, n) : RACE_DEFAULT_LENGTH;
}

// Stamina by default; "Health"-style stakes only when the chat sets one.
export function raceStakes(ctx, sheet) {
    const name = String(ctx?.opts?.stakes || "Stamina");
    return ctx.ops.match(sheet?.resources || [], name) || null;
}

// Runners in place order: [{ name, side, progress, out, place }]. Ties keep
// the participant order (whoever led before stays ahead on a draw).
export function raceOrder(ctx) {
    const seen = new Set();
    const list = [];
    (ctx?.participants || []).forEach((p, i) => {
        const key = contestKey(p.name);
        if (seen.has(key)) return;
        seen.add(key);
        const name = ctx.ops.sheet(p.name)?.sheet?.name || p.name;
        list.push({ name, side: p.side, progress: trackValue(ctx.contest, name, "progress"), out: outStateOf(ctx, name), i });
    });
    list.sort((a, b) => (!!a.out - !!b.out) || (b.progress - a.progress) || (a.i - b.i));
    list.forEach((r, i) => { r.place = r.out ? 0 : i + 1; });
    return list;
}

// start / middle / final stretch, from the leader's share of the course.
export function racePhase(ctx) {
    const lead = raceOrder(ctx).find(r => !r.out);
    const share = lead ? lead.progress / raceLength(ctx) : 0;
    if (share >= 2 / 3) return "final stretch";
    if (share >= 1 / 3) return "middle";
    return "start";
}

export function racePlaceWord(n) {
    const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
    return `${n}${tail}`;
}

function raceGapWord(gap) {
    if (gap <= 0) return "level";
    if (gap === 1) return "a length back";
    if (gap <= 3) return "a few lengths back";
    return "far behind";
}

// Places and gaps in words for the story LLM — never a number of segments.
export function raceStanding(ctx) {
    const length = raceLength(ctx);
    const order = raceOrder(ctx);
    let prev = null;
    return order.map(r => {
        if (r.out) return `${r.name} is out of the race`;
        let text = `${racePlaceWord(r.place)} ${r.name}`;
        if (r.progress >= length) text += ", across the finish";
        else if (prev) text += `, ${raceGapWord(prev.progress - r.progress)}`;
        prev = r;
        return text;
    }).join("; ");
}

export function raceIsOver(ctx) {
    const order = raceOrder(ctx);
    if (!order.length) return false;
    const racing = order.filter(r => !r.out);
    return !racing.length || racing.some(r => r.progress >= raceLength(ctx));
}

// Progress never goes below the start or past the finish.
export function raceTrackBounds(ctx, track) {
    return track === "progress" ? { min: 0, max: raceLength(ctx) } : null;
}

const RACE_RESULT_WORDS = { crit: "pays off brilliantly", hit: "works", graze: "barely works", miss: "comes to nothing", fumble: "costs them dearly" };

export function raceInterruptedLine(actor, action) {
    return `${actor} is out of the race before ${action ? `the ${action}` : "acting"} can happen.`;
}

export function raceResultLine(actor, action, key, versus) {
    return `${actor}'s ${action || "move"}${versus ? ` against ${versus}` : ""} ${RACE_RESULT_WORDS[key] || "happens"}.`;
}

// The oracle's view (numbers allowed: it is not the story).
export function raceOracleState(ctx) {
    const length = raceLength(ctx);
    const rows = raceOrder(ctx).map(r => r.out ? `${r.name} (out)` : `${racePlaceWord(r.place)} ${r.name} (progress ${r.progress}/${length})`);
    return [`Race to ${length} segments. Current order: ${rows.join(", ") || "everyone at the start"}.`];
}

// HUD rows: progress bars in place order, with the stakes resource alongside.
export function raceHudRows(ctx) {
    const length = raceLength(ctx);
    return raceOrder(ctx).map(r => {
        const found = ctx.ops.sheet(r.name);
        const st = found ? raceStakes(ctx, found.sheet) : null;
        const tank = st ? ` · ${st.name} ${Number(st.value) || 0}/${ctx.ops.max(found.sheet, st)}` : "";
        return {
            name: r.name,
            side: r.side,
            value: r.progress,
            max: length,
            ratio: Math.max(0, Math.min(1, r.progress / length)),
            out: r.out,
            text: r.out ? r.out : `${racePlaceWord(r.place)} · ${r.progress}/${length}${tank}`,
        };
    });
}

const RACE_ORACLE_RULES = [
    "THIS CONTEST IS A RACE:",
    "- Every runner has a progress track toward the finish (see <contest_state>). Each tier moves runners with track effects: <effect by=\"Runner\" target=\"Runner\" track=\"progress\" delta=\"+2\"/>. A normal round moves a runner 1-2 segments; a great one 3; a stumble 0.",
    "- Overtaking a runner directly ahead is CONTESTED: pair it with that runner's action. A successful pass is <effect by=\"Overtaker\" target=\"Runner ahead\" track=\"progress\" swap=\"true\"/> (they trade places) or simply more progress than the other.",
    "- The stakes resource (Stamina) is the tank: pushing, overtaking and spurting cost it as resource effects on the runner; holding or conserving costs little or even recovers some. An empty tank makes pushing near-impossible, but nobody is knocked out by it.",
    "- Speed, stamina, wits and the runner's own traits decide the odds. Collisions or a fall may knock a runner out of the race (state=\"out\") only on a critical failure the scene supports.",
];

const RACE_BASIC_ACTIONS = [
    { id: "push", label: "Push the pace", icon: "fa-solid fa-gauge-high" },
    { id: "hold", label: "Hold position", icon: "fa-solid fa-equals" },
    { id: "overtake", label: "Overtake", icon: "fa-solid fa-angles-right", target: "enemy" },
    { id: "conserve", label: "Conserve", icon: "fa-solid fa-battery-half" },
    { id: "block", label: "Block", icon: "fa-solid fa-road-barrier", target: "enemy" },
    { id: "spurt", label: "Spurt", icon: "fa-solid fa-bolt" },
];

export const shapeRace = {
    id: "shape.race",
    label: "Race",
    basicActions: RACE_BASIC_ACTIONS,
    storyTag: "race_round",
    lineTag: "move",
    rule: "These results are final: narrate them, and change no positions beyond them.",
    lethal: false,
    rivals: true,
    notesLabel: "Notes",
    swapTrack: "progress",
    stakesDefault: "Stamina",
    options: [{ key: "length", label: "Course length (segments)", type: "number", min: 3, max: 40, default: RACE_DEFAULT_LENGTH }],
    oracleRules: RACE_ORACLE_RULES,
    opposition: "Every rival runner picks ONE race tactic this round: push the pace, hold position, overtake a runner ahead, block a runner behind, conserve stamina, or spurt for the finish (best kept for the final stretch). Read each rival's place, gap and stamina in <contest_state>.",
    stakes: raceStakes,
    standing: raceStanding,
    isOver: raceIsOver,
    trackBounds: raceTrackBounds,
    oracleState: raceOracleState,
    hudRows: raceHudRows,
    interruptedLine: raceInterruptedLine,
    resultLine: raceResultLine,
};
