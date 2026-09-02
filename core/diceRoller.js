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
import { substituteParams } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel } from "./stateManager.js";
import { captureSnapshot } from "./snapshots.js";
import { queueHigh, getPreviousInjections } from "./injection.js";
import { getPreviousPrePassRaw } from "./prePass.js";
import { parseAttrs, escAttr } from "./toolParser.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { diceBubble, attachRollToMessage } from "../ui/diceBubble.js";
import { playRoll, playTierResult } from "./soundFx.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the game master's dice engine for a tabletop-style roleplay session.",
    "You receive the recent scene and the player's action. Decide if the action's outcome is uncertain enough to require a random roll.",
    "Routine, guaranteed, or purely narrative actions do NOT need a roll.",
    "If a roll IS needed, respond with ONLY XML (no markdown fences, no prose):",
    '<roll title="<short action title, e.g. Use Fireball on Goblin>">',
    '  <tier name="Critical Failure" chance="10">The mage\'s Fireball explodes in her face</tier>',
    '  <tier name="Failure" chance="25">She launches the spell and misses</tier>',
    '  <tier name="Success" chance="50">The blast engulfs the target</tier>',
    '  <tier name="Critical Success" chance="15">The goblin is vaporized instantly</tier>',
    "</roll>",
    "Always provide exactly 4 tiers in that order. Chances are percentages of a 100% total. Outcome lines are short, vivid, and ALWAYS third person, referring to the actor by name (from the party list or the scene) — never \"you\"/\"your\"/\"I\", even though the player's action is written in first person (\"The mage's Fireball explodes in her face\").",
    "If no roll is needed respond with ONLY: <roll needs=\"false\"/>",
].join("\n");

function collectContext(playerAction, notes = null) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1500)}`);
    const d = stateManager.getData();

    // Compact XML party snapshot — same dialect as the pre-pass router state
    // (* = skill on cooldown; statuses as Name (modifiers)).
    const party = (d.characters || [])
        .filter(c => c.state?.mode !== "dead")
        .map(c => {
            const skills = (c.skills || []).map(sk => `${escAttr(sk.name)}${(Number(sk.cooldown_left) || 0) > 0 ? "*" : ""}`).join(", ");
            const statuses = (c.statuses || []).map(x => `${escAttr(x.name)}${x.modifiers ? ` (${escAttr(x.modifiers)})` : ""}`).join(", ");
            return `  <char name="${escAttr(c.name)}"${skills ? ` skills="${skills}"` : ""}${statuses ? ` statuses="${statuses}"` : ""}/>`;
        });
    // Previous GM notes: the pre-pass router's full LAST output plus whatever
    // the game system actually injected last turn (high: roll/transaction
    // results; low: one-shot notes/resources) — near the bottom so it reads
    // as fresh context, not buried mid-prompt.
    const prevRaw = getPreviousPrePassRaw();
    const prevInj = getPreviousInjections();
    const prevNotes = [
        ...(prevRaw ? ["PRE-PASS GM (last turn):", prevRaw] : []),
        ...(prevInj ? ["INJECTED RESULTS (last turn):", prevInj] : []),
    ];
    return [
        "PARTY (tracked characters):",
        "<party>",
        ...party,
        "</party>",
        "",
        "RECENT SCENE:",
        ...history,
        ...(prevNotes.length ? ["", "PREVIOUS GM NOTES:", "<gm_notes>", ...prevNotes, "</gm_notes>"] : []),
        // The pre-pass router's remarks about THIS action — the context that
        // made it call for the roll, weighed when building the tiers.
        ...(notes?.length ? ["", "GM NOTES FOR THIS ACTION (from the pre-pass router):", "<gm_notes>", ...notes.map(n => `  <note>${escAttr(n)}</note>`), "</gm_notes>"] : []),
        "",
        `PLAYER ACTION TO JUDGE: ${playerAction}`,
    ].join("\n");
}

// Extracts complete tier objects from a partial XML stream so the bubble can
// render options as they arrive, one by one. Incomplete (unclosed) tiers are
// skipped until their closing tag arrives.
export function extractStreamedTiers(partialText) {
    const tiers = [];
    if (!partialText) return tiers;
    const re = /<tier\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tier>)/gi;
    let m;
    while ((m = re.exec(partialText)) !== null) {
        const a = parseAttrs(m[1]);
        tiers.push({
            name: String(a.name || ""),
            chance: Number(a.chance) || 0,
            outcome: String(m[2] || "").replace(/\s+/g, " ").trim(),
        });
    }
    return tiers;
}

// Tolerant final parse: the first <roll> block in the reply.
function parseReply(text) {
    if (!text) return null;
    const rollM = text.match(/<roll\b([^>]*?)(?:\/>|>([\s\S]*?)<\/roll>)/i);
    if (!rollM) return null;
    const attrs = parseAttrs(rollM[1]);
    if (String(attrs.needs ?? attrs.needed ?? "true").toLowerCase() === "false") {
        return { needsRoll: false };
    }
    const tiers = [];
    const tierRe = /<tier\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tier>)/gi;
    let m;
    while ((m = tierRe.exec(rollM[2] || "")) !== null) {
        const a = parseAttrs(m[1]);
        tiers.push({
            name: String(a.name || ""),
            chance: Number(a.chance) || 0,
            outcome: String(m[2] || "").replace(/\s+/g, " ").trim(),
        });
    }
    return { needsRoll: true, title: String(attrs.title || "Roll"), tiers };
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
    // Minimal injection: the story engine needs the outcome, not the odds.
    queueHigh(`  <roll title="${title}" tier="${tier.name}">${tier.outcome}</roll>`);
}

// Full dice flow for a player action on message `mesId`. `opts.title` comes
// from the pre-pass plan: when set, the router already decided a roll IS
// needed, so a needsRoll=false reply from the dice LLM is overridden (the
// dice LLM still provides the tiers). `opts.notes` carries the router's
// contextual remarks about the action. Returns true if a roll was made.
export async function rollDice(playerAction, mesId, { title = null, notes = null } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_dice) return false;

    const bubble = diceBubble.show("Judging action...");
    try {
        const st = getContext();
        const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        // Deep context (own "Deep Context for Engines" setting) goes into the
        // system message, after the dice engine instructions — the roller must
        // know who and where the scene is to build fitting outcome tiers.
        let systemContent = SYSTEM_PROMPT;
        if (s.deep_context_engines) {
            const deep = await buildDeepContext(String(playerAction || ""));
            if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
        }
        // User's standing instructions for the pre-master engines — at the END
        // of the system message, after the deep context (same layout as the
        // pre-pass/post-pass). Full ST macro parsing via substituteParams.
        const custom = String(s.custom_instructions?.pre || "").trim();
        if (custom) {
            let rendered = custom;
            try {
                const charName = st.characters?.[st.characterId]?.name;
                rendered = substituteParams(rendered, { name2Override: charName });
            } catch (e) {
                console.warn("[Game Manager] custom instruction macro substitution failed:", e);
            }
            systemContent += `\n\n<custom>\n${rendered}\n</custom>`;
        }

        const forced = !!title; // pre-pass already decided a roll is needed
        const seenTiers = new Set();
        let streamed = "";
        const messages = [
            { role: "system", content: systemContent },
            { role: "user", content: collectContext(playerAction, notes) },
        ];

        // Stream the pre-master reply; surface tiers one by one as they arrive.
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

        const rollTitle = title || parsed.title || "Roll";

        const winner = weightedRoll(tiers);
        // Rolling time setting with a ±200ms random variation so repeated
        // rolls don't feel mechanical.
        const rollMs = Math.max(300, Math.round((Number(s.roll_duration) || 1600) + (Math.random() * 400 - 200)));
        bubble.startRoll(); // slot-machine sweep across the streamed tiers
        playRoll(rollMs); // tumbling dice while the animation breathes
        await new Promise(r => setTimeout(r, rollMs)); // let the animation breathe
        bubble.resolve(winner);
        playTierResult(winner.name);

        // State baseline for swipe/delete rollback. The player's message text
        // is NEVER edited — the result is DOM-rendered on the message and
        // injected to the LLM via the high-priority macro.
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