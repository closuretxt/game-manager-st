// Roster rotation — pure functions over `d` (no ST imports, unit-tested).
//
// The party is the cast the story is currently about; the roster is the
// bench. With rotation on, the post-pass tracker judges who is actually in
// the scene with the player and reports it as <scene_cast> (leave / join).
// Name matching over the chat could not tell "mentioned" from "present"
// (a character talked ABOUT stayed in the party, one present but quiet left
// it), so the decision is the LLM's; this module only enforces the limits:
// pinned characters and the player never leave, the party never empties,
// recalls respect the cap and need a sheet.
//
// Separately (rotation on or off), benched characters with a sheet who
// appear in the latest exchange are "present": the post-pass sees their
// full sheets and may update them.

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
// `aliases` ("also known as") count as whole names too.
export function isMentioned(text, name, aliases = []) {
    const hay = String(text ?? "");
    if (!hay) return false;
    const needles = [...mentionNeedles(name), ...(aliases || []).map(a => String(a ?? "").trim().toLowerCase()).filter(a => a.length >= 2)];
    return needles.some(n =>
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "iu").test(hay));
}

const normName = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const sameName = (a, b) => !!normName(a) && normName(a) === normName(b);

// Reported name -> actor: the tracked name first, then a unique alias.
function findActor(list, name, aliasesOf) {
    const exact = list.find(x => sameName(x.name, name));
    if (exact) return exact;
    const hits = list.filter(x => (aliasesOf(x) || []).some(a => sameName(a, name)));
    return hits.length === 1 ? hits[0] : null;
}

// Turns the tracker's <scene_cast> report into a rotation plan without
// touching `d`. `report` = { leave: [names], join: [names] }. Returns
// { out: [charId], in: [rosterId] }.
// - Pinned characters and `keepNames` (the player's own character) never
//   leave; the party never empties (the first reported stays).
// - Only benched characters WITH a sheet come back, up to `cap`.
export function planRotation(d, report = {}, { cap = 6, keepNames = [] } = {}) {
    const chars = d?.characters || [];
    const out = [];
    for (const name of report.leave || []) {
        const c = findActor(chars, name, x => x.aliases);
        if (!c || out.includes(c.id) || c.pinned || keepNames.some(k => sameName(k, c.name))) continue;
        out.push(c.id);
    }
    if (out.length && out.length === chars.length) out.shift();
    const free = Math.max(0, cap - (chars.length - out.length));
    const ins = [];
    for (const name of report.join || []) {
        const r = findActor(d?.roster || [], name, x => x.sheet?.aliases);
        if (!r?.sheet || ins.includes(r.id)) continue;
        ins.push(r.id);
    }
    return { out, in: ins.slice(0, free) };
}

// Benched characters with a sheet named in `text` (the latest exchange).
export function presentRoster(d, text) {
    return (d?.roster || []).filter(r => r.sheet && isMentioned(text, r.name, r.sheet.aliases));
}
