// shape.scores — cooking/talent/card contests, exams, matches played by
// halves (plans/combat-modules.md 4.1). Every participant has a `score`
// track; the contest runs a fixed number of rounds and ends with a ranking.
// Nobody falls (lethal: false): a bad round costs points, not health.

import { contestKey, outStateOf, trackValue } from "../../effects.js";
import { racePlaceWord } from "./race.js";

const SCORES_DEFAULT_ROUNDS = 3;

export function scoresRounds(ctx) {
    const n = Math.trunc(Number(ctx?.opts?.["shape.scores"]?.rounds));
    return Number.isFinite(n) && n >= 1 ? Math.min(20, n) : SCORES_DEFAULT_ROUNDS;
}

// Optional stakes (Composure, Energy...): nothing by default.
export function scoresStakes(ctx, sheet) {
    const name = String(ctx?.opts?.stakes || "").trim();
    return name ? ctx.ops.match(sheet?.resources || [], name) || null : null;
}

// Ranking: [{ name, side, score, out, place }]; ties share a place.
export function scoresRanking(ctx) {
    const seen = new Set();
    const list = [];
    (ctx?.participants || []).forEach((p, i) => {
        const key = contestKey(p.name);
        if (seen.has(key)) return;
        seen.add(key);
        const name = ctx.ops.sheet(p.name)?.sheet?.name || p.name;
        list.push({ name, side: p.side, score: trackValue(ctx.contest, name, "score"), out: outStateOf(ctx, name), i });
    });
    list.sort((a, b) => (!!a.out - !!b.out) || (b.score - a.score) || (a.i - b.i));
    let place = 0;
    list.forEach((r, i) => {
        if (r.out) { r.place = 0; return; }
        if (i === 0 || r.score !== list[i - 1].score || list[i - 1].out) place = i + 1;
        r.place = place;
    });
    return list;
}

// The round being resolved (ctx.roundNo) out of the configured count.
function scoresRoundNo(ctx) {
    return Math.max(1, Math.trunc(Number(ctx?.roundNo) || (Number(ctx?.contest?.round) || 0) + 1));
}

// Ranking in words — "close behind" instead of points.
export function scoresStanding(ctx) {
    const ranking = scoresRanking(ctx);
    const best = ranking.find(r => !r.out)?.score || 0;
    const parts = ranking.map(r => {
        if (r.out) return `${r.name} is out of the contest`;
        const gap = best - r.score;
        const spread = Math.max(1, Math.abs(best));
        const word = gap <= 0 ? (r.place === 1 ? "leading" : "tied") : gap / spread <= 0.15 ? "close behind" : gap / spread <= 0.4 ? "behind" : "well behind";
        return `${racePlaceWord(r.place)} ${r.name}, ${word}`;
    });
    const total = scoresRounds(ctx);
    const roundNo = scoresRoundNo(ctx);
    const when = roundNo >= total ? "Final ranking" : `After round ${roundNo} of ${total}`;
    return parts.length ? `${when}: ${parts.join("; ")}` : "";
}

export function scoresIsOver(ctx) {
    const left = scoresRanking(ctx).filter(r => !r.out);
    return scoresRoundNo(ctx) >= scoresRounds(ctx) || (scoresRanking(ctx).length > 0 && !left.length);
}

export function scoresTrackBounds(ctx, track) {
    return track === "score" ? { min: 0, max: Infinity } : null;
}

const SCORES_RESULT_WORDS = { crit: "wows everyone", hit: "goes over well", graze: "is merely fine", miss: "falls flat", fumble: "is a disaster" };

export function scoresInterruptedLine(actor, action) {
    return `${actor} is out of the contest before ${action ? `the ${action}` : "performing"} can happen.`;
}

export function scoresResultLine(actor, action, key, versus) {
    return `${actor}'s ${action || "performance"}${versus ? ` against ${versus}` : ""} ${SCORES_RESULT_WORDS[key] || "happens"}.`;
}

export function scoresOracleState(ctx) {
    const rows = scoresRanking(ctx).map(r => r.out ? `${r.name} (out)` : `${r.name} ${r.score}`);
    return [`Scored contest, round ${scoresRoundNo(ctx)} of ${scoresRounds(ctx)}. Scores so far: ${rows.join(", ") || "nobody has scored yet"}.`];
}

export function scoresHudRows(ctx) {
    const ranking = scoresRanking(ctx);
    const top = Math.max(1, ...ranking.map(r => r.score));
    return ranking.map(r => ({
        name: r.name,
        side: r.side,
        value: r.score,
        max: top,
        ratio: Math.max(0, Math.min(1, r.score / top)),
        out: r.out,
        text: r.out ? r.out : `${racePlaceWord(r.place)} · ${r.score} pts`,
    }));
}

const SCORES_ORACLE_RULES = [
    "THIS CONTEST IS SCORED:",
    "- Each participant performs (cooks, plays, answers, competes) and earns points as track effects: <effect by=\"Name\" target=\"Name\" track=\"score\" delta=\"+7\"/>. On a 0-10 scale per round: a disaster 0-2, a flop 3-4, fine 5-6, good 7-8, outstanding 9-10.",
    "- Usually every performance is its own SINGLE-SIDED group; pair two actions only when one directly interferes with the other (sabotage, a head-to-head question).",
    "- Skills, attributes, traits and the participant's condition decide the odds; nerves, fatigue or a missing ingredient lower them. Nobody is hurt by a bad score.",
];

const SCORES_BASIC_ACTIONS = [
    { id: "safe", label: "Play it safe", icon: "fa-solid fa-shield" },
    { id: "showy", label: "Go for a showpiece", icon: "fa-solid fa-star" },
    { id: "signature", label: "Use a signature move", icon: "fa-solid fa-wand-magic-sparkles" },
    { id: "rival", label: "Outshine", icon: "fa-solid fa-arrow-up-wide-short", target: "enemy" },
    { id: "recover", label: "Steady the nerves", icon: "fa-solid fa-mug-hot" },
];

export const shapeScores = {
    id: "shape.scores",
    label: "Scored contest",
    basicActions: SCORES_BASIC_ACTIONS,
    storyTag: "contest_round",
    lineTag: "performance",
    rule: "These results are final: narrate them, and change no scores or rankings beyond them.",
    lethal: false,
    rivals: true,
    notesLabel: "Notes",
    stakesDefault: "",
    options: [{ key: "rounds", label: "Rounds", type: "number", min: 1, max: 20, default: SCORES_DEFAULT_ROUNDS }],
    oracleRules: SCORES_ORACLE_RULES,
    opposition: "Every rival competitor decides HOW they compete this round: a safe performance, a risky showpiece, a signature move, or outshining someone ahead. Read the scores in <contest_state>.",
    stakes: scoresStakes,
    standing: scoresStanding,
    isOver: scoresIsOver,
    trackBounds: scoresTrackBounds,
    oracleState: scoresOracleState,
    hudRows: scoresHudRows,
    interruptedLine: scoresInterruptedLine,
    resultLine: scoresResultLine,
};
