// Action rewrite tag — visual feedback for the pre-pass rewrite specialist.
// When the pre-pass clarifies a vague or contradictory player action, the
// clarified action is appended to the player's message text as
// "original -- rewrite" (persisted in the chat) and a highlighted tag is
// attached to the message — the story engine also receives the rewrite
// through the high-priority injection instead.
//
// The tag is DOM-only and wiped by ST re-renders; the clarified text is also
// persisted on the message (gm_rewrite) so the attachment restore pass in
// util/messageDom.js rebuilds the tag after every re-render.

import { getContext } from "../../../../extensions.js";
import { onMessageRendered, registerAttachmentRestorer } from "../util/messageDom.js";
import { storeMessageData } from "../util/chatStore.js";

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

// Builds the highlighted tag (shared by the first attach and the restore pass).
function buildRewriteTag(text) {
    const tag = $("<div>").addClass("gm_rewrite_tag");
    tag.append(
        $("<i>").addClass("fa-solid fa-pen-to-square"),
        $("<span>").addClass("gm_rewrite_tag_label").text("Action"),
        $("<span>").addClass("gm_rewrite_tag_text").text(String(text)),
    );
    return tag;
}

// Rewrite tag attached to a chat message. Safe to call repeatedly
// (idempotent per mesId).
export function attachRewriteToMessage(mesId, text) {
    if (!text) return;
    text = String(text);
    // Persisted first so the restore pass can rebuild the tag even when the
    // message has not landed yet (custom send flows).
    storeMessageData(mesId, "gm_rewrite", text);
    // Data-level edit next: safe while the message is still held unrendered
    // (ST renders it from chat data — rewrite included — once released).
    appendRewriteToText(mesId, text);
    // The highlighted tag waits for the message to actually render.
    onMessageRendered(mesId, (mesEl) => {
        if (mesEl.querySelector(".gm_rewrite_tag")) return; // already rendered
        const target = mesEl.querySelector(".mes_text");
        if (target) $(target).after(buildRewriteTag(text));
    });
}

// Re-attaches the tag from the persisted gm_rewrite after ST re-renders the
// message (swipes, edits, chat reload).
registerAttachmentRestorer((mesEl, msg) => {
    if (!msg?.is_user) return; // the tag belongs to the player's action only
    const text = String(msg?.gm_rewrite || "").trim();
    if (!text || mesEl.querySelector(".gm_rewrite_tag")) return; // already rendered
    const target = mesEl.querySelector(".mes_text");
    if (target) $(target).after(buildRewriteTag(text));
});
