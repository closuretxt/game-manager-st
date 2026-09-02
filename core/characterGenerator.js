// Single-character generator — the "Generate" side of the Add Character flow.
// One setup-LLM call proposes a full sheet for ONE character, given a name,
// free-form details and optional REFERENCE characters whose stat structure
// and ranges the proposal should mirror. NOTHING touches state: the sanitized
// character (same shape as a wizard party entry) is returned for the review
// page (ui/characterCreator.js), which applies it through stateManager.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { progression } from "./progression.js";
import { CHARACTER_CONTAINERS } from "./schemas.js";
import { escAttr } from "./toolParser.js";
import { parseSetupXml, sanitizeProposal, characterToXml, fieldKeysFor, recentChatLines } from "./setupWizard.js";
import { sendRequestViaProfile, resolveWizardProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

const CHAR_RESPONSE_SHAPE = [
    '<setup name="<short source/title>">',
    "  <party>",
    '    <char name="..." level="N">  <!-- exactly ONE char; level = progression level (see rules); give only the containers that matter for them -->',
    '      <resource name="Health" value="80" min="0" max="100" description="..."/>',
    '      <attribute name="Strength" value="5" description="..."/>',
    '      <item name="Rope" qty="1" description="..."/>',
    '      <skill name="Fireball" cost="10 Mana" cooldown="2" description="..."/>  <!-- cooldown in messages; 0 or omitted = always ready -->',
    '      <passive name="Tough" ptype="stat" description="..."/>  <!-- ptype: special|stat -->',
    '      <status name="Dazed" modifiers="Aim -2" effect="..."/>  <!-- TEMPORARY conditions only, removed when they end -->',
    "    </char>",
    "  </party>",
    "</setup>",
].join("\n");

const CHAR_PROMPT_HEADER = [
    "You are the character engine of a tabletop-style roleplay tracker.",
    "You receive a character name, optional details, the recent chat and optional REFERENCE characters, and propose a full tracked sheet for that ONE character.",
    "Respond with ONLY the <setup> XML block (no markdown fences, no prose), with this shape:",
    CHAR_RESPONSE_SHAPE,
    "",
    "Rules:",
    "- Exactly ONE <char> inside <party>, named exactly as requested.",
    "- REFERENCE CHARACTERS, when given, are the template: mirror their stat structure, resource names, ranges and granularity so similar characters stay comparable (an SSM with Ammo 0-36 stays Ammo 0-36), while adapting values, skills and descriptions to THIS character's role and details.",
    "- Without references, YOU decide which systems the character uses: give containers ONLY when they matter for THEM (a brute: resources+attributes; a mage: skills+passives; a quartermaster: inventory). Empty containers are correct when a system does not apply.",
    "- Stats, ranges and quantities must be deliberate — reflect the character's role and the scenario's pressure. No filler.",
    "- Every entry gets a short, IN-WORLD description — a fact about the thing itself, never meta commentary ('tracks', 'resource for', 'important for this character'). Never leave descriptions empty.",
    "- Resources are turn-to-turn meters updated during play (Health, Stamina, Ammo, Sanity, Stress) with sensible custom ranges (Health 0-100, Ammo 0-36 = one revolver loadout). Attributes are milestone stats (Strength, Fortitude, Dexterity, Charisma) without hard caps, changed rarely.",
    "- CALIBRATE NUMBERS to the world: starting quantities and ranges must imply real scale. Anchor non-obvious scales in the description (e.g. 'a meal costs about 15').",
    "- LEVEL: when the prompt states a level, use it; when progression is active WITHOUT a stated level, INFER it from the context (recent chat, details, reference levels) and report it in level (whole number, at least 1). Without progression, omit the attribute.",
    "- Omit tags that do not apply. Never invent entries outside the given shapes.",
].join("\n");

const CHAR_REFINE_PROMPT_HEADER = [
    "You are the character engine of a tabletop-style roleplay tracker, running a REFINEMENT pass on an earlier character proposal.",
    "You receive the CURRENT proposal (XML), the character brief, optional references and refinement feedback, and return an IMPROVED proposal.",
    "Respond with ONLY the <setup> XML block (no markdown fences, no prose), with this shape:",
    CHAR_RESPONSE_SHAPE,
    "",
    "Rules:",
    "- DEPTH OVER BREADTH: replace generic/shallow entries with concrete, grounded ones. Every value must be deliberate.",
    "- Preserve everything the feedback does not ask to change — especially entries the user may have edited by hand.",
    "- Keep the character's name exactly as proposed.",
    "- Every entry carries a short, IN-WORLD description — a fact about the thing itself, never meta commentary. Fill any that are missing, vague or meta.",
    "- LEVEL: keep the character's level from the current proposal unless the feedback asks to change it.",
    "- Omit tags that do not apply. Never invent entries outside the given shapes.",
].join("\n");

//

// Shared tail of both calls: system prompt + user content -> sanitized char.
// The user's requested name always wins over whatever the LLM replied.
async function runCharLLM(systemPrompt, userContent, name) {
    const s = extension_settings[extensionName];
    const st = getContext();
    const profileId = resolveWizardProfile(st, s.wizard_profile, s.premaster_profile, s.connection_profile);
    const reply = await sendRequestViaProfile(profileId, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
    ]);
    const proposal = sanitizeProposal(parseSetupXml(String(reply || "")));
    const char = proposal?.party?.[0] || null;
    if (!char) {
        logDebug("characterGenerator: no <char> in reply");
        return null;
    }
    char.name = name;
    return char;
}

// Progression anchoring: when the scenario has progression, generated
// characters receive a level-appropriate attribute budget so they spawn
// as real peers for the party — the numbers are code-owned, the LLM only
// distributes them across attribute names. An explicit targetLevel (enemy
// mode, or a party member with a chosen starting level) pins the anchor;
// without one the LLM INFERS the level from context and reports it back
// via the <char level> attribute, calibrating against a budget table.
function progressionBlocks(targetLevel = null, isEnemy = false) {
    if (!progression.isEnabled()) return [];
    const partyLevel = progression.partyLevel();
    const explicit = Math.max(1, Math.trunc(Number(targetLevel) || 0));
    const budget = lvl => progression.attrBudgetForLevel(lvl);
    // Budget table around the party level — the LLM picks the row matching
    // the level it infers; the math itself stays code-owned.
    const lo = Math.max(1, partyLevel - 3);
    const table = Array.from({ length: 9 }, (_, i) => `L${lo + i}=${budget(lo + i)}`).join(", ");
    const anchor = explicit
        ? (isEnemy
            ? `THIS ENEMY is level ${explicit} (the party is around level ${partyLevel}) — calibrate its total attribute points to roughly ${budget(explicit)} and scale starting resources (Health and similar) to that threat level.`
            : `THIS CHARACTER joins the party at level ${explicit} (the party is around level ${partyLevel}) — calibrate their total attribute points to roughly ${budget(explicit)} and scale starting resources (Health and similar) to that level.`)
        : `No level was given — INFER this character's level from the context (recent chat, details, reference levels${isEnemy ? "; a fair fight sits at the party's level, a boss above it, a minion below it" : ""}) and report it in the <char level="..."> attribute. Expected TOTAL attribute points by level: ${table}. Calibrate to the row you infer and scale starting resources (Health and similar) proportionately.`;
    return [
        "PROGRESSION ACTIVE: the party is around level " + partyLevel + ".",
        anchor,
    ];
}

//

// Enemy-mode blocks: the sheet describes a HOSTILE threat for the Enemies
// tracker, not a party member — combat-relevant containers first.
function enemyBlocks() {
    return [
        "ENEMY SHEET: this character is a HOSTILE threat tracked in the Enemies tab, not a party member.",
        "- Bias toward combat-relevant containers: Health-style resources, attributes, skills and passives. Inventory only when they carry loot; statuses only for conditions they ALREADY start with.",
        "- Calibrate danger against the party: a fair fight at the party's level, a boss above it, a minion below it.",
    ];
}

// Brief blocks shared by generation and refinement: field shapes, existing
// names and the character brief (+ references when given). Recent chat is
// NOT part of this — chatBlocks() appends it at the very bottom so the
// scene the character appears in is the LAST thing the LLM reads.
function briefBlocks({ name, details, references, level = null, kind = "party" }) {
    const d = stateManager.getData();
    // Existing names as compact XML — the LLM reads it far better than JSON.
    const existingParts = [
        `  <party>${(d.characters || []).map(c => escAttr(c.name)).join(", ")}</party>`,
        `  <roster>${(d.roster || []).map(r => escAttr(r.name)).join(", ")}</roster>`,
        ...(kind === "enemy" ? [`  <enemies>${(d.enemies || []).map(e => escAttr(e.name)).join(", ")}</enemies>`] : []),
    ];
    const blocks = [
        `ENTRY FIELD SHAPES: resource {${fieldKeysFor("resource")}}, attribute {${fieldKeysFor("attribute")}}, item {${fieldKeysFor("item")}}, skill {${fieldKeysFor("skill")}}, passive {${fieldKeysFor("passive")}} (ptype: special|stat), status {${fieldKeysFor("status")}}.`,
        ...progressionBlocks(level, kind === "enemy"),
        ...(kind === "enemy" ? enemyBlocks() : []),
        "",
        "EXISTING SETUP (names only — the new character must not duplicate them):",
        "<existing>",
        ...existingParts,
        "</existing>",
        "",
        "NEW CHARACTER BRIEF:",
        `name: ${name}`,
        `details: ${String(details || "").trim() || "(none — infer from the recent chat and references)"}`,
    ];
    if (references.length) {
        blocks.push(
            "",
            "REFERENCE CHARACTERS (mirror their stat structure, names and ranges; adapt values to THIS character):",
            ...references.map(characterToXml),
        );
    }
    return blocks;
}

// Deep context (setting-gated): character card, persona, author's note and
// activated World Info — same gate as the scenario wizard.
async function deepContextBlocks(details) {
    const s = extension_settings[extensionName];
    if (!s.deep_context) return [];
    const deep = await buildDeepContext(String(details || ""));
    return deep ? ["", "<deep_context>", deep, "</deep_context>"] : [];
}

// Recent chat tail: the LAST context block in the prompt, so the scene the
// new character/enemy appears in is freshest in the LLM's attention.
// `count` overrides the wizard_chat_messages setting (the auto-spawn path
// passes a larger window — the tracker brief alone carries no scene context).
function chatBlocks(count = null) {
    const s = extension_settings[extensionName];
    const lines = recentChatLines(count ?? s.wizard_chat_messages);
    return lines.length ? ["", "RECENT CHAT (context):", ...lines] : [];
}

//

// Runs the generation call. Returns a sanitized character (wizard party-entry
// shape) or null on failure.
export async function generateCharacterProposal({ name, details, references = [], level = null, kind = "party", chatMessages = null } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled) return null;
    try {
        const blocks = [
            ...briefBlocks({ name, details, references, level, kind }),
            ...(await deepContextBlocks(details)),
            ...chatBlocks(chatMessages),
        ];
        const char = await runCharLLM(CHAR_PROMPT_HEADER, blocks.join("\n"), name);
        if (char) {
            logDebug(`characterGenerator: proposal for "${name}" — ` +
                CHARACTER_CONTAINERS.map(k => `${k}=${(char[k] || []).length}`).join(" "));
        }
        return char;
    } catch (e) {
        console.error("[Game Manager] character generation failed:", e);
        return null;
    }
}

//

// Recursive refinement: feeds the (possibly user-edited) character back
// through the LLM. Returns a NEW sanitized character or null (the caller
// keeps the current one).
export async function refineCharacterProposal(char, feedback, { name, details, references = [], level = null, kind = "party" } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !char) return null;
    try {
        const blocks = [
            ...briefBlocks({ name, details, references, level, kind }),
            ...(await deepContextBlocks(details)),
            ...chatBlocks(),
            "",
            "CURRENT PROPOSAL (improve THIS — keep what works, deepen what is shallow):",
            characterToXml(char),
            "",
            "REFINEMENT FEEDBACK:",
            String(feedback || "(none — deepen the sheet on your own judgment: richer entries, deliberate values, no filler)"),
        ];
        const refined = await runCharLLM(CHAR_REFINE_PROMPT_HEADER, blocks.join("\n"), name);
        if (refined) logDebug(`characterGenerator: refined proposal for "${name}"`);
        return refined;
    } catch (e) {
        console.error("[Game Manager] character refinement failed:", e);
        return null;
    }
}
