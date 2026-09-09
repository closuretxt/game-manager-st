// GLOBAL SHEET RENDERER — the single place that turns sheet objects into
// LLM-readable XML, like valueGuidelines is the single source for numeric
// rules. Every GM_SCHEMA description field (resources, attributes, items,
// skills, passives, status effects, shared, custom) reaches the model here.
//
// SECTIONED NAME-KEY LAYOUT: each SECTION is a wrapper element that appears
// ONCE per actor (<resources>, <attributes>, <items>, <skills>, <passives>,
// <statuses>), and every entry inside is an element whose TAG is the tracked
// NAME with the value as its single attribute and the description as its
// body — <HP="30/30">Vitality</HP>, <Fireball*="cost: 5 MP, cd: 3">2d6 fire
// + 1d4 burn</Fireball>. No repeated name="..." noise, no bracket tails;
// the description always sits inside its own entry. Empty sections are
// skipped entirely, each actor renders as ONE line, and the closing tag
// carries the actor's name (</char Kael>) so long sheets re-bind entries to
// the actor at both ends. Non-standard XML is fine: this is model-facing
// text only — the tool-tag parser (core/toolParser.js) reads the MODEL's
// output, which keeps the explicit name="..." syntax shown in the prompts.

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

// Name-keyed entry: <Name="value">body</Name>; an empty value renders a bare
// element (<Beast Form>effect</Beast Form>). The tracked name IS the tag —
// exactly the name the model must echo into its name="..." tool tags.
const entryEl = (name, value, bodyText = "") => {
    const key = escAttr(name || "?");
    const open = value ? `${key}="${escAttr(value)}"` : key;
    return bodyText ? `<${open}>${bodyText}</${key}>` : `<${open}/>`;
};

// Description body: escaped one-line text, or "" (attribute-only element).
// Element bodies do NOT need quote escaping — descriptions render with their
// literal quotes ("Sleepy"), never as " noise. Only &, < and > must go.
const bodyEsc = v => String(v)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
const body = (v, enabled) => (enabled ? bodyEsc(oneLine(v)) : "");

// ---------- per-type renderers ----------

export const resourceXml = (r, descriptions = true, actor = null) => {
    const max = resolveResourceMax(actor, r);
    // Effective max — formula strings ("100+(Level*10)") resolve per actor.
    // Uncapped resources show the bare value, never "/0"; min is appended.
    const val = Number.isFinite(max)
        ? `${r?.value ?? 0}/${max}${Number(r?.min) > 0 ? ` (min ${Number(r.min)})` : ""}`
        : String(r?.value ?? 0);
    return entryEl(r?.name, val, body(r?.description, descriptions));
};

export const attributeXml = (a, descriptions = true) => entryEl(a?.name, String(a?.value ?? 0), body(a?.description, descriptions));

// qty travels only when it differs from the default 1 — a stack of one item
// never needs the token.
export const itemXml = (i, descriptions = true) => entryEl(i?.name, (i?.qty ?? 1) !== 1 ? String(i?.qty ?? 1) : "", body(i?.description, descriptions));

export const skillXml = (s, descriptions = true) => {
    // Value carries the cost and the CONFIGURED cooldown (the tree generator
    // may alter it); the * on-cooldown marker stays glued to the name tag.
    const bits = [];
    const cost = String(s?.cost || "").trim();
    if (cost) bits.push(`cost: ${cost}`);
    if (Number(s?.cooldown) > 0) bits.push(`cd: ${Number(s.cooldown)}`);
    const name = `${s?.name ?? "?"}${(Number(s?.cooldown_left) || 0) > 0 ? "*" : ""}`;
    return entryEl(name, bits.join(", "), body(s?.description, descriptions));
};

export const passiveXml = (p, descriptions = true) => entryEl(p?.name, "", body(p?.description, descriptions));

export const statusXml = (s, descriptions = true) => entryEl(s?.name, String(s?.modifiers || "").trim(), body(s?.effect, descriptions));

// Party-level entries (shared resources, custom features): bare name-keyed
// elements — the CALLER provides the type wrapper (<shared>, <custom>).
export const sharedXml = (r, descriptions = true) => entryEl(r?.name, String(r?.qty ?? 0), body(r?.description, descriptions));

export const customXml = (c, descriptions = true) => entryEl(c?.name, String(c?.value ?? ""), body(c?.description, descriptions));

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
    // Each present section is ONE wrapper element; empty sections vanish.
    const children = sections.filter(s => SECTIONS[s]).map(s => {
        const entries = (actor?.[s] || []).filter(e => !filter || filter(e, s));
        if (!entries.length) return "";
        return `<${s}>${entries.map(e => SECTIONS[s](e, descriptions, actor)).join("")}</${s}>`;
    }).join("");
    // Closing tag carries the actor's name: on a long single-line sheet the
    // model re-binds every section to the actor at both ends (</char Kael>).
    if (!children) return `<${tag} ${attrList.join(" ")}/>`;
    return `<${tag} ${attrList.join(" ")}>${children}</${tag} ${escAttr(actor?.name)}>`;
}
