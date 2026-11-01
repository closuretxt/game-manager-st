// BONDS — where each NPC stands with the player (Bonds v2, plans/bonds-v2.md).
//
// Per chat, the scenario defines the bars (d.bonds.defs: Trust, Affection,
// Loyalty... — not a fixed set). Every non-player character carries one bond:
//   c.bond = { stage, label, values: {defId: n}, statuses: [...], history: [...] }
//
// The story model never sees numbers or feelings. It sees a STAGE it can play
// (Stranger ... Best friend, Crush, Wary, Hostile, each with a role note) and
// the THREADS still open between the character and the player (the statuses'
// one-line notes, third person). Once a character settles into an end stage
// they GRADUATE: no more story injection, the chat carries the relationship.
//
// Bars ground the progression. Each bar weighs into three scores (closeness,
// romance, hostility); a score crossing a stage threshold only makes that
// stage ELIGIBLE — the tracker has to level the relationship up
// (<bond_stage>) when the character accepts the standing, so a single "I
// would kiss you" never makes anyone a Crush. Going down needs no gate:
// scores falling a margin below the stage demote on their own, and a
// betrayal can push anyone to Wary at once.
//
// Numbers NEVER move on their own or from a bare LLM delta: they move only
// through bond statuses (threads, "Broken promise — Trust -8"). A status
// applies its effect ONCE when created; an edit applies only the difference.
// Ending a status reverses what it applied; a status left untouched for
// `settle` messages SETTLES — it leaves the list and its effect stays.
//
// Pure functions over the data object (no ST imports) — the store wraps them.

import { genId } from "./schemas.js";

export const BOND_MIN = 0;
export const BOND_MAX = 100;
export const BOND_DEFAULT_STEP = 15;     // max |effect| per bar per status
export const BOND_DEFAULT_SETTLE = 16;   // messages unmodified before a status settles
export const BOND_DEFAULT_REATTACH = 40; // messages before a character's bond line is attached again
export const BOND_MAX_THREADS = 4;       // open threads per character; the oldest settles early
const BOND_HISTORY = 12;
const STAGE_MARGIN = 10;     // hysteresis: how far below a stage's threshold before it drops
const GRADUATE_MARGIN = 10;  // how far past an end stage's threshold before the bond graduates
const RUPTURE = 6;           // closeness-weighted loss from one thread that un-graduates

// The fixed stages. `axis` = which score gates them; the ladder climbs one
// rung at a time, Crush branches off from Known or above, the negative side
// is reachable from anywhere.
export const BOND_STAGES = [
    { key: "stranger", name: "Stranger", axis: "close", note: "Doesn't know {{user}} and owes them nothing. Polite at best; guarded about anything personal." },
    { key: "neutral", name: "Neutral", axis: "close", note: "Has dealt with {{user}} but holds no strong opinion yet. Cooperates when it suits them." },
    { key: "known", name: "Known", axis: "close", note: "Familiar with {{user}}: easy small talk and some trust, but no favors beyond reason." },
    { key: "friend", name: "Friend", axis: "close", note: "At ease with {{user}}: teases, helps without being asked, speaks their mind. Romantic moves catch them off guard." },
    { key: "best_friend", name: "Best friend", axis: "close", note: "Trusts {{user}} deeply: takes real risks for them and stays honest even when it stings. Romance is not assumed." },
    { key: "crush", name: "Crush", axis: "romance", note: "Romantically drawn to {{user}}: notices them, and gets flustered or bold depending on who they are." },
    { key: "wary", name: "Wary", axis: "hostility", note: "Distrusts {{user}}: watches them, gives little, expects the worst." },
    { key: "hostile", name: "Hostile", axis: "hostility", note: "Openly against {{user}}: refuses, undermines or confronts them." },
];
export const BOND_LADDER = ["stranger", "neutral", "known", "friend", "best_friend"];
const END_STAGES = new Set(["best_friend", "crush"]);
const NEGATIVE = new Set(["wary", "hostile"]);
const AXIS_KEY = { close: "weight", romance: "romance", hostility: "hostility" };

// Score each stage needs (0-100). Stranger needs nothing.
export const DEFAULT_BOND_THRESHOLDS = { neutral: 15, known: 30, friend: 50, best_friend: 75, crush: 55, wary: 40, hostile: 65 };

// Starting bar sets. Weights: how much the bar counts toward closeness
// (`weight`, the ladder), `romance` (Crush) and `hostility` (Wary/Hostile);
// negative = counts against.
export const BOND_PRESETS = {
    basic: {
        label: "Basic",
        defs: [
            { name: "Affection", start: 20, weight: 0.7, romance: 0.8, hostility: -0.3, description: "Warmth and fondness toward the player." },
            { name: "Trust", start: 20, weight: 0.5, romance: 0.3, hostility: -0.4, description: "Belief that the player is honest and reliable." },
            { name: "Tension", start: 5, weight: -0.5, romance: -0.3, hostility: 1, description: "Friction, resentment or unease toward the player." },
        ],
    },
    persist: {
        label: "Persist classic",
        defs: [
            { name: "Romantic", start: 10, weight: 0.2, romance: 1, hostility: 0, description: "Romantic intent and willingness. The hardest to gain; someone can be close without being romantic." },
            { name: "Friendship", start: 10, weight: 1, romance: 0.3, hostility: -0.3, description: "How much of a friend they are; closely tied to trust." },
            { name: "Hate", start: 1, weight: -0.6, romance: -0.4, hostility: 1, description: "Dislike toward the player. Can coexist with any other bar; carries the long-lasting results of arguments." },
            { name: "Saturation", start: 0, weight: -0.2, romance: -0.2, hostility: 0.3, description: "Need for space. High means gains in the other bars are less justified for now." },
            { name: "Pursuit", start: 20, weight: 0.2, romance: 0.4, hostility: 0, description: "Willingness to pursue the player. Falls when they feel pushed or flattered, rises when given space." },
            { name: "Acquiescence", start: 20, weight: 0, romance: 0.3, hostility: 0, description: "Willingness toward intimacy; follows the relationship and trust, drops with awkward behavior." },
        ],
    },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const weightOf = v => {
    const n = Number(v);
    return Number.isFinite(n) ? clamp(Math.round(n * 100) / 100, -1, 1) : null;
};

// ---------- config ----------

// Weights a bar without its own: the preset bar of the same name (chats from
// before v2), else a plain closeness bar.
function presetWeights(name) {
    const n = norm(name);
    for (const p of Object.values(BOND_PRESETS)) {
        const hit = p.defs.find(x => norm(x.name) === n);
        if (hit) return { weight: hit.weight, romance: hit.romance, hostility: hit.hostility };
    }
    return { weight: 0.5, romance: 0, hostility: 0 };
}

export function bondConfig(d) {
    if (!d.bonds || typeof d.bonds !== "object" || Array.isArray(d.bonds)) d.bonds = {};
    const b = d.bonds;
    if (!Array.isArray(b.defs)) b.defs = [];
    b.defs = b.defs.filter(x => x && typeof x === "object" && String(x.name ?? "").trim());
    for (const def of b.defs) {
        def.id = def.id || genId();
        def.name = String(def.name).trim();
        def.description = String(def.description ?? "");
        def.start = clamp(Math.round(Number(def.start) || 0), BOND_MIN, BOND_MAX);
        const fallback = presetWeights(def.name);
        for (const k of ["weight", "romance", "hostility"]) def[k] = weightOf(def[k]) ?? fallback[k];
    }
    if (typeof b.inject !== "boolean") b.inject = true;
    b.placement = b.placement === "message" ? "message" : "low";
    b.notes = typeof b.notes === "string" ? b.notes : "";
    delete b.guide; // v1 guidance text, replaced by the stage notes
    b.step = clamp(Math.trunc(Number(b.step) || BOND_DEFAULT_STEP), 1, 50);
    b.settle = clamp(Math.trunc(Number(b.settle) || BOND_DEFAULT_SETTLE), 2, 500);
    b.reattach = clamp(Math.trunc(Number(b.reattach) || BOND_DEFAULT_REATTACH), 4, 500);
    const t = b.thresholds && typeof b.thresholds === "object" ? b.thresholds : {};
    b.thresholds = {};
    for (const [k, v] of Object.entries(DEFAULT_BOND_THRESHOLDS)) {
        const n = Number(t[k]);
        b.thresholds[k] = Number.isFinite(n) ? clamp(Math.round(n), 1, 100) : v;
    }
    return b;
}

export function bondDefs(d) {
    return Array.isArray(d?.bonds?.defs) ? d.bonds.defs : [];
}

function thresholds(d) {
    return { ...DEFAULT_BOND_THRESHOLDS, ...(d?.bonds?.thresholds || {}) };
}

// Bar name -> def. Exact/normalized first, then a unique prefix ("Aff").
export function matchDef(defs, name) {
    const n = norm(name);
    if (!n) return null;
    const exact = defs.filter(x => norm(x.name) === n);
    if (exact.length === 1) return exact[0];
    const pre = defs.filter(x => norm(x.name).startsWith(n) || n.startsWith(norm(x.name)));
    return pre.length === 1 ? pre[0] : null;
}

// Every sheet that can carry a bond: party characters and benched sheets.
export function bondSheets(d) {
    return [...(d.characters || []), ...(d.roster || []).map(r => r.sheet).filter(Boolean)];
}

// The player's own character never has a bond (it IS the other side).
export function isPlayerSheet(c, playerNames = []) {
    const n = norm(c?.name);
    return !!n && playerNames.some(p => norm(p) === n);
}

// ---------- stages ----------

export function stageDef(key) {
    return BOND_STAGES.find(s => s.key === key) || null;
}

// Stage name or key from an LLM / UI -> key ("Best Friend", "best_friend").
export function matchStage(name) {
    const n = norm(name);
    if (!n) return null;
    return BOND_STAGES.find(s => norm(s.key) === n || norm(s.name) === n)?.key ?? null;
}

export function stageOf(c) {
    return stageDef(c?.bond?.stage) ? c.bond.stage : "stranger";
}

// Whether any bar feeds this score at all (no romance weight = no Crush).
export function axisAvailable(d, axis) {
    return bondDefs(d).some(x => (Number(x[AXIS_KEY[axis]]) || 0) > 0);
}

// Weighted, normalized 0-100 score of one axis over the character's bars.
export function stageScore(d, c, axis) {
    const key = AXIS_KEY[axis];
    let sum = 0, pos = 0;
    for (const def of bondDefs(d)) {
        const w = Number(def[key]) || 0;
        if (!w) continue;
        sum += w * (c?.bond?.values?.[def.id] ?? def.start);
        if (w > 0) pos += w;
    }
    return pos > 0 ? clamp(Math.round(sum / pos), 0, 100) : 0;
}

function scores(d, c) {
    return { close: stageScore(d, c, "close"), romance: stageScore(d, c, "romance"), hostility: stageScore(d, c, "hostility") };
}

// Rank for "is this a move down": ladder index, Crush level with Best friend,
// the negative side below everything (leaving it is never "down").
function rank(key) {
    if (NEGATIVE.has(key)) return -1;
    if (key === "crush") return BOND_LADDER.indexOf("best_friend");
    return BOND_LADDER.indexOf(key);
}

// Highest ladder rung the closeness score supports, never above `cap`.
function fitLadder(d, close, cap = "best_friend") {
    const t = thresholds(d);
    const top = Math.max(0, BOND_LADDER.indexOf(BOND_LADDER.includes(cap) ? cap : "best_friend"));
    let i = top;
    while (i > 0 && close < t[BOND_LADDER[i]]) i--;
    return BOND_LADDER[i];
}

// Stages the tracker may level the character up to right now.
export function eligibleStages(d, c) {
    const stage = stageOf(c);
    const t = thresholds(d);
    const sc = scores(d, c);
    const out = [];
    if (stage === "hostile") {
        if (sc.hostility < t.hostile) out.push("wary");
        return out;
    }
    if (stage === "wary") {
        if (sc.hostility < t.wary) out.push(fitLadder(d, sc.close, c.bond?.before));
        return out;
    }
    const i = BOND_LADDER.indexOf(stage);
    if (i >= 0 && i < BOND_LADDER.length - 1 && sc.close >= t[BOND_LADDER[i + 1]]) out.push(BOND_LADDER[i + 1]);
    if (stage === "crush" && sc.close >= t.best_friend) out.push("best_friend");
    if (stage !== "crush" && i >= BOND_LADDER.indexOf("known") && axisAvailable(d, "romance") && sc.romance >= t.crush) out.push("crush");
    return out;
}

// Whether the bars support holding `key` at all (wizard starting stages,
// v1 migration) — the same bounds the automatic demotion uses.
function stageSupported(d, c, key) {
    const t = thresholds(d);
    const sc = scores(d, c);
    if (key === "stranger") return true;
    if (BOND_LADDER.includes(key)) return sc.close >= t[key];
    if (key === "crush") return axisAvailable(d, "romance") && sc.romance >= t.crush;
    if (key === "wary") return sc.hostility >= t.wary - STAGE_MARGIN;
    if (key === "hostile") return sc.hostility >= t.hostile - STAGE_MARGIN;
    return false;
}

// A stage that fits the bars with no gate: negative side first, then the
// ladder. Used for v1 bonds and when a proposed starting stage doesn't hold.
function fitStage(d, c) {
    const t = thresholds(d);
    const sc = scores(d, c);
    if (axisAvailable(d, "hostility")) {
        if (sc.hostility >= t.hostile) return "hostile";
        if (sc.hostility >= t.wary) return "wary";
    }
    return fitLadder(d, sc.close);
}

// Starting stage (wizard / manual): the proposal when the bars support it,
// else the best fit.
export function initialStage(d, c, proposed) {
    const key = matchStage(proposed);
    return key && stageSupported(d, c, key) ? key : fitStage(d, c);
}

function moveStage(bond, from, to, now) {
    if (NEGATIVE.has(to) && !NEGATIVE.has(from)) bond.before = from === "crush" ? bond.before || "friend" : from;
    if (to === "crush" && BOND_LADDER.includes(from)) bond.before = from;
    bond.stage = to;
    bond.stageAt = now;
    bond.touchedAt = now;
    if (!END_STAGES.has(to)) bond.graduated = false;
}

// The tracker's <bond_stage>. Up = only to an eligible stage (the GM gate);
// down / to the negative side = any time (a real rupture). Returns
// { from, to } or { rejected: reason }.
export function setBondStage(d, c, to, now = 0) {
    if (!bondDefs(d).length) return { rejected: "no bars" };
    const bond = ensureBond(c, d);
    const target = matchStage(to);
    if (!target) return { rejected: `unknown stage '${to}'` };
    const from = stageOf(c);
    if (target === from) return { rejected: "already there" };
    const down = NEGATIVE.has(target) || rank(target) < rank(from);
    if (!down && !eligibleStages(d, c).includes(target)) return { rejected: `${stageDef(target).name} is not eligible` };
    moveStage(bond, from, target, now);
    bond.graduated = false;
    return { from, to: target };
}

// Automatic moves after the bars changed: demotion past the margin, the
// negative side by hostility (no gate either way), graduation at an end
// stage. Returns { from?, to?, graduated? } or null when nothing changed.
export function reviewBondStage(d, c, now = 0) {
    const bond = ensureBond(c, d, false);
    if (!bond || !bondDefs(d).length) return null;
    const t = thresholds(d);
    const sc = scores(d, c);
    const stage = stageOf(c);
    const hostile = axisAvailable(d, "hostility");
    let next = stage;
    if (hostile && stage !== "hostile" && sc.hostility >= t.hostile) next = "hostile";
    else if (hostile && !NEGATIVE.has(stage) && sc.hostility >= t.wary) next = "wary";
    else if (stage === "hostile" && sc.hostility < t.hostile - STAGE_MARGIN) next = "wary";
    else if (stage === "wary" && sc.hostility < t.wary - STAGE_MARGIN) next = fitLadder(d, sc.close, bond.before);
    else if (stage === "crush" && (!axisAvailable(d, "romance") || sc.romance < t.crush - STAGE_MARGIN)) next = fitLadder(d, sc.close, bond.before);
    else if (BOND_LADDER.includes(stage)) {
        let i = BOND_LADDER.indexOf(stage);
        while (i > 0 && sc.close < t[BOND_LADDER[i]] - STAGE_MARGIN) i--;
        next = BOND_LADDER[i];
    }
    const out = {};
    if (next !== stage) {
        moveStage(bond, stage, next, now);
        Object.assign(out, { from: stage, to: next });
    }
    const cur = stageOf(c);
    if (END_STAGES.has(cur) && !bond.graduated && sc[stageDef(cur).axis] >= t[cur] + GRADUATE_MARGIN) {
        bond.graduated = true;
        out.graduated = true;
    }
    return Object.keys(out).length ? out : null;
}

// ---------- per-character bond ----------

// Normalizes (and with create, makes) a character's bond against the defs.
// A brand-new bond starts at Stranger; a v1 bond (bars, no stage) gets the
// stage its bars fit.
export function ensureBond(c, d, create = true) {
    const defs = bondDefs(d);
    if (!c.bond || typeof c.bond !== "object") {
        if (!create) return null;
        c.bond = { stage: "stranger" };
    }
    const b = c.bond;
    b.label = String(b.label ?? "");
    if (!b.values || typeof b.values !== "object") b.values = {};
    const ids = new Set(defs.map(x => x.id));
    for (const k of Object.keys(b.values)) if (!ids.has(k)) delete b.values[k];
    for (const def of defs) {
        const v = Number(b.values[def.id]);
        b.values[def.id] = Number.isFinite(v) ? clamp(Math.round(v), BOND_MIN, BOND_MAX) : def.start;
    }
    if (!Array.isArray(b.statuses)) b.statuses = [];
    for (const s of b.statuses) {
        s.id = s.id || genId();
        for (const key of ["effects", "applied"]) {
            if (!s[key] || typeof s[key] !== "object") s[key] = {};
            for (const k of Object.keys(s[key])) if (!ids.has(k)) delete s[key][k];
        }
    }
    if (!Array.isArray(b.history)) b.history = [];
    delete b.recent; // v1 shift note
    if (!stageDef(b.stage)) b.stage = defs.length ? fitStage(d, c) : "stranger";
    b.graduated = !!b.graduated;
    return b;
}

// "Trust +6, Tension -2" -> { defId: 6, defId2: -2 }, each capped to ±step.
// Unknown bar names are returned separately (logged, never applied).
export function parseEffects(text, defs, step = BOND_DEFAULT_STEP) {
    const effects = {};
    const unknown = [];
    const re = /([^,;:=+\-−\d][^,;:=+\-−\d]*?)\s*[:=]?\s*([+\-−]?)\s*(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(String(text ?? ""))) !== null) {
        const def = matchDef(defs, m[1]);
        if (!def) {
            unknown.push(m[1].trim());
            continue;
        }
        const n = Math.round(Number(m[3])) * (m[2] === "-" || m[2] === "−" ? -1 : 1);
        effects[def.id] = clamp((effects[def.id] || 0) + n, -step, step);
    }
    for (const k of Object.keys(effects)) if (!effects[k]) delete effects[k];
    return { effects, unknown };
}

export function formatEffects(effects, defs) {
    return defs.filter(x => effects?.[x.id]).map(x => `${x.name} ${effects[x.id] > 0 ? "+" : ""}${effects[x.id]}`).join(", ");
}

// Moves a bar by `delta` within range; returns the change actually made.
function shift(bond, defId, delta) {
    const before = bond.values[defId] ?? 0;
    bond.values[defId] = clamp(before + delta, BOND_MIN, BOND_MAX);
    return bond.values[defId] - before;
}

// Same status, or a near-duplicate the model re-worded ("Broken Promise" /
// "The broken promise"): exact, containment (6+ letters) or 60% word overlap.
export function findBondStatus(bond, name) {
    const target = norm(name);
    if (!target) return null;
    const words = s => new Set(s.split(" ").filter(Boolean));
    for (const s of bond.statuses) {
        const have = norm(s.name);
        if (!have) continue;
        if (have === target) return s;
        if (have.length >= 6 && target.length >= 6 && (have.includes(target) || target.includes(have))) return s;
        const a = words(have), b = words(target);
        let overlap = 0;
        for (const w of a) if (b.has(w)) overlap++;
        if (overlap / Math.min(a.size, b.size) >= 0.6) return s;
    }
    return null;
}

// Closeness-weighted size of a set of bar shifts (negative = colder).
function warmth(d, shifts) {
    return bondDefs(d).reduce((sum, def) => sum + (Number(def.weight) || 0) * (shifts[def.id] || 0), 0);
}

// Creates or edits a status (thread) and applies the not-yet-applied part of
// its effect. Returns { action: "new"|"edit", status, shifts, settled? } or null.
export function setBondStatus(d, c, { name, effect, ends, note } = {}, now = 0) {
    const cfg = bondConfig(d);
    const defs = cfg.defs;
    if (!defs.length || !String(name ?? "").trim()) return null;
    const bond = ensureBond(c, d);
    let status = findBondStatus(bond, name);
    const action = status ? "edit" : "new";
    if (!status) {
        status = { id: genId(), name: String(name).trim().slice(0, 80), effect: "", effects: {}, applied: {}, ends: "", note: "", since: now };
        bond.statuses.push(status);
    }
    const before = JSON.stringify([status.effects, status.ends, status.note]);
    if (effect !== undefined && effect !== null && String(effect).trim() !== "") {
        status.effects = parseEffects(effect, defs, cfg.step).effects;
        status.effect = formatEffects(status.effects, defs);
    }
    if (ends !== undefined && String(ends).trim()) status.ends = String(ends).trim().slice(0, 200);
    if (note !== undefined && String(note).trim()) status.note = String(note).trim().slice(0, 300);
    const shifts = {};
    for (const def of defs) {
        const diff = (status.effects[def.id] || 0) - (status.applied[def.id] || 0);
        if (!diff) continue;
        const moved = shift(bond, def.id, diff);
        status.applied[def.id] = (status.applied[def.id] || 0) + moved;
        if (!status.applied[def.id]) delete status.applied[def.id];
        if (moved) shifts[def.id] = moved;
    }
    // A real edit restarts the settle timer; a re-emitted, unchanged status
    // does not (models repeat themselves, and nothing would ever settle).
    const changed = action === "new" || JSON.stringify([status.effects, status.ends, status.note]) !== before;
    if (!changed) return null;
    status.since = now;
    bond.touchedAt = now;
    // A real rupture brings a graduated character back into tracking.
    if (bond.graduated && warmth(d, shifts) <= -RUPTURE) bond.graduated = false;
    // Too many open threads: the oldest settles early (its effect stays).
    let settled;
    if (bond.statuses.length > BOND_MAX_THREADS) {
        const oldest = bond.statuses.filter(s => s !== status).sort((a, b) => (a.since ?? 0) - (b.since ?? 0))[0];
        bond.statuses = bond.statuses.filter(s => s !== oldest);
        archive(bond, oldest, "settled", now);
        settled = oldest.name;
    }
    return { action, status, shifts, ...(settled ? { settled } : {}) };
}

function archive(bond, status, outcome, now) {
    bond.history.unshift({ name: status.name, effect: status.effect, note: status.note || "", outcome, at: now });
    bond.history.length = Math.min(bond.history.length, BOND_HISTORY);
}

// The thread resolved: what the status applied is taken back out.
export function endBondStatus(d, c, name, now = 0) {
    const bond = ensureBond(c, d, false);
    if (!bond) return null;
    const status = findBondStatus(bond, name);
    if (!status) return null;
    const shifts = {};
    for (const [defId, n] of Object.entries(status.applied)) {
        const moved = shift(bond, defId, -n);
        if (moved) shifts[defId] = moved;
    }
    bond.statuses = bond.statuses.filter(s => s !== status);
    archive(bond, status, "ended", now);
    bond.touchedAt = now;
    return { status, shifts };
}

// Statuses untouched for the settle window leave the list; the bars keep
// their effect for good. Returns the settled status names.
export function settleBondStatuses(d, c, now) {
    const bond = ensureBond(c, d, false);
    if (!bond) return [];
    const after = bondConfig(d).settle;
    const settled = bond.statuses.filter(s => Number.isFinite(s.since) && now - s.since >= after);
    if (!settled.length) return [];
    bond.statuses = bond.statuses.filter(s => !settled.includes(s));
    for (const s of settled) archive(bond, s, "settled", now);
    return settled.map(s => s.name);
}

// Bar edits from the definitions dialog: ids survive renames; removed bars
// leave every bond (values and status effects); new bars start at `start`.
export function setBondDefs(d, next) {
    const cfg = bondConfig(d);
    cfg.defs = (Array.isArray(next) ? next : []).map(x => ({ ...x }));
    bondConfig(d);
    for (const c of bondSheets(d)) {
        if (!c.bond) continue;
        ensureBond(c, d, false);
        for (const s of c.bond.statuses) s.effect = formatEffects(s.effects, cfg.defs);
    }
    return cfg;
}

// ---------- story text ----------

// Role notes: the chat's text ("Friend: ..." one per line, "" = defaults),
// any stage it leaves out keeps the built-in note.
export function defaultStageNotesText() {
    return BOND_STAGES.map(s => `${s.name}: ${s.note}`).join("\n");
}

export function stageNote(d, key, user = "the player") {
    const custom = {};
    for (const line of String(d?.bonds?.notes ?? "").split(/\r?\n/)) {
        const m = /^\s*([^:]+?)\s*:\s*(.+)$/.exec(line);
        const k = m && matchStage(m[1]);
        if (k) custom[k] = m[2].trim();
    }
    return String(custom[key] ?? stageDef(key)?.note ?? "").replace(/\{\{user\}\}/gi, user).trim();
}

// Whether this character's bond reaches the story model at all: bars exist,
// injection on, a bond, not graduated.
export function bondInjects(d, c) {
    return !!(d?.bonds?.inject !== false && bondDefs(d).length && c?.bond && !c.bond.graduated);
}

// One character's story-facing content: the stage + its role note, and the
// open threads (their notes — third person, both names — or the name when
// the tracker left no note). No numbers, no bars, no feelings.
export function bondStoryParts(d, c, user = "the player") {
    if (!bondInjects(d, c)) return null;
    const key = stageOf(c);
    const threads = (c.bond.statuses || []).map(s => String(s.note || s.name || "").trim()).filter(Boolean);
    return { stage: stageDef(key).name, note: stageNote(d, key, user), threads };
}

// Plain-prose rendering (the message-attached line): reads as a narrator
// aside, no tags.
export function bondStoryText(d, c, user = "the player") {
    const p = bondStoryParts(d, c, user);
    if (!p) return "";
    const lines = [`${c.name} — ${p.stage}: ${p.note}`];
    if (p.threads.length) lines.push(`Still open between ${c.name} and ${user}: ${p.threads.join(" ")}`);
    return lines.join("\n");
}

// Whether the bond line should be attached to message `now`: the bond
// changed in this pass, or the character is in the exchange and their last
// attached line is old enough to have scrolled away.
export function bondNeedsAttach(d, c, now, mentioned) {
    if (!bondInjects(d, c)) return false;
    if (c.bond.touchedAt === now) return true;
    if (!mentioned) return false;
    const at = Number(c.bond.attachedAt);
    return !Number.isFinite(at) || now - at >= bondConfig(d).reattach || at > now;
}
