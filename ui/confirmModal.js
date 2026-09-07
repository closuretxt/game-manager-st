// Generic destructive-action confirm modal: Continue / Go back.
// Resolves true only when the user explicitly presses Continue; backdrop
// click, Escape and "Go back" all resolve false and change nothing.

import { fadeOutRemove } from "../util/fx.js";

export function confirmAction({ title = "Are you sure?", message = "", confirmLabel = " Continue", cancelLabel = " Go back", danger = true } = {}) {
    return new Promise(resolve => {
        const overlay = $("<div>").addClass("gm_modal_overlay gm_confirm_overlay");
        const dialog = $("<div>").addClass("gm_modal gm_confirm_modal");

        const done = ok => {
            $(document).off("keydown.gm_confirm");
            fadeOutRemove(overlay);
            resolve(ok);
        };

        // Header: warning badge + title (badge goes danger-red only when the
        // action is actually destructive).
        const head = $("<div>").addClass("gm_confirm_head").append(
            $("<div>").addClass("gm_confirm_badge").toggleClass("gm_confirm_danger_bg", !!danger)
                .append($("<i>").addClass("fa-solid fa-triangle-exclamation")),
            $("<b>").addClass("gm_confirm_title").text(title),
        );

        const cancel = $("<div>").addClass("menu_button gm_confirm_back").append(
            $("<i>").addClass("fa-solid fa-arrow-left"), $("<span>").text(cancelLabel));
        cancel.on("click", () => done(false));

        const ok = $("<div>").addClass("menu_button")
            .toggleClass("gm_confirm_danger", !!danger)
            .append($("<i>").addClass("fa-solid fa-check"), $("<span>").text(confirmLabel));
        ok.on("click", () => done(true));

        dialog.append(
            head,
            message ? $("<div>").addClass("gm_modal_hint gm_confirm_msg").text(message) : null,
            $("<div>").addClass("gm_modal_actions").append(cancel, ok),
        );

        overlay.append(dialog).appendTo("body");
        overlay.on("mousedown", e => { if (e.target === overlay[0]) done(false); });
        $(document).on("keydown.gm_confirm", e => { if (e.key === "Escape") done(false); });
    });
}
