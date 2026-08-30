// Action rewrite tag — visual feedback for the pre-pass rewrite specialist.
// When the pre-pass clarifies a vague or contradictory player action, a
// highlighted tag is attached to the player's message IN THE DOM ONLY (the
// message text itself is never edited) — the story engine receives the
// rewrite through the high-priority injection instead.

// DOM-only rewrite tag attached to a chat message. Safe to call repeatedly
// (idempotent per mesId).
export function attachRewriteToMessage(mesId, text) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!mesEl || !text) return;
    if (mesEl.querySelector(".gm_rewrite_tag")) return; // already rendered
    const tag = $("<div>").addClass("gm_rewrite_tag");
    tag.append(
        $("<i>").addClass("fa-solid fa-pen-to-square"),
        $("<span>").addClass("gm_rewrite_tag_label").text("Action"),
        $("<span>").addClass("gm_rewrite_tag_text").text(String(text)),
    );
    const target = mesEl.querySelector(".mes_text");
    if (target) $(target).after(tag);
}
