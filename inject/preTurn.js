// Event wiring for pre-turn triggers, agentic resource updates, and snapshot
// rollbacks.
//
// ORDERING MATTERS: everything the LLM should see for THIS turn runs inside
// the AWAITED GENERATION_AFTER_COMMANDS handler (SillyTavern's event emitter
// awaits its listeners, so prompt assembly waits for us):
//
//   player sends action / swipes
//     └─ GENERATION_AFTER_COMMANDS (awaited)
//          ├─ dice rolls / transactions (triggered by the action text)
//          └─ agentic pass — analyses the exchange, applies tool tags + warnings
//     └─ prompt assembly — {{gamemaster-*}} macros substitute the buffers
//     └─ story generation — sees fresh, relevant state only
//
// Snapshots: the pre-change state of each tracked generation is snapshotted
// (last 5 kept). Deleting the AI message, swiping it, or re-running the pass
// rolls the state back to that baseline.
//
// The agentic pass is gated behind the "Agentic resource updates" setting
// (off by default). buildPreTurnPrompt() remains the placeholder seam for
// future pre-turn logic (relevant-info gating, action modification, maps).

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { runAgentPass } from "../core/agentRunner.js";
import { restoreSnapshot, restoreLastDeleted } from "../core/snapshots.js";
import { handlePreTurn } from "../core/triggerWatcher.js";
import { clearHigh, clearLow } from "../core/injection.js";

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
            clearLow();
        } catch (e) {
            console.error("[Game Manager] failed to load state for chat:", e);
        }
    });

    // Pre-turn: EVERYTHING (dice, transactions, agentic pass) runs inside this
    // awaited handler — before prompt assembly — so its results are injected
    // into the SAME turn via the {{gamemaster-*}} macros.
    st.eventSource.on(st.event_types.GENERATION_AFTER_COMMANDS, async (type, _opts, dryRun) => {
        try {
            if (dryRun) return;
            const s = extension_settings[extensionName];
            if (!s.enabled) return;
            if (!["normal", "swipe", "regenerate", "continue"].includes(String(type))) return;
            await handlePreTurn(String(type));
        } catch (e) {
            console.error("[Game Manager] pre-turn failed:", e);
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