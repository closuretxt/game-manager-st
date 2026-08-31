// Pre-turn orchestrator: PRE-PASS + SPECIALISTS only.
// Everything here runs inside the awaited GENERATION_AFTER_COMMANDS handler:
//
//   player sends action
//     └─ GENERATION_AFTER_COMMANDS (awaited — prompt assembly waits for us)
//          ├─ PRE-PASS router LLM (core/prePass.js) judges EVERY fresh action
//          │    └─ plan: combat? / roll? / transactions? / warnings? / relevant?
//          └─ specialists execute only the plan's entries
//               ├─ plan.combat      -> opposed combat resolution
//               │                      (core/combatEngine.js: ally AI + enemy AI
//               │                      + clash resolver + per-group dice)
//               ├─ plan.roll        -> dice roll (core/diceRoller.js)
//               ├─ plan.transactions-> transaction (core/transactions.js)
//               ├─ plan.warnings    -> stateManager warnings
//               ├─ plan.relevant    -> one-shot low-priority injection
//               ├─ plan.notes       -> one-shot low-priority notes
//               └─ plan.rewrite     -> highlighted tag on the message +
//                                      high-priority clarified action
//
// Results land in the high-priority buffer BEFORE prompt assembly, so the
// macros (substituted during prompt building, after this handler returns)
// inject them into the SAME turn's story generation.
//
// The agentic tracker pass is NOT here — it runs AFTER the AI reply lands
// (inject/postTurn.js, post-pass contract).
//
// Fallback: when the pre-pass is disabled or fails, the legacy keyword
// detection (detectTriggers) builds a synthetic plan instead.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { rollDice } from "./diceRoller.js";
import { runCombatTurn } from "./combatEngine.js";
import { runTransaction } from "./transactions.js";
import { runPrePass } from "./prePass.js";
import { restoreSnapshot } from "./snapshots.js";
import { queueLowOnce, queueLowNote, queueRewrite, replayHigh, stashHigh, resetInjectionRecord } from "./injection.js";
import { attachRewriteToMessage } from "../ui/rewriteTag.js";
import { statusBubble } from "../ui/statusBubble.js";

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds mentions of tracked names in the action text. Returns the matched
// entries ({ kind, name, entry }).
export function detectTriggers(actionText) {
    const d = stateManager.getData();
    const hits = [];
    if (!actionText) return hits;
    const text = String(actionText);

    for (const char of d.characters || []) {
        for (const skill of char.skills || []) {
            if (!skill.name) continue;
            const re = new RegExp(`\\b${escapeRegex(skill.name)}\\b`, "i");
            if (re.test(text)) hits.push({ kind: "skill", name: skill.name, char });
        }
    }

    for (const res of d.sharedResources || []) {
        if (!res.name) continue;
        const re = new RegExp(`\\b${escapeRegex(res.name)}\\b`, "i");
        if (re.test(text)) hits.push({ kind: "resource", name: res.name, entry: res });
    }

    return hits;
}

let _running = false;

// Some send flows fire GENERATION_AFTER_COMMANDS BEFORE the user's message is
// pushed into chat (last message is still the AI's). inject/preTurn.js captures
// the action at MESSAGE_SENT and parks it here; handlePreTurn consumes it.
let _pendingAction = "";

export function setPendingAction(text) {
    _pendingAction = String(text ?? "").trim();
}

function takePendingAction() {
    const t = _pendingAction;
    _pendingAction = "";
    return t;
}

// Some send flows (custom send buttons, QR/Choices-style extensions) fire
// GENERATION_AFTER_COMMANDS BEFORE the player's message is pushed into chat —
// the typed text is still sitting in the send textarea. NEVER block or poll
// here: the awaited handler would hold the user's input hostage. Just read
// the textarea as a non-blocking fallback.
function readTextareaAction() {
    try {
        return String(document.querySelector("#send_textarea")?.value ?? "").trim();
    } catch {
        return "";
    }
}

// Builds a plan from legacy keyword hits — the fallback when the pre-pass is
// disabled or fails. No delta/comparison: the specialists judge amounts
// themselves, exactly like the old trigger-word flow.
function planFromTriggers(hits) {
    const skills = hits.filter(h => h.kind === "skill");
    const resources = hits.filter(h => h.kind === "resource");
    return {
        roll: skills.length ? { needed: true, title: skills[0].name } : null,
        transactions: resources.map(h => ({ entry: h.entry, delta: 0, comparison: "" })),
        warnings: [],
        relevant: [],
        notes: [],
        rewrite: null,
        nothing: !hits.length,
    };
}

// Called from the awaited GENERATION_AFTER_COMMANDS handler before prompt
// assembly. `type` is the generation type ("normal", "swipe", ...).
export async function handlePreTurn(type = "normal") {
    const s = extension_settings[extensionName];
    if (!s.enabled) return;
    // Fresh per-turn injection record: whatever the macros consume during
    // THIS prompt assembly is what the post-pass tracker will see.
    resetInjectionRecord();
    if (_running) {
        console.info("[GM DIAG] handlePreTurn skipped: already running");
        return;
    }

    const st = getContext();
    const chat = st.chat || [];
    const isPlayerAction = type === "normal";
    const playerMsgId = Math.max(0, chat.length - 1);
    const playerMsg = chat[playerMsgId];

    let action = "";
    let snapshotId;
    let targetMsgId;
    if (isPlayerAction && playerMsg?.is_user) {
        // Usual flow: the user message is already the last chat entry.
        action = String(playerMsg.mes ?? "").trim();
        snapshotId = chat.length; // the AI reply will occupy chat.length
        targetMsgId = playerMsgId;
    } else if (isPlayerAction) {
        // Send flow where the user message is NOT in chat yet — use the
        // MESSAGE_SENT capture, then the send textarea (still holds the typed
        // text in these flows). The message will land at chat.length and the
        // AI reply the one after it.
        action = takePendingAction() || readTextareaAction();
        targetMsgId = chat.length;
        snapshotId = chat.length + 1;
    } else {
        // Swipes/regenerates: the AI message already sits at chat.length - 1.
        snapshotId = Math.max(0, chat.length - 1);
        targetMsgId = playerMsgId;
        // Roll back to the pre-message baseline HERE, inside the awaited
        // handler. The SWIPED event cannot be relied on: it does not fire
        // before a new-swipe generation (and in some ST versions only fires
        // after the reply lands, when restoring would wipe the NEW tracker
        // pass instead of the old one). "continue" is excluded: it extends
        // the existing reply and never re-runs the tracker.
        if (type === "swipe" || type === "regenerate") {
            if (restoreSnapshot(snapshotId)) {
                console.info(`[GM DIAG] handlePreTurn: rolled back state for message ${snapshotId} before swipe/regenerate`);
            } else {
                console.info(`[GM DIAG] handlePreTurn: no baseline to roll back for message ${snapshotId}`);
            }
        }
    }
    console.info(`[GM DIAG] handlePreTurn: type=${type} lastMsg.is_user=${!!playerMsg?.is_user} actionLength=${action.length} snapshotId=${snapshotId} targetMsgId=${targetMsgId}`);

    // Skill cooldowns tick once per fresh player message (never on swipes —
    // the swipe branch above already rolled the state back to the pre-message
    // baseline). Runs BEFORE the pre-pass so its snapshot reflects who is on
    // cooldown right now.
    if (isPlayerAction && type === "normal") {
        stateManager.tickCooldowns();
    }

    // Pre-pass router — every fresh action is judged by the router LLM first
    // (never on swipes, where the action was already judged when first sent).
    // Falls back to legacy keyword detection when disabled or on failure.
    let plan = null;
    if (action) {
        // Live feedback: the story generation waits for the pre-pass, so the
        // screen would otherwise look frozen.
        statusBubble.show(s.pre_pass ? "Judging action..." : "Checking action...");
        plan = await runPrePass(action);
        console.info(`[GM DIAG] pre-pass returned: ${plan ? `roll=${!!plan.roll} tx=${plan.transactions.length} warn=${plan.warnings.length} relevant=${plan.relevant.length} notes=${plan.notes.length} rewrite=${!!plan.rewrite} nothing=${plan.nothing}` : "NULL (fell back to keywords)"}`);
        if (!plan) plan = planFromTriggers(detectTriggers(action));
    }
    // Swipes/regenerates never re-run the pre-pass (the plan was already
    // judged when the action was first sent), but the re-generated prompt
    // still needs THIS turn's results — the previous generation's macro
    // already consumed the high-priority buffer. Re-queue the stashed
    // payload for the message being re-generated.
    if (!isPlayerAction) replayHigh(targetMsgId);

    if (!plan || plan.nothing) {
        console.info("[GM DIAG] plan empty/nothing — no specialists will run");
        statusBubble.done("Nothing to track this turn.");
        return;
    }

    statusBubble.update("Applying...");
    _running = true;
    try {
        // Specialist flows — only on a fresh player action, only for what the
        // plan contains.
        if (action && plan && !plan.nothing) {
            // Combat Mode — the pre-pass judged the action ENGAGES tracked
            // enemies: the opposed resolution (ally AI + enemy AI + clash +
            // dice) replaces the plain dice path entirely. Requires the
            // enemies feature and at least one tracked enemy.
            if (s.feature_combat && plan.combat?.engaged && (stateManager.getData().enemies || []).length) {
                logDebug("pre-turn: combat planned — running opposed resolution");
                statusBubble.close(true); // the combat bubble takes over visually
                await runCombatTurn(action, plan, targetMsgId);
            } else if (s.feature_dice && plan.roll?.needed) {
                // Dice — the pre-pass decided IF, the roller decides HOW.
                logDebug(`pre-turn: roll planned "${plan.roll.title}"`);
                statusBubble.close(true); // the dice bubble takes over visually
                await rollDice(action, targetMsgId, { title: plan.roll.title });
            }

            // Transactions — plan entries carry a pre-judged delta when the
            // router provided one; otherwise the specialist judges the amount.
            // Snapshot keyed to the upcoming AI message so delete/swipe
            // rollback finds it.
            if (s.feature_transactions && plan.transactions.length) {
                for (const tx of plan.transactions) {
                    logDebug(`pre-turn: transaction planned for "${tx.entry.name}"`);
                    statusBubble.update(`Checking ${tx.entry.name}...`);
                    await runTransaction(tx.entry, action, snapshotId, tx);
                }
            }

            // Warnings — set/clear per the plan.
            if (s.feature_warnings && plan.warnings.length) {
                for (const w of plan.warnings) {
                    if (w.action === "clear") stateManager.clearWarning(w.name);
                    else stateManager.setWarning({ name: w.name, text: w.text });
                }
            }

            // Relevant resources — one-shot low-priority injection of values
            // that matter THIS turn (always-inject ones are already persistent;
            // transacted ones are reported by the transaction itself).
            if (s.feature_injection && plan.relevant.length) {
                const transacted = new Set(plan.transactions.map(t => t.entry.id));
                for (const entry of plan.relevant) {
                    if (entry.always_inject || transacted.has(entry.id)) continue;
                    queueLowOnce(`  <resource name="${entry.name}" value="${entry.qty}"/>`);
                }
            }

            // Notes — free-form contextual remarks the pre-pass judged worth
            // injecting this turn (relevance-gated world info). One-shot,
            // low priority, XML-escaped by the queue.
            if (s.feature_injection && plan.notes?.length) {
                for (const note of plan.notes) {
                    logDebug(`pre-turn: note queued "${note}"`);
                    queueLowNote(note);
                }
            }

            // Rewrite — the pre-pass clarified a vague/contradictory action.
            // The clarified action is appended to the message text as
            // "original -- rewrite" (with a highlighted tag) and injected
            // high-priority so the story engine acts on the clarified
            // intent this turn.
            if (s.feature_rewrite && plan.rewrite) {
                logDebug(`pre-turn: rewrite planned "${plan.rewrite}"`);
                statusBubble.update("Clarifying action...");
                attachRewriteToMessage(targetMsgId, plan.rewrite);
                queueRewrite(plan.rewrite);
            }
        }
    } catch (e) {
        console.error("[Game Manager] pre-turn handling failed:", e);
    } finally {
        _running = false;
        // Keep this turn's queued results for swipes/regenerates of the
        // upcoming AI message (keyed by its id) — replayHigh re-queues them.
        stashHigh(snapshotId);
        statusBubble.done("All set.");
    }
}