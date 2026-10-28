// Chat Mode dialog — the window's home for everything that is per chat:
// the feature mode preset, single feature toggles and tab toggles
// (core/features.js). The settings drawer only holds the global defaults.
// Changes apply immediately; the dialog re-renders after each one.

import { saveSettingsDebounced } from "../../../../../script.js";
import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { gmNotify } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import {
    FEATURE_MODES, FEATURE_LABELS, TAB_TOGGLES, OVERRIDABLE_KEYS, hasChat, getChatMode,
    getEffectiveMode, getFeature, getOverrides, setChatMode, setFeatureOverride, resetChatFeatures,
} from "../core/features.js";
import { refreshFeatureUI } from "../settings/settingsManager.js";
import { fadeOutRemove } from "../util/fx.js";

function changed() {
    stateManager.emitChange("features");
}

function toggleGrid(entries) {
    const grid = $("<div>").addClass("gm_settings_grid");
    const overrides = getOverrides();
    for (const [key, label] of entries) {
        const box = $("<input>").attr("type", "checkbox").prop("checked", getFeature(key));
        box.on("change", () => {
            setFeatureOverride(key, box.prop("checked"));
            changed();
        });
        const row = $("<label>").addClass("checkbox_label").append(box, $("<span>").text(label));
        // Marks the toggles this chat changed away from its mode.
        if (key in overrides) row.addClass("gm_mode_changed").attr("title", "Changed from the mode's value");
        grid.append(row);
    }
    return grid;
}

function renderBody(body) {
    body.empty();
    const s = extension_settings[extensionName];
    const defMode = FEATURE_MODES[s.default_mode] ? s.default_mode : "custom";

    const select = $("<select>").addClass("text_pole gm_mode_select");
    select.append($("<option>").val("").text(`Default: ${FEATURE_MODES[defMode].label}`));
    for (const [id, mode] of Object.entries(FEATURE_MODES)) {
        select.append($("<option>").val(id).text(mode.label));
    }
    select.val(getChatMode() ?? "");
    select.on("change", () => {
        setChatMode(select.val() || null);
        changed();
    });
    body.append($("<div>").addClass("gm_field gm_field_inline gm_mode_row").append($("<label>").text("Mode"), select));

    const n = Object.keys(getOverrides()).length;
    body.append($("<div>").addClass("gm_modal_hint").text(n
        ? `${n} toggle(s) changed from the ${FEATURE_MODES[getEffectiveMode()].label} mode.`
        : "Romance, Slice of life and Survival switch off what the scenario doesn't need; Custom uses your global defaults."));

    body.append($("<div>").addClass("gm_settings_subhead").text("Game features"));
    body.append(toggleGrid(Object.entries(FEATURE_LABELS)));
    body.append($("<div>").addClass("gm_settings_subhead")
        .attr("title", "A hidden tab is not tracked: the AI no longer sees or changes that part of the sheets (the data is kept).")
        .text("Tabs"));
    body.append(toggleGrid(TAB_TOGGLES.map(t => [t.key, t.label])));
}

export function openChatModeDialog() {
    if (!hasChat()) {
        gmNotify("Open a chat first — the mode is saved per chat.", "info");
        return;
    }
    const overlay = $("<div>").addClass("gm_modal_overlay");
    const dialog = $("<div>").addClass("gm_modal gm_chat_mode_modal");
    const body = $("<div>");
    let off = null;
    const close = () => {
        off?.();
        fadeOutRemove(overlay);
    };

    renderBody(body);
    // Re-render on our own changes; close if the chat switches underneath.
    off = stateManager.onChange((reason) => {
        if (reason === "features") renderBody(body);
        else if (reason === "chat_loaded") close();
    });

    const reset = $("<div>").addClass("menu_button")
        .attr("title", "Forget this chat's mode and toggle changes — it follows the default mode again")
        .text("Reset");
    reset.on("click", () => {
        resetChatFeatures();
        changed();
    });
    // Copies this chat's result into the global defaults so 'Custom' (and
    // new chats) reproduce it.
    const saveDefault = $("<div>").addClass("menu_button")
        .attr("title", "Make this chat's toggles the global defaults and 'Custom' the mode for new chats")
        .text("Save as defaults");
    saveDefault.on("click", () => {
        const s = extension_settings[extensionName];
        for (const key of OVERRIDABLE_KEYS) s[key] = getFeature(key);
        s.default_mode = "custom";
        saveSettingsDebounced();
        refreshFeatureUI();
        changed();
        gmNotify("This chat's toggles are now the defaults for new chats.", "success");
    });

    dialog.append(
        $("<b>").text("Chat Mode"),
        $("<div>").addClass("gm_modal_hint").text("Applies to this chat only."),
        body,
        $("<div>").addClass("gm_modal_actions").append(
            reset, saveDefault,
            $("<div>").addClass("menu_button gm_modal_save").text("Close").on("click", close),
        ),
    );
    overlay.append(dialog).appendTo("body");
    overlay.on("mousedown", e => { if (e.target === overlay[0]) close(); });
}
