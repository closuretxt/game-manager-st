// CHRONOGRAM — the world clock, each present character's daily schedule and
// long-term objectives (the Chronogram fold-in: no separate tracker call, the
// GM post-pass keeps it).
//
// Per chat: d.chrono = {
//   clock: null | { date: "MM/DD/YYYY", time: "HH:MM" },
//   locked,                       // frozen clock: <clock_update> is ignored
//   schedules: { owner: { date: [{ time, activity }] } },   owner = sheet id | "player"
//   objectives: [{ id, owner, ownerName, title, description, deadline, steps, progress, status, created }],
//   schedules_on, objectives_on,  // tracking modules (objectives off by default)
//   schedules_party,              // false (default) = only the player keeps a schedule
//   inject_clock, inject_schedules, inject_objectives,
// }
// The clock is set ONCE (wizard, first post-pass or by hand) with absolute
// values; after that the tracker only reports how much time PASSED, which
// removes the copy-the-example / drift-backward failure of absolute clocks.
//
// Pure functions over the data object (no ST imports) — the store wraps them.

import { genId } from "./schemas.js";

export const PLAYER_OWNER = "player";
const SCHEDULE_DAYS_KEPT = 2;
const YEAR_SANITY = 10;     // years away from the clock before a date is treated as a typo
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// ---------- date/time (MM/DD/YYYY + 24h HH:MM) ----------

export function pad2(n) {
    return String(n).padStart(2, "0");
}

// Years below 100 would be mapped to 19xx by the Date constructor.
function makeDate(y, mo, day) {
    const dt = new Date(2000, mo, day);
    dt.setFullYear(y, mo, day);
    return dt;
}

export function formatDate(dt) {
    return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())}/${String(dt.getFullYear()).padStart(4, "0")}`;
}

export function formatTime(dt) {
    return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

export function parseDateMDY(s) {
    const m = String(s ?? "").match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,4})/);
    if (!m) return null;
    const mo = parseInt(m[1], 10) - 1, day = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
    const dt = makeDate(y, mo, day);
    return isNaN(dt.getTime()) ? null : dt;
}

// "14:30" / "2:30 PM" / "9 am" -> minutes since midnight | null
export function parseTimeHM(s) {
    const str = String(s ?? "").trim();
    let m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (m) {
        let h = parseInt(m[1], 10) % 12;
        if (/pm/i.test(m[3])) h += 12;
        return h * 60 + Math.min(59, parseInt(m[2] || "0", 10));
    }
    m = str.match(/^(\d{1,2}):(\d{2})/);
    if (m) return (parseInt(m[1], 10) % 24) * 60 + Math.min(59, parseInt(m[2], 10));
    return null;
}

function hm(minutes) {
    return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

export function clockToDate(clock) {
    const dt = parseDateMDY(clock?.date);
    if (!dt) return null;
    const t = parseTimeHM(clock?.time);
    if (t !== null) dt.setMinutes(t);
    return dt;
}

export function weekday(clock) {
    const dt = parseDateMDY(clock?.date);
    return dt ? WEEKDAYS[dt.getDay()] : "";
}

// Models copy the "MM/DD/YYYY" template literally ("04/12/YYYY") or slip a
// real-world year into a fantasy timeline ("2024" in 1420); both get the
// clock's year. Returns a normalized "MM/DD/YYYY" or "" when unusable.
export function repairDate(value, clockYear = null) {
    const s = String(value ?? "").replace(/​/g, "").trim();
    const full = s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,4})$/);
    const partial = !full && s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/?\s*(?:[Yy]{2,4}|\?+|_+|[Xx]{2,4})?$/);
    if (!full && !partial) return "";
    let year = full ? parseInt(full[3], 10) : null;
    if (Number.isFinite(clockYear) && (year === null || Math.abs(year - clockYear) > YEAR_SANITY)) year = clockYear;
    if (year === null) return "";
    const m = full || partial;
    const dt = parseDateMDY(`${m[1]}/${m[2]}/${year}`);
    return dt ? formatDate(dt) : "";
}

// Delta attributes (days/hours/minutes, each optional) or a "1d 2h 30m"
// shorthand -> minutes | null. Negative time never happens: clamped to 0.
export function parseDelta(attrs = {}, text = "") {
    const num = v => {
        const m = String(v ?? "").match(/[+-]?\d+/);
        return m ? parseInt(m[0], 10) : null;
    };
    let total = 0, found = false;
    for (const [keys, mult] of [[["days", "day", "d"], 1440], [["hours", "hour", "h"], 60], [["minutes", "minute", "min", "mins", "m"], 1]]) {
        const key = keys.find(k => attrs[k] !== undefined);
        const n = key ? num(attrs[key]) : null;
        if (n !== null) { total += n * mult; found = true; }
    }
    if (!found) {
        const body = String(text ?? "");
        const dm = body.match(/(\d+)\s*d(?:ays?)?\b/i), hmm = body.match(/(\d+)\s*h(?:ours?)?\b/i), mm = body.match(/(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
        if (!dm && !hmm && !mm) return null;
        total = (dm ? +dm[1] * 1440 : 0) + (hmm ? +hmm[1] * 60 : 0) + (mm ? +mm[1] : 0);
    }
    return Math.max(0, total);
}

export function formatDuration(minutes) {
    const m = Math.max(0, Math.round(minutes));
    const parts = [];
    if (m >= 1440) parts.push(`${Math.floor(m / 1440)}d`);
    if (m % 1440 >= 60) parts.push(`${Math.floor((m % 1440) / 60)}h`);
    if (m % 60 || !parts.length) parts.push(`${m % 60}m`);
    return parts.join(" ");
}

// ---------- config ----------

const bool = (v, dflt) => (typeof v === "boolean" ? v : dflt);

export function chronoConfig(d) {
    if (!d.chrono || typeof d.chrono !== "object" || Array.isArray(d.chrono)) d.chrono = {};
    const c = d.chrono;
    if (c.clock && !(parseDateMDY(c.clock.date) && parseTimeHM(c.clock.time) !== null)) c.clock = null;
    if (c.clock) c.clock = { date: formatDate(parseDateMDY(c.clock.date)), time: hm(parseTimeHM(c.clock.time)) };
    else c.clock = null;
    c.locked = !!c.locked;
    if (!c.schedules || typeof c.schedules !== "object" || Array.isArray(c.schedules)) c.schedules = {};
    if (!Array.isArray(c.objectives)) c.objectives = [];
    c.objectives = c.objectives.filter(o => o && typeof o === "object" && String(o.title ?? "").trim());
    for (const o of c.objectives) {
        o.id = o.id || genId();
        o.title = String(o.title).trim();
        for (const k of ["owner", "ownerName", "description", "deadline", "steps", "progress", "created"]) o[k] = String(o[k] ?? "");
        if (!["active", "completed", "abandoned"].includes(o.status)) o.status = "active";
    }
    c.schedules_on = bool(c.schedules_on, true);
    c.schedules_party = bool(c.schedules_party, false);
    c.objectives_on = bool(c.objectives_on, false);
    c.inject_clock = bool(c.inject_clock, true);
    c.inject_schedules = bool(c.inject_schedules, true);
    c.inject_objectives = bool(c.inject_objectives, true);
    return c;
}

// Anything to show in the Time tab outside edit mode.
export function chronoHasData(d) {
    const c = d?.chrono;
    if (!c || typeof c !== "object") return false;
    return !!c.clock || (c.objectives || []).length > 0
        || Object.values(c.schedules || {}).some(days => Object.keys(days || {}).length > 0);
}

export function clockYear(d) {
    const dt = parseDateMDY(d?.chrono?.clock?.date);
    return dt ? dt.getFullYear() : null;
}

// ---------- clock ----------

// Absolute set (anchor). Returns the new clock or null when unusable.
export function setClock(d, date, time) {
    const c = chronoConfig(d);
    const fixed = repairDate(date, null);
    const t = parseTimeHM(time);
    if (!fixed || t === null) return null;
    c.clock = { date: fixed, time: hm(t) };
    return c.clock;
}

// Moves the clock forward. Returns { from, to, minutes, dayChanged } or null.
export function advanceClock(d, minutes) {
    const c = chronoConfig(d);
    const mins = Math.max(0, Math.round(Number(minutes) || 0));
    if (!c.clock || !mins) return null;
    const from = { ...c.clock };
    const dt = clockToDate(c.clock);
    dt.setMinutes(dt.getMinutes() + mins);
    c.clock = { date: formatDate(dt), time: formatTime(dt) };
    return { from, to: { ...c.clock }, minutes: mins, dayChanged: from.date !== c.clock.date };
}

// ---------- schedules ----------

// Free lines "08:00 wakes up" (also "- 8:00 AM - text", "9am: text").
export function parseScheduleLines(text) {
    const out = [];
    for (const line of String(text ?? "").split(/\r?\n|;\s*(?=\d{1,2}(?::\d{2}|\s*[ap]m))/i)) {
        const s = line.replace(/^[\s\-*•]+/, "").trim();
        const m = s.match(/^(\d{1,2}:\d{2}(?:\s*[ap]m\b)?|\d{1,2}\s*[ap]m\b)\s*[-–—:.]?\s*(.+)$/i);
        if (!m) continue;
        const t = parseTimeHM(m[1]);
        if (t === null) continue;
        const activity = m[2].replace(/\s*\(\s*current\s*\)\s*$/i, "").trim();
        if (activity) out.push({ time: hm(t), activity: activity.slice(0, 200) });
    }
    return out.sort((a, b) => parseTimeHM(a.time) - parseTimeHM(b.time)).slice(0, 24);
}

export function scheduleFor(d, owner, date) {
    const list = d?.chrono?.schedules?.[owner]?.[date];
    return Array.isArray(list) ? list : [];
}

// Stores one owner's day, keeping only the newest SCHEDULE_DAYS_KEPT dates
// (never pruning the clock's date). Returns the stored date or "".
// A rewrite identical to the stored day is a no-op ("") so it neither
// notifies nor breaks the cached low-priority block.
export function setSchedule(d, owner, date, entries) {
    const c = chronoConfig(d);
    const fixed = repairDate(date, clockYear(d));
    const list = (Array.isArray(entries) ? entries : []).filter(e => e?.time && e?.activity);
    if (!owner || !fixed || !list.length) return "";
    const same = (a, b) => a.length === b.length && a.every((e, i) => e.time === b[i].time && e.activity === b[i].activity);
    if (same(scheduleFor(d, owner, fixed), list)) return "";
    const days = c.schedules[owner] = c.schedules[owner] || {};
    days[fixed] = list.map(e => ({ time: String(e.time), activity: String(e.activity) }));
    const keep = new Set([c.clock?.date, fixed].filter(Boolean));
    const newestFirst = Object.keys(days).sort((a, b) => (parseDateMDY(b)?.getTime() ?? 0) - (parseDateMDY(a)?.getTime() ?? 0));
    for (const date of newestFirst) if (keep.size < SCHEDULE_DAYS_KEPT) keep.add(date);
    for (const date of newestFirst) if (!keep.has(date)) delete days[date];
    return fixed;
}

// Owners whose schedules no longer belong to anyone tracked are dropped.
export function pruneScheduleOwners(d, keepOwners) {
    const keep = new Set(keepOwners);
    const c = chronoConfig(d);
    for (const owner of Object.keys(c.schedules)) if (!keep.has(owner)) delete c.schedules[owner];
}

// What an owner is doing at the clock: the slot in progress, the next one,
// and the rest of the day.
export function nowNext(entries, time) {
    const nowMin = parseTimeHM(time);
    let now = null;
    const upcoming = [];
    for (const e of entries || []) {
        const t = parseTimeHM(e.time);
        if (nowMin !== null && t !== null && t <= nowMin) now = e;
        else upcoming.push(e);
    }
    return { now, next: upcoming[0] || null, rest: upcoming.slice(1) };
}

// ---------- objectives ----------

export function findObjective(d, title, { owner = null, activeOnly = false } = {}) {
    const list = (d?.chrono?.objectives || []).filter(o => !activeOnly || o.status === "active");
    const n = norm(title);
    if (!n) return null;
    const pool = owner ? list.filter(o => o.owner === owner) : list;
    const exact = pool.filter(o => norm(o.title) === n);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact.find(o => o.status === "active") || exact[0];
    const loose = pool.filter(o => norm(o.title).includes(n) || n.includes(norm(o.title)));
    return loose.length === 1 ? loose[0] : null;
}

// Never duplicates: an existing objective with that title (same owner) is
// returned untouched with created=false.
export function addObjective(d, fields = {}, now = "") {
    const c = chronoConfig(d);
    const title = String(fields.title ?? "").trim().slice(0, 120);
    if (!title) return null;
    const existing = findObjective(d, title, { owner: fields.owner || null });
    if (existing && norm(existing.title) === norm(title)) return { objective: existing, created: false };
    const obj = {
        id: genId(),
        owner: String(fields.owner ?? ""),
        ownerName: String(fields.ownerName ?? "").trim(),
        title,
        description: String(fields.description ?? "").trim().slice(0, 400),
        deadline: String(fields.deadline ?? "").trim().slice(0, 60),
        steps: String(fields.steps ?? "").trim().slice(0, 300),
        progress: "",
        status: "active",
        created: String(now || c.clock?.date || ""),
    };
    c.objectives.push(obj);
    return { objective: obj, created: true };
}

// Returns the objective when something changed, else null.
export function updateObjective(d, title, { progress, deadline } = {}) {
    const obj = findObjective(d, title, { activeOnly: true });
    if (!obj) return null;
    let changed = false;
    const p = String(progress ?? "").trim().slice(0, 300);
    const dl = String(deadline ?? "").trim().slice(0, 60);
    if (p && p !== obj.progress) { obj.progress = p; changed = true; }
    if (dl && dl !== obj.deadline) { obj.deadline = dl; changed = true; }
    return changed ? obj : null;
}

export function setObjectiveStatus(d, titleOrId, status) {
    const list = d?.chrono?.objectives || [];
    const obj = list.find(o => o.id === titleOrId) || findObjective(d, titleOrId, { activeOnly: true });
    const next = ["completed", "abandoned"].includes(status) ? status : "active";
    if (!obj || obj.status === next) return null;
    obj.status = next;
    return obj;
}

// ---------- prompt / injection text ----------

// The whole day as one line, for the tracker snapshot and the low block. No
// now/next pointers: the reader matches the clock against the plan itself,
// and the line stays byte-identical all day.
function scheduleLine(ownerLabel, date, entries, esc) {
    if (!entries.length) return `<schedule owner="${esc(ownerLabel)}" missing="true"/>`;
    return `<schedule owner="${esc(ownerLabel)}" date="${esc(date)}">${esc(entries.map(e => `${e.time} ${e.activity}`).join("; "))}</schedule>`;
}

// Post-pass snapshot (user message). `owners` = [{ key, name }] of the
// present cast (player first). Returns "" when the feature has nothing to say.
export function chronoStateXml(d, owners, esc, ownerNameOf = o => o.ownerName) {
    const c = chronoConfig(d);
    const lines = [];
    if (!c.clock) lines.push(`<chrono clock="unset">`);
    else lines.push(`<chrono clock="${esc(`${c.clock.date} ${c.clock.time}`)}" day="${weekday(c.clock)}"${c.locked ? ` locked="true"` : ""}>`);
    if (c.clock && c.schedules_on) {
        for (const o of owners) {
            lines.push(scheduleLine(o.name, c.clock.date, scheduleFor(d, o.key, c.clock.date), esc));
        }
    }
    if (c.objectives_on) {
        for (const o of c.objectives.filter(x => x.status === "active")) {
            const attrs = [`owner="${esc(ownerNameOf(o))}"`, `title="${esc(o.title)}"`];
            if (o.deadline) attrs.push(`deadline="${esc(o.deadline)}"`);
            if (o.progress) attrs.push(`progress="${esc(o.progress)}"`);
            lines.push(`<objective ${attrs.join(" ")}>${esc(o.description)}</objective>`);
        }
    }
    lines.push("</chrono>");
    return lines.join("\n");
}

// Story-facing tag from a display name: "Tokai Teio" -> "tokai_teio". The
// story engine reads <tokai_teio_chronogram> far more naturally than
// <schedule owner="Tokai Teio">, and the name stays bound to the content.
export function nameTag(name, fallback = "character") {
    const t = String(name ?? "").trim().toLowerCase()
        .replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "").replace(/^_+|_+$/g, "");
    if (!t) return fallback;
    return /^\p{N}/u.test(t) ? `_${t}` : t;
}

// The volatile part (time moves every turn): only the clock. Rides in the
// high-priority turn context, never in the cached low-priority block.
export function clockInjectionText(d, esc) {
    const c = d?.chrono;
    if (!c?.clock || !c.inject_clock) return "";
    return `<clock>${weekday(c.clock)} ${esc(c.clock.date)}, ${esc(c.clock.time)}</clock>`;
}

// Low-priority (cache-first): the whole day's plan only changes on a new
// calendar day or when the tracker revises it, so it stays in the cached prefix.
// Story-facing form, keyed by the owner's name (the player = persona name).
export function scheduleInjectionLines(d, owners, esc) {
    const c = d?.chrono;
    if (!c?.clock || !c.schedules_on || !c.inject_schedules) return [];
    return owners
        .map(o => ({ o, entries: scheduleFor(d, o.key, c.clock.date) }))
        .filter(x => x.entries.length)
        .map(x => {
            const tag = `${nameTag(x.o.name)}_chronogram`;
            return `<${tag}>Plan for ${esc(c.clock.date)}: ${esc(x.entries.map(e => `${e.time} ${e.activity}`).join("; "))}</${tag}>`;
        });
}

// Low-priority (cache-first): active objectives only change when the
// tracker edits one.
export function objectiveInjectionLines(d, esc, ownerNameOf = o => o.ownerName) {
    const c = d?.chrono;
    if (!c?.objectives_on || !c.inject_objectives) return [];
    return (c.objectives || []).filter(o => o.status === "active").map(o => {
        const tag = `${nameTag(ownerNameOf(o))}_objective`;
        const meta = [o.deadline && `deadline ${o.deadline}`, o.progress && `progress: ${o.progress}`].filter(Boolean).join("; ");
        const desc = String(o.description || "").trim();
        return `<${tag}>${esc(o.title)}${meta ? ` (${esc(meta)})` : ""}${desc ? `: ${esc(desc)}` : ""}</${tag}>`;
    });
}
