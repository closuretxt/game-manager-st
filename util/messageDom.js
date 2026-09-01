// Message DOM helper — waiting for a chat message to actually exist.
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
