// BONDS — how each NPC feels about the player (the Persist redesign).
//
// Per chat, the scenario defines the bars (d.bonds.defs: Trust, Affection,
// Loyalty... — not a fixed set). Every non-player character carries one bond:
//   c.bond = { label, values: {defId: n}, statuses: [...], history: [...] }
//
// Numbers NEVER move on their own or from a bare LLM delta: they move only
// through bond statuses ("Broken promise — Trust -8"). A status applies its
// effect ONCE when created; an edit applies only the difference. Ending a
// status (the feeling resolved) reverses what it applied; a status left
// untouched for `settle` messages SETTLES — it leaves the list and its effect
// stays for good, so the list stays short and old history becomes base.
//
// Pure functions over the data object (no ST imports) — the store wraps them.

import { genId } from "./schemas.js";

export const BOND_MIN = 0;
export const BOND_MAX = 100;
export const BOND_DEFAULT_STEP = 15;     // max |effect| per bar per status
export const BOND_DEFAULT_SETTLE = 16;   // messages unmodified before a status settles
const BOND_HISTORY = 12;

// Starting bar sets. "persist" is the original tracker's six (start values kept).
export const BOND_PRESETS = {
    basic: {
        label: "Basic",
        defs: [
            { name: "Affection", start: 20, description: "Warmth and fondness toward the player." },
            { name: "Trust", start: 20, description: "Belief that the player is honest and reliable." },
            { name: "Tension", start: 5, description: "Friction, resentment or unease toward the player." },
        ],
    },
    persist: {
        label: "Persist classic",
        defs: [
            { name: "Romantic", start: 10, description: "Romantic intent and willingness. The hardest to gain; someone can be close without being romantic." },
            { name: "Friendship", start: 10, description: "How much of a friend they are; closely tied to trust." },
            { name: "Hate", start: 1, description: "Dislike toward the player. Can coexist with any other bar; carries the long-lasting results of arguments." },
            { name: "Saturation", start: 0, description: "Need for space. High means gains in the other bars are less justified for now." },
            { name: "Pursuit", start: 20, description: "Willingness to pursue the player. Falls when they feel pushed or flattered, rises when given space." },
            { name: "Acquiescence", start: 20, description: "Willingness toward intimacy; follows the relationship and trust, drops with awkward behavior." },
        ],
    },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// ---------- config ----------

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
    }
    if (typeof b.inject !== "boolean") b.inject = true;
    b.step = clamp(Math.trunc(Number(b.step) || BOND_DEFAULT_STEP), 1, 50);
    b.settle = clamp(Math.trunc(Number(b.settle) || BOND_DEFAULT_SETTLE), 2, 500);
    return b;
}

export function bondDefs(d) {
    return Array.isArray(d?.bonds?.defs) ? d.bonds.defs : [];
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

// ---------- per-character bond ----------

// Normalizes (and with create, makes) a character's bond against the defs.
export function ensureBond(c, d, create = true) {
    const defs = bondDefs(d);
    if (!c.bond || typeof c.bond !== "object") {
        if (!create) return null;
        c.bond = {};
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
    if (b.recent && (typeof b.recent !== "object" || !Array.isArray(b.recent.events))) delete b.recent;
    for (const ev of b.recent?.events || []) {
        if (!ev.shifts || typeof ev.shifts !== "object") ev.shifts = {};
        for (const k of Object.keys(ev.shifts)) if (!ids.has(k)) delete ev.shifts[k];
    }
    return b;
}

// What the latest pass changed, one pass deep (the story prompt's shift note).
// A different `now` starts a fresh list, so old changes never pile up; the
// same feeling touched twice in one pass merges into one event.
function noteRecent(bond, now, kind, name, shifts) {
    if (!bond.recent || bond.recent.at !== now) bond.recent = { at: now, events: [] };
    const ev = bond.recent.events.find(e => e.name === name);
    if (!ev) {
        bond.recent.events.push({ kind, name, shifts: { ...shifts } });
        return;
    }
    if (kind === "end") ev.kind = "end";
    for (const [k, n] of Object.entries(shifts)) {
        ev.shifts[k] = (ev.shifts[k] || 0) + n;
        if (!ev.shifts[k]) delete ev.shifts[k];
    }
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

// Creates or edits a status and applies the not-yet-applied part of its
// effect. Returns { action: "new"|"edit", status, shifts: {defId: n} } or null.
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
    // A reworded note alone is no shift worth telling the story engine.
    if (action === "new" || Object.keys(shifts).length) noteRecent(bond, now, action, status.name, shifts);
    return { action, status, shifts };
}

function archive(bond, status, outcome, now) {
    bond.history.unshift({ name: status.name, effect: status.effect, outcome, at: now });
    bond.history.length = Math.min(bond.history.length, BOND_HISTORY);
}

// The feeling resolved: what the status applied is taken back out.
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
    noteRecent(bond, now, "end", status.name, shifts);
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

// ---------- injection ----------

// Bonds ride in the per-turn (high-priority) context, which is rebuilt every
// turn anyway: exact values cost no cache, and the band word tells the story
// engine how to read the number.
export function bondBand(v) {
    const n = Number(v) || 0;
    if (n < 15) return "very low";
    if (n < 35) return "low";
    if (n < 60) return "moderate";
    if (n < 85) return "high";
    return "very high";
}

// One short prose line per bonded character: the relationship label and the
// banded bars, in words (no numbers — the story engine echoed them back).
// Feelings stay tracker-side: they already move the bars and the label, and
// listing them every turn bloated the prompt. `esc` = the caller's body
// escaper; `tag` = the element name (the character's name tag).
export function bondInjectionLine(d, c, esc, tag = "bond") {
    const defs = bondDefs(d);
    if (!defs.length || !c.bond) return "";
    const bars = defs.map(x => `${x.name} ${bondBand(c.bond.values?.[x.id])}`).join(", ");
    const label = String(c.bond.label || "").trim().replace(/[.\s]+$/, "");
    return `<${tag}>${esc(`${label ? `${label}. ` : ""}${bars}.`)}</${tag}>`;
}

// Whether the latest pass's changes still describe "last turn" at chat index
// `last` (the newest message when the prompt is built). The pass that wrote
// them accounted AI message N: the next prompt is built at N+1 (the user's
// reply), a swipe of the following reply at N+2 (rollback restored this
// record). Older than that = a pass was skipped since, so it is stale.
export function bondShiftFresh(c, last) {
    const at = c?.bond?.recent?.at;
    return Number.isFinite(at) && last >= at && last - at <= 2;
}

// One-turn note of what moved: "started feeling X (Trust +6); ended Y".
// No longer injected (bondInjectionLine folds the marks in); kept for UI/tests.
export function bondShiftLine(d, c, last, esc) {
    if (!bondShiftFresh(c, last)) return "";
    const defs = bondDefs(d);
    const verb = { new: "started feeling", edit: "changed feeling", end: "stopped feeling" };
    const parts = c.bond.recent.events.map(ev => {
        const fx = formatEffects(ev.shifts, defs);
        return `${verb[ev.kind] || verb.edit} ${ev.name}${fx ? ` (${fx})` : ""}`;
    });
    if (!parts.length) return "";
    return `<bond_shift char="${esc(c.name)}">${esc(parts.join("; "))}</bond_shift>`;
}
