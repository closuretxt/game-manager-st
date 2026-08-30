// Pre-pass router LLM.
// EVERY fresh player action is judged by this cheap pre-master call BEFORE any
// specialist runs — replacing the old trigger-word guessing. It receives the
// recent scene, a compact state snapshot and the action, and returns a
// structured PLAN (XML tags) describing what this turn needs:
//
//   roll         — is the action's outcome uncertain enough to require a roll?
//   transactions — implied shared-resource spends/gains (signed delta)
//   warnings     — imminent-need remarks to set/clear
//   relevant     — shared resources worth injecting this turn
//   nothing      — fast path: skip every specialist
//
// The pre-pass decides IF; the specialists (diceRoller, transactions) decide
// HOW. On failure or a malformed reply it returns null and the caller falls
// back to legacy keyword detection (detectTriggers in core/triggerWatcher.js).

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { parseAttrs } from "./toolParser.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the router of a tabletop-style roleplay game system.",
    "You receive the recent scene, a snapshot of the tracked state, and the player's action.",
    "Judge what the action implies and respond with ONLY XML tags (no markdown fences, no prose). Every tag is OPTIONAL — emit only what applies:",
    '  <roll needed="true" title="<short action title, e.g. Use Fireball on Goblin>"/>',
    '  <transaction resource="<shared resource name>" delta="<signed number, negative = spending>" comparison="<plain-language note, under 12 words>"/>',
    '  <warning action="set" name="<short name>" text="<under 15 words>"/>  or  <warning action="clear" name="<short name>"/>',
    '  <relevant names="<comma-separated shared resource names whose value matters this turn>"/>',
    "  <nothing/>",
    "",
    "Rules:",
    "- <roll> ONLY when the outcome is genuinely uncertain AND consequential. Naming a skill in a trivial context (\"I mention Fireball to the mage\") does NOT need a roll; implicit actions (\"I swing at it again\") CAN need one.",
    "- <transaction> ONLY for the party-wide shared resources listed in the snapshot. delta is negative when spending, positive when gaining. Omit the tag if none. Use delta=\"0\" only when the action mentions the resource without implying an amount.",
    "- <warning> ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). Do not re-emit warnings that are already true and unchanged.",
    "- <relevant>: shared resources the story needs to know the current value of this turn, even without a transaction.",
    "- If nothing applies at all, respond with ONLY: <nothing/>",
].join("\n");

//

async function collectContext(playerAction) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1500)}`);

    // Compact snapshot: only what the router needs to judge intent.
    const d = stateManager.getData();
    const s = extension_settings[extensionName];
    const snapshot = {
        party: (d.characters || []).map(c => ({
            name: c.name,
            skills: (c.skills || []).map(s => s.name),
            statuses: (c.statuses || []).map(s => ({ name: s.name, modifiers: s.modifiers || "" })),
        })),
        sharedResources: (d.sharedResources || []).map(r => ({ name: r.name, qty: r.qty })),
        warnings: (d.warnings || []).map(w => w.name),
    };
    // Enemies only when the feature is on AND some exist — the router never
    // pays tokens for an enemy-free scene.
    if (s.feature_enemies && (d.enemies || []).length) {
        snapshot.enemies = d.enemies.map(e => ({
            name: e.name,
            resources: (e.resources || []).map(r => ({ name: r.name, value: r.value, max: r.max })),
            statuses: (e.statuses || []).map(x => ({ name: x.name, modifiers: x.modifiers || "" })),
        }));
    }

    const blocks = [
        "TRACKED STATE (JSON):",
        JSON.stringify(snapshot),
        "",
        "RECENT SCENE:",
        ...history,
        "",
        `PLAYER ACTION TO JUDGE: ${playerAction}`,
    ];

    // Deep context (setting-gated): card / persona / author's note / activated
    // World Info, so judgments account for lore-defined rules and casts.
    if (s.deep_context) {
        const deep = await buildDeepContext(String(playerAction || ""));
        if (deep) blocks.push("", "DEEP CONTEXT (card / persona / lore):", deep);
    }

    return blocks.join("\n");
}

//

// Tolerant XML parse of the plan. Every tag is optional; <nothing/> is the
// fast path. Returns a raw plan or null when no recognizable tag is present.
function parseReply(text) {
    if (!text) return null;
    const plan = { roll: null, transactions: [], warnings: [], relevant: [], nothing: /<nothing\b/i.test(text) };
    let m;

    const rollM = text.match(/<roll\b([^>]*?)(?:\/>|>[\s\S]*?<\/roll>)/i);
    if (rollM) {
        const attrs = parseAttrs(rollM[1]);
        if (String(attrs.needed ?? "").toLowerCase() === "true") {
            plan.roll = { needed: true, title: String(attrs.title || "Roll") };
        }
    }

    const txRe = /<transaction\b([^>]*?)(?:\/>|>[\s\S]*?<\/transaction>)/gi;
    while ((m = txRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        plan.transactions.push({ resource: a.resource ?? a.name ?? "", delta: a.delta ?? 0, comparison: a.comparison ?? "" });
    }

    const warnRe = /<warning\b([^>]*?)(?:\/>|>[\s\S]*?<\/warning>)/gi;
    while ((m = warnRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        plan.warnings.push({ action: a.action || "set", name: a.name ?? "", text: a.text ?? "" });
    }

    const relM = text.match(/<relevant\b([^>]*?)(?:\/>|>[\s\S]*?<\/relevant>)/i);
    if (relM) {
        const a = parseAttrs(relM[1]);
        plan.relevant = String(a.names || a.name || "").split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    }

    const empty = !plan.roll && !plan.transactions.length && !plan.warnings.length && !plan.relevant.length;
    if (empty && !plan.nothing) {
        logDebug("prePass: no recognizable plan tags in reply");
        return null;
    }
    return plan;
}

// Validates the raw plan against the live state: unknown resource names are
// dropped, strings trimmed, the nothing fast path computed.
function sanitizePlan(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.nothing === true) {
        return { roll: null, transactions: [], warnings: [], relevant: [], nothing: true };
    }

    const d = stateManager.getData();
    const findShared = name => (d.sharedResources || []).find(
        r => r.name && String(r.name).toLowerCase() === String(name ?? "").toLowerCase()
    );

    const roll = (parsed.roll && parsed.roll.needed === true)
        ? { needed: true, title: String(parsed.roll.title || "Roll").slice(0, 80) }
        : null;

    const transactions = (Array.isArray(parsed.transactions) ? parsed.transactions : [])
        .map(t => {
            const entry = findShared(t?.resource);
            if (!entry) return null;
            return {
                entry,
                delta: Math.trunc(Number(t?.delta) || 0), // 0 = specialist judges the amount
                comparison: String(t?.comparison || "").slice(0, 120),
            };
        })
        .filter(Boolean);

    const warnings = (Array.isArray(parsed.warnings) ? parsed.warnings : [])
        .map(w => {
            if (!w?.name) return null;
            const action = String(w.action || "set").toLowerCase() === "clear" ? "clear" : "set";
            return { action, name: String(w.name).slice(0, 40), text: String(w.text || "").slice(0, 120) };
        })
        .filter(Boolean);

    const relevant = (Array.isArray(parsed.relevant) ? parsed.relevant : [])
        .map(name => findShared(name))
        .filter(Boolean);

    const nothing = !roll && !transactions.length && !warnings.length && !relevant.length;
    return { roll, transactions, warnings, relevant, nothing };
}

//

// Runs the pre-pass router for a player action. Returns a sanitized plan, or
// null when disabled/failed (caller falls back to keyword triggers).
export async function runPrePass(playerAction) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.pre_pass) return null;
    if (!playerAction) return null;

    try {
        const st = getContext();
        const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: await collectContext(playerAction) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        const plan = sanitizePlan(parseReply(reply || ""));
        if (!plan) {
            logDebug("prePass: malformed reply — caller will fall back to keyword triggers");
            return null;
        }
        logDebug(`prePass: plan — roll=${!!plan.roll} tx=${plan.transactions.length} warn=${plan.warnings.length} relevant=${plan.relevant.length} nothing=${plan.nothing}`);
        return plan;
    } catch (e) {
        console.error("[Game Manager] pre-pass failed:", e);
        return null;
    }
}
