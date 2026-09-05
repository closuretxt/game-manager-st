// Per-message state snapshots, stored in the chat metadata alongside the game
// state (chatMetadata.game_manager.snapshots). Before an agentic pass applies
// changes to message N, the pre-change state is snapshotted under N. Deleting
// that message, swiping it, or re-running the pass rolls the state back.
// Only the last MAX_SNAPSHOTS MESSAGES are kept (the limit is messages deep,
// not entries) to avoid bloating chat data.
//
// Swipe versions: every swipe of message N gets its own recorded post-pass
// state (entry.versions[swipeId]), so navigating between swipe versions of
// the last message restores exactly the tracker state that version produced.

import { getContext } from "../../../../extensions.js";
import { stateManager } from "./stateManager.js";
import { logDebug } from "./debug.js";

export const MAX_SNAPSHOTS = 5;

// Swipe versions kept per message (the newest wins).
const MAX_SWIPE_VERSIONS = 10;

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
    if (gm.snapshots[key]?.state) {
        logDebug(`snapshot: baseline for message ${key} already exists, keeping it`);
        return false;
    }
    // Fresh baseline — either a first capture or a re-capture after a
    // rollback consumed the previous one (per-swipe versions survive).
    gm.snapshots[key] = {
        ts: Date.now(),
        state: structuredClone(stateManager.getData()),
        messageText: messageText ?? null,
        versions: gm.snapshots[key]?.versions || {},
    };
    trim(gm);
    persist();
    logDebug(`snapshot: captured baseline for message ${key}`);
    return true;
}

// Rolls the live state back to the baseline of a message and consumes that
// baseline. Also restores the pre-roll message text if one was stored (dice
// rolls append to the player's message). Returns true if a restore happened.
// The recorded per-swipe states are KEPT: older swipe versions of the message
// stay restorable when the user navigates back to them.
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
    if (snap.state) stateManager.replaceData(snap.state);

    if (typeof snap.messageText === "string" && snap.messageText) {
        const msg = st?.chat?.[Number(key)];
        if (msg && typeof msg.mes === "string" && msg.mes !== snap.messageText) {
            msg.mes = snap.messageText;
            try {
                st.saveChat();
            } catch { /* best effort */ }
        }
    }

    // The baseline is consumed by this rollback; a re-capture during the next
    // generation writes a fresh one (versions survive).
    gm.snapshots[key] = { ts: snap.ts, state: null, messageText: null, versions: snap.versions || {} };
    persist();
    logDebug(`snapshot: restored state from message ${key}`);
    return !!snap.state;
}

export function discardSnapshot(mesId) {
    const gm = store();
    if (!gm || !gm.snapshots[String(mesId)]) return false;
    delete gm.snapshots[String(mesId)];
    persist();
    return true;
}

// Rolls back the newest snapshot at or above `minId`. Covers flows where the
// target message's id has shifted upwards (middle deletions, regenerate flows
// that pop the AI message before the generation event fires).
export function restoreNewestFrom(minId) {
    const st = getContext();
    const gm = store();
    if (!gm) return false;
    const ids = Object.keys(gm.snapshots)
        .map(Number)
        .sort((a, b) => b - a);
    // Version-only entries (baseline already consumed) restore nothing — keep
    // walking down until a real baseline is found.
    for (const id of ids) {
        if (id < minId) return false;
        if (restoreSnapshot(id)) return true;
    }
    return false;
}

// Records the CURRENT state as the post-pass state of swipe version `swipeId`
// of message `mesId` (called at the end of every tracker pass).
export function captureSwipeState(mesId, swipeId) {
    const id = Number(mesId);
    const ver = Number(swipeId);
    if (!Number.isFinite(id) || !Number.isFinite(ver)) return false;
    const gm = store();
    if (!gm) return false;
    const key = String(id);
    const entry = gm.snapshots[key]
        || (gm.snapshots[key] = { ts: Date.now(), state: null, messageText: null, versions: {} });
    entry.versions = entry.versions || {};
    entry.versions[String(ver)] = { ts: Date.now(), state: structuredClone(stateManager.getData()) };
    // Cap versions per message: only the newest survive.
    const vers = Object.entries(entry.versions).sort((a, b) => a[1].ts - b[1].ts);
    while (vers.length > MAX_SWIPE_VERSIONS) {
        const [oldest] = vers.shift();
        delete entry.versions[oldest];
    }
    trim(gm);
    persist();
    logDebug(`snapshot: recorded post-pass state for message ${key} swipe #${ver}`);
    return true;
}

// Restores the recorded post-pass state of swipe version `swipeId` of message
// `mesId`. Returns false when no record exists (the live state stays as-is —
// older chats and fresh swipes have no version recorded yet).
export function restoreSwipeState(mesId, swipeId) {
    const gm = store();
    if (!gm) return false;
    const v = gm.snapshots[String(Number(mesId))]?.versions?.[String(Number(swipeId))];
    if (!v?.state) return false;
    stateManager.replaceData(v.state);
    logDebug(`snapshot: restored post-pass state of message ${mesId} swipe #${swipeId}`);
    return true;
}

// MESSAGE_DELETED does not report which message was removed. The common case
// is deleting the last AI message, which occupied index `chat.length` after
// removal — fall back to the newest snapshot at or above that index (covers
// middle deletions shifting ids as well).
export function restoreLastDeleted() {
    const st = getContext();
    return restoreNewestFrom(st.chat.length);
}