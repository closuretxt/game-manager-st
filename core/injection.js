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
// once by the macro at prompt build time. Anything the macro did not consume
// is discarded at the next pre-turn (discardPending): a roll from an earlier
// turn must never reach a later prompt as if it had just been resolved.
//
// Everything here is gated by the feature_injection setting in the macros.

import { extension_settings } from "../../../../extensions.js";
import { extensionName, CHARACTER_STATES } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { resolveResourceMax } from "./resourceScaler.js";
import { CHARACTER_CONTAINERS } from "./schemas.js";
import { sheetXml } from "./sheetXml.js";
import { scenarioBriefInjection } from "./scenarioBrief.js";

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
    
    queueHigh(`<action_rewrite note="The original message may be vague, contain meta, deterministic narration or contradictory. Dialogue in the original message still stands.">${t}</action_rewrite>`);
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

// Queues a ONE-SHOT high-priority clash override — ONLY when a clash
// resolution actually ran this turn (called from combatEngine). Tells the
// story engine that clash outcomes supersede the skill-use suggestions
// whose actions got interrupted, cancelled or negated by a clash.
export function queueClashOverride() {
    queueHigh(`<clash_override note="This turn's actions were clash-resolved: a clash outcome that interrupts, cancels or negates an action supersedes any <skill_use> in this block — that action fails before it happens, so narrate ONLY the interruption, pay no cost, apply no cooldown, no effect."/>`);
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

// Cache-first: the low-priority block only carries what persists between
// turns, so a prompt prefix that contains it stays byte-identical (and
// cached) until that state actually changes. Everything that changes per turn
// (one-shot readouts, live enemy state) rides in the high-priority macro,
// which sits near the end of the prompt anyway.
function cacheFirst() {
    return extension_settings[extensionName]?.cache_first !== false;
}

// Per-turn context: live enemy state + the pre-pass's one-shot readouts.
// Drains the one-shot queue (recorded for the post-pass as _lastLow).
function buildTurnContext() {
    const d = stateManager.getData();
    const s = extension_settings[extensionName];
    const parts = [];
    // Context-based enemies: compact state summary, only when the feature is
    // on AND enemies exist — zero tokens otherwise.
    if (s.feature_enemies && (d.enemies || []).length) {
        parts.push(`<enemies note="Active enemies in the scene; their state is ground truth.">`);
        for (const e of d.enemies) {
            const res = (e.resources || []).map(r => `${r.name} ${r.value}/${resolveResourceMax(e, r)}`).join(", ");
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
    return parts;
}

// Returns everything queued so far and drains the queue. In cache-first mode
// the per-turn context (enemy state, one-shot readouts) is appended here
// instead of in the low-priority block.
export function consumeHigh() {
    if (!enabled()) return "";
    const turn = cacheFirst() ? buildTurnContext() : [];
    if (_pendingHigh.length === 0 && !turn.length) return "";
    const out = _pendingHigh.join("\n");
    _pendingHigh = [];
    if (out) _lastHigh = out;
    const blocks = [];
    if (out) {
        blocks.push(`<gamemaster_result note="Outcomes just resolved by the game system (dice rolls, transactions, action rewrites, skill uses). Treat as ground truth; narrate accordingly, do not repeat the numbers or the tags themselves. Narrate ONLY the actions and outcomes shown here, never invent extra actions or results that are not explicit, characters not mentioned did not act.">\n${out}\n</gamemaster_result>`);
    }
    if (turn.length) {
        blocks.push(`<gamemaster_turn_context note="Tracked state relevant to this turn only; ground truth the story engine must not recount or track itself.">\n${turn.join("\n")}\n</gamemaster_turn_context>`);
    }
    return blocks.join("\n");
}

export function clearHigh() {
    _pendingHigh = [];
    _stashedHigh.clear();
}

// Drops whatever the previous generation left unconsumed (macro not placed in
// the preset, generation aborted before prompt assembly). Called at the start
// of every pre-turn: without it, stale rolls/transactions piled up turn after
// turn and flooded the first prompt that finally contained the macro. The
// stash is kept — swipes still replay their own turn's payload.
export function discardPending() {
    if (_pendingHigh.length || _pendingLow.length) {
        logDebug(`injection: discarding ${_pendingHigh.length} stale high / ${_pendingLow.length} stale low entries`);
    }
    _pendingHigh = [];
    _pendingLow = [];
}

// ---------- low priority (persistent context) ----------

// Builds the persistent context block: warnings, always-inject entries and
// character states. Ordered deterministically (no insertion-order churn), so
// the block only changes when the underlying state does.
export function buildLowPriority() {
    if (!enabled()) return "";
    const d = stateManager.getData();
    const parts = [];
    const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));

    const brief = scenarioBriefInjection();
    if (brief) parts.push(brief);

    for (const w of [...(d.warnings || [])].sort(byName)) {
        parts.push(`<warning name="${esc(w.name)}">${esc(w.text || "")}</warning>`);
    }

    for (const r of (d.sharedResources || []).filter(x => x.always_inject).sort(byName)) {
        parts.push(`<resource name="${esc(r.name)}" value="${esc(r.qty)}"/>`);
    }
    for (const c of (d.custom || []).filter(x => x.always_inject).sort(byName)) {
        parts.push(`<custom name="${esc(c.name)}" value="${esc(c.value)}"/>`);
    }

    for (const c of d.characters || []) {
        // Characters in a special state: the story engine must respect them
        // (dead = never use again; knocked out = down until recovery, and the
        // scene may ease toward rest or a timeskip).
        const mode = c.state ? CHARACTER_STATES[c.state.mode] : null;
        if (mode) {
            parts.push(`<character name="${esc(c.name)}" status="${mode.status}"${c.state.reason ? ` reason="${esc(c.state.reason)}"` : ""}/>`);
            if (mode.status === "dead") continue;
        }
        // Per-entry "always inject" flags (clothing, a signature stat...).
        if (CHARACTER_CONTAINERS.some(k => (c[k] || []).some(e => e.always_inject))) {
            parts.push(sheetXml(c, { tag: "char", descriptions: false, filter: e => !!e.always_inject }));
        }
    }

    // Legacy layout: per-turn context shares this block (cache-first off).
    if (!cacheFirst()) parts.push(...buildTurnContext());

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

// Whether THIS turn's story prompt contained a resolved combat round
// (<combat_round> queued by combatEngine). The post-pass tracker
// (core/agentRunner.js) uses it to tighten its damage instructions —
// combat turns need sheet-derived, ground-truth accounting.
export function hadCombatThisTurn() {
    return _lastHigh.includes("<combat_round");
}