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
//               │                      (skill names resolve to cooldown state)
//               ├─ plan.notes       -> one-shot low-priority notes
//               ├─ plan.skills      -> high-priority skill-use suggestion
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
import { rollDice, requeueRollResult } from "./diceRoller.js";
import { runCombatTurn, requeueCombatRound } from "./combatEngine.js";
import { runTransaction } from "./transactions.js";
import { runPrePass, planFromRaw } from "./prePass.js";
import { restoreSnapshot } from "./snapshots.js";
import { attachRollToMessage } from "../ui/diceBubble.js";
import { attachCombatToMessage } from "../ui/combatBubble.js";
import { queueLowOnce, queueLowNote, queueRewrite, queueSkillUse, replayHigh, stashHigh, resetInjectionRecord } from "./injection.js";
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
// Timestamped: in flows where MESSAGE_SENT fires AFTER the turn already ran,
// the capture lands too late for its own turn and must never be judged as the
// NEXT action.
let _pendingAction = "";
let _pendingActionTs = 0;
const PENDING_MAX_AGE_MS = 60_000; // GAC fires right after send; older = leftover

export function setPendingAction(text) {
    _pendingAction = String(text ?? "").trim();
    _pendingActionTs = Date.now();
}

function takePendingAction() {
    const fresh = (Date.now() - _pendingActionTs) <= PENDING_MAX_AGE_MS;
    const t = fresh ? _pendingAction : "";
    _pendingAction = "";
    _pendingActionTs = 0;
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
        skills: [],
        rewrite: null,
        nothing: !hits.length,
    };
}

// Swipe/regenerate recovery for a missing stash (page reload, chat switch,
// or the original turn never stashed). The roll result stored on the action
// message (gm_roll) is REPLAYED verbatim — swiping never re-rolls: the odds
// were decided once for this action against this exact state. The plan is
// rebuilt from the persisted pre-pass output (gm_prepass on the user message)
// WITHOUT a new router call — the action was already judged once, and a swipe
// must not throw a redundant API call at it (including a <nothing/> judgment:
// reused as-is, no specialists run). Only when nothing was persisted (turn
// predates the persistence or the store failed) does the router re-judge the
// ORIGINAL player action. Returns { plan, action, reused } or null.
async function recoverSwipePlan(targetMsgId) {
    const s = extension_settings[extensionName];
    const st = getContext();
    const userMsgId = targetMsgId - 1; // the action the AI reply answers to
    const prev = st.chat?.[userMsgId];
    const action = prev?.is_user ? String(prev.mes ?? "").trim() : "";
    if (!action) return null;

    // Same roll as the first generation — re-attach the chip and re-queue the
    // result for the prompt; the plan's roll demand is stripped downstream.
    let rollReplayed = false;
    if (s.feature_dice && prev.gm_roll?.title && prev.gm_roll?.tier?.name) {
        const stored = prev.gm_roll;
        console.info(`[GM DIAG] recoverSwipePlan: replaying stored roll "${stored.title}" -> ${stored.tier.name}`);
        attachRollToMessage(userMsgId, stored.title, stored.tier);
        requeueRollResult(stored.title, stored.tier);
        rollReplayed = true;
    }

    // Same combat round as the first generation — same contract as rolls:
    // re-attach the chips and re-queue the round; a swipe never re-runs the
    // opposed resolution (no ally/enemy/clash API calls).
    let combatReplayed = false;
    if (s.feature_combat && Array.isArray(prev.gm_combat?.groups) && prev.gm_combat.groups.length) {
        console.info(`[GM DIAG] recoverSwipePlan: replaying stored combat round (${prev.gm_combat.groups.length} group(s))`);
        attachCombatToMessage(userMsgId, prev.gm_combat.groups, prev.gm_combat.winners);
        requeueCombatRound(prev.gm_combat);
        combatReplayed = true;
    }

    // Fast path: reuse the persisted pre-pass judgment — zero API calls.
    const storedRaw = prev.gm_prepass ? String(prev.gm_prepass) : "";
    if (storedRaw) {
        console.info(`[GM DIAG] recoverSwipePlan: stash missed — reusing persisted pre-pass (${storedRaw.length} chars) for message ${targetMsgId} — no router call`);
        const plan = planFromRaw(storedRaw);
        if (!plan || plan.nothing) return { plan: null, action, reused: true };
        if (rollReplayed) plan.roll = null; // the outcome already exists — never re-roll
        if (combatReplayed) plan.combat = null; // the round already exists — never re-resolve
        return { plan, action, reused: true };
    }

    // Nothing persisted for this action — the only case that pays for a call.
    console.info(`[GM DIAG] recoverSwipePlan: no persisted pre-pass for message ${targetMsgId} — re-judging original action`);
    statusBubble.show(s.pre_pass ? "Judging action..." : "Checking action...");
    const plan = await runPrePass(action);
    if (!plan || plan.nothing) return { plan: null, action, reused: false };
    if (rollReplayed) plan.roll = null; // the outcome already exists — never re-roll
    if (combatReplayed) plan.combat = null; // the round already exists — never re-resolve
    return { plan, action, reused: false };
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
    if (isPlayerAction) {
        // Player action sources, freshest first: the send textarea (custom
        // send flows fire this handler BEFORE the message lands in chat — the
        // typed text is still in the bar), then the chat message (stock flow,
        // bar already cleared), then the MESSAGE_SENT capture (flows that
        // clear the bar early; timestamped so a leftover from a previous turn
        // is never judged).
        action = readTextareaAction()
            || (playerMsg?.is_user ? String(playerMsg.mes ?? "").trim() : "")
            || takePendingAction();
        if (playerMsg?.is_user) {
            // Stock flow: the user message is already the last chat entry and
            // the AI reply will occupy chat.length.
            snapshotId = chat.length;
            targetMsgId = playerMsgId;
        } else {
            // The message will land at chat.length and the AI reply the one
            // after it.
            targetMsgId = chat.length;
            snapshotId = chat.length + 1;
        }
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
    console.info(`[GM DIAG] handlePreTurn: type=${type} lastMsg.is_user=${!!playerMsg?.is_user} actionLength=${action.length} snapshotId=${snapshotId} targetMsgId=${targetMsgId} action="${action.slice(0, 80)}"`);

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
        console.info(`[GM DIAG] pre-pass returned: ${plan ? `roll=${!!plan.roll} tx=${plan.transactions.length} warn=${plan.warnings.length} relevant=${plan.relevant.length} notes=${plan.notes.length} skills=${plan.skills.length} rewrite=${!!plan.rewrite} nothing=${plan.nothing}` : "NULL (fell back to keywords)"}`);
        if (!plan) plan = planFromTriggers(detectTriggers(action));
    }
    // Swipes/regenerates never re-run the pre-pass while the stash holds the
    // original turn's results (the previous generation's macro already
    // consumed the live buffers — replayHigh re-queues the stashed payload).
    // When the stash is gone (page reload, chat switch, or the original turn
    // never stashed), rebuild the plan from the persisted pre-pass output on
    // the user message — zero API calls. Only when nothing was persisted does
    // the router re-judge the ORIGINAL player action.
    let reusedSwipe = false;
    if (!isPlayerAction) {
        if (!replayHigh(targetMsgId)) {
            const recovered = await recoverSwipePlan(targetMsgId);
            if (recovered) {
                plan = recovered.plan;
                reusedSwipe = !!recovered.reused;
                // Execute the recovered plan like a fresh action — the
                // specialist block below is gated on `action`, which is
                // empty on swipes without this.
                action = recovered.action;
                console.info(`[GM DIAG] handlePreTurn: swipe recovered action (${action.length} chars) reused=${reusedSwipe} — specialists will run`);
            }
        }
    }

    if (!plan || plan.nothing) {
        console.info("[GM DIAG] plan empty/nothing — no specialists will run");
        statusBubble.done(reusedSwipe ? "Reused previous results." : "Nothing to track this turn.");
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
                // The dice GM reads the router's full persisted output from
                // the user's message (gm_prepass) — no payload passing needed.
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

            // Relevant values — one-shot low-priority injection of values that
            // matter THIS turn. Shared entries ({ entry }) skip always-inject
            // ones (already persistent) and transacted ones (reported by the
            // transaction itself); character entries ({ character, name,
            // value }) are that character's own stats/resources.
            if (s.feature_injection && plan.relevant.length) {
                const transacted = new Set(plan.transactions.map(t => t.entry.id));
                for (const rel of plan.relevant) {
                    if (rel.entry) {
                        if (rel.entry.always_inject || transacted.has(rel.entry.id)) continue;
                        queueLowOnce(`<resource name="${rel.entry.name}" value="${rel.entry.qty}"/>`);
                    } else if (rel.skill) {
                        // Skill cooldown state (turns 0 = ready) — relevance-gated
                        // by the pre-pass so the story engine never hallucinates a use.
                        if (rel.cooldown > 0) {
                            logDebug(`pre-turn: skill cooldown queued "${rel.character}.${rel.name}" (${rel.cooldown} left)`);
                            queueLowOnce(`<skill_cooldown character="${rel.character}" skill="${rel.name}" turns="${rel.cooldown}"/>`);
                        } else {
                            logDebug(`pre-turn: skill ready queued "${rel.character}.${rel.name}"`);
                            queueLowOnce(`<skill_ready character="${rel.character}" skill="${rel.name}"/>`);
                        }
                    } else {
                        logDebug(`pre-turn: character stat queued "${rel.character}.${rel.name}" = ${rel.value}`);
                        queueLowOnce(`<character_stat character="${rel.character}" name="${rel.name}" value="${rel.value}"/>`);
                    }
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
                // Fresh actions target the user message directly; on a
                // swipe/regenerate targetMsgId is the AI reply — the tag
                // belongs on the action it clarifies (targetMsgId - 1).
                attachRewriteToMessage(isPlayerAction ? targetMsgId : targetMsgId - 1, plan.rewrite);
                queueRewrite(plan.rewrite);
            }

            // Skill suggestions — the pre-pass proposed a tracked skill that
            // fits the action (ally-AI-style autonomy, outside combat).
            // High-priority so the story engine narrates the use; the cooldown
            // itself is still applied by the post-pass <use_skills> report.
            if (s.feature_skill_suggest && plan.skills?.length) {
                for (const sk of plan.skills) {
                    logDebug(`pre-turn: skill suggested "${sk.char}" -> "${sk.name}"`);
                    queueSkillUse(sk.char, sk.name, sk.cost);
                }
            }
        }
    } catch (e) {
        console.error("[Game Manager] pre-turn handling failed:", e);
    } finally {
        _running = false;
        // Never let a parked action capture outlive its turn: a leftover here
        // would be judged as the player's NEXT action when a send flow fires
        // GENERATION_AFTER_COMMANDS before the message lands in chat.
        _pendingAction = "";
        // Keep this turn's queued results for swipes/regenerates of the
        // upcoming AI message (keyed by its id) — replayHigh re-queues them.
        stashHigh(snapshotId);
        statusBubble.done(reusedSwipe ? "Reused previous results." : "All set.");
    }
}