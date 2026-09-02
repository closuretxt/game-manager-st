// Per-turn persistence on chat message objects.
//
// Pre-master results (the pre-pass router's raw output, the resolved dice
// roll) are stored on the triggering USER message, so they are saved with the
// chat itself: they survive page reloads and chat switches, and swipes replay
// them verbatim instead of re-running the engines on identical state.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

// The most recent user message. When `action` is given, only a message whose
// text matches it exactly qualifies — guards against parked/stale actions
// from send flows that fire before the message lands.
export function findActionMessage(action = null) {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m?.is_user) continue;
        if (action == null || String(m.mes ?? "") === String(action)) return m;
        break;
    }
    return null;
}

// Writes `value` under `key` on the message matching `action`. Returns true
// on success; failures are logged and swallowed (persistence is best-effort).
export function storeActionData(action, key, value) {
    try {
        const m = findActionMessage(action);
        if (!m) return false;
        m[key] = value;
        return true;
    } catch (e) {
        logDebug(`chatStore: failed to store ${key}:`, e?.message || e);
        return false;
    }
}
