// Post-turn wiring: the agentic tracker pass (post-pass contract).
//
// ORDERING: the tracker runs AFTER the AI reply lands, on MESSAGE_RECEIVED —
// never inside the pre-turn. By then the story generation is done, so the
// pass analyses the FULL exchange (player action + AI reply) and applies
// tool-tag state changes + rollback snapshots. Its results are visible to the
// NEXT turn's prompt assembly: the following pre-pass builds its snapshot
// from already-updated state.
//
//   AI reply lands (MESSAGE_RECEIVED, non-user message)
//     └─ POST-PASS tracker (core/agentRunner.js)
//          exchange + state snapshot -> tool tags (<change_values>,
//          <add_items>, <update_custom>, <warnings>...) -> state changes
//          + rollback snapshot keyed to the AI message id
//
// Snapshots: keyed to the AI message id, so deleting or swiping that message
// rolls the state back to the pre-message baseline (core/snapshots.js).
// Swipes are safe: the swipe/regenerate branch of handlePreTurn restores the
// baseline inside the awaited GENERATION_AFTER_COMMANDS handler, before the
// new reply is generated — so re-running the tracker on the new text starts
// from the correct pre-message state.
//
// Gated behind the "Agentic updates" setting (auto_update — off by default).

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { runAgentPass } from "../core/agentRunner.js";

// Tiny replies ("...", "Ok.", short emotes) carry nothing worth tracking —
// skip the tracker instead of paying a full LLM call for them.
const MIN_REPLY_CHARS = 100;

function updatesEnabled() {
    const s = extension_settings[extensionName];
    return !!(s.enabled && s.auto_update);
}

// Manual run: reruns the tracker on the last AI message. If a snapshot
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

export function initPostTurn() {
    const st = getContext();

    // MESSAGE_RECEIVED — the AI reply landed; analyse the full exchange.
    // User messages are ignored: the tracker only consumes AI replies.
    st.eventSource.on(st.event_types.MESSAGE_RECEIVED, async (mesId) => {
        try {
            if (!updatesEnabled()) return;
            const id = Number.isFinite(mesId) ? mesId : st.chat.length - 1;
            const msg = st.chat[id];
            if (!msg || msg.is_user) return;
            if (String(msg.mes ?? "").trim().length < MIN_REPLY_CHARS) {
                logDebug(`postTurn: reply under ${MIN_REPLY_CHARS} chars — tracker skipped`);
                return;
            }
            await runAgentPass("post_pass", id);
        } catch (e) {
            console.error("[Game Manager] post-turn tracker failed:", e);
        }
    });

    logDebug("postTurn: tracker wired to MESSAGE_RECEIVED");
}
