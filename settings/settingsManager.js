import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { defaultPresets } from "./defaultPresets.js";
import { extensionName } from "../core/constants.js";
import { stateManager } from "../core/stateManager.js";

export const defaultSettings = {
    enabled: true,
    auto_update: false, // Parse AI tool-tags (change_values etc.) on received messages. Off while the system is a placeholder.
    debug_mode: false,
    open_panel_on_start: true,

    // Pre-pass router — LLM judges every fresh action instead of keyword triggers.
    pre_pass: true,

    // Scenario Setup Wizard — one-button LLM bootstrap of the tracked setup.
    feature_setup_wizard: true,
    max_party_size: 6, // Full character sheets the wizard may propose; extra allies go to the roster.
    wizard_chat_messages: 1, // Recent chat messages included as wizard context.

    // Character Creator — Add Character modal: instant copy from a reference
    // character or preset, or an LLM-generated sheet with a review page.
    feature_character_creator: true,

    // Deep context — send character card, persona, author's note and activated
    // World Info to the extension's LLMs (wizard + pre-pass). Off by default:
    // it raises the token cost of every pre-pass call.
    deep_context: false,

    // Agentic feature toggles — every feature can be disabled separately.
    feature_warnings: true,       // AI-managed warnings (panel note + low-priority injection).
    feature_dice: true,           // Dice rolls (pre-master LLM on skill mentions).
    feature_transactions: true,   // Fair-use transactions (pre-master LLM on shared resource mentions).
    feature_injection: true,      // {{gamemaster-*}} macros inject warnings/context into prompts.
    feature_enemies: true,        // Context-based enemies (AI-managed sheets, archived when irrelevant).
    feature_rewrite: true,        // Pre-pass rewrites vague/contradictory actions (highlighted tag + high-priority injection).

    // Standing instructions injected verbatim into the specialists' prompt
    // contexts (summaries, clock times, chronograms, house rules...).
    custom_instructions: { pre: "", post: "" },

    presets: structuredClone(defaultPresets),
    active_preset: "Default Preset",

    connection_profile: "", // Connection profile id for the extension's own AI calls ("" = same as current connection).
    premaster_profile: "",  // Connection profile id for pre-master calls (dice rolls / transactions). "" = same as connection_profile.
    wizard_profile: "",     // Connection profile id for the scenario build wizard (less agentic). "" = same as premaster chain.
    legacy_api: false, // LEGACY: swap the active connection profile for extension AI calls instead of per-request profiles.
    edit_mode: false, // When off, all resource/entry mutation controls are hidden (view-only, hardcore feel).
    window_opacity: 95, // Floating window background opacity in percent.
};

export async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];

    // Backfill any missing keys (also survives new settings in updates).
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = typeof value === "object" ? structuredClone(value) : value;
        }
    }
    // Make sure the default preset always exists.
    if (!s.presets.some(p => p.name === "Default Preset")) {
        s.presets.unshift(structuredClone(defaultPresets[0]));
    }

    $("#gm_setting_enabled").prop("checked", !!s.enabled);
    $("#gm_setting_auto_update").prop("checked", !!s.auto_update);
    $("#gm_setting_debug_mode").prop("checked", !!s.debug_mode);
    $("#gm_setting_open_panel").prop("checked", !!s.open_panel_on_start);
    $("#gm_setting_legacy").prop("checked", !!s.legacy_api);
    $("#gm_setting_pre_pass").prop("checked", !!s.pre_pass);
    $("#gm_setting_feat_wizard").prop("checked", !!s.feature_setup_wizard);
    $("#gm_setting_feat_char_creator").prop("checked", !!s.feature_character_creator);
    $("#gm_setting_deep_context").prop("checked", !!s.deep_context);
    $("#gm_setting_feat_warnings").prop("checked", !!s.feature_warnings);
    $("#gm_setting_feat_dice").prop("checked", !!s.feature_dice);
    $("#gm_setting_feat_transactions").prop("checked", !!s.feature_transactions);
    $("#gm_setting_feat_injection").prop("checked", !!s.feature_injection);
    $("#gm_setting_feat_enemies").prop("checked", !!s.feature_enemies);
    $("#gm_setting_feat_rewrite").prop("checked", !!s.feature_rewrite);
    $("#gm_setting_bg_opacity").val(Number.isFinite(+s.window_opacity) ? +s.window_opacity : 95);
    $("#gm_bg_opacity_value").text(`${s.window_opacity}%`);

    // Initialize the game-state store (characters, shared resources, ids).
    stateManager.init();
}

export function saveSettings() {
    const s = extension_settings[extensionName];
    s.enabled = $("#gm_setting_enabled").prop("checked");
    s.auto_update = $("#gm_setting_auto_update").prop("checked");
    s.debug_mode = $("#gm_setting_debug_mode").prop("checked");
    s.open_panel_on_start = $("#gm_setting_open_panel").prop("checked");
    s.legacy_api = $("#gm_setting_legacy").prop("checked");
    s.pre_pass = $("#gm_setting_pre_pass").prop("checked");
    s.feature_setup_wizard = $("#gm_setting_feat_wizard").prop("checked");
    s.feature_character_creator = $("#gm_setting_feat_char_creator").prop("checked");
    s.deep_context = $("#gm_setting_deep_context").prop("checked");
    s.feature_warnings = $("#gm_setting_feat_warnings").prop("checked");
    s.feature_dice = $("#gm_setting_feat_dice").prop("checked");
    s.feature_transactions = $("#gm_setting_feat_transactions").prop("checked");
    s.feature_injection = $("#gm_setting_feat_injection").prop("checked");
    s.feature_enemies = $("#gm_setting_feat_enemies").prop("checked");
    s.feature_rewrite = $("#gm_setting_feat_rewrite").prop("checked");
    saveSettingsDebounced();
}

export function initSettingsListeners() {
    $("#gm_setting_enabled, #gm_setting_auto_update, #gm_setting_debug_mode, #gm_setting_open_panel, #gm_setting_legacy, #gm_setting_pre_pass, " +
      "#gm_setting_feat_wizard, #gm_setting_feat_char_creator, #gm_setting_deep_context, " +
      "#gm_setting_feat_warnings, #gm_setting_feat_dice, #gm_setting_feat_transactions, #gm_setting_feat_injection, " +
      "#gm_setting_feat_enemies, #gm_setting_feat_rewrite").on("change", saveSettings);
}

