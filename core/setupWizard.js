// Scenario Setup Wizard — one-button bootstrap.
// The user pastes a scenario/character description (or leaves it empty to use
// the recent chat as context) and a single setup LLM call proposes the whole
// tracked setup: party characters (full sheets), a lightweight ROSTER for the
// dozens of allies gacha-style scenarios tend to have, shared resources,
// custom features and initial warnings.
//
// NOTHING is applied automatically: the proposal is returned for the review
// modal (ui/setupWizard.js) and only touches state through applyProposal().
// The prompt is derived from the GM_SCHEMA type registry, so future trackable
// types are automatically wizard-settable.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel } from "./stateManager.js";
import { GM_SCHEMA, CHARACTER_CONTAINERS, defaultEntry } from "./schemas.js";
import { parseAttrs } from "./toolParser.js";
import { sendRequestViaProfile, resolveWizardProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_ROSTER = 24;
const MAX_LIST = 20;

const RESPONSE_SHAPE = [
    '<setup name="<short scenario title>">',
    "  <party>  <!-- FULLY tracked characters, at most the given party cap -->",
    '    <char name="...">  <!-- give a char ONLY the containers that matter for them; omit the rest -->',
    '      <resource name="Health" value="80" min="0" max="100" description="..."/>',
    '      <attribute name="Strength" value="5" description="..."/>',
    '      <item name="Rope" qty="1" description="..."/>',
    '      <skill name="Fireball" cost="10 Mana" cooldown="2" description="..."/>  <!-- cooldown in messages; 0 or omitted = always ready -->',
    '      <passive name="Tough" ptype="stat" description="..."/>  <!-- ptype: special|stat -->',
    '      <status name="Dazed" modifiers="Aim -2" effect="..."/>  <!-- TEMPORARY conditions only, removed when they end -->',
    "    </char>",
    "  </party>",
    '  <ally name="..." note="<one line: who they are, why they matter>"/>',
    '  <shared name="Dinheiro" qty="150" description="..." always_inject="false"/>',
    '  <custom name="Seeds" value="Pouch" description="..."/>',
    '  <progression enabled="true" exp_base="100" exp_growth="1.25" skill_points="1" bonus_every="5" attr_points="0" attr_cost_every="10" attr_starting_budget="20">EXP guidelines: how much EXP trivial actions, minor victories and major challenges give</progression>',
    '  <warning name="Food" text="<under 15 words, imminent need>"/>',
    "</setup>",
].join("\n");

const SYSTEM_PROMPT_HEADER = [
    "You are the setup engine of a tabletop-style roleplay tracker.",
    "You receive a scenario description (and possibly the recent chat) and propose the tracked setup for it.",
    "Respond with ONLY the <setup> XML block (no markdown fences, no prose), with this shape:",
    RESPONSE_SHAPE,
    "",
    "Rules:",
    "- PARTY vs ROSTER: only characters who actively adventure with the player get a full party sheet. Every other named ally (gacha rosters can be DOZENS) goes to roster as a one-liner. Respect the party cap.",
    "- CHARACTER SHEETS: YOU decide which systems each character uses. Give a character containers ONLY when they matter for THEM (a brute: resources+attributes; a mage: skills+passives; a quartermaster: inventory). Empty arrays are correct when a system does not apply to that character.",
    "- Stats, ranges and quantities must be deliberate — reflect each character's role and the scenario's pressure. No filler, no identical sheets.",
    "- Every entry gets a short, IN-WORLD description — a fact about the thing itself, never meta commentary ('tracks', 'resource for', 'important for this character'). Example: 'Standard sidearm; reliable, low recoil.' Never leave descriptions empty.",
    "- Resources are turn-to-turn meters updated during play (Health, Stamina, Ammo, Sanity, Stress) with sensible custom ranges (Health 0-100, Ammo 0-36 = one revolver loadout). Attributes are milestone stats (Strength, Fortitude, Dexterity, Charisma) without hard caps, changed rarely. Only include entries that matter for THIS scenario — no filler.",
    "- CALIBRATE NUMBERS to the world: starting quantities and ranges must imply real scale and purchasing power (e.g. Dollars 150 when a meal costs 15; rations counted in days; Health 30 = badly wounded). Anchor non-obvious scales in the description (e.g. 'a meal costs about 15').",
    "- sharedResources are party-wide and managed by the USER (money, food, expendables). Mark one always_inject: true ONLY if its value is relevant almost every turn (e.g. money).",
    "- custom features are AI-managed PARTY-WIDE dynamic gimmicks whose value/state evolves during play and which the AI rewrites with tool calls (planted seeds: sprouting, base alert level: rising, ongoing ritual: stage 2/3). They are NOT relationship or intimacy meters, NOT per-character stats or conditions (put those on that character's sheet — temporary conditions like Dazed are <status> entries with explicit modifiers), NOT user-managed supplies (those are sharedResources).",
    "- warnings are minimalist imminent-need remarks about the PARTY AS A WHOLE (food, water, approaching danger), under 15 words. They never describe one character's personal state.",
    "- OWNERSHIP TEST — apply to EVERY shared/custom/warning entry: if it is about ONE named character (their hunger, health, mood, condition, stats), it belongs on THAT character's sheet as a resource/attribute/status — NEVER in a party-wide section. Party-wide entries must be true for the whole group and must not name a single character. 'Hunger — Cerberos is starving' is WRONG: it is a Hunger resource on Cerberos's sheet (or, only if the ENTIRE party shares the need, a nameless party-wide warning).",
    "- If the scenario implies survival pressure (food, water, enemies, territory), make it tangible through sharedResources + warnings for the group, and per-character resources/statuses for individual states. If it is purely casual, keep the setup minimal.",
    "- PROGRESSION: include <progression> ONLY when the scenario implies growth over time (combat, leveling, long campaigns). Calibrate exp_base (EXP for the first level-up) and exp_growth (multiplier per level) to the world's pace, set skill_points per level (bonus_every: +1 extra point every N levels, 0 = off), and write plain-language EXP guidelines as the tag's text (how much EXP trivial actions, minor victories and major challenges give). Attribute points are a second currency the PLAYER spends to raise attributes: attr_points per level (0 = off), attr_cost_every (raising costs +1 extra point per N current value, 0 = flat), attr_starting_budget (the TOTAL attribute points a fresh level-1 character should have — calibrate party starting attributes to roughly this sum). Omit the tag for purely casual scenarios.",
    "- Omit tags that do not apply (an empty <setup> is valid). Never invent entries outside the given shapes.",
].join("\n");

const REFINE_PROMPT_HEADER = [
    "You are the setup engine of a tabletop-style roleplay tracker, running a REFINEMENT pass on an earlier proposal.",
    "You receive the CURRENT proposal (XML), the scenario and refinement feedback, and return an IMPROVED proposal.",
    "Respond with ONLY the <setup> XML block (no markdown fences, no prose), with this shape:",
    RESPONSE_SHAPE,
    "",
    "Rules:",
    "- DEPTH OVER BREADTH: replace generic/shallow entries with concrete, scenario-grounded ones. Every value must be deliberate.",
    "- CHARACTER SHEETS: YOU decide which systems each character uses. Give a character containers ONLY when they matter for THEM (a brute: resources+attributes; a mage: skills+passives; a quartermaster: inventory). Empty arrays are correct when a system does not apply to that character.",
    "- Stats, ranges and quantities must reflect each character's role and the scenario's pressure — no filler, no identical sheets.",
    "- Every entry carries a short, IN-WORLD description — a fact about the thing itself, never meta commentary ('tracks', 'resource for', 'important because'). Fill any that are missing, vague or meta.",
    "- CALIBRATE NUMBERS to the world: quantities and ranges must imply real scale and purchasing power (e.g. Dollars 150 when a meal costs 15). Anchor non-obvious scales in the description.",
    "- Preserve everything the feedback does not ask to change — especially names and entries the user may have edited by hand.",
    "- PARTY vs ROSTER: only active companions get full sheets; everyone else stays a roster one-liner. Respect the party cap.",
    "- sharedResources stay party-wide and user-managed (money, food, expendables); custom features stay AI-managed PARTY-WIDE gimmicks (seeds, alert levels, ongoing effects) — never relationship/intimacy meters or per-character stats; warnings stay minimalist imminent-need remarks about the whole party, under 15 words.",
    "- Preserve the <progression> block exactly as given unless the feedback asks to change it.",
    "- OWNERSHIP TEST — apply to EVERY shared/custom/warning entry: if it is about ONE named character (their hunger, health, mood, condition, stats), MOVE it onto that character's sheet as a resource/attribute/status. Party-wide entries must be true for the whole group and must not name a single character.",
    "- Omit tags that do not apply (an empty <setup> is valid). Never invent entries outside the given shapes.",
].join("\n");

//

// Field keys per type, derived from the schema registry (id excluded).
export function fieldKeysFor(type) {
    return GM_SCHEMA[type].fields.map(f => f.key);
}

export function recentChatLines(count) {
    const n = Math.max(0, Math.trunc(Number(count) || 0));
    if (!n) return [];
    const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];
    return chat.slice(-n)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 800)}`);
}

async function collectContext(scenarioText) {
    const s = extension_settings[extensionName];
    const partyCap = Math.max(1, Math.trunc(Number(s.max_party_size) || 6));
    const d = stateManager.getData();

    // Existing names as compact XML — the LLM reads it far better than JSON.
    const existingParts = [
        `  <party>${(d.characters || []).map(c => escAttr(c.name)).join(", ")}</party>`,
        `  <roster>${(d.roster || []).map(r => escAttr(r.name)).join(", ")}</roster>`,
        `  <shared>${(d.sharedResources || []).map(r => escAttr(r.name)).join(", ")}</shared>`,
    ];

    const recent = recentChatLines(s.wizard_chat_messages);

    const blocks = [
        `PARTY CAP: ${partyCap} full character sheets maximum.`,
        `ENTRY FIELD SHAPES: resource {${fieldKeysFor("resource")}}, attribute {${fieldKeysFor("attribute")}}, item {${fieldKeysFor("item")}}, skill {${fieldKeysFor("skill")}}, passive {${fieldKeysFor("passive")}} (ptype: special|stat), status {${fieldKeysFor("status")}}.`,
        "",
        "EXISTING SETUP (names only — avoid duplicates unless asked):",
        "<existing>",
        ...existingParts,
        "</existing>",
        "",
        "RECENT CHAT (context):",
        ...recent,
        "",
        `SCENARIO DESCRIPTION:`,
        String(scenarioText || "(none provided — infer from the recent chat)"),
    ];

    // Deep context (setting-gated): character card, persona, author's note and
    // activated World Info — so lorebook-defined casts and settings are known.
    logDebug(`setupWizard: deep_context setting = ${s.deep_context}`);
    if (s.deep_context) {
        const deep = await buildDeepContext(String(scenarioText || ""));
        logDebug(`setupWizard: deep context block ${deep ? `built (${deep.length} chars)` : "EMPTY — skipped"}`);
        if (deep) blocks.push("", "<deep_context>", deep, "</deep_context>");
    }

    return blocks.join("\n");
}

//

// Coerces a raw LLM entry into a schema-valid entry for `type`.
function sanitizeEntry(type, raw) {
    if (!raw || typeof raw !== "object") return null;
    const keys = fieldKeysFor(type);
    const overrides = {};
    for (const key of keys) {
        if (raw[key] === undefined || raw[key] === null) continue;
        const field = GM_SCHEMA[type].fields.find(f => f.key === key);
        if (field?.type === "number") {
            const n = Number(raw[key]);
            if (Number.isFinite(n)) overrides[key] = n;
        } else if (field?.type === "checkbox") {
            const v = raw[key];
            overrides[key] = v === true || String(v).toLowerCase() === "true";
        } else {
            overrides[key] = String(raw[key]).slice(0, 400);
        }
    }
    if (!overrides.name) return null;
    return defaultEntry(type, overrides);
}

function sanitizeList(type, list, cap = MAX_LIST) {
    return (Array.isArray(list) ? list : [])
        .map(e => sanitizeEntry(type, e))
        .filter(Boolean)
        .slice(0, cap);
}

// Validates the raw reply into a proposal the review modal can render and
// applyProposal() can trust. Unknown shapes are dropped, lists capped.
export function sanitizeProposal(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    const s = extension_settings[extensionName];
    const partyCap = Math.max(1, Math.trunc(Number(s.max_party_size) || 6));

    const party = (Array.isArray(parsed.party) ? parsed.party : []).slice(0, partyCap)
        .map(raw => {
            if (!raw?.name) return null;
            // Optional progression level (character generator auto-mode).
            const lvl = Math.trunc(Number(raw.level));
            const char = { name: String(raw.name).slice(0, 60), level: Number.isFinite(lvl) && lvl >= 1 ? lvl : null };
            for (const container of CHARACTER_CONTAINERS) {
                const type = Object.keys(GM_SCHEMA).find(t => GM_SCHEMA[t].container === container);
                char[container] = sanitizeList(type, raw[container]);
            }
            return char;
        })
        .filter(Boolean);

    const roster = sanitizeList("roster", parsed.roster, MAX_ROSTER);
    const sharedResources = sanitizeList("shared", parsed.sharedResources);
    const custom = sanitizeList("custom", parsed.custom);
    const warnings = (Array.isArray(parsed.warnings) ? parsed.warnings : [])
        .map(w => (w?.name ? { name: String(w.name).slice(0, 40), text: String(w.text || "").slice(0, 120) } : null))
        .filter(Boolean)
        .slice(0, MAX_LIST);

    // Per-scenario progression config (optional; null when not proposed).
    let progression = null;
    if (parsed.progression && typeof parsed.progression === "object") {
        const raw = parsed.progression;
        const num = (v, def, min) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(min, n) : def;
        };
        progression = {
            enabled: raw.enabled !== false,
            exp_base: num(raw.exp_base, 100, 1),
            exp_growth: num(raw.exp_growth, 1.25, 1),
            skill_points_per_level: num(raw.skill_points ?? raw.skill_points_per_level, 1, 0),
            bonus_every: num(raw.bonus_every, 5, 0),
            attr_points_per_level: num(raw.attr_points ?? raw.attr_points_per_level, 0, 0),
            attr_cost_every: num(raw.attr_cost_every, 10, 0),
            attr_starting_budget: num(raw.attr_starting_budget, 20, 0),
            exp_guidelines: String(raw.exp_guidelines || "").slice(0, 600),
        };
    }

    return {
        scenarioName: String(parsed.scenario_name || "Scenario").slice(0, 80),
        party,
        roster,
        sharedResources,
        custom,
        warnings,
        progression,
    };
}

//

// Tolerant XML parse of the <setup> proposal block. Entry tags are attribute
// bags; unknown/malformed data is dropped later by sanitizeProposal().
export function parseSetupXml(text) {
    if (!text) return null;
    const start = text.indexOf("<setup");
    if (start === -1) return null;
    const openEnd = text.indexOf(">", start);
    if (openEnd === -1) return null;
    const close = text.lastIndexOf("</setup>");
    const inner = text.slice(openEnd + 1, close === -1 ? undefined : close);
    const head = parseAttrs(text.slice(start + 6, openEnd));

    const parsed = {
        scenario_name: head.name || "Scenario",
        party: [],
        roster: [],
        sharedResources: [],
        custom: [],
        warnings: [],
    };

    // Party characters with nested container entries.
    const CONTAINER_TAGS = { resource: "resources", attribute: "attributes", item: "inventory", skill: "skills", passive: "passives", status: "statuses" };
    const charRe = /<char\b([^>]*?)\/>|<char\b([^>]*?)>([\s\S]*?)<\/char>/gi;
    let m;
    while ((m = charRe.exec(inner)) !== null) {
        const attrs = parseAttrs(m[1] || m[2] || "");
        if (!attrs.name) continue;
        const char = { name: attrs.name, level: attrs.level };
        for (const container of Object.values(CONTAINER_TAGS)) char[container] = [];
        const body = m[3] || "";
        for (const [tag, container] of Object.entries(CONTAINER_TAGS)) {
            const entryRe = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`, "gi");
            let e;
            while ((e = entryRe.exec(body)) !== null) char[container].push(parseAttrs(e[1]));
        }
        parsed.party.push(char);
    }

    // Party-level tags — scanned outside <char> blocks to avoid double-counts.
    const stripped = inner.replace(/<char\b[^>]*?\/>|<char\b[^>]*?>[\s\S]*?<\/char>/gi, " ");
    for (const [tag, key] of [["ally", "roster"], ["shared", "sharedResources"], ["custom", "custom"], ["warning", "warnings"]]) {
        const re = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`, "gi");
        while ((m = re.exec(stripped)) !== null) parsed[key].push(parseAttrs(m[1]));
    }

    // Optional per-scenario progression config (guidelines live in the body).
    const progMatch = /<progression\b([^>]*?)(?:\/>|>([\s\S]*?)<\/progression>)/i.exec(stripped);
    if (progMatch) {
        const pa = parseAttrs(progMatch[1] || "");
        parsed.progression = {
            enabled: pa.enabled !== undefined ? String(pa.enabled).toLowerCase() === "true" : true,
            exp_base: pa.exp_base,
            exp_growth: pa.exp_growth,
            skill_points: pa.skill_points ?? pa.skill_points_per_level,
            bonus_every: pa.bonus_every,
            attr_points: pa.attr_points ?? pa.attr_points_per_level,
            attr_cost_every: pa.attr_cost_every,
            attr_starting_budget: pa.attr_starting_budget,
            exp_guidelines: (progMatch[2] ?? "").trim(),
        };
    }

    return parsed;
}

// Single setup LLM call: sends system+user, extracts the <setup> block and
// sanitizes it. Returns a proposal or null.
async function runSetupLLM(systemPrompt, userContent) {
    const s = extension_settings[extensionName];
    const st = getContext();
    const profileId = resolveWizardProfile(st, s.wizard_profile, s.premaster_profile, s.connection_profile);
    const reply = await sendRequestViaProfile(profileId, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
    ]);
    const parsed = parseSetupXml(String(reply || ""));
    if (!parsed) {
        logDebug("setupWizard: no <setup> block in reply");
        return null;
    }
    return sanitizeProposal(parsed);
}

// Runs the setup LLM call. Returns a sanitized proposal (for the review
// modal) or null on failure.
export async function generateProposal(scenarioText) {
    const s = extension_settings[extensionName];
    if (!s.enabled) return null;
    try {
        const proposal = await runSetupLLM(SYSTEM_PROMPT_HEADER, await collectContext(scenarioText));
        if (!proposal) {
            logDebug("setupWizard: malformed proposal");
            return null;
        }
        logDebug(`setupWizard: proposal — party=${proposal.party.length} roster=${proposal.roster.length} shared=${proposal.sharedResources.length} custom=${proposal.custom.length} warnings=${proposal.warnings.length}`);
        return proposal;
    } catch (e) {
        console.error("[Game Manager] setup wizard generation failed:", e);
        return null;
    }
}

//

function escAttr(v) {
    // Entity bodies are concatenated at runtime so the source never contains
    // raw XML entities (which some editors/pipelines decode).
    return String(v ?? "")
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/"/g, "&" + "quot;");
}

// Container -> tag mapping for the LLM wire shape (proposals & references).
const PROMPT_CONTAINER_TAGS = { resources: "resource", attributes: "attribute", inventory: "item", skills: "skill", passives: "passive", statuses: "status" };

// Serializes a single character sheet to the LLM wire shape (internal ids
// stripped) — used as reference context by the character generator.
export function characterToXml(c) {
    // Level rides along when known — the character generator uses reference
    // levels to infer a new character's level in auto mode. Live sheets
    // (party AND enemies) keep it on the progression track; proposals carry
    // it as a plain field.
    const lvl = Math.trunc(Number(c?.level ?? c?.progression?.level));
    const lines = [`  <char name="${escAttr(c?.name)}"${Number.isFinite(lvl) && lvl >= 1 ? ` level="${lvl}"` : ""}>`];
    for (const [container, tag] of Object.entries(PROMPT_CONTAINER_TAGS)) {
        for (const e of c?.[container] || []) {
            const attrs = Object.entries(e)
                .filter(([k]) => k !== "id")
                .map(([k, v]) => `${k}="${escAttr(v)}"`)
                .join(" ");
            lines.push(`    <${tag} ${attrs}/>`);
        }
    }
    lines.push("  </char>");
    return lines.join("\n");
}

// Serializes a proposal back to the LLM wire shape (internal ids stripped).
function proposalToPromptXml(p) {
    const lines = [`<setup name="${escAttr(p.scenarioName)}">`];
    for (const c of p.party || []) {
        lines.push(`  <char name="${escAttr(c.name)}">`);
        for (const [container, tag] of Object.entries(PROMPT_CONTAINER_TAGS)) {
            for (const e of c[container] || []) {
                const attrs = Object.entries(e)
                    .filter(([k]) => k !== "id")
                    .map(([k, v]) => `${k}="${escAttr(v)}"`)
                    .join(" ");
                lines.push(`    <${tag} ${attrs}/>`);
            }
        }
        lines.push("  </char>");
    }
    for (const a of p.roster || []) lines.push(`  <ally name="${escAttr(a.name)}" note="${escAttr(a.note)}"/>`);
    for (const r of p.sharedResources || []) lines.push(`  <shared name="${escAttr(r.name)}" qty="${escAttr(r.qty)}" description="${escAttr(r.description)}" always_inject="${r.always_inject ? "true" : "false"}"/>`);
    for (const c of p.custom || []) lines.push(`  <custom name="${escAttr(c.name)}" value="${escAttr(c.value)}" description="${escAttr(c.description)}"/>`);
    for (const w of p.warnings || []) lines.push(`  <warning name="${escAttr(w.name)}" text="${escAttr(w.text)}"/>`);
    if (p.progression) {
        const g = p.progression;
        lines.push(`  <progression enabled="${g.enabled !== false ? "true" : "false"}" exp_base="${escAttr(g.exp_base)}" exp_growth="${escAttr(g.exp_growth)}" skill_points="${escAttr(g.skill_points_per_level)}" bonus_every="${escAttr(g.bonus_every)}" attr_points="${escAttr(g.attr_points_per_level)}" attr_cost_every="${escAttr(g.attr_cost_every)}" attr_starting_budget="${escAttr(g.attr_starting_budget)}">${escAttr(g.exp_guidelines || "")}</progression>`);
    }
    lines.push("</setup>");
    return lines.join("\n");
}

// Context for a refinement pass: scenario + chat + the current proposal and
// the user's feedback on what to improve.
async function collectRefineContext(proposal, feedback, scenarioText) {
    const s = extension_settings[extensionName];
    const partyCap = Math.max(1, Math.trunc(Number(s.max_party_size) || 6));
    const blocks = [
        `PARTY CAP: ${partyCap} full character sheets maximum.`,
        `ENTRY FIELD SHAPES: resource {${fieldKeysFor("resource")}}, attribute {${fieldKeysFor("attribute")}}, item {${fieldKeysFor("item")}}, skill {${fieldKeysFor("skill")}}, passive {${fieldKeysFor("passive")}} (ptype: special|stat), status {${fieldKeysFor("status")}}.`,
        "",
        "RECENT CHAT (context):",
        ...recentChatLines(s.wizard_chat_messages),
        "",
        "SCENARIO DESCRIPTION:",
        String(scenarioText || "(none provided — infer from the recent chat)"),
        "",
        "CURRENT PROPOSAL (improve THIS — keep what works, deepen what is shallow):",
        proposalToPromptXml(proposal),
        "",
        "REFINEMENT FEEDBACK:",
        String(feedback || "(none — deepen the setup on your own judgment: richer sheets, deliberate values, no filler)"),
    ];

    // Deep context (setting-gated), same as the initial generation.
    if (s.deep_context) {
        const deep = await buildDeepContext(String(scenarioText || ""));
        if (deep) blocks.push("", "<deep_context>", deep, "</deep_context>");
    }

    return blocks.join("\n");
}

// Recursive refinement: feeds a (possibly user-edited) proposal back through
// the setup LLM to deepen/improve it. Returns a NEW sanitized proposal or null
// (the caller keeps the current one).
export async function refineProposal(proposal, feedback, scenarioText) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !proposal) return null;
    try {
        const refined = await runSetupLLM(REFINE_PROMPT_HEADER, await collectRefineContext(proposal, feedback, scenarioText));
        if (!refined) {
            logDebug("setupWizard: malformed refined proposal");
            return null;
        }
        logDebug(`setupWizard: refined proposal — party=${refined.party.length} roster=${refined.roster.length} shared=${refined.sharedResources.length} custom=${refined.custom.length} warnings=${refined.warnings.length}`);
        return refined;
    } catch (e) {
        console.error("[Game Manager] setup wizard refinement failed:", e);
        return null;
    }
}

// Applies a (possibly user-edited) proposal to the live state.
// mode "replace" wipes the current setup first; "merge" appends to it.
export function applyProposal(proposal, mode = "replace") {
    if (!proposal || typeof proposal !== "object") return false;
    const d = stateManager.getData();

    if (mode === "replace") {
        d.characters = [];
        d.roster = [];
        d.sharedResources = [];
        d.custom = [];
        d.warnings = [];
        d.activeCharacterId = null;
    }

    for (const raw of proposal.party || []) {
        const templateEntries = {};
        for (const container of CHARACTER_CONTAINERS) {
            templateEntries[container] = raw[container] || [];
        }
        stateManager.addCharacter(String(raw.name || "Unnamed"), templateEntries);
    }

    for (const entry of proposal.roster || []) {
        stateManager.addRosterEntry({ name: entry.name, note: entry.note || "" });
    }
    for (const entry of proposal.sharedResources || []) {
        stateManager.addSharedEntry({
            name: entry.name,
            qty: Number(entry.qty) || 0,
            description: entry.description || "",
            always_inject: !!entry.always_inject,
        });
    }
    for (const entry of proposal.custom || []) {
        stateManager.addCustomEntry({ name: entry.name, value: entry.value || "", description: entry.description || "" });
    }
    for (const w of proposal.warnings || []) {
        stateManager.setWarning({ name: w.name, text: w.text });
    }

    // Per-scenario progression config: replace resets it (absent = no
    // progression in this scenario); merge only overwrites when proposed.
    if (mode === "replace") {
        delete d.progression;
    }
    if (proposal.progression) {
        d.progression = { ...proposal.progression };
    }

    stateManager.emitChange(mode === "replace" ? "wizard_replace" : "wizard_merge");
    logDebug(`setupWizard: proposal applied (${mode})`);
    return true;
}
