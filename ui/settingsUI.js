import { extension_settings, getContext } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../core/constants.js";
import { gmNotify, logDebug } from "../core/debug.js";
import { CONTAINER_TYPES, GM_SCHEMA, defaultEntry } from "../core/schemas.js";
import { stateManager } from "../core/stateManager.js";
import { swapProfile } from "../util/profileSwapper.js";
import { fadeOutRemove } from "../util/fx.js";
import { getConnectionProfiles, getProfileNameById, resolveConnectionProfile } from "../util/connectionService.js";

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
        $("#gm_profile_select").on("change", () => {
            extension_settings[extensionName].connection_profile = $("#gm_profile_select").val();
            saveSettingsDebounced();
        });
        $("#gm_premaster_profile_select").on("change", () => {
            extension_settings[extensionName].premaster_profile = $("#gm_premaster_profile_select").val();
            saveSettingsDebounced();
        });
        $("#gm_wizard_profile_select").on("change", () => {
            extension_settings[extensionName].wizard_profile = $("#gm_wizard_profile_select").val();
            saveSettingsDebounced();
        });
        $("#gm_profile_swap").on("click", async () => {
            const targetId = $("#gm_profile_select").val();
            const targetName = targetId ? getProfileNameById(getContext(), targetId) : null;
            if (!targetName) {
                gmNotify("No connection profile selected.", "warning");
                return;
            }
            // Resolve the currently active profile name so swapProfile() can
            // skip the swap when the target is already active (same pattern
            // as core/agentRunner.js and the Recast reference).
            const st = getContext();
            const currentName = st.extensionSettings?.connectionManager?.selectedProfileName
                || getProfileNameById(st, resolveConnectionProfile(st, ""));
            gmNotify(`Swapping to connection profile "${targetName}"...`, "info");
            const ok = await swapProfile(targetName, currentName);
            gmNotify(
                ok ? `Swapped to connection profile "${targetName}".` : "Profile swap failed — check the console for details.",
                ok ? "success" : "error"
            );
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
    populateProfiles() {
        const s = this._settings();
        const profiles = getConnectionProfiles();
        const agenticSel = $("#gm_profile_select").empty();
        const premasterSel = $("#gm_premaster_profile_select").empty();
        const wizardSel = $("#gm_wizard_profile_select").empty();
        agenticSel.append($("<option>").val("").text("Same as Current"));
        premasterSel.append($("<option>").val("").text("Same as Agentic"));
        wizardSel.append($("<option>").val("").text("Same as Pre-master"));
        for (const p of profiles) {
            agenticSel.append($("<option>").val(p.id).text(p.name));
            premasterSel.append($("<option>").val(p.id).text(p.name));
            wizardSel.append($("<option>").val(p.id).text(p.name));
        }
        if (!profiles.length) {
            agenticSel.append($("<option>").val("").text("— connection manager not active —").prop("disabled", true));
            premasterSel.append($("<option>").val("").text("— connection manager not active —").prop("disabled", true));
            wizardSel.append($("<option>").val("").text("— connection manager not active —").prop("disabled", true));
        }
        agenticSel.val(profiles.some(p => p.id === s.connection_profile) ? s.connection_profile : "");
        premasterSel.val(profiles.some(p => p.id === s.premaster_profile) ? s.premaster_profile : "");
        wizardSel.val(profiles.some(p => p.id === s.wizard_profile) ? s.wizard_profile : "");
        logDebug("connection profiles populated:", profiles.map(p => p.name));
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