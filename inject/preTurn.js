// Event wiring for pre-turn triggers, agentic resource updates, and snapshot
// rollbacks.
//
// Tool usage does NOT scan the main SillyTavern model's output. Instead, after
// an exchange settles, a dedicated agentic call (core/agentRunner.js, on the
// configured connection profile) analyses the final AI/player responses and
// applies the resulting state changes (dice rolls, spent resources, etc.).
//
// Snapshots: the pre-change state of each tracked message is snapshotted (last
// 5 kept). Deleting the message, swiping it, or re-running the pass rolls the
// state back to that baseline.
//
// The pass is gated behind the "Agentic resource updates" setting (off by
// default). buildPreTurnPrompt() remains the placeholder seam for future
// pre-turn logic (relevant-info gating, action modification, combat/maps).

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { runAgentPass } from "../core/agentRunner.js";
import { restoreSnapshot, restoreLastDeleted } from "../core/snapshots.js";
import { initTriggerWatcher } from "../core/triggerWatcher.js";
import { clearHigh } from "../core/injection.js";

let _pendingTimer = null;

function updatesEnabled() {
    const s = extension_settings[extensionName];
    return !!(s.enabled && s.auto_update);
}

export function buildPreTurnPrompt(chatContext) {
    // PLACEHOLDER: future pre-turn logic goes here.
    logDebug("preTurn: buildPreTurnPrompt called (placeholder)");
    return "";
}

// Manual run: reruns the agentic pass on the last AI message. If a snapshot
// baseline already exists for it, the state is rolled back first so changes
// don't stack on top of the previous run.
export async function manualRun() {
    const st = getContext();
    if (!updatesEnabled()) {
        logDebug("manual run skipped — agentic updates disabled");
        return 0;
    }
    const mesId = st.chat.length - 1;
    const msg = st.chat[mesId];
    if (!msg || msg.is_user) {
        logDebug("manual run skipped — no AI message found");
        return 0;
    }
    return runAgentPass("manual", mesId);
}

export function initPreTurn() {
    const st = getContext();

    // CHAT_CHANGED — every chat owns its own game state.
    st.eventSource.on(st.event_types.CHAT_CHANGED, async () => {
        try {
            stateManager.loadForChat();
            clearHigh(); // pending one-shot results never cross chats
        } catch (e) {
            console.error("[Game Manager] failed to load state for chat:", e);
        }
    });

    // Pre-master triggers (dice rolls / transactions) on the player's action.
    initTriggerWatcher();

    // MESSAGE_RECEIVED — after the exchange settles, run the agentic analysis.
    st.eventSource.on(st.event_types.MESSAGE_RECEIVED, async (mesId) => {
        try {
            if (!updatesEnabled()) return;
            const msg = st.chat[mesId];
            if (!msg || msg.is_user) return;
            clearTimeout(_pendingTimer);
            _pendingTimer = setTimeout(() => runAgentPass("message_received", mesId), 1500);
        } catch (e) {
            console.error("[Game Manager] agent scheduling failed:", e);
        }
    });

    // MESSAGE_DELETED — roll the state back to before the deleted message's
    // changes and drop its snapshot.
    st.eventSource.on(st.event_types.MESSAGE_DELETED, async () => {
        try {
            if (restoreLastDeleted()) {
                logDebug("MESSAGE_DELETED: state rolled back to pre-message baseline");
            }
        } catch (e) {
            console.error("[Game Manager] snapshot restore on delete failed:", e);
        }
    });

    // SWIPED — the current last message is being re-rolled; restore its
    // baseline (if any) so the new swipe starts from the pre-message state.
    st.eventSource.on(st.event_types.SWIPED, async () => {
        try {
            const mesId = st.chat.length - 1;
            if (mesId >= 0 && restoreSnapshot(mesId)) {
                logDebug(`SWIPED: state rolled back for message ${mesId}`);
            }
        } catch (e) {
            console.error("[Game Manager] snapshot restore on swipe failed:", e);
        }
    });

    // GENERATION_STARTED — pre-turn hook placeholder.
    st.eventSource.on(st.event_types.GENERATION_STARTED, (...args) => {
        const s = extension_settings[extensionName];
        if (!s.enabled) return;
        buildPreTurnPrompt(args); // seam for future logic
    });
}