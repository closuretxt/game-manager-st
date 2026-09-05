// Injection core — builds the minimal XML context blocks exposed through the
// {{gamemaster-low-priority}} and {{gamemaster-high-priority}} macros.
//
// Low priority (persistent context, non-immediate): active warnings and the
// values of shared resources flagged "always inject". Rendered only when
// something actually exists — an empty buffer returns "" so unused macros
// cost zero tokens ("only inject when relevant").
//
// High priority (immediate, one-shot): pending roll results, transaction
// reports and skill-use suggestions queued by the pre-master flows. Consumed
// once by the macro at prompt build time; if the macro is not placed in the
// prompt the buffer is re-emitted until consumed, so a result is never
// silently lost.
//
// Everything here is gated by the feature_injection setting in the macros.

import { extension_settings } from "../../../../extensions.js";
import { extensionName, CHARACTER_STATES } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";

let _pendingHigh = [];
let _pendingLow = [];

// Record of what the macros actually injected into THIS turn's story prompt:
// the drained high-priority payload and the one-shot low-priority lines. The
// post-pass tracker reads it (getLastInjections) so its LLM sees the same
// ground-truth results the story engine saw — raw chat text alone never
// contains the roll numbers or transaction outcomes. Reset per generation by
// resetInjectionRecord (called from handlePreTurn), so a turn where the macro
// was not placed (or nothing was queued) never leaks the previous turn's data.
let _lastHigh = "";
let _lastLow = "";

// Previous generation's record, preserved when resetInjectionRecord clears
// the current one. Exposed to the pre-master engines (dice roller) so they
// judge the action knowing what the game system injected LAST turn.
let _prevHigh = "";
let _prevLow = "";

function enabled() {
    const s = extension_settings[extensionName];
    return !!(s.enabled && s.feature_injection);
}

function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------- high priority (one-shot queue) ----------

// Queues an immediate report (roll result / transaction / rewrite / skill
// suggestion) for the next prompt.
export function queueHigh(xmlBlock) {
    if (!xmlBlock) return;
    _pendingHigh.push(xmlBlock);
}

// Stash of this turn's queued payloads, keyed by the id of the AI message it
// belongs to. Swipes/regenerates never re-run the pre-pass, and the previous
// generation's macros already consumed both buffers — so the re-generated
// prompt would lose the roll / combat round / transaction results AND the
// one-shot low-priority lines (relevant resource values, character stats,
// notes). stashHigh keeps both; replayHigh re-queues them.
// NOTE: stashHigh runs in handlePreTurn's finally — BEFORE prompt assembly —
// so _pendingLow still holds this turn's one-shot lines at stash time (the
// macro drains them only when the prompt is built).
const _stashedHigh = new Map();
const STASH_LIMIT = 10;

export function stashHigh(mesId) {
    const id = Number(mesId);
    if (!Number.isFinite(id)) return;
    const high = _pendingHigh.join("\n");
    const low = _pendingLow.join("\n");
    if (!high && !low) return;
    _stashedHigh.set(id, { high, low });
    for (const k of _stashedHigh.keys()) {
        if (k < id - STASH_LIMIT) _stashedHigh.delete(k);
    }
    console.info(`[GM DIAG] stashHigh: key=${id} highChars=${high.length} lowChars=${low.length} keys=[${[..._stashedHigh.keys()]}]`);
}

export function replayHigh(mesId) {
    const stored = _stashedHigh.get(Number(mesId));
    if (!stored) {
        console.info(`[GM DIAG] replayHigh: MISS for message ${mesId} (stashed keys=[${[..._stashedHigh.keys()]}])`);
        return false; // caller decides the fallback (swipe recovery)
    }
    logDebug(`injection: replaying stashed results for message ${mesId} (swipe/regenerate)`);
    console.info(`[GM DIAG] replayHigh: HIT for message ${mesId} (high=${stored.high.length} chars, low=${stored.low.length} chars re-queued)`);
    if (stored.high) _pendingHigh.push(stored.high);
    if (stored.low) {
        // One-shot low-priority lines were drained by the previous
        // generation's macro — re-queue them verbatim for this one.
        _pendingLow.push(...stored.low.split("\n").filter(Boolean));
    }
    return true;
}

// Queues a ONE-SHOT high-priority action rewrite produced by the pre-pass.
// XML-escaped on queue.
export function queueRewrite(text) {
    const t = esc(String(text ?? "").trim());
    if (!t) return;
    // No indentation: LLMs read tags sequentially, alignment just wastes tokens
    queueHigh(`<action_rewrite note="The player's clarified intent for this turn; the original message may be vague or contradictory. Dialogue in the original message still stands.">${t}</action_rewrite>`);
}

// Queues a ONE-SHOT high-priority skill suggestion produced by the pre-pass:
// the story engine should narrate the character using the skill this turn.
// The cooldown itself is NOT applied here — the post-pass <use_skills> report
// stays the only cooldown writer. XML-escaped on queue.
export function queueSkillUse(character, skill, cost = "") {
    const c = esc(String(character ?? "").trim());
    const sk = esc(String(skill ?? "").trim());
    const co = esc(String(cost ?? "").trim());
    if (!c || !sk) return;
    const costNote = co ? ` Its cost (${co}) must be narrated as paid — resource, stat or narrative, exactly as the skill describes.` : "";
    queueHigh(`<skill_use character="${c}" skill="${sk}" note="The game system judged this tracked skill to fit the player's action; narrate the character using it.${costNote} Its cooldown is applied by the tracker afterwards."/>`);
}

// Queues a ONE-SHOT low-priority line (e.g. a shared resource value the
// pre-pass flagged as relevant this turn). Rendered by the next low-priority
// build, then dropped — unlike always-inject values, it does not persist.
export function queueLowOnce(line) {
    if (!line || !enabled()) return;
    _pendingLow.push(line);
}

// Queues a ONE-SHOT low-priority note: a free-form contextual remark the
// pre-pass judged relevant this turn (relevance-gated world info). Rendered
// inside the low-priority block, then dropped. XML-escaped on queue.
export function queueLowNote(text) {
    const t = esc(String(text ?? "").trim());
    if (!t) return;
    queueLowOnce(`<note>${t}</note>`);
}

export function clearLow() {
    _pendingLow = [];
}

// Returns everything queued so far and drains the queue.
export function consumeHigh() {
    if (!enabled() || _pendingHigh.length === 0) return "";
    const out = _pendingHigh.join("\n");
    _pendingHigh = [];
    _lastHigh = out;
    return `<gamemaster_result note="Outcomes just resolved by the game system (dice rolls, transactions, action rewrites, skill uses). Treat as ground truth; narrate accordingly, do not repeat the numbers or the tags themselves.">\n${out}\n</gamemaster_result>`;
}

export function clearHigh() {
    _pendingHigh = [];
    _stashedHigh.clear();
}

// ---------- low priority (persistent context) ----------

// Builds the persistent context block: warnings + always-inject shared values.
export function buildLowPriority() {
    if (!enabled()) return "";
    const d = stateManager.getData();
    const parts = [];

    for (const w of d.warnings || []) {
        parts.push(`<warning name="${esc(w.name)}">${esc(w.text || "")}</warning>`);
    }

    for (const r of d.sharedResources || []) {
        if (r.always_inject) {
            parts.push(`<resource name="${esc(r.name)}" value="${esc(r.qty)}"/>`);
        }
    }

    // Characters in a special state: the story engine must respect them
    // (dead = never use again; knocked out = down until recovery, and the
    // scene may ease toward rest or a timeskip).
    for (const c of d.characters || []) {
        const mode = c.state ? CHARACTER_STATES[c.state.mode] : null;
        if (!mode) continue;
        parts.push(`<character name="${esc(c.name)}" status="${mode.status}"${c.state.reason ? ` reason="${esc(c.state.reason)}"` : ""}/>`);
    }

    // Context-based enemies: compact state summary, only when the feature is
    // on AND enemies exist — zero tokens otherwise.
    const s = extension_settings[extensionName];
    if (s.feature_enemies && (d.enemies || []).length) {
        parts.push(`<enemies note="Active enemies in the scene; their state is ground truth.">`);
        for (const e of d.enemies) {
            const res = (e.resources || []).map(r => `${r.name} ${r.value}/${r.max}`).join(", ");
            const st = (e.statuses || []).map(x => x.name).join(", ");
            const state = [res, st].filter(Boolean).join("; ");
            parts.push(`<enemy name="${esc(e.name)}"${state ? ` state="${esc(state)}"` : ""}/>`);
        }
        parts.push(`</enemies>`);
    }

    // One-shot lines queued by the pre-pass for THIS turn only.
    if (_pendingLow.length) {
        const oneShot = _pendingLow.splice(0, _pendingLow.length);
        _lastLow = oneShot.join("\n");
        parts.push(...oneShot);
    }

    if (!parts.length) return "";
    return `<gamemaster_context note="Ground-truth tracked state the story engine must not recount or track itself; warnings describe imminent needs.">\n${parts.join("\n")}\n</gamemaster_context>`;
}

// ---------- post-pass visibility ----------

// Clears the per-turn injection record. Called at the start of every
// generation (handlePreTurn), before prompt assembly — so the record always
// describes exactly what THIS generation's macros injected, even when the
// macro is missing from the prompt or nothing was queued.
export function resetInjectionRecord() {
    // What was injected last generation becomes the "previous GM notes"
    // before the per-turn record is cleared.
    _prevHigh = _lastHigh;
    _prevLow = _lastLow;
    _lastHigh = "";
    _lastLow = "";
}

// What the macros injected into the PREVIOUS turn's story prompt (one-shot
// notes, roll results, transactions). Empty when nothing was injected.
export function getPreviousInjections() {
    if (!_prevHigh && !_prevLow) return "";
    const parts = [];
    if (_prevHigh) parts.push(_prevHigh);
    if (_prevLow) parts.push(_prevLow);
    return parts.join("\n");
}

// What the macros injected into this turn's story prompt, as one XML block.
// Empty when nothing was injected this turn. Consumed by the post-pass
// tracker (core/agentRunner.js) so it judges the exchange with the same
// ground-truth results (dice, transactions, rewrites, one-shot notes) the
// story engine saw.
export function getLastInjections() {
    if (!_lastHigh && !_lastLow) return "";
    const parts = [];
    if (_lastHigh) parts.push(_lastHigh);
    if (_lastLow) parts.push(_lastLow);
    return `<gamemaster_injections note="Results and context the game system injected into this turn's story prompt (dice rolls, transactions, action rewrites, one-shot notes). Treat as ground truth when reading the exchange.">\n${parts.join("\n")}\n</gamemaster_injections>`;
}