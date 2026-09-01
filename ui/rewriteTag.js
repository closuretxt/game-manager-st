// Action rewrite tag — visual feedback for the pre-pass rewrite specialist.
// When the pre-pass clarifies a vague or contradictory player action, the
// clarified action is appended to the player's message text as
// "original -- rewrite" (persisted in the chat) and a highlighted tag is
// attached to the message — the story engine also receives the rewrite
// through the high-priority injection instead.

import { getContext } from "../../../../extensions.js";
import { onMessageRendered } from "../util/messageDom.js";

// Appends the clarified action to the persisted message text as
// "original -- rewrite" (idempotent) and refreshes the DOM copy.
function appendRewriteToText(mesId, text) {
    const st = getContext();
    const msg = st?.chat?.[Number(mesId)];
    if (!msg || typeof msg.mes !== "string") return;
    if (msg.mes.includes(` -- ${text}`)) return; // already appended
    msg.mes = `${msg.mes.trimEnd()} -- ${text}`;
    try {
        st.saveChat();
    } catch { /* best effort */ }
    const mesText = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    if (mesText) $(mesText).text(msg.mes);
}

// Rewrite tag attached to a chat message. Safe to call repeatedly
// (idempotent per mesId).
export function attachRewriteToMessage(mesId, text) {
    if (!text) return;
    // Data-level edit first: safe while the message is still held unrendered
    // (ST renders it from chat data — rewrite included — once released).
    appendRewriteToText(mesId, String(text));
    // The highlighted tag waits for the message to actually render.
    onMessageRendered(mesId, (mesEl) => {
        if (mesEl.querySelector(".gm_rewrite_tag")) return; // already rendered
        const tag = $("<div>").addClass("gm_rewrite_tag");
        tag.append(
            $("<i>").addClass("fa-solid fa-pen-to-square"),
            $("<span>").addClass("gm_rewrite_tag_label").text("Action"),
            $("<span>").addClass("gm_rewrite_tag_text").text(String(text)),
        );
        const target = mesEl.querySelector(".mes_text");
        if (target) $(target).after(tag);
    });
}
