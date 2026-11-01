// CHRONOGRAM — the world clock, each present character's daily schedule and
// the plans made in the story (the Chronogram fold-in: no separate tracker
// call, the GM post-pass keeps it).
//
// Per chat: d.chrono = {
//   clock: null | { date: "MM/DD/YYYY", time: "HH:MM" },
//   locked,                       // frozen clock: <clock_update> is ignored
//   schedules: { owner: { date: [{ time, activity }] } },   owner = sheet id | "player"
//   plans: [{ id, title, date, time, note, status, created }],   status = active | kept | missed | cancelled
//   schedules_on, plans_on,       // tracking modules
//   schedules_party,              // false (default) = only the player keeps a schedule
//   inject_clock, inject_schedules, inject_plans,
//   guide,                        // custom story-facing guidance ("" = built-in)
// }
// The clock is set ONCE (wizard, first post-pass or by hand) with absolute
// values; after that the tracker only reports how much time PASSED, which
// removes the copy-the-example / drift-backward failure of absolute clocks.
//
// Pure functions over the data object (no ST imports) — the store wraps them.

import { genId } from "./schemas.js";

export const PLAYER_OWNER = "player";
const SCHEDULE_DAYS_KEPT = 2;
const PLAN_INJECT_DAYS = 7;   // dated plans reach the story prompt only this close
const PLAN_GRACE_MIN = 60;    // a timed plan counts as overdue this long after its time
export const PLAN_STATUSES = ["active", "kept", "missed", "cancelled"];
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
    if (!Array.isArray(c.plans)) c.plans = [];
    // Long-term objectives became casual plans (goals injected every turn made
    // the story model steer scenes toward them). Carried over once; their old
    // on/off flags are not, since the module now means something else.
    if (Array.isArray(c.objectives)) {
        const year = c.clock ? parseDateMDY(c.clock.date).getFullYear() : null;
        const status = { completed: "kept", abandoned: "cancelled" };
        for (const o of c.objectives) {
            if (!o || typeof o !== "object" || !String(o.title ?? "").trim()) continue;
            c.plans.push({
                id: o.id, title: o.title, date: repairDate(o.deadline, year), time: "",
                note: [o.description, o.progress].map(v => String(v ?? "").trim()).filter(Boolean).join(" — "),
                status: status[o.status] || "active", created: o.created,
            });
        }
    }
    delete c.objectives; delete c.objectives_on; delete c.inject_objectives;
    c.plans = c.plans.filter(p => p && typeof p === "object" && String(p.title ?? "").trim());
    for (const p of c.plans) {
        p.id = p.id || genId();
        p.title = String(p.title).trim();
        for (const k of ["date", "time", "note", "created"]) p[k] = String(p[k] ?? "");
        if (!PLAN_STATUSES.includes(p.status)) p.status = "active";
    }
    c.schedules_on = bool(c.schedules_on, true);
    c.schedules_party = bool(c.schedules_party, false);
    c.plans_on = bool(c.plans_on, true);
    c.inject_clock = bool(c.inject_clock, true);
    c.inject_schedules = bool(c.inject_schedules, true);
    c.inject_plans = bool(c.inject_plans, true);
    c.guide = typeof c.guide === "string" ? c.guide : "";
    return c;
}

// Anything to show in the Time tab outside edit mode.
export function chronoHasData(d) {
    const c = d?.chrono;
    if (!c || typeof c !== "object") return false;
    return !!c.clock || (c.plans || []).length > 0
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

// ---------- plans ----------
// Casual arrangements the story made (a dinner on Sunday, sparring at dawn,
// a promise to call back) — the small commitments a story model forgets
// days later. Not goals or quests: those belong to the tracker's threads.

// "MM/DD/YYYY" (repaired against the clock's year) and "HH:MM", each "" when
// absent or unusable — an undated plan is valid ("next time we meet").
function planWhenFields(d, date, time) {
    const t = parseTimeHM(time);
    return { date: repairDate(date, clockYear(d)), time: t === null ? "" : hm(t) };
}

// Sort key: dated plans by date/time, undated ones last.
function planStamp(p) {
    const dt = parseDateMDY(p.date);
    if (!dt) return Infinity;
    const t = parseTimeHM(p.time);
    return dt.getTime() + (t ?? 0) * 60000;
}

export function activePlans(d) {
    return (d?.chrono?.plans || []).filter(p => p.status === "active").sort((a, b) => planStamp(a) - planStamp(b));
}

// Its time has passed at the clock: a timed plan PLAN_GRACE_MIN after its
// time, a dated one once its day is over. Undated plans never are.
export function planOverdue(p, clock) {
    const now = clockToDate(clock), dt = parseDateMDY(p?.date);
    if (!now || !dt) return false;
    const t = parseTimeHM(p.time);
    if (t === null) dt.setDate(dt.getDate() + 1);
    else dt.setMinutes(t + PLAN_GRACE_MIN);
    return now.getTime() > dt.getTime();
}

// Whole calendar days from the clock's date to the plan's (negative = past).
function planDaysAway(p, clock) {
    const today = parseDateMDY(clock?.date), dt = parseDateMDY(p?.date);
    return today && dt ? Math.round((dt.getTime() - today.getTime()) / 86400000) : null;
}

export function findPlan(d, title, { activeOnly = false } = {}) {
    const list = (d?.chrono?.plans || []).filter(p => !activeOnly || p.status === "active");
    const n = norm(title);
    if (!n) return null;
    const exact = list.filter(p => norm(p.title) === n);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact.find(p => p.status === "active") || exact[0];
    const loose = list.filter(p => norm(p.title).includes(n) || n.includes(norm(p.title)));
    return loose.length === 1 ? loose[0] : null;
}

// Never duplicates an ACTIVE plan with that title (returned untouched with
// created=false); a finished one may recur ("Dinner with Mara" next week).
export function addPlan(d, fields = {}, now = "") {
    const c = chronoConfig(d);
    const title = String(fields.title ?? "").trim().slice(0, 120);
    if (!title) return null;
    const existing = (c.plans || []).find(p => p.status === "active" && norm(p.title) === norm(title));
    if (existing) return { plan: existing, created: false };
    const plan = {
        id: genId(),
        title,
        ...planWhenFields(d, fields.date, fields.time),
        note: String(fields.note ?? "").trim().slice(0, 300),
        status: "active",
        created: String(now || c.clock?.date || ""),
    };
    c.plans.push(plan);
    return { plan, created: true };
}

// Moved or changed details. Returns the plan when something changed, else null.
export function updatePlan(d, title, { date, time, note } = {}) {
    const plan = findPlan(d, title, { activeOnly: true });
    if (!plan) return null;
    let changed = false;
    const when = planWhenFields(d, date, time);
    const n = String(note ?? "").trim().slice(0, 300);
    if (when.date && when.date !== plan.date) { plan.date = when.date; changed = true; }
    if (when.time && when.time !== plan.time) { plan.time = when.time; changed = true; }
    if (n && n !== plan.note) { plan.note = n; changed = true; }
    return changed ? plan : null;
}

// outcome: kept | missed | cancelled (anything else = active again). Free
// text is read by its first known word ("kept|missed" copied from the example).
export function resolvePlan(d, titleOrId, outcome) {
    const list = d?.chrono?.plans || [];
    const plan = list.find(p => p.id === titleOrId) || findPlan(d, titleOrId, { activeOnly: true });
    const word = String(outcome ?? "").toLowerCase().match(/kept|missed|cancel|active/)?.[0] ?? "";
    const next = word.startsWith("cancel") ? "cancelled" : PLAN_STATUSES.includes(word) ? word : "active";
    if (!plan || plan.status === next) return null;
    plan.status = next;
    return plan;
}

// "Sunday 11/08/2026, 19:00" | "Sunday 11/08/2026" | "" (undated).
export function planWhenText(p) {
    if (!p?.date) return "";
    const day = weekday({ date: p.date });
    return `${day ? `${day} ` : ""}${p.date}${p.time ? `, ${p.time}` : ""}`;
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
export function chronoStateXml(d, owners, esc) {
    const c = chronoConfig(d);
    const lines = [];
    if (!c.clock) lines.push(`<chrono clock="unset">`);
    else lines.push(`<chrono clock="${esc(`${c.clock.date} ${c.clock.time}`)}" day="${weekday(c.clock)}"${c.locked ? ` locked="true"` : ""}>`);
    if (c.clock && c.schedules_on) {
        for (const o of owners) {
            lines.push(scheduleLine(o.name, c.clock.date, scheduleFor(d, o.key, c.clock.date), esc));
        }
    }
    // Every active plan (not just the injected window): the tracker resolves
    // overdue ones and folds a date's plans into that day's schedule.
    if (c.plans_on) {
        for (const p of activePlans(d)) {
            const attrs = [`title="${esc(p.title)}"`];
            if (p.date) attrs.push(`date="${esc(p.date)}"`, `day="${weekday({ date: p.date })}"`);
            if (p.time) attrs.push(`time="${esc(p.time)}"`);
            if (planOverdue(p, c.clock)) attrs.push(`overdue="true"`);
            lines.push(`<plan ${attrs.join(" ")}>${esc(p.note)}</plan>`);
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
            return `<${tag}>Schedule for ${esc(c.clock.date)}: ${esc(x.entries.map(e => `${e.time} ${e.activity}`).join("; "))}</${tag}>`;
        });
}

// Built-in story-facing guidance of the <chronogram> block, for the parts
// that are injected ({{user}} = the persona name, filled at injection).
export function defaultChronoGuide({ clock = true, schedules = true, plans = true } = {}) {
    const guide = [];
    if (clock) guide.push("The current in-fiction date and time are in <clock>; keep the narration consistent with them.");
    if (schedules) {
        guide.push(
            "- Each schedule covers the whole day: work out what each character is doing right now from the time. Someone mid-task isn't instantly free, and {{user}} has a schedule that may pull them away too.",
            "- Schedules are a loose reference, not a script. If an activity runs long, stay in it: don't rush, skip ahead, or have characters bring up later items (like dinner) before the current scene ends. If the narration is mid another scene, ignore the schedule for this beat; the timeline catches up afterward.",
        );
    }
    if (plans) guide.push("- <plan> entries are arrangements already made. Honor them when their time comes and let characters remember them; until then, don't bring them up or steer scenes toward them.");
    return guide.join("\n");
}

// The guidance actually injected: the chat's own text when set (used as-is,
// whatever modules are on), else the built-in one for what is injected.
export function chronoGuideText(d, parts, user = "the player") {
    const custom = String(d?.chrono?.guide ?? "").trim();
    return (custom || defaultChronoGuide(parts)).replace(/\{\{user\}\}/gi, user);
}

// Low-priority (cache-first): active plans from today up to PLAN_INJECT_DAYS
// ahead, plus undated ones. Far-off plans stay out so the story model can't
// bring them up early; the list only changes when the tracker edits a plan
// or the date rolls over. Without a clock nothing can be windowed: all show.
export function planInjectionLines(d, esc) {
    const c = d?.chrono;
    if (!c?.plans_on || !c.inject_plans) return [];
    return activePlans(d)
        .filter(p => {
            const days = planDaysAway(p, c.clock);
            return days === null || (days >= 0 && days <= PLAN_INJECT_DAYS);
        })
        .map(p => {
            const when = planWhenText(p) || "No set day";
            const note = String(p.note || "").trim();
            return `<plan>${esc(when)} — ${esc(p.title)}${note ? ` (${esc(note)})` : ""}</plan>`;
        });
}
