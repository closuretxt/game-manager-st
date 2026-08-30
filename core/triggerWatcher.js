// Pre-turn orchestrator: PRE-PASS + SPECIALISTS only.
// Everything here runs inside the awaited GENERATION_AFTER_COMMANDS handler:
//
//   player sends action
//     └─ GENERATION_AFTER_COMMANDS (awaited — prompt assembly waits for us)
//          ├─ PRE-PASS router LLM (core/prePass.js) judges EVERY fresh action
//          │    └─ plan: roll? / transactions? / warnings? / relevant values?
//          └─ specialists execute only the plan's entries
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
import { runTransaction } from "./transactions.js";
import { runPrePass } from "./prePass.js";
import { queueLowOnce, queueLowNote, queueRewrite } from "./injection.js";
import { attachRewriteToMessage } from "../ui/rewriteTag.js";

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
    if (_running) {
        logDebug("pre-turn skipped — already running");
        return;
    }

    const st = getContext();
    const chat = st.chat || [];
    const isPlayerAction = type === "normal";
    const playerMsgId = Math.max(0, chat.length - 1);
    const playerMsg = chat[playerMsgId];
    const action = (isPlayerAction && playerMsg?.is_user) ? String(playerMsg.mes ?? "").trim() : "";

    // Snapshot key: on a fresh send the AI reply will occupy chat.length, so
    // snapshots keyed there are found by the delete/swipe rollback logic.
    // On swipes/regenerates the AI message already sits at chat.length - 1.
    const snapshotId = isPlayerAction ? chat.length : Math.max(0, chat.length - 1);

    // Pre-pass router — every fresh action is judged by the router LLM first
    // (never on swipes, where the action was already judged when first sent).
    // Falls back to legacy keyword detection when disabled or on failure.
    let plan = null;
    if (action) {
        plan = await runPrePass(action);
        if (!plan) plan = planFromTriggers(detectTriggers(action));
    }
    if (!plan || plan.nothing) return;

    _running = true;
    try {
        // Specialist flows — only on a fresh player action, only for what the
        // plan contains.
        if (action && plan && !plan.nothing) {
            // Dice — the pre-pass decided IF, the roller decides HOW.
            if (s.feature_dice && plan.roll?.needed) {
                logDebug(`pre-turn: roll planned "${plan.roll.title}"`);
                await rollDice(action, playerMsgId, { title: plan.roll.title });
            }

            // Transactions — plan entries carry a pre-judged delta when the
            // router provided one; otherwise the specialist judges the amount.
            // Snapshot keyed to the upcoming AI message so delete/swipe
            // rollback finds it.
            if (s.feature_transactions && plan.transactions.length) {
                for (const tx of plan.transactions) {
                    logDebug(`pre-turn: transaction planned for "${tx.entry.name}"`);
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
            // The original message text is NEVER edited: the rewrite is
            // rendered as a highlighted tag on the message (DOM-only) and
            // injected high-priority so the story engine acts on the
            // clarified intent this turn.
            if (s.feature_rewrite && plan.rewrite) {
                logDebug(`pre-turn: rewrite planned "${plan.rewrite}"`);
                attachRewriteToMessage(playerMsgId, plan.rewrite);
                queueRewrite(plan.rewrite);
            }
        }
    } catch (e) {
        console.error("[Game Manager] pre-turn handling failed:", e);
    } finally {
        _running = false;
    }
}