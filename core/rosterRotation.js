// Roster rotation — pure functions over `d` (no ST imports, unit-tested).
//
// The party is the cast the story is currently about; the roster is the
// bench. With rotation on, a party character nobody has named in the last
// ROTATION_LOOKBACK messages is benched (full sheet kept), and a benched
// character with a sheet who shows up in the latest exchange comes back,
// up to the party cap. Presence is plain name matching (like Chronogram's
// participant lookback): no LLM call, deterministic, reruns cleanly after
// a swipe rollback.
//
// Separately (rotation on or off), benched characters with a sheet who
// appear in the latest exchange are "present": the post-pass sees their
// full sheets and may update them.

export const ROTATION_LOOKBACK = 20;

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lowercased names that count as "this character is mentioned": the full
// name, plus the first word of a multi-word name ("Kael" for "Kael Voss").
export function mentionNeedles(name) {
    const full = String(name ?? "").trim().toLowerCase();
    const needles = new Set();
    if (full.length >= 2) needles.add(full);
    const first = full.split(/\s+/)[0];
    if (first && first !== full && first.length >= 4) needles.add(first);
    return [...needles];
}

// Whole-word match with Unicode letters as word characters (\b treats "é"
// as a boundary, so "Zoé" would match inside "Zoéline").
export function isMentioned(text, name) {
    const hay = String(text ?? "");
    if (!hay) return false;
    return mentionNeedles(name).some(n =>
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "iu").test(hay));
}

// Index of the newest message mentioning `name`, or -1. `messages` is
// [{ idx, text }] (text includes the speaker name: a character who speaks
// is present even when nobody says their name).
export function lastMention(messages, name) {
    let best = -1;
    for (const m of messages) {
        if (m.idx > best && isMentioned(m.text, name)) best = m.idx;
    }
    return best;
}

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// Decides the rotation without touching `d`. `now` is the index of the newest
// message; `messages` covers the lookback window. Returns
// { seen: {charId: idx}, out: [charId], in: [rosterId] }.
// - A party character's last_seen starts at `now` the first time rotation
//   sees them (a fresh character gets a full window of grace).
// - Pinned characters and `keepNames` (the player's own character) never
//   leave; the party never empties.
// - Only benched characters WITH a sheet come back, and only when named in
//   the latest exchange (idx >= exchangeFrom), newest mention first.
export function planRotation(d, messages, now, { cap = 6, keepNames = [], exchangeFrom = now - 1 } = {}) {
    const chars = d?.characters || [];
    const seen = {};
    const out = [];
    for (const c of chars) {
        const prev = Number.isFinite(c.last_seen) ? Math.min(c.last_seen, now) : now;
        const s = Math.max(prev, lastMention(messages, c.name));
        seen[c.id] = s;
        if (c.pinned || keepNames.some(k => sameName(k, c.name))) continue;
        if (now - s >= ROTATION_LOOKBACK) out.push(c.id);
    }
    if (out.length && out.length === chars.length) {
        // Keep the most recently seen one rather than an empty party.
        const keep = [...out].sort((a, b) => seen[b] - seen[a])[0];
        out.splice(out.indexOf(keep), 1);
    }
    const free = Math.max(0, cap - (chars.length - out.length));
    const recent = messages.filter(m => m.idx >= exchangeFrom);
    const candidates = (d?.roster || [])
        .filter(r => r.sheet)
        .map(r => ({ id: r.id, at: lastMention(recent, r.name) }))
        .filter(x => x.at >= 0)
        .sort((a, b) => b.at - a.at);
    return { seen, out, in: candidates.slice(0, free).map(x => x.id) };
}

// Benched characters with a sheet named in `text` (the latest exchange).
export function presentRoster(d, text) {
    return (d?.roster || []).filter(r => r.sheet && isMentioned(text, r.name));
}
