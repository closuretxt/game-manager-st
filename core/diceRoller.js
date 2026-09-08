// DICE ENGINE — the pre-master pass that judges player actions outside of
// formal combat clashes. It receives the tracked party sheets (skills,
// statuses, and when available resources/attributes/passives), the recent
// scene and the pre-pass router's notes, decides whether the action is
// uncertain enough to need a roll and — if so — provides a title and four
// ordered chance tiers (Critical Failure / Failure / Success / Critical
// Success) with short outcome lines. Chances are EARNED from the sheets,
// never generous by default; untracked actors are judged conservatively from
// the scene alone. The tiers stream in one by one into a chat bubble while
// the roll animates; the weighted result is then appended permanently to the
// player's message and queued for high-priority injection.
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
import { storeMessageData, recentMessages, sceneContextBlock } from "../util/chatStore.js";
import { parseAttrs, escAttr, decodeEntities } from "./toolParser.js";
import { valueGuidelines } from "./valueGuidelines.js";
import { sendRequestViaProfile, resolveDiceProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { diceBubble, attachRollToMessage } from "../ui/diceBubble.js";
import { playRoll, playTierResult } from "./soundFx.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the DICE ENGINE of a tabletop-style roleplay game system: you judge whether the player's action is uncertain enough to need a random roll and, if so, build a fair 4-tier chance set. REALISM FIRST: chances are EARNED from the actor's sheet and the scene, never generous by default. Every tier must be justifiable by a stat, skill, passive, status or an established scene fact — if nothing supports a chance, lower it.",
    "",
    "WHAT YOU RECEIVE:",
    "- <party>: tracked characters with skills ('*' = on cooldown), statuses (with modifiers), and — when tracked — resources, attributes and passives.",
    "- <scene_context>: the last few messages of the roleplay — PAST context, already tracked (specific note inside the block). The action you judge happens NOW and is the PLAYER ACTION TO JUDGE alone; never judge or re-roll actions taken from the scene.",
    "- GM NOTES (optional): the pre-pass router's full output for this action.",
    "- <deep_context> / <custom> (optional): world lore and the user's standing instructions for this engine.",
    "- PLAYER ACTION TO JUDGE: the action being decided.",
    "",
    "HARD RESOLUTION RULES:",
    "- UNCERTAINTY GATE. Routine, guaranteed, or purely narrative actions do NOT need a roll: reply <roll needs=\"false\"/>. Only outcomes with genuine chances of going either way get rolled.",
    "- UNKNOWN ABILITIES = IMPOSSIBLE. If the action names an ability/technique/spell NOT on the actor's sheet (and the scene never established the actor can do it), Success and Critical Success are 0%: only Failure/Critical Failure tiers describing the fumble (doesn't know the technique, move misfires, nothing happens). A swordsman without 'Dimensional Slash' cannot use it.",
    "- ATTRIBUTES & SKILLS DECIDE. Match the action to its relevant attribute (Strength for melee, Dexterity for dodging...) and the actor's skills — they must visibly shift the tiers. Trained characters attempting easy tasks skew heavily toward Success; untrained or hard tasks skew toward Failure. Extreme stat or skill gaps cap Success around ~30%.",
    "- RESOURCES & STATUSES CAP PERFORMANCE. Check current health and statuses: below ~25% health, demanding actions shift hard toward Failure; wounded, slowed, blinded, buffed or exhausted actors apply their modifiers to the chances. Near-death actors cannot perform demanding maneuvers at all.",
    "- ON-COOLDOWN SKILLS. A skill marked '*' is unavailable this turn: attempting it is a Critical Failure (the technique fizzles, the actor fumbles the timing).",
    "- RESPONSIBLE GUESSING. If the actor has NO sheet data in <party> (untracked character or creature), infer their capabilities CONSERVATIVELY from the scene alone: their role, gear, described behavior and established lore. Default to middling odds (~40-50% Success) — never extreme chances without clear scene evidence, and never invent sheet entries. An unknown farmhand cannot out-fence a master swordsman.",
    "",
    "YOUR OBJECTIVE:",
    "If a roll IS needed, respond with ONLY XML (no markdown fences, no prose) — exactly 4 ordered tiers (Critical Failure / Failure / Success / Critical Success), chances as percentages of a 100% total:",
    '<roll title="<short action title, e.g. Use Fireball on Goblin>">',
    '<tier name="Critical Failure" chance="10">The mage\'s Fireball bursts in her palm, scorching her sleeve — she staggers back, and the goblin starts to close in</tier>',
    '<tier name="Failure" chance="25">The fireball roars wide and slams into the wall; the goblin levels its blade at her</tier>',
    '<tier name="Success" chance="50">The blast catches the goblin square in the chest and sends it sprawling, smoke curling off its armor</tier>',
    '<tier name="Critical Success" chance="15">The fireball detonates with a deafening crack — the goblin is thrown clear and does not get back up</tier>',
    "</roll>",
    "Tier chances must always sum to 100 and reflect the actor's ACTUAL odds given their stats and the scene — a nimble rogue picking a simple lock is NOT a coin flip, and a wounded novice facing a master is NOT a likely success.",
    "Each tier outcome is a HOOK, not a conclusion: it shows the immediate result of the action (what happens, who reacts) and then STOPS, leaving the scene open — the main GM narrative continues from it and decides everything that follows. Never wrap up, never state final fates (no \"the fight is over\", no aftermath, no closing dialogue), unless the outcome is truly unambiguous (e.g. an instant kill on a critical success).",
    "Outcome lines are short, vivid, and ALWAYS third person, referring to the actor by name (from the party list or the scene) — never \"you\"/\"your\"/\"I\", even though the player's action is written in first person (\"The mage's Fireball explodes in her face\").",
    "NEVER include dialogue, quoted speech, or spoken lines of any kind in tier outcomes — narration only.",
    "NEVER roleplay as the characters in tier outcomes: no thoughts, feelings, words, or deliberate choices for them — describe only what physically happens as a consequence of the roll, and let the main GM narrative handle how everyone reacts.",
    "If no roll is needed respond with ONLY: <roll needs=\"false\"/>",
    "When a roll is needed you MUST always produce the full <roll> block with all four <tier> — never a bare <roll .../> without tiers, never an empty reply.",
    "TIER CHANCES are plain percentages — the engine weights them into a true random pick. When the action or its outcomes carry dice terms (variable damage, random effects), keep them in the outcome line as written (\"the flask bursts for 2d6+2\"): the tracker rolls them with TRUE RNG when it applies the numbers.",
    valueGuidelines(),
].join("\n");

function collectContext(playerAction, notes = null, title = null, rewrite = null) {
    // Always ends at the AI's last reply (trailing user action excluded).
    // No char cap — messages stay intact; the message count bounds the size.
    const history = recentMessages(MAX_CONTEXT_MESSAGES)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "")}`);
    const d = stateManager.getData();

    // Compact XML party snapshot — same dialect as the clash resolver's
    // sheets (* = skill on cooldown; statuses as Name (modifiers); resources
    // and attributes as value pairs; passives keep their descriptions so
    // chances are earned from them).
    const party = (d.characters || [])
        .filter(c => c.state?.mode !== "dead")
        .map(c => {
            const attrs = [`name="${escAttr(c.name)}"`];
            for (const r of c.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
            for (const a of c.attributes || []) attrs.push(`${escAttr(a.name)}="${a.value}"`);
            const skills = (c.skills || []).map(sk => `${escAttr(sk.name)}${(Number(sk.cooldown_left) || 0) > 0 ? "*" : ""}`).join(", ");
            if (skills) attrs.push(`skills="${skills}"`);
            const passives = (c.passives || []).map(p => `${escAttr(p.name)}${p.description ? `: ${escAttr(p.description)}` : ""}`).join("; ");
            if (passives) attrs.push(`passives="${passives}"`);
            const statuses = (c.statuses || []).map(x => `${escAttr(x.name)}${x.modifiers ? ` (${escAttr(x.modifiers)})` : ""}`).join(", ");
            if (statuses) attrs.push(`statuses="${statuses}"`);
            return `<char ${attrs.join(" ")}/>`;
        });
    // GM notes: the pre-pass router's FULL output for this action, persisted
    // on the user's message (roll call, title, notes, rewrite, transactions...)
    // — near the bottom so it reads as fresh context, not buried mid-prompt.
    const gmRaw = getPreviousPrePassRaw();
    return [
        "PARTY (tracked characters):",
        "<party>",
        ...(party.length ? party : ["<!-- no tracked party — judge the actor from the scene alone (RESPONSIBLE GUESSING) -->"]),
        "</party>",
        "",
        // The whole scene window is one <scene_context> block: past context,
        // already tracked — the specific note INSIDE the block says so next to
        // the data, not only in the system prompt.
        sceneContextBlock(history),
        ...(gmRaw ? ["", "GM NOTES (the pre-pass router's full output for this action):", "<gm_notes>", gmRaw, "</gm_notes>"] : []),
        "",
        `PLAYER ACTION TO JUDGE: ${playerAction}`,
        // Closing recency anchor at the VERY bottom of the full prompt.
        "Reminder: whatever else you write, deliver the <roll> block with all four <tier> children (or <roll needs=\"false\"/>) — that block is what the system reads.",
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
        systemContent += "\n\nOUTPUT REMINDER: reply with exactly ONE <roll> element and NOTHING else. If a roll is needed, it contains four <tier> (Critical Failure, Failure, Success, Critical Success) and is NOT self-closing — a reply without all four tiers is a failure. If no roll is needed: <roll needs=\"false\"/>.";

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