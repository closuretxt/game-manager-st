// Per-turn persistence on chat message objects.
//
// Pre-master results (the pre-pass router's raw output, the resolved dice
// roll) are stored on the triggering USER message, so they are saved with the
// chat itself: they survive page reloads and chat switches, and swipes replay
// them verbatim instead of re-running the engines on identical state.
//
// Some send flows fire GENERATION_AFTER_COMMANDS BEFORE the user's message
// lands in chat, so the first write misses its target. Every store therefore
// retries non-blocking until the message appears (or the timeout expires) —
// the result is still saved on the FIRST send, so the first swipe replays it
// instead of re-rolling.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

const RETRY_INTERVAL_MS = 250;
const RETRY_TIMEOUT_MS = 20000;

// The most recent user message. When `action` is given, only a message whose
// text matches it qualifies — guards against parked/stale actions from send
// flows that fire before the message lands. Both sides are TRIMMED before
// comparing: the pipeline normalizes actions with .trim() (handlePreTurn,
// recoverSwipePlan) while m.mes keeps the raw sent text, so an exact compare
// silently dropped the store whenever the message carried leading/trailing
// whitespace — gm_prepass/gm_roll never persisted and swipes re-judged.
export function findActionMessage(action = null) {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m?.is_user) continue;
        if (action == null || String(m.mes ?? "").trim() === String(action).trim()) return m;
        break;
    }
    return null;
}

// Best-effort chat save after a late (retried) write — ST's own end-of-turn
// save may already have run by the time the message lands.
function saveChatBestEffort() {
    try {
        getContext()?.saveChat();
    } catch { /* best effort */ }
}

// Non-blocking retry until `tryWrite()` succeeds or the timeout expires.
// Covers send flows where the message lands in chat AFTER the pre-turn pass
// ran. Fire-and-forget: persistence is best-effort, never blocking.
function retryUntil(tryWrite, label) {
    const started = Date.now();
    const timer = setInterval(() => {
        let ok = false;
        try {
            ok = tryWrite();
        } catch { /* keep retrying */ }
        if (ok) {
            clearInterval(timer);
            saveChatBestEffort();
            logDebug(`chatStore: ${label} persisted on retry (message landed)`);
            return;
        }
        if (Date.now() - started > RETRY_TIMEOUT_MS) {
            clearInterval(timer);
            console.warn(`[Game Manager] chatStore: ${label} not persisted after ${RETRY_TIMEOUT_MS / 1000}s`);
        }
    }, RETRY_INTERVAL_MS);
}

// Writes `value` under `key` on the message matching `action`. Returns true
// when written immediately; on a miss it schedules a non-blocking retry and
// returns false (failures are logged and swallowed). A successful write saves
// the chat: the pre-turn runs BEFORE ST's end-of-generation save, and an
// interrupted generation would otherwise leave the record memory-only — gone
// on reload, so swipes re-judge instead of reusing.
export function storeActionData(action, key, value) {
    try {
        const m = findActionMessage(action);
        if (m) {
            m[key] = value;
            saveChatBestEffort();
            return true;
        }
    } catch (e) {
        logDebug(`chatStore: failed to store ${key}:`, e?.message || e);
    }
    if (action == null) return false;
    retryUntil(() => {
        const m = findActionMessage(action);
        if (!m) return false;
        m[key] = value;
        return true;
    }, key);
    return false;
}

// Writes `value` under `key` on the chat message at `mesId` — the visual
// attachment records (gm_roll, gm_combat, gm_rewrite) are keyed by position,
// not by text. Same retry contract as storeActionData.
export function storeMessageData(mesId, key, value) {
    const id = Number(mesId);
    if (!Number.isFinite(id)) return false;
    const write = () => {
        const m = getContext()?.chat?.[id];
        if (!m) return false;
        m[key] = value;
        return true;
    };
    try {
        if (write()) {
            saveChatBestEffort();
            return true;
        }
    } catch (e) {
        logDebug(`chatStore: failed to store ${key}:`, e?.message || e);
    }
    retryUntil(write, key);
    return false;
}
