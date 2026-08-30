// Dice roll pre-master.
// When the player's action explicitly names a tracked skill, this LLM decides
// whether the action needs a roll and — if so — provides a title and four
// ordered chance tiers (Critical Failure / Failure / Success / Critical
// Success) with short outcome lines. The tiers stream in one by one into a
// chat bubble while the roll animates; the weighted result is then appended
// permanently to the player's message and queued for high-priority injection.
//
// Uses the pre-master connection profile (util/connectionService.js).

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { captureSnapshot } from "./snapshots.js";
import { queueHigh } from "./injection.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { diceBubble, attachRollToMessage } from "../ui/diceBubble.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the game master's dice engine for a tabletop-style roleplay session.",
    "You receive the recent scene and the player's action. Decide if the action's outcome is uncertain enough to require a random roll.",
    "Routine, guaranteed, or purely narrative actions do NOT need a roll.",
    "If a roll IS needed, respond with ONLY a JSON object (no markdown fences, no prose):",
    '{"needsRoll": true, "title": "<short action title, e.g. Use Fireball on Goblin>", "tiers": [',
    '  {"name": "Critical Failure", "chance": 10, "outcome": "<short outcome line>"},',
    '  {"name": "Failure", "chance": 25, "outcome": "<short outcome line>"},',
    '  {"name": "Success", "chance": 50, "outcome": "<short outcome line>"},',
    '  {"name": "Critical Success", "chance": 15, "outcome": "<short outcome line>"}]}',
    "Always provide exactly 4 tiers in that order. Chances are percentages of a 100% total. Outcome lines are short, vivid, second person (\"Fireball explodes in your face\").",
    "If no roll is needed respond with ONLY: {\"needsRoll\": false}",
].join("\n");

function collectContext(playerAction) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1500)}`);
    const d = stateManager.getData();
    const party = d.characters.map(c => ({
        name: c.name,
        skills: c.skills.map(s => s.name),
    }));
    return [
        "PARTY (tracked characters and their skills):",
        JSON.stringify(party),
        "",
        "RECENT SCENE:",
        ...history,
        "",
        `PLAYER ACTION TO JUDGE: ${playerAction}`,
    ].join("\n");
}

// Extracts complete tier objects from a partial JSON stream so the bubble can
// render options as they arrive, one by one.
export function extractStreamedTiers(partialText) {
    const tiers = [];
    if (!partialText) return tiers;
    const re = /{\s*"name"\s*:\s*"([^"]*?)"\s*,\s*"chance"\s*:\s*([\d.]+)\s*,\s*"outcome"\s*:\s*"((?:[^"\\]|\\.)*)"\s*}/g;
    let m;
    while ((m = re.exec(partialText)) !== null) {
        tiers.push({ name: m[1], chance: parseFloat(m[2]) || 0, outcome: m[3].replace(/\\n/g, " ") });
    }
    return tiers;
}

// Tolerant final parse: grabs the first {...} JSON object in the reply.
function parseReply(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch (e) {
        logDebug("diceRoller: JSON parse failed:", e);
        return null;
    }
}

// Weighted random pick across the provided tiers (chances used as weights).
export function weightedRoll(tiers) {
    const total = tiers.reduce((sum, t) => sum + Math.max(0, Number(t.chance) || 0), 0);
    if (total <= 0) return tiers[Math.floor(Math.random() * tiers.length)];
    let roll = Math.random() * total;
    for (const t of tiers) {
        roll -= Math.max(0, Number(t.chance) || 0);
        if (roll <= 0) return t;
    }
    return tiers[tiers.length - 1];
}

function queueRollResult(title, tier) {
    const pct = Math.round(Number(tier.chance) || 0);
    queueHigh(`  <roll title="${title}" tier="${tier.name}" chance="${pct}">${tier.outcome}</roll>`);
}

// Full dice flow for a player action on message `mesId`. `opts.title` comes
// from the pre-pass plan: when set, the router already decided a roll IS
// needed, so a needsRoll=false reply from the dice LLM is overridden (the
// dice LLM still provides the tiers). Returns true if a roll was made.
export async function rollDice(playerAction, mesId, { title = null } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_dice) return false;

    const bubble = diceBubble.show("Judging action...");
    try {
        const st = getContext();
        const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: collectContext(playerAction) },
        ];

        // Stream the pre-master reply; surface tiers one by one as they arrive.
        const seenTiers = new Set();
        let streamed = "";
        const reply = await sendRequestViaProfile(profileId, messages, {
            stream: true,
            onChunk: (partial) => {
                streamed = partial;
                for (const tier of extractStreamedTiers(partial)) {
                    const key = `${tier.name}|${tier.chance}`;
                    if (seenTiers.has(key)) continue;
                    seenTiers.add(key);
                    bubble.addTier(tier);
                }
            },
        });

        const parsed = parseReply(reply || streamed);
        const forced = !!title; // pre-pass already decided a roll is needed
        if (!parsed || !Array.isArray(parsed.tiers) || (parsed.needsRoll !== true && !forced)) {
            bubble.resolveNoRoll();
            logDebug("diceRoller: no roll needed or malformed reply");
            return false;
        }

        // Sanitize tiers: names/outcomes strings, chances numbers.
        const tiers = parsed.tiers
            .filter(t => t && t.name && t.outcome)
            .map(t => ({ name: String(t.name), chance: Number(t.chance) || 0, outcome: String(t.outcome) }));
        if (tiers.length < 2) {
            bubble.resolveNoRoll();
            return false;
        }

        const winner = weightedRoll(tiers);
        await new Promise(r => setTimeout(r, 1600)); // let the animation breathe
        bubble.resolve(winner);

        // State baseline for swipe/delete rollback. The player's message text
        // is NEVER edited — the result is DOM-rendered on the message and
        // injected to the LLM via the high-priority macro.
        const rollTitle = title || parsed.title || "Roll";
        captureSnapshot(mesId);
        attachRollToMessage(mesId, rollTitle, winner);
        queueRollResult(rollTitle, winner);
        logDebug(`diceRoller: rolled "${rollTitle}" -> ${winner.name}`);
        return true;
    } catch (e) {
        console.error("[Game Manager] dice roll failed:", e);
        bubble.resolveNoRoll();
        return false;
    }
}