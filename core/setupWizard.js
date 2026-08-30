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
import { stateManager } from "./stateManager.js";
import { GM_SCHEMA, CHARACTER_CONTAINERS, defaultEntry } from "./schemas.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_ROSTER = 24;
const MAX_LIST = 20;

const SYSTEM_PROMPT_HEADER = [
    "You are the setup engine of a tabletop-style roleplay tracker.",
    "You receive a scenario description (and possibly the recent chat) and propose the tracked setup for it.",
    "Respond with ONLY a JSON object (no markdown fences, no prose) with this shape:",
    "{",
    '  "scenario_name": "<short scenario title>",',
    '  "party": [  // FULLY tracked characters, at most the given party cap',
    '    { "name": "...",',
    '      "resources": [ { "name": "Health", "value": 80, "min": 0, "max": 100 } ],',
    '      "attributes": [ { "name": "Strength", "value": 5 } ],',
    '      "inventory": [ { "name": "Rope", "qty": 1, "description": "..." } ],',
    '      "skills": [ { "name": "Fireball", "cost": "10 Mana", "description": "..." } ],',
    '      "passives": [ { "name": "Tough", "ptype": "stat", "description": "..." } ] }',
    '  ],',
    '  "roster": [ { "name": "...", "note": "<one line: who they are, why they matter>" } ],',
    '  "sharedResources": [ { "name": "Dinheiro", "qty": 150, "description": "...", "always_inject": false } ],',
    '  "custom": [ { "name": "Seeds", "value": "Pouch", "description": "..." } ],',
    '  "warnings": [ { "name": "Food", "text": "<under 15 words, imminent need>" } ]',
    "}",
    "",
    "Rules:",
    "- PARTY vs ROSTER: only characters who actively adventure with the player get a full party sheet. Every other named ally (gacha rosters can be DOZENS) goes to roster as a one-liner. Respect the party cap.",
    "- Resources need sensible custom ranges (Health 0-100, Ammo 0-36...). Attributes are milestone stats without hard caps. Only include entries that matter for THIS scenario — no filler.",
    "- sharedResources are party-wide and managed by the USER (money, food, expendables). Mark one always_inject: true ONLY if its value is relevant almost every turn (e.g. money).",
    "- custom features are AI-managed party-wide gimmicks (planted seeds, ongoing effects). warnings describe imminent survival needs (food, water, danger).",
    "- If the scenario implies survival pressure (food, water, enemies, territory), make it tangible through sharedResources + warnings. If it is purely casual, keep the setup minimal.",
    "- Use empty arrays when a category does not apply. Never invent entries outside the given shapes.",
].join("\n");

//

// Field keys per type, derived from the schema registry (id excluded).
function fieldKeysFor(type) {
    return GM_SCHEMA[type].fields.map(f => f.key);
}

async function collectContext(scenarioText) {
    const s = extension_settings[extensionName];
    const partyCap = Math.max(1, Math.trunc(Number(s.max_party_size) || 6));
    const d = stateManager.getData();

    const existing = {
        party: (d.characters || []).map(c => c.name),
        roster: (d.roster || []).map(r => r.name),
        sharedResources: (d.sharedResources || []).map(r => r.name),
    };

    const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];
    const recent = chat.slice(-6)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 800)}`);

    const blocks = [
        `PARTY CAP: ${partyCap} full character sheets maximum.`,
        `ENTRY FIELD SHAPES: resource {${fieldKeysFor("resource")}}, attribute {${fieldKeysFor("attribute")}}, item {${fieldKeysFor("item")}}, skill {${fieldKeysFor("skill")}}, passive {${fieldKeysFor("passive")}} (ptype: special|stat).`,
        "",
        `EXISTING SETUP (names only — avoid duplicates unless asked): ${JSON.stringify(existing)}`,
        "",
        "RECENT CHAT (context):",
        ...recent,
        "",
        `SCENARIO DESCRIPTION:`,
        String(scenarioText || "(none provided — infer from the recent chat)"),
    ];

    // Deep context (setting-gated): character card, persona, author's note and
    // activated World Info — so lorebook-defined casts and settings are known.
    if (s.deep_context) {
        const deep = await buildDeepContext(String(scenarioText || ""));
        if (deep) blocks.push("", "DEEP CONTEXT (card / persona / lore):", deep);
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
            overrides[key] = !!raw[key];
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
            const char = { name: String(raw.name).slice(0, 60) };
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

    return {
        scenarioName: String(parsed.scenario_name || "Scenario").slice(0, 80),
        party,
        roster,
        sharedResources,
        custom,
        warnings,
    };
}

//

// Runs the setup LLM call. Returns a sanitized proposal (for the review
// modal) or null on failure.
export async function generateProposal(scenarioText) {
    const s = extension_settings[extensionName];
    if (!s.enabled) return null;
    try {
        const st = getContext();
        const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        const messages = [
            { role: "system", content: SYSTEM_PROMPT_HEADER },
            { role: "user", content: await collectContext(scenarioText) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        const text = String(reply || "");
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start === -1 || end <= start) {
            logDebug("setupWizard: no JSON object in reply");
            return null;
        }
        const parsed = JSON.parse(text.slice(start, end + 1));
        const proposal = sanitizeProposal(parsed);
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

    stateManager.emitChange(mode === "replace" ? "wizard_replace" : "wizard_merge");
    logDebug(`setupWizard: proposal applied (${mode})`);
    return true;
}
