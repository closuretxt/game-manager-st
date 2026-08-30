// Per-message state snapshots, stored in the chat metadata alongside the game
// state (chatMetadata.game_manager.snapshots). Before an agentic pass applies
// changes to message N, the pre-change state is snapshotted under N. Deleting
// that message, swiping it, or re-running the pass rolls the state back.
// Only the last MAX_SNAPSHOTS messages are kept to avoid bloating chat data.

import { getContext } from "../../../../extensions.js";
import { stateManager } from "./stateManager.js";
import { logDebug } from "./debug.js";

export const MAX_SNAPSHOTS = 5;

function store() {
    const st = getContext();
    if (!st?.chatMetadata) return null;
    const gm = (st.chatMetadata.game_manager = st.chatMetadata.game_manager || {});
    gm.snapshots = gm.snapshots || {};
    return gm;
}

function persist() {
    try {
        getContext().saveMetadata();
    } catch (e) {
        console.error("[Game Manager] snapshot saveMetadata failed:", e);
    }
}

function trim(gm) {
    const entries = Object.entries(gm.snapshots).sort((a, b) => a[1].ts - b[1].ts);
    while (entries.length > MAX_SNAPSHOTS) {
        const [oldest] = entries.shift();
        delete gm.snapshots[oldest];
    }
}

export function hasSnapshot(mesId) {
    const gm = store();
    return !!gm && !!gm.snapshots[String(mesId)];
}

// Captures the current state as the baseline for a message. Keeps the ORIGINAL
// baseline if one already exists (so re-running/swiping always rolls back to
// the state before that message's first applied changes). An optional
// `messageText` is stored alongside (used by the dice flow so a swipe/delete
// can also restore the pre-roll message text).
export function captureSnapshot(mesId, { messageText = null } = {}) {
    if (mesId === null || mesId === undefined) return false;
    const gm = store();
    if (!gm) return false;
    const key = String(mesId);
    if (gm.snapshots[key]) {
        logDebug(`snapshot: baseline for message ${key} already exists, keeping it`);
        return false;
    }
    gm.snapshots[key] = {
        ts: Date.now(),
        state: structuredClone(stateManager.getData()),
        messageText: messageText ?? null,
    };
    trim(gm);
    persist();
    logDebug(`snapshot: captured baseline for message ${key}`);
    return true;
}

// Rolls the live state back to the baseline of a message and drops that
// baseline. Also restores the pre-roll message text if one was stored (dice
// rolls append to the player's message). Returns true if a restore happened.
export function restoreSnapshot(mesId) {
    const st = getContext();
    const gm = store();
    if (!gm) return false;
    const key = String(mesId);
    const snap = gm.snapshots[key];
    if (!snap) {
        console.info(`[GM DIAG] restoreSnapshot: no snapshot for message ${key} (have keys=[${Object.keys(gm.snapshots)}])`);
        return false;
    }
    stateManager.replaceData(snap.state);

    if (typeof snap.messageText === "string") {
        const msg = st?.chat?.[Number(key)];
        if (msg && typeof msg.mes === "string" && msg.mes !== snap.messageText) {
            msg.mes = snap.messageText;
            try {
                st.saveChat();
            } catch { /* best effort */ }
        }
    }

    delete gm.snapshots[key];
    persist();
    logDebug(`snapshot: restored state from message ${key}`);
    return true;
}

export function discardSnapshot(mesId) {
    const gm = store();
    if (!gm || !gm.snapshots[String(mesId)]) return false;
    delete gm.snapshots[String(mesId)];
    persist();
    return true;
}

// MESSAGE_DELETED does not report which message was removed. The common case
// is deleting the last AI message, which occupied index `chat.length` after
// removal — fall back to the newest snapshot at or above that index (covers
// middle deletions shifting ids as well).
export function restoreLastDeleted() {
    const st = getContext();
    const gm = store();
    if (!gm) return false;
    const ids = Object.keys(gm.snapshots)
        .map(Number)
        .sort((a, b) => b - a);
    const target = ids.find(id => id >= st.chat.length);
    if (target === undefined) return false;
    return restoreSnapshot(target);
}