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

// Contest rounds and transactions keep their baseline on the USER message and
// the post-pass on the AI reply, so a turn can hold two entries.
export const MAX_SNAPSHOTS = 8;

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

// MESSAGE_DELETED does not report which messages were removed, and one event
// can cover many (the "Delete messages" mode drops a message and everything
// after it). So the chat's message objects are remembered between events
// (`noteChat`, in memory: ST mutates the same objects, never recreates them)
// and the delete compares that list with the live chat.
let _chatShadow = null;

export function noteChat() {
    const chat = getContext()?.chat;
    _chatShadow = Array.isArray(chat) ? chat.slice() : null;
}

// Pure: what a delete did, from the chat before and after and the snapshot
// ids. Returns
//   { mode: "unknown" }                    no usable shadow, or none of its
//                                          messages left (a message added
//                                          after the last noteChat): fall back
//   { mode: "tail", from, drop, single }   the end of the chat went: roll back to
//                                          the OLDEST baseline at or above `from`
//   { mode: "middle", remap, drop }        older messages went: no rollback (the
//                                          later turns still stand), ids shift
// `drop` = snapshot ids of deleted messages; `remap` = old id -> new id.
export function deletePlan(prev, now, snapshotIds) {
    if (!Array.isArray(prev) || !prev.length || !Array.isArray(now)) return { mode: "unknown" };
    const alive = new Set(now);
    const gone = [];
    prev.forEach((m, i) => { if (!alive.has(m)) gone.push(i); });
    if (!gone.length) return { mode: "unknown" };
    const ids = (snapshotIds || []).map(Number).filter(Number.isFinite);
    if (gone[gone.length - 1] === prev.length - 1) {
        // Messages after the shadow (none known) count as part of the tail.
        const from = gone.find((g, k) => gone.slice(k).every((x, j) => x === g + j));
        return { mode: "tail", from, drop: ids.filter(id => id >= from), single: gone.length === 1 };
    }
    const goneSet = new Set(gone);
    const remap = {};
    const drop = [];
    for (const id of ids) {
        if (goneSet.has(id)) { drop.push(id); continue; }
        const shift = gone.filter(g => g < id).length;
        if (shift) remap[id] = id - shift;
    }
    return { mode: "middle", remap, drop };
}

// Rolls the state back after a delete. A deleted tail rolls back to the state
// before its FIRST message's changes (a fight round committed on the user
// message included); deleted messages' snapshots go, so a new message at the
// same position never inherits a stale baseline. One deleted last message
// (also the regenerate flow) keeps its swipe versions, as before.
export function restoreLastDeleted() {
    const st = getContext();
    const gm = store();
    const prev = _chatShadow;
    noteChat();
    if (!gm) return false;
    const plan = deletePlan(prev, st.chat, Object.keys(gm.snapshots));
    console.info(`[GM DIAG] MESSAGE_DELETED: ${plan.mode}${plan.mode === "tail" ? ` from #${plan.from}` : ""}`);
    if (plan.mode === "unknown") return restoreNewestFrom(st.chat.length);
    if (plan.mode === "middle") {
        const next = {};
        for (const [key, entry] of Object.entries(gm.snapshots)) {
            if (plan.drop.includes(Number(key))) continue;
            next[String(plan.remap[key] ?? key)] = entry;
        }
        gm.snapshots = next;
        persist();
        return false;
    }
    const restoredId = plan.drop.slice().sort((a, b) => a - b).find(id => gm.snapshots[String(id)]?.state);
    const restored = restoredId !== undefined && restoreSnapshot(restoredId);
    for (const id of plan.drop) {
        if (plan.single && id === restoredId) continue;
        delete gm.snapshots[String(id)];
    }
    persist();
    return restored;
}