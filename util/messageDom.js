// Message DOM helper — waiting for a chat message to actually exist, plus the
// persistent attachment restore pass.
//
// The whole pre-turn pipeline (pre-pass, dice, combat, rewrite) runs inside
// the awaited GENERATION_AFTER_COMMANDS emission — and while that emission is
// pending, SillyTavern HOLDS the player's fresh message unrendered: the chat
// entry already exists (st.chat[N]) but its `.mes` DOM element does not. Any
// DOM-only attachment made during the pipeline would silently no-op.
//
// onMessageRendered polls for the element and fires the callback once it
// exists (immediately, when the message is already on screen — swipes,
// re-runs). The callback receives the `.mes` element.
//
// Restore pass: the roll/combat chips and the rewrite tag are DOM-only
// decorations, wiped whenever ST re-renders the chat (reload, swipes, edits).
// Their rendering data is persisted on the message objects (gm_roll,
// gm_combat, gm_rewrite) — UI modules register an idempotent restorer here
// and the pass re-attaches whatever is missing after every re-render.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

const DEFAULT_TIMEOUT_MS = 20000; // generous: covers slow pre-turn pipelines
const POLL_INTERVAL_MS = 200;

export function onMessageRendered(mesId, callback, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
    const started = Date.now();
    const poll = () => {
        const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        if (mesEl) {
            callback(mesEl);
            return;
        }
        if (Date.now() - started > timeoutMs) {
            console.warn(`[Game Manager] message element #${mesId} never rendered — DOM attachment skipped`);
            return;
        }
        setTimeout(poll, intervalMs);
    };
    poll();
}

//

// ---------- persistent attachment restore ----------

const _restorers = new Set();
const RESTORE_DEBOUNCE_MS = 150;

// UI modules register (mesEl, msg) => void. Restorers MUST be idempotent:
// skip when their element is already present on the message.
export function registerAttachmentRestorer(fn) {
    _restorers.add(fn);
}

// One pass over the rendered chat: every message with persisted gm_* data
// gets its missing attachments rebuilt.
function restorePass() {
    let chat;
    try {
        chat = getContext()?.chat;
    } catch { return; }
    if (!Array.isArray(chat)) return;
    document.querySelectorAll("#chat .mes[mesid]").forEach(mesEl => {
        const msg = chat[Number(mesEl.getAttribute("mesid"))];
        if (!msg) return;
        for (const fn of _restorers) {
            try {
                fn(mesEl, msg);
            } catch (e) {
                logDebug("attachment restore failed:", e?.message || e);
            }
        }
    });
}

let _restoreTimer = null;
function scheduleRestore() {
    clearTimeout(_restoreTimer);
    _restoreTimer = setTimeout(restorePass, RESTORE_DEBOUNCE_MS);
}

// Wires the restore triggers: ST events cover the known re-render cases; the
// MutationObserver on #chat catches any other DOM rebuild (swipe swaps,
// message edits, chat loads). Called once from index.js.
export function initAttachmentRestore() {
    try {
        const st = getContext();
        const on = st?.eventSource;
        const types = st?.event_types;
        if (on && types) {
            for (const name of ["CHAT_CHANGED", "MESSAGE_UPDATED", "MESSAGE_EDITED", "MESSAGE_SWIPED", "SWIPED"]) {
                const t = types[name];
                if (t) on.on(t, scheduleRestore);
            }
        }
    } catch (e) {
        console.warn("[Game Manager] attachment restore: event wiring failed", e);
    }
    // Catch-all: any .mes added back into #chat triggers a debounced pass.
    const chatEl = document.getElementById("chat");
    if (chatEl && typeof MutationObserver !== "undefined") {
        new MutationObserver(scheduleRestore).observe(chatEl, { childList: true, subtree: true });
    }
    scheduleRestore(); // whatever is on screen right now
}
