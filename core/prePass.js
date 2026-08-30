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
//   notes        — free-form contextual remarks worth injecting this turn
//   rewrite      — clarified version of a vague/contradictory action
//                  (actions only, dialogue cropped out)
//   nothing      — fast path: skip every specialist
//
// The pre-pass decides IF; the specialists (diceRoller, transactions) decide
// HOW. On failure or a malformed reply it returns null and the caller falls
// back to legacy keyword detection (detectTriggers in core/triggerWatcher.js).

import { extension_settings, getContext } from "../../../../extensions.js";
import { substituteParams } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { parseAttrs } from "./toolParser.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the PRE-PASS ROUTER of a tabletop-style roleplay game system that runs alongside a story engine LLM.",
    "",
    "YOUR OBJECTIVE:",
    "Before every player action reaches the story engine, you judge what that action IMPLIES and decide what the game system must do this turn. You are the only gate: nothing is injected, rolled, or spent unless you say so. You do not write the story, you do not narrate, you do not talk to the player — you route.",
    "",
    "WHAT YOU RECEIVE:",
    "- TRACKED STATE: the party (characters, skills, statuses), the party-wide SHARED resources (money, food, ammo...), active warnings, OPEN THREADS, and optionally enemies.",
    "- OPEN THREADS: untracked/unfinished things the post-pass left for itself (ongoing trips with resources spent so far, half-done actions) and secrets hidden from the player. Use them to keep continuity (e.g. a <transaction> or <note> that accounts for the fuel already burned) and to reveal a secret ONLY when the scene genuinely demands it.",
    "- RECENT SCENE: the last few messages of the roleplay.",
    "- PLAYER ACTION: the message you must judge.",
    "",
    "CORE PRINCIPLES:",
    "- Judge INTENT, not keywords. \"I hand him the coins\" implies a money transaction even though no resource is named; \"I swing at it again\" can need a roll even though no skill is named. Conversely, naming a skill or resource in a trivial context (\"I mention Fireball to the mage\") triggers NOTHING.",
    "- Minimal injection. The story engine must stay lean: inject ONLY what THIS turn genuinely needs. Casual chat with no survival, combat, or resource stakes costs the player nothing — that is a feature, not a failure.",
    "- When in doubt whether something is needed, leave it out. False negatives are cheap; context flooding is the one thing this system exists to prevent.",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML tags — no markdown fences, no prose, no explanations. Every tag is OPTIONAL; emit only what applies:",
    '  <roll needed="true" title="<short action title, e.g. Use Fireball on Goblin>"/>',
    '  <combat engaged="true" speed="<initiative value, 0 if unknown>"/>',
    '  <transaction resource="<shared resource name>" delta="<signed number, negative = spending>" comparison="<plain-language note, under 12 words>"/>',
    '  <warning action="set" name="<short name>" text="<under 15 words>"/>  or  <warning action="clear" name="<short name>"/>',
    '  <relevant names="<comma-separated shared resource names whose value matters this turn>"/>',
    '  <note text="<short contextual remark the story engine should know this turn>"/>',
    '  <rewrite text="<clarified version of the player\'s action, actions only>"/>',
    "  <nothing/>",
    "",
    "TAG RULES:",
    "- <roll>: ONLY when the action's outcome is genuinely uncertain AND consequential — risky stunts, contested attempts, unpredictable reactions. Routine, guaranteed, or purely narrative actions never roll. The dice engine will build the outcome tiers; you only decide IF and give the action a short title.",
    "- <combat>: INSTEAD of <roll>, when the action ENGAGES tracked enemies (attacking, defending under threat, fleeing from them, using a skill on one). Casual talk with an enemy present does NOT count. speed is the actor's initiative judged from their attributes/statuses (Dexterity, Haste...), 0 when unknown. The combat engine runs the opposed resolution (enemy AI + clash + dice); you only decide IF and the speed. Never emit <roll> together with <combat>.",
    "- <transaction>: ONLY for the party-wide shared resources listed in the snapshot, when the action implies spending or gaining. delta is negative when spending, positive when gaining; the transaction engine validates amounts against the current value. Use delta=\"0\" only when the action involves the resource but the amount is unclear — the engine will judge it. The comparison is a plain-language sense of scale (\"Could buy a week's worth of food\").",
    "- <warning>: ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). action=\"set\" adds or updates one; action=\"clear\" removes one whose cause is resolved. Never re-emit a warning that is already true and unchanged.",
    "- <relevant>: shared resources whose CURRENT VALUE the story engine needs to know this turn even though nothing was spent (haggling, showing off wealth, checking supplies). Resources flagged always-inject are already visible — never list them.",
    "- <note>: brief free-form information the story engine would otherwise miss and that affects how the scene should unfold right now (local prices, an NPC's hidden intent, a rule of the location). At most two per turn, under 25 words each. This is NOT for tracked values — those go in <relevant> — and NOT for anything the scene text already establishes.",
    "- <rewrite>: ONLY when the action is vague, ambiguous, or self-contradictory AND clarifying it changes what should happen next (\"I grab the coins in my pocket and I hand it to the seller\" -> the amount and target become explicit). Rules: rewrite ONLY what the player DOES — CROP OUT all dialogue (quoted speech stays the player's own; the story engine already sees the original message); NEVER invent actions the player did not imply; NEVER answer or extend dialogue; keep it under 40 words, plain declarative description of the action. If the action is already clear, omit the tag entirely.",
    "- <nothing/>: when NONE of the above applies (pure casual chat, simple dialogue, movement with no stakes). Respond with ONLY <nothing/> and nothing else.",
    "- COOLDOWNS are tracked by the system, not by you: a skill marked on_cooldown in the snapshot is UNAVAILABLE this turn. If the player's action tries to use one, emit a <note> saying that skill is still on cooldown so the story engine can narrate the failed/refused attempt — never decide yourself when a cooldown ends.",
    "",
    "EXAMPLES OF JUDGMENT:",
    "- \"I buy three apples\" -> <transaction resource=\"Dinheiro\" delta=\"-6\" comparison=\"A few days of meals\"/>",
    "- \"I cast Fireball at the goblin\" -> <roll needed=\"true\" title=\"Cast Fireball on Goblin\"/>",
    "- \"I ask the innkeeper about rumors\" -> <nothing/>",
    "- \"I flaunt my wealth to impress the merchant\" -> <relevant names=\"Dinheiro\"/>",
    "- \"I check our supplies before leaving\" -> <relevant names=\"Food, Water\"/>",
    "- \"I grab the coins in my pocket and I hand it to the seller. Here you go, friend.\" -> <transaction resource=\"Dinheiro\" delta=\"0\" comparison=\"\"/> <rewrite text=\"I count out a handful of coins from my pocket and hand them to the seller as payment\"/>",
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
        party: (d.characters || []).map(c => {
            // The dead have nothing left to judge — collapse their entry.
            if (c.dead === true) return { name: c.name, dead: true };
            return {
                name: c.name,
                // on_cooldown is a code-computed boolean — the router never sees
                // (and never computes) remaining cooldown counts.
                skills: (c.skills || []).map(s => {
                    const skill = { name: s.name };
                    if ((Number(s.cooldown_left) || 0) > 0) skill.on_cooldown = true;
                    return skill;
                }),
                statuses: (c.statuses || []).map(s => ({ name: s.name, modifiers: s.modifiers || "" })),
            };
        }),
        sharedResources: (d.sharedResources || []).map(r => ({ name: r.name, qty: r.qty })),
        warnings: (d.warnings || []).map(w => w.name),
        // Open threads: untracked/unfinished things + secrets left by the
        // post-pass. Never injected into the story prompt directly — the
        // router leaks what the scene demands via <note>.
        openThreads: (d.threads || []).map(t => ({ name: t.name, text: t.text, ref: t.ref || "" })),
    };
    // Enemies only when the feature is on AND some exist — the router never
    // pays tokens for an enemy-free scene.
    if (s.feature_enemies && (d.enemies || []).length) {
        snapshot.enemies = d.enemies.map(e => ({
            name: e.name,
            resources: (e.resources || []).map(r => ({ name: r.name, value: r.value, max: r.max })),
            skills: (e.skills || []).map(sk => {
                const skill = { name: sk.name };
                if ((Number(sk.cooldown_left) || 0) > 0) skill.on_cooldown = true;
                return skill;
            }),
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

    // User's standing instructions for the pre-pass. Full ST macro parsing
    // ({{char}}, {{user}}, {{time}}...) via substituteParams, like a normal
    // generation would do.
    const custom = String(s.custom_instructions?.pre || "").trim();
    if (custom) {
        let rendered = custom;
        try {
            const charName = st.characters?.[st.characterId]?.name;
            rendered = substituteParams(rendered, { name2Override: charName });
        } catch (e) {
            console.warn("[Game Manager] custom instruction macro substitution failed:", e);
        }
        blocks.push("", `<custom>\n${rendered}\n</custom>`);
    }

    return blocks.join("\n");
}

//

// Tolerant XML parse of the plan. Every tag is optional; <nothing/> is the
// fast path. Returns a raw plan or null when no recognizable tag is present.
function parseReply(text) {
    if (!text) return null;
    const plan = { roll: null, combat: null, transactions: [], warnings: [], relevant: [], notes: [], rewrite: null, nothing: /<nothing\b/i.test(text) };
    let m;

    const rollM = text.match(/<roll\b([^>]*?)(?:\/>|>[\s\S]*?<\/roll>)/i);
    if (rollM) {
        const attrs = parseAttrs(rollM[1]);
        if (String(attrs.needed ?? "").toLowerCase() === "true") {
            plan.roll = { needed: true, title: String(attrs.title || "Roll") };
        }
    }

    const combatM = text.match(/<combat\b([^>]*?)(?:\/>|>[\s\S]*?<\/combat>)/i);
    if (combatM) {
        const attrs = parseAttrs(combatM[1]);
        if (String(attrs.engaged ?? "").toLowerCase() === "true") {
            plan.combat = { engaged: true, speed: Math.max(0, Math.trunc(Number(attrs.speed) || 0)) };
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

    const noteRe = /<note\b([^>]*?)(?:\/>|>([\s\S]*?)<\/note>)/gi;
    while ((m = noteRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        const note = String(a.text || a.content || m[2] || "").trim();
        if (note) plan.notes.push(note);
    }

    const rwM = text.match(/<rewrite\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rewrite>)/i);
    if (rwM) {
        const a = parseAttrs(rwM[1]);
        const rewrite = String(a.text || a.action || rwM[2] || "").trim();
        if (rewrite) plan.rewrite = rewrite;
    }

    const empty = !plan.roll && !plan.combat && !plan.transactions.length && !plan.warnings.length && !plan.relevant.length && !plan.notes.length && !plan.rewrite;
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
        return { roll: null, combat: null, transactions: [], warnings: [], relevant: [], notes: [], rewrite: null, nothing: true };
    }

    const d = stateManager.getData();
    const findShared = name => (d.sharedResources || []).find(
        r => r.name && String(r.name).toLowerCase() === String(name ?? "").toLowerCase()
    );

    // Combat and a plain roll are mutually exclusive: combat takes over the
    // opposed resolution entirely.
    const combat = (parsed.combat && parsed.combat.engaged === true)
        ? { engaged: true, speed: Math.max(0, Math.trunc(Number(parsed.combat.speed) || 0)) }
        : null;

    const roll = (!combat && parsed.roll && parsed.roll.needed === true)
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

    const notes = (Array.isArray(parsed.notes) ? parsed.notes : [])
        .map(n => String(n || "").trim().slice(0, 200))
        .filter(Boolean);

    const rewrite = parsed.rewrite ? String(parsed.rewrite).trim().slice(0, 300) : null;

    const nothing = !roll && !combat && !transactions.length && !warnings.length && !relevant.length && !notes.length && !rewrite;
    return { roll, combat, transactions, warnings, relevant, notes, rewrite, nothing };
}

//

// Builds the system message: the router instructions plus, when the deep
// context setting is on, the card / persona / author's note / activated World
// Info — so the router knows who and where the scene is before judging
// anything in the user message.
async function buildSystemContent(playerAction) {
    const s = extension_settings[extensionName];
    if (!s.deep_context) return SYSTEM_PROMPT;
    const deep = await buildDeepContext(String(playerAction || ""));
    if (!deep) return SYSTEM_PROMPT;
    return `${SYSTEM_PROMPT}\n\nDEEP CONTEXT (card / persona / lore):\n${deep}`;
}

// Runs the pre-pass router for a player action. Returns a sanitized plan, or
// null when disabled/failed (caller falls back to keyword triggers).
export async function runPrePass(playerAction) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.pre_pass) {
        console.info(`[GM DIAG] runPrePass skipped: enabled=${!!s.enabled} pre_pass=${!!s.pre_pass}`);
        return null;
    }
    if (!playerAction) {
        console.info("[GM DIAG] runPrePass skipped: empty player action");
        return null;
    }

    try {
        const st = getContext();
        const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        console.info(`[GM DIAG] runPrePass: calling pre-master profile='${profileId || "<same-as-current>"}'`);
        const messages = [
            { role: "system", content: await buildSystemContent(playerAction) },
            { role: "user", content: await collectContext(playerAction) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        console.info(`[GM DIAG] runPrePass raw reply (${String(reply || "").length} chars):`, String(reply || "").slice(0, 400));
        const plan = sanitizePlan(parseReply(reply || ""));
        if (!plan) {
            console.info("[GM DIAG] runPrePass: malformed reply — caller will fall back to keyword triggers");
            logDebug("prePass: malformed reply — caller will fall back to keyword triggers");
            return null;
        }
        logDebug(`prePass: plan — combat=${!!plan.combat} roll=${!!plan.roll} tx=${plan.transactions.length} warn=${plan.warnings.length} relevant=${plan.relevant.length} notes=${plan.notes.length} rewrite=${!!plan.rewrite} nothing=${plan.nothing}`);
        return plan;
    } catch (e) {
        console.error("[GM DIAG] pre-pass failed (exception):", e);
        return null;
    }
}
