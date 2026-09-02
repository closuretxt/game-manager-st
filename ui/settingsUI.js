import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../core/constants.js";
import { gmNotify, logDebug } from "../core/debug.js";
import { CONTAINER_TYPES, GM_SCHEMA, defaultEntry } from "../core/schemas.js";
import { stateManager } from "../core/stateManager.js";
import { fadeOutRemove } from "../util/fx.js";
import { getConnectionProfiles } from "../util/connectionService.js";

// ---------- connection profile drawers ----------
// Declarative registry: adding a new profile dropdown to the Advanced panel is
// one entry here — the drawer DOM, change handler and summary label are all
// generated from it (see buildProfileDrawer / populateProfiles).
//   select:    DOM id of the generated <select>
//   setting:   extension_settings key persisted on change
//   key:       short slug used for the summary label element id
//   emptyText: label of the "" option (the "Same as ..." fallback)
//   warning:   when true, an empty selection triggers the red setup warning
const PROFILE_DRAWERS = [
    {
        select: "gm_profile_select", setting: "connection_profile", key: "agentic",
        label: "Agentic profile", icon: "fa-robot",
        tooltip: "Connection profile used by the agentic pass (post-pass tracker / state updates)",
        emptyText: "Same as Current", warning: true,
    },
    {
        select: "gm_premaster_profile_select", setting: "premaster_profile", key: "premaster",
        label: "Pre-master profile", icon: "fa-dice",
        tooltip: "Connection profile used by the pre-master engines (dice rolls, transactions)",
        emptyText: "Same as Agentic",
    },
    {
        select: "gm_wizard_profile_select", setting: "wizard_profile", key: "wizard",
        label: "Scenario Build Wizard profile", icon: "fa-wand-magic-sparkles",
        tooltip: "Connection profile used by the Scenario Build Wizard",
        emptyText: "Same as Pre-master",
    },
    {
        select: "gm_dice_profile_select", setting: "dice_profile", key: "dice",
        label: "Dice Rolls profile", icon: "fa-dice-d20",
        tooltip: "Connection profile used by the dice engine (chance calculations)",
        emptyText: "Same as Pre-master",
    },
    {
        select: "gm_enemy_profile_select", setting: "enemy_creation_profile", key: "enemy",
        label: "Enemy Creation profile", icon: "fa-skull",
        tooltip: "Connection profile used to auto-generate enemy sheets from the spawn-review popup",
        emptyText: "Same as Wizard",
    },
];

export const settingsUI = {
    init() {
        this.populatePresets();
        $("#gm_preset_select").on("change", () => {
            extension_settings[extensionName].active_preset = $("#gm_preset_select").val();
            saveSettingsDebounced();
        });
        $("#gm_preset_save").on("click", () => this.savePreset());
        $("#gm_preset_load").on("click", () => this.loadPreset());
        $("#gm_preset_delete").on("click", () => this.deletePreset());

        // Connection profiles — populated ONCE at startup, exactly like the
        // Recast reference (populateConnectionDropdown is only called when the
        // UI element is created). The selects are NEVER touched during user
        // interaction: rebuilding or re-valuing options while the native
        // dropdown picker is open glitches the selection out. Delayed
        // refreshes only exist to catch the Connection Manager extension
        // loading after us — at that point no picker can be open.
        this.populateProfiles();
        setTimeout(() => this.populateProfiles(), 1000);
        setTimeout(() => this.populateProfiles(), 3000);
        // Profile drawers — generated from the registry so new profiles are a
        // one-entry addition. Header click expands/collapses (delegated).
        for (const def of PROFILE_DRAWERS) {
            $("#gm_profile_drawers").append(this.buildProfileDrawer(def));
            $(`#${def.select}`).on("change", () => {
                extension_settings[extensionName][def.setting] = $(`#${def.select}`).val();
                saveSettingsDebounced();
                this.updateProfileSummaries();
            });
        }
        $("#gm_profile_drawers").on("click", ".gm_drawer_header", function () {
            $(this).closest(".gm_drawer").toggleClass("open");
        });

        // Custom instructions popup (pre-pass / post-pass standing notes).
        $("#gm_custom_instructions").on("click", () => this.openCustomInstructions());
    },

    // ---------- custom instructions popup ----------
    // Two standing instruction fields injected verbatim into the specialists'
    // prompt contexts: pre-pass (router) and post-pass (tracker). Use them for
    // summaries, clock times, chronograms, house rules — anything the
    // specialists should always know.
    openCustomInstructions() {
        const s = this._settings();
        s.custom_instructions = s.custom_instructions || { pre: "", post: "" };

        const overlay = $("<div>").addClass("gm_modal_overlay");
        const dialog = $("<div>").addClass("gm_modal");
        const preArea = $("<textarea>").addClass("gm_modal_textarea").val(s.custom_instructions.pre || "")
            .attr("placeholder", "Standing instructions for the PRE-PASS router (judges every action)...");
        const postArea = $("<textarea>").addClass("gm_modal_textarea").val(s.custom_instructions.post || "")
            .attr("placeholder", "Standing instructions for the POST-PASS tracker (applies state changes)...");

        const close = () => fadeOutRemove(overlay);
        const save = () => {
            s.custom_instructions.pre = String(preArea.val() || "");
            s.custom_instructions.post = String(postArea.val() || "");
            saveSettingsDebounced();
            gmNotify("Custom instructions saved.", "success");
            close();
        };

        dialog.append(
            $("<b>").text("Custom instructions"),
            $("<div>").addClass("gm_modal_hint").text("Injected as a <custom> block into the respective LLM's prompt context on every call. Full SillyTavern macros are supported ({{char}}, {{user}}, {{time}}...)."),
            $("<label>").text("Pre-pass (router)"),
            preArea,
            $("<label>").text("Post-pass (tracker)"),
            postArea,
            $("<div>").addClass("gm_modal_actions").append(
                $("<div>").addClass("menu_button").text("Cancel").on("click", close),
                $("<div>").addClass("menu_button gm_modal_save").text("Save").on("click", save),
            ),
        );
        overlay.append(dialog).appendTo("body");
        overlay.on("mousedown", e => { if (e.target === overlay[0]) close(); });
    },

    // ---------- connection profiles ----------
    // Same pattern as the Recast reference's populateConnectionDropdown():
    // rebuild the options and select the stored value. Only ever called at
    // startup / delayed startup refreshes — NEVER during user interaction,
    // because touching the options while the native dropdown picker is open
    // glitches the selection out.
    // Builds one minimalistic drawer (tooltip header + select) for a registry entry.
    buildProfileDrawer(def) {
        const sel = $("<select>").attr("id", def.select);
        return $("<div>").addClass("gm_drawer").append(
            $("<div>").addClass("gm_drawer_header").attr("title", def.tooltip).append(
                $("<i>").addClass(`fa-solid ${def.icon}`),
                $("<span>").addClass("gm_drawer_title").text(def.label),
                $("<span>").addClass("gm_drawer_value").attr("id", `gm_profile_value_${def.key}`),
                $("<i>").addClass("fa-solid fa-chevron-down gm_drawer_chevron"),
            ),
            $("<div>").addClass("gm_drawer_content").append(
                $("<div>").addClass("gm_drawer_inner").append(
                    $("<div>").addClass("gm_preset_row").append(sel),
                ),
            ),
        );
    },

    populateProfiles() {
        const s = this._settings();
        const profiles = getConnectionProfiles();
        for (const def of PROFILE_DRAWERS) {
            const sel = $(`#${def.select}`).empty();
            sel.append($("<option>").val("").text(def.emptyText));
            for (const p of profiles) sel.append($("<option>").val(p.id).text(p.name));
            if (!profiles.length) {
                sel.append($("<option>").val("").text("— connection manager not active —").prop("disabled", true));
            }
            sel.val(profiles.some(p => p.id === s[def.setting]) ? s[def.setting] : "");
        }
        this.updateProfileSummaries();
        logDebug("connection profiles populated:", profiles.map(p => p.name));
    },

    // Drawer summary labels + the setup warning (no profiles at all, or any
    // warning-marked drawer left on its "Same as ..." fallback).
    updateProfileSummaries() {
        for (const def of PROFILE_DRAWERS) {
            $(`#gm_profile_value_${def.key}`).text($(`#${def.select}`).find("option:selected").text());
        }
        const anyFallback = PROFILE_DRAWERS.some(d => d.warning && !$(`#${d.select}`).val());
        $("#gm_no_profile_warning").toggle(!getConnectionProfiles().length || anyFallback);
    },

    _settings() {
        return extension_settings[extensionName];
    },

    getActivePreset() {
        const s = this._settings();
        return s.presets.find(p => p.name === s.active_preset) || s.presets[0] || null;
    },

    populatePresets() {
        const s = this._settings();
        const sel = $("#gm_preset_select").empty();
        for (const p of s.presets) sel.append($("<option>").val(p.name).text(p.name));
        sel.val(this.getActivePreset()?.name ?? "");
    },

    // Fresh, id-stamped entries for every character container from a preset template.
    getTemplateEntries(preset = this.getActivePreset()) {
        const out = {};
        for (const [container, type] of Object.entries(CONTAINER_TYPES)) {
            // Party-level containers (shared resources, custom) are not part of a character template.
            if (GM_SCHEMA[type].partyLevel) continue;
            out[container] = (preset?.characterTemplate?.[container] || []).map(e => defaultEntry(type, e));
        }
        return out;
    },

    savePreset() {
        const s = this._settings();
        const name = window.prompt("Save preset as:", s.active_preset || "New Preset");
        if (!name) return;
        const template = { resources: [], attributes: [], inventory: [], skills: [], passives: [] };
        const char = stateManager.getActiveCharacter();
        if (char) {
            for (const container of Object.keys(template)) {
                template[container] = (char[container] || []).map(({ id, ...rest }) => structuredClone(rest));
            }
        }
        const shared = stateManager.getData().sharedResources.map(({ id, ...rest }) => structuredClone(rest));
        const preset = { name, characterTemplate: template, sharedResources: shared };
        const existing = s.presets.findIndex(p => p.name === name);
        if (existing !== -1) s.presets[existing] = preset;
        else s.presets.push(preset);
        s.active_preset = name;
        saveSettingsDebounced();
        this.populatePresets();
        gmNotify(`Preset "${name}" saved.`, "success");
        logDebug("preset saved:", preset);
    },

    loadPreset() {
        const preset = this.getActivePreset();
        if (!preset) return;
        const d = stateManager.getData();
        d.sharedResources = (preset.sharedResources || []).map(e => defaultEntry("shared", e));
        stateManager.emitChange("preset_loaded");
        gmNotify(
            `Preset "${preset.name}" loaded — shared resources replaced and new characters will use this template. ` +
            `Unlock edit mode and open a character to apply the template to them (wand button).`,
            "info", 8000
        );
    },

    deletePreset() {
        const s = this._settings();
        const preset = this.getActivePreset();
        if (!preset) return;
        if (preset.name === "Default Preset") {
            gmNotify("The default preset cannot be deleted.", "warning");
            return;
        }
        if (!window.confirm(`Delete preset "${preset.name}"?`)) return;
        s.presets = s.presets.filter(p => p !== preset);
        s.active_preset = s.presets[0]?.name ?? "";
        saveSettingsDebounced();
        this.populatePresets();
        gmNotify(`Preset "${preset.name}" deleted.`, "info");
    },

    applyTemplateToCharacter(char) {
        const preset = this.getActivePreset();
        if (!preset || !char) return;
        const entries = this.getTemplateEntries(preset);
        for (const key of Object.keys(entries)) char[key] = entries[key];
        stateManager.emitChange("template_applied");
        gmNotify(`Applied "${preset.name}" template to ${char.name}.`, "success");
    },
};