// Event wiring for the PRE-TURN stage: pre-pass routing, specialists, and
// snapshot rollbacks. The agentic tracker pass lives in inject/postTurn.js
// (it runs AFTER the AI reply lands, per the post-pass contract).
//
// ORDERING MATTERS: everything the LLM should see for THIS turn runs inside
// the AWAITED GENERATION_AFTER_COMMANDS handler (SillyTavern's event emitter
// awaits its listeners, so prompt assembly waits for us):
//
//   player sends action / swipes
//     └─ GENERATION_AFTER_COMMANDS (awaited)
//          ├─ pre-pass router LLM judges the action (core/prePass.js)
//          └─ specialists execute the plan (core/triggerWatcher.js)
//     └─ prompt assembly — {{gamemaster-*}} macros substitute the buffers
//     └─ story generation — sees fresh, relevant state only
//
// Snapshots: the pre-change state of each tracked generation is snapshotted
// (last 5 kept). Deleting the AI message, swiping it, or re-running the pass
// rolls the state back to that baseline.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { restoreSnapshot, restoreLastDeleted, hasSnapshot } from "../core/snapshots.js";
import { handlePreTurn, setPendingAction } from "../core/triggerWatcher.js";
import { clearHigh, clearLow } from "../core/injection.js";

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

    // MESSAGE_SENT — capture the player's action the moment it is created.
    // Some send flows fire GENERATION_AFTER_COMMANDS BEFORE the user message
    // is pushed into chat, so handlePreTurn can't read it from there.
    st.eventSource.on(st.event_types.MESSAGE_SENT, (mesId) => {
        try {
            const msg = st.chat?.[mesId];
            if (msg?.is_user) setPendingAction(String(msg.mes ?? ""));
        } catch (e) {
            console.error("[Game Manager] MESSAGE_SENT capture failed:", e);
        }
    });

    // Pre-turn: EVERYTHING (dice, transactions, agentic pass) runs inside this
    // awaited handler — before prompt assembly — so its results are injected
    // into the SAME turn via the {{gamemaster-*}} macros.
    st.eventSource.on(st.event_types.GENERATION_AFTER_COMMANDS, async (type, _opts, dryRun) => {
        try {
            console.info(`[GM DIAG] GENERATION_AFTER_COMMANDS fired: type=${type} dryRun=${!!dryRun}`);
            if (dryRun) return;
            const s = extension_settings[extensionName];
            if (!s.enabled) { console.info("[GM DIAG] skipped: extension disabled"); return; }
            if (!["normal", "swipe", "regenerate", "continue"].includes(String(type))) {
                console.info(`[GM DIAG] skipped: type "${type}" not handled`);
                return;
            }
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
    st.eventSource.on(st.event_types.SWIPED, async (mesId) => {
        try {
            const id = Number.isFinite(mesId) ? Number(mesId) : st.chat.length - 1;
            console.info(`[GM DIAG] SWIPED fired: mesId=${id} (chat.length-1=${st.chat.length - 1}) hasSnapshot=${hasSnapshot(id)}`);
            if (id >= 0 && restoreSnapshot(id)) {
                logDebug(`SWIPED: state rolled back for message ${id}`);
                console.info(`[GM DIAG] SWIPED: state rolled back for message ${id}`);
            } else {
                console.info(`[GM DIAG] SWIPED: NO snapshot restored for message ${id}`);
            }
        } catch (e) {
            console.error("[Game Manager] snapshot restore on swipe failed:", e);
        }
    });

}