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
// Catch-up: MESSAGE_RECEIVED never fires for messages that already exist in
// a chat (reopened session, extension enabled mid-story). On CHAT_CHANGED the
// last AI reply gets its pass automatically — exactly once per message
// (tracked in chat metadata), and only when there is a full exchange to
// analyse: 2+ messages in the chat (a lone greeting is never tracked).
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
import { restoreSnapshot, restoreSwipeState } from "../core/snapshots.js";

// Tiny replies ("...", "Ok.", short emotes) carry nothing worth tracking —
// skip the tracker instead of paying a full LLM call for them.
const MIN_REPLY_CHARS = 100;

function updatesEnabled() {
    const s = extension_settings[extensionName];
    return !!(s.enabled && s.auto_update);
}

// Already-tracked bookkeeping: chat metadata maps mesId -> send_date. A NEW
// message reusing a freed index has a different send_date, so it is never
// mistaken for a processed one.
function passesStore() {
    const st = getContext();
    if (!st?.chatMetadata) return null;
    const gm = (st.chatMetadata.game_manager = st.chatMetadata.game_manager || {});
    gm.post_passes = gm.post_passes || {};
    return gm.post_passes;
}

function wasProcessed(mesId, msg) {
    return passesStore()?.[String(mesId)] === String(msg?.send_date ?? "");
}

function markProcessed(mesId, msg) {
    const store = passesStore();
    if (!store) return;
    store[String(mesId)] = String(msg?.send_date ?? "");
    try {
        getContext().saveMetadata();
    } catch { /* best effort */ }
}

// Shared eligibility gate + runner for the tracker: AI message only,
// substantial reply, never tracked before (catch-up dedup). Marks the
// message as tracked and runs one pass.
async function maybeRunPass(id, reason) {
    const st = getContext();
    const msg = st.chat[id];
    if (!msg || msg.is_user) return;
    if (wasProcessed(id, msg)) {
        logDebug(`postTurn: message ${id} already tracked — pass skipped`);
        return;
    }
    if (String(msg.mes ?? "").trim().length < MIN_REPLY_CHARS) {
        logDebug(`postTurn: reply under ${MIN_REPLY_CHARS} chars — tracker skipped`);
        return;
    }
    await runAgentPass(reason, id);
    markProcessed(id, msg);
}

// Manual run: reruns the tracker on the last AI message. The state is rolled
// back to that message's pre-message baseline first (if one exists), so the
// re-run starts clean instead of stacking on top of the previous tracker
// changes; runAgentPass then captures a fresh baseline before applying.
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
    if (restoreSnapshot(mesId)) {
        logDebug(`manual run: state rolled back to pre-message baseline of ${mesId}`);
    }
    const applied = await runAgentPass("manual", mesId);
    markProcessed(mesId, msg);
    return applied;
}

export function initPostTurn() {
    const st = getContext();

    // MESSAGE_RECEIVED — the AI reply landed; analyse the full exchange.
    // User messages are ignored: the tracker only consumes AI replies.
    st.eventSource.on(st.event_types.MESSAGE_RECEIVED, async (mesId) => {
        try {
            if (!updatesEnabled()) return;
            const id = Number.isFinite(mesId) ? mesId : st.chat.length - 1;
            await maybeRunPass(id, "post_pass");
        } catch (e) {
            console.error("[Game Manager] post-turn tracker failed:", e);
        }
    });

    // CHAT_CHANGED — catch-up pass for the last AI reply when it never saw a
    // MESSAGE_RECEIVED pass (reopened chat, extension enabled mid-story).
    // Requires 2+ messages: the tracker needs a full exchange (player action
    // + AI reply); a lone greeting has nothing to account. Runs once per
    // message — already-tracked replies are skipped via chat metadata.
    st.eventSource.on(st.event_types.CHAT_CHANGED, async () => {
        try {
            if (!updatesEnabled()) return;
            if (!Array.isArray(st.chat) || st.chat.length < 2) return;
            const id = st.chat.length - 1;
            await maybeRunPass(id, "catch_up");
        } catch (e) {
            console.error("[Game Manager] post-turn catch-up failed:", e);
        }
    });

    // SWIPED — the user navigated between swipe versions of the last AI
    // message: the tracker state follows the version being viewed (the
    // post-pass state its tracker produced). No-op when the version has no
    // record yet (older chats, or a fresh swipe still generating — the
    // pre-turn rollback runs first in that case).
    st.eventSource.on(st.event_types.SWIPED, async (mesId) => {
        try {
            const id = Number.isFinite(mesId) ? mesId : st.chat.length - 1;
            const msg = st.chat?.[id];
            if (!msg || msg.is_user) return;
            const swipeId = Number(msg.swipe_id);
            if (!Number.isFinite(swipeId)) return;
            if (restoreSwipeState(id, swipeId)) {
                logDebug(`postTurn: state restored for swipe #${swipeId} of message ${id}`);
            }
        } catch (e) {
            console.error("[Game Manager] swipe state restore failed:", e);
        }
    });

    logDebug("postTurn: tracker wired to MESSAGE_RECEIVED + CHAT_CHANGED + SWIPED");
}
