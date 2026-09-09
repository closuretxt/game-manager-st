// GLOBAL SHEET RENDERER — the single place that turns sheet objects into
// LLM-readable XML, like valueGuidelines is the single source for numeric
// rules. Every GM_SCHEMA description field (resources, attributes, items,
// skills, passives, status effects, shared, custom) reaches the model here.
// XML is minimal and single-line: scalars as attributes, descriptions as
// element bodies, self-closing when empty, no indentation, never truncated.

import { escAttr } from "./toolParser.js";
import { resolveResourceMax } from "./resourceScaler.js";

// Collapse whitespace so multi-line descriptions stay one compact line.
const oneLine = v => String(v ?? "").replace(/\s+/g, " ").trim();

// Minimal single-line element: <tag a="1">body</tag> or <tag a="1"/> when the
// body is empty. attrs is a plain object; undefined/null/"" values are skipped.
export const xmlEl = (tag, attrs = {}, bodyText = "") => {
    const list = Object.entries(attrs)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}="${escAttr(v)}"`);
    const open = `<${tag}${list.length ? ` ${list.join(" ")}` : ""}`;
    return bodyText ? `${open}>${bodyText}</${tag}>` : `${open}/>`;
};

// Description body: escaped one-line text, or "" (attribute-only element).
const body = (v, enabled) => (enabled ? escAttr(oneLine(v)) : "");

// ---------- per-type renderers ----------

export const resourceXml = (r, descriptions = true, actor = null) => {
    const max = resolveResourceMax(actor, r);
    return xmlEl("resource", {
        name: r?.name,
        // Effective max — formula strings ("100+(Level*10)") resolve per actor.
        value: `${r?.value ?? 0}/${Number.isFinite(max) ? max : 0}`,
        min: Number(r?.min) > 0 ? Number(r.min) : "",
    }, body(r?.description, descriptions));
};

export const attributeXml = (a, descriptions = true) => xmlEl("attribute", {
    name: a?.name,
    value: a?.value ?? 0,
}, body(a?.description, descriptions));

export const itemXml = (i, descriptions = true) => xmlEl("item", {
    name: i?.name,
    qty: i?.qty ?? 1,
}, body(i?.description, descriptions));

export const skillXml = (s, descriptions = true) => xmlEl("skill", {
    // * travels with the name (existing legends: "no * marker" = on cooldown).
    name: `${s?.name ?? ""}${(Number(s?.cooldown_left) || 0) > 0 ? "*" : ""}`,
    cost: String(s?.cost || "").trim(),
    // Configured cooldown (messages) — the tree generator may alter it.
    cooldown: Number(s?.cooldown) > 0 ? Number(s.cooldown) : "",
}, body(s?.description, descriptions));

export const passiveXml = (p, descriptions = true) => xmlEl("passive", {
    name: p?.name,
}, body(p?.description, descriptions));

export const statusXml = (s, descriptions = true) => xmlEl("status", {
    name: s?.name,
    modifiers: String(s?.modifiers || "").trim(),
}, body(s?.effect, descriptions));

// Party-level entries (shared resources, custom features).
export const sharedXml = (r, descriptions = true) => xmlEl("entry", {
    name: r?.name,
    qty: r?.qty ?? 0,
}, body(r?.description, descriptions));

export const customXml = (c, descriptions = true) => xmlEl("entry", {
    name: c?.name,
    value: c?.value ?? "",
}, body(c?.description, descriptions));

// ---------- section registry ----------

// Keyed by the actor's container field — a future GM_SCHEMA type needs one
// renderer above and one entry here.
const SECTIONS = {
    resources: resourceXml,
    attributes: attributeXml,
    inventory: itemXml,
    skills: skillXml,
    passives: passiveXml,
    statuses: statusXml,
};

export const ALL_SECTIONS = Object.keys(SECTIONS);

// Render one actor as a single-line sheet. Options:
//   tag          element name (default "char"; also "enemy"/"actor")
//   sections     containers to include (default all, in registry order)
//   descriptions include description bodies (default true; false = compact)
//   attrs        extra literal attributes, e.g. { state: "ko", level: 3 }
//   filter       optional (entry, section) => bool per-entry filter
export function sheetXml(actor, {
    tag = "char",
    sections = ALL_SECTIONS,
    descriptions = true,
    attrs = {},
    filter = null,
} = {}) {
    const attrList = [`name="${escAttr(actor?.name)}"`];
    for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null && v !== "") attrList.push(`${k}="${escAttr(v)}"`);
    }
    const children = sections.filter(s => SECTIONS[s]).map(s => {
        const entries = (actor?.[s] || []).filter(e => !filter || filter(e, s));
        return entries.map(e => SECTIONS[s](e, descriptions, actor)).join("");
    }).join("");
    const open = `<${tag} ${attrList.join(" ")}`;
    return children ? `${open}>${children}</${tag}>` : `${open}/>`;
}
