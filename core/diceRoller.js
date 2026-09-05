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
import { queueHigh } from "./injection.js";
import { getPreviousPrePassRaw } from "./prePass.js";
import { storeMessageData } from "../util/chatStore.js";
import { parseAttrs, escAttr, decodeEntities } from "./toolParser.js";
import { sendRequestViaProfile, resolveDiceProfile } from "../util/connectionService.js";
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
    '<tier name="Critical Failure" chance="10">The mage\'s Fireball explodes in her face</tier>',
    '<tier name="Failure" chance="25">She launches the spell and misses</tier>',
    '<tier name="Success" chance="50">The blast engulfs the target</tier>',
    '<tier name="Critical Success" chance="15">The goblin is vaporized instantly</tier>',
    "</roll>",
    "Always provide exactly 4 tiers in that order. Chances are percentages of a 100% total. Outcome lines are short, vivid, and ALWAYS third person, referring to the actor by name (from the party list or the scene) — never \"you\"/\"your\"/\"I\", even though the player's action is written in first person (\"The mage's Fireball explodes in her face\").",
    "If no roll is needed respond with ONLY: <roll needs=\"false\"/>",
    "When a roll is needed you MUST always produce the full <roll> block with all four <tier> children — never a bare <roll .../> without tiers, never an empty reply.",
].join("\n");

function collectContext(playerAction, notes = null, title = null, rewrite = null) {
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
            return `<char name="${escAttr(c.name)}"${skills ? ` skills="${skills}"` : ""}${statuses ? ` statuses="${statuses}"` : ""}/>`;
        });
    // GM notes: the pre-pass router's FULL output for this action, persisted
    // on the user's message (roll call, title, notes, rewrite, transactions...)
    // — near the bottom so it reads as fresh context, not buried mid-prompt.
    const gmRaw = getPreviousPrePassRaw();
    return [
        "PARTY (tracked characters):",
        "<party>",
        ...party,
        "</party>",
        "",
        "RECENT SCENE:",
        ...history,
        ...(gmRaw ? ["", "GM NOTES (the pre-pass router's full output for this action):", "<gm_notes>", gmRaw, "</gm_notes>"] : []),
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
            // Agents XML-escape dialogue in tier content ("...") —
            // decode before the text reaches the bubble/chip/injection.
            outcome: decodeEntities(String(m[2] || "")).replace(/\s+/g, " ").trim(),
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
            outcome: decodeEntities(String(m[2] || "")).replace(/\s+/g, " ").trim(),
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
    // Swipe-recovered tiers are read from the persisted gm_roll record and may
    // predate agent-output entity decoding — normalize before injecting.
    queueHigh(`<roll title="${decodeEntities(title)}" tier="${tier.name}">${decodeEntities(tier.outcome)}</roll>`);
}

// Re-queues an ALREADY RESOLVED roll result (swipe recovery) — the outcome
// was decided once for this action and is replayed verbatim, never re-rolled.
export function requeueRollResult(title, tier) {
    queueRollResult(title, tier);
}

// Full dice flow for a player action on message `mesId`. `opts.title` comes
// from the pre-pass plan: when set, the router already decided a roll IS
// needed, so a needsRoll=false reply from the dice LLM is overridden (the
// dice LLM still provides the tiers). Returns true if a roll was made.
export async function rollDice(playerAction, mesId, { title = null } = {}) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_dice) return false;

    // When the pre-pass already decided a roll is needed, surface its title
    // while the dice LLM computes the tiers — the player sees what is being
    // judged instead of a generic "Judging action...".
    const forced = !!title;
    const bubble = diceBubble.show(title ? `${title}` : "Judging action...");
    try {
        const st = getContext();
        const profileId = resolveDiceProfile(st, s.dice_profile, s.premaster_profile, s.connection_profile);
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

        // Output contract — the LAST thing in the system message (recency):
        // models that self-close <roll/> with no tiers silently drop the roll.
        systemContent += "\n\nOUTPUT REMINDER: reply with exactly ONE <roll> element and NOTHING else. If a roll is needed, it contains four <tier> children (Critical Failure, Failure, Success, Critical Success) and is NOT self-closing — a reply without all four tiers is a failure. If no roll is needed: <roll needs=\"false\"/>.";

        const seenTiers = new Set();
        let streamed = "";
        const messages = [
            { role: "system", content: systemContent },
            { role: "user", content: collectContext(playerAction) },
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

        const raw = String(reply || streamed || "");
        console.info(`[GM DIAG] rollDice raw reply (${raw.length} chars):`, raw.slice(0, 600));
        const parsed = parseReply(raw);
        console.info(`[GM DIAG] rollDice parsed: needsRoll=${parsed?.needsRoll}, tierCount=${parsed?.tiers?.length ?? 0}, title=${parsed?.title ?? "-"}`);
        if (!parsed || !Array.isArray(parsed.tiers) || (parsed.needsRoll !== true && !forced)) {
            console.info(`[GM DIAG] rollDice SKIP: parsed=${!!parsed}, needsRoll=${parsed?.needsRoll}, tierCount=${parsed?.tiers?.length ?? 0}, forced=${forced}`);
            bubble.resolveNoRoll();
            logDebug("diceRoller: no roll needed or malformed reply");
            return false;
        }

        // Sanitize tiers: names/outcomes strings, chances numbers.
        const tiers = parsed.tiers
            .filter(t => t && t.name && t.outcome)
            .map(t => ({ name: String(t.name), chance: Number(t.chance) || 0, outcome: String(t.outcome) }));
        if (tiers.length < 2) {
            console.info(`[GM DIAG] rollDice SKIP: usable tiers=${tiers.length} (from ${parsed.tiers.length} raw)`);
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
        // Persist the resolved roll on the triggering user message: a swipe
        // of the reply re-attaches THIS result instead of re-rolling (same
        // action, same state — the odds were already decided once). Keyed by
        // message id (not action text) so the first send persists even in
        // send flows where the message lands after the pre-turn pass.
        storeMessageData(mesId, "gm_roll", { title: rollTitle, tier: winner });
        logDebug(`diceRoller: rolled "${rollTitle}" -> ${winner.name}`);
        return true;
    } catch (e) {
        console.error("[Game Manager] dice roll failed:", e);
        bubble.resolveNoRoll();
        return false;
    }
}