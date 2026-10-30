// Injected-guidance editor — one modal for the per-chat prompt texts the
// story engine reads (Time guidance, Bonds guidance). Shows the current text
// (the built-in default while nothing custom is saved), Reset brings the
// default back. Saving the default text unchanged stores "" so the chat keeps
// following the built-in wording if it improves later.

import { fadeOutRemove } from "../util/fx.js";

export function openPromptEditor({ title, hint = "", value = "", defaultText = "", placeholders = [], onSave }) {
    const overlay = $("<div>").addClass("gm_modal_overlay");
    const dialog = $("<div>").addClass("gm_modal gm_prompt_modal");
    const close = () => {
        $(document).off("keydown.gm_prompt");
        fadeOutRemove(overlay);
    };
    const area = $("<textarea>").addClass("gm_input gm_prompt_text").attr({ rows: 12, spellcheck: false })
        .val(String(value || "").trim() ? value : defaultText);
    const state = $("<span>").addClass("gm_section_hint");
    const refresh = () => state.text(area.val().trim() === defaultText.trim() ? "Built-in default" : "Custom");
    area.on("input", refresh);
    refresh();

    const reset = $("<div>").addClass("menu_button").attr("title", "Put the built-in text back (not saved until Save)")
        .append($("<i>").addClass("fa-solid fa-rotate-left"), $("<span>").text(" Reset"));
    reset.on("click", () => { area.val(defaultText); refresh(); });
    const save = $("<div>").addClass("menu_button gm_modal_save").text("Save");
    save.on("click", () => {
        const text = area.val().trim();
        onSave?.(text === defaultText.trim() ? "" : text);
        close();
    });

    dialog.append(
        $("<div>").addClass("gm_prompt_head").append($("<b>").text(title), state),
        hint ? $("<div>").addClass("gm_modal_hint").text(hint) : null,
        placeholders.length ? $("<div>").addClass("gm_modal_hint gm_prompt_ph").text(`Placeholders: ${placeholders.join(" · ")}`) : null,
        area,
        $("<div>").addClass("gm_modal_actions").append(
            reset,
            $("<div>").addClass("menu_button").text("Cancel").on("click", close),
            save,
        ),
    );
    overlay.append(dialog).appendTo("body");
    overlay.on("mousedown", e => { if (e.target === overlay[0]) close(); });
    $(document).on("keydown.gm_prompt", e => { if (e.key === "Escape") close(); });
}
