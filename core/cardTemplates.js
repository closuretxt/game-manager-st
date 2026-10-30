// Standard card — the per-chat character template with LIVE STRUCTURE SYNC.
// The card lists the resources, attributes and details every linked party
// character carries (d.cardTemplate = { resources, attributes, traits }, plain
// schema entries whose ids double as field ids). Linked sheets
// (c.template_link) tag their copy of each field with `tid` = that id:
//   - adding a field to the card adds it to every linked sheet,
//   - renaming / editing its structure (range, description, inject flag)
//     rewrites those keys on every linked copy,
//   - removing it removes the linked copies.
// VALUES stay per character (a card edit never touches value), and a
// structure key is only rewritten when the CARD changes it — a character's
// own tweak (a tank's bigger max) survives until the card edits that key.
// Extra entries beyond the card are allowed; unlinked characters are never
// touched. Lives in game data, so snapshot rollbacks treat card edits like
// any other change.
//
// Pure functions over a data object (no stateManager import) so
// stateManager itself can conform new sheets without an import cycle.

import { GM_SCHEMA, CONTAINER_TYPES, defaultEntry } from "./schemas.js";

export const TEMPLATE_CONTAINERS = ["resources", "attributes", "traits"];

// Per-character keys: never propagated by a card edit.
const VALUE_KEYS = new Set(["id", "tid", "value"]);

// Injection flags are the card's call on every linked copy, on every
// conform: a sheet built by the wizard/generator/tracker never carries them
// (the LLM is not asked for them), so a per-copy value would silently stay
// off while the card says "inject".
const CARD_FLAGS = ["always_inject", "inject_description"];

function structureKeys(type) {
    return GM_SCHEMA[type].fields.map(f => f.key).filter(k => !VALUE_KEYS.has(k));
}

function normName(v) {
    return String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function emptyTemplate() {
    return Object.fromEntries(TEMPLATE_CONTAINERS.map(k => [k, []]));
}

// The chat's card, or null when it has no fields.
export function getTemplate(d) {
    const t = d?.cardTemplate;
    if (!t || typeof t !== "object") return null;
    return TEMPLATE_CONTAINERS.some(k => Array.isArray(t[k]) && t[k].length) ? t : null;
}

export function hasTemplate(d) {
    return !!getTemplate(d);
}

// Editable working copy for the card editor (always has every container).
export function templateDraft(d) {
    const t = getTemplate(d);
    const out = emptyTemplate();
    if (t) for (const k of TEMPLATE_CONTAINERS) out[k] = structuredClone(t[k] || []);
    return out;
}

// Card built from an existing sheet's structure (values kept as defaults).
export function templateFromSheet(sheet) {
    const out = emptyTemplate();
    for (const k of TEMPLATE_CONTAINERS) {
        out[k] = (sheet?.[k] || []).map(e => {
            const { id, tid, ...rest } = structuredClone(e);
            return defaultEntry(CONTAINER_TYPES[k], rest);
        });
    }
    return out;
}

// Per-chat option (d.cardEnemies): every enemy sheet, active or archived,
// follows the card too — no per-enemy link, enemies come and go too fast.
export function enemiesFollowCard(d) {
    return !!d?.cardEnemies && hasTemplate(d);
}

// Turns the enemy option on/off. Off strips the enemies' tags (their
// entries stay); on conforms every enemy sheet right away.
export function setEnemiesFollowCard(d, on) {
    const enemies = [...(d?.enemies || []), ...(d?.enemyArchive || [])];
    if (on) {
        d.cardEnemies = true;
        const tpl = getTemplate(d);
        if (tpl) for (const e of enemies) conformSheet(e, tpl);
    } else {
        delete d.cardEnemies;
        for (const e of enemies) for (const k of TEMPLATE_CONTAINERS) for (const x of e[k] || []) delete x.tid;
    }
}

// Whether one sheet (party, roster or enemy) follows the card.
export function followsCard(d, sheet) {
    if (!sheet || !hasTemplate(d)) return false;
    if (sheet.template_link) return true;
    return !!d.cardEnemies && [...(d.enemies || []), ...(d.enemyArchive || [])].includes(sheet);
}

// Party characters, roster sheets and (with the option) enemies that follow the card.
export function linkedSheets(d) {
    return [
        ...(d?.characters || []).filter(c => c.template_link),
        ...(d?.roster || []).filter(r => r.template_link && r.sheet).map(r => r.sheet),
        ...(d?.cardEnemies ? [...(d.enemies || []), ...(d.enemyArchive || [])] : []),
    ];
}

// Makes one sheet carry every card field: entries already tagged keep their
// values, same-name untagged entries are adopted, missing fields are added
// with the card's defaults. Card fields come first, in card order, then the
// sheet's extras. Returns how many entries were added.
export function conformSheet(sheet, tpl) {
    if (!sheet || !tpl) return 0;
    let added = 0;
    for (const container of TEMPLATE_CONTAINERS) {
        const type = CONTAINER_TYPES[container];
        const fields = Array.isArray(tpl[container]) ? tpl[container] : [];
        const ids = new Set(fields.map(f => f.id));
        const list = Array.isArray(sheet[container]) ? sheet[container] : [];
        // Tags pointing at fields that no longer exist are stale.
        for (const e of list) if (e.tid && !ids.has(e.tid)) delete e.tid;
        const ordered = [];
        for (const f of fields) {
            let e = list.find(x => x.tid === f.id)
                || list.find(x => !x.tid && normName(x.name) === normName(f.name));
            if (e) {
                // Adopted entries take the card's exact spelling and fill an
                // empty description from it; their own range survives (a
                // tank's bigger max), like a per-character tweak would.
                if (!e.tid) {
                    e.name = f.name;
                    if (!String(e.description ?? "").trim() && String(f.description ?? "").trim()) e.description = f.description;
                }
                for (const k of CARD_FLAGS) {
                    if (f[k] !== undefined) e[k] = !!f[k];
                }
                e.tid = f.id;
            } else {
                const { id, ...structure } = structuredClone(f);
                e = defaultEntry(type, { ...structure, tid: f.id });
                added++;
            }
            ordered.push(e);
        }
        sheet[container] = [...ordered, ...list.filter(e => !ordered.includes(e))];
    }
    return added;
}

// Replaces the card with `next` and syncs every linked sheet: removed fields
// drop their linked copies, structure keys the card changed are rewritten,
// new fields are added. Returns { added, removed, updated } entry counts.
export function syncTemplate(d, next) {
    const prev = getTemplate(d) || emptyTemplate();
    const stats = { added: 0, removed: 0, updated: 0 };
    const sheets = linkedSheets(d);
    // An empty card deletes the card itself: linked sheets keep every entry
    // (only the tags go) instead of losing all the fields at once.
    if (!TEMPLATE_CONTAINERS.some(k => Array.isArray(next?.[k]) && next[k].length)) {
        delete d.cardTemplate;
        delete d.cardEnemies;
        for (const sheet of sheets) for (const k of TEMPLATE_CONTAINERS) for (const e of sheet[k] || []) delete e.tid;
        return stats;
    }
    for (const container of TEMPLATE_CONTAINERS) {
        const type = CONTAINER_TYPES[container];
        const nextList = Array.isArray(next?.[container]) ? next[container] : [];
        const nextIds = new Set(nextList.map(f => f.id));
        const prevById = new Map((prev[container] || []).map(f => [f.id, f]));
        for (const sheet of sheets) {
            const list = Array.isArray(sheet[container]) ? sheet[container] : (sheet[container] = []);
            for (const old of prev[container] || []) {
                if (nextIds.has(old.id)) continue;
                const idx = list.findIndex(e => e.tid === old.id);
                if (idx !== -1) {
                    list.splice(idx, 1);
                    stats.removed++;
                }
            }
            for (const f of nextList) {
                const old = prevById.get(f.id);
                const e = old && list.find(x => x.tid === f.id);
                if (!e) continue;
                for (const k of structureKeys(type)) {
                    if (JSON.stringify(old[k]) !== JSON.stringify(f[k])) {
                        e[k] = structuredClone(f[k]);
                        stats.updated++;
                    }
                }
            }
        }
    }
    const clean = emptyTemplate();
    for (const k of TEMPLATE_CONTAINERS) clean[k] = structuredClone(next?.[k] || []);
    d.cardTemplate = clean;
    for (const sheet of sheets) stats.added += conformSheet(sheet, clean);
    return stats;
}

// Fresh entries for a brand-new sheet built from the card alone.
export function templateEntries(d) {
    const sheet = {};
    conformSheet(sheet, getTemplate(d));
    return sheet;
}

// STANDARD CARD prompt block for the generators: exact names, ranges and
// descriptions; the LLM only picks the values. Empty when there is no card.
export function templatePromptBlock(d, escAttr) {
    const tpl = getTemplate(d);
    if (!tpl) return [];
    const lines = [];
    for (const container of TEMPLATE_CONTAINERS) {
        const type = CONTAINER_TYPES[container];
        for (const f of tpl[container] || []) {
            const attrs = structureKeys(type)
                .filter(k => !CARD_FLAGS.includes(k) && f[k] !== undefined && f[k] !== null && f[k] !== "")
                .map(k => `${k}="${escAttr(String(f[k]).replace(/\s+/g, " ").trim())}"`);
            lines.push(`<${type} ${attrs.join(" ")}/>`);
        }
    }
    return [
        "STANDARD CARD — every party character of this chat carries EXACTLY these entries, with these exact names, ranges and descriptions; choose only each entry's value (traits: the text) for THIS character. Add other entries only when the character genuinely needs more.",
        "<card>",
        ...lines,
        "</card>",
    ];
}
