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
    // World Info to the extension's LLMs (wizard + pre/post pass). Off by
    // default: it raises the token cost of every call.
    deep_context: false,

    // Deep context for the specialist engines (dice roller + transactions)
    // only — separate toggle since those calls are frequent and cheap.
    deep_context_engines: false,

    // Agentic feature toggles — every feature can be disabled separately.
    feature_warnings: true,       // AI-managed warnings (panel note + low-priority injection).
    feature_dice: true,           // Dice rolls (pre-master LLM on skill mentions).
    feature_transactions: true,   // Fair-use transactions (pre-master LLM on shared resource mentions).
    feature_injection: true,      // {{gamemaster-*}} macros inject warnings/context into prompts.
    feature_enemies: true,        // Context-based enemies (AI-managed sheets, archived when irrelevant).
    feature_rewrite: true,        // Pre-pass rewrites vague/contradictory actions (highlighted tag + high-priority injection).
    feature_progression: true,    // EXP/levels/skill points (per-scenario curve, <grant_exp> tool tag).
    feature_skill_tree: true,     // Per-character skill trees (LLM-generated segments, unlocked with skill points).
    feature_combat: true,         // Combat Mode (Text): opposed resolution (ally AI + enemy AI + clash + dice).
    feature_ally_ai: true,        // ALLY AI invents actions for party members the player didn't command.
    combat_max_enemy_actions: 6,  // Sanity cap on enemy actions per combat round.
    feature_death: true,          // Permadeath: the post-pass may kill characters (<deaths> tag); only the user revives.

    // Standing instructions injected verbatim into the specialists' prompt
    // contexts (summaries, clock times, chronograms, house rules...).
    custom_instructions: { pre: "", post: "" },

    presets: structuredClone(defaultPresets),
    active_preset: "Default Preset",

    connection_profile: "", // Connection profile id for the extension's own AI calls ("" = same as current connection).
    premaster_profile: "",  // Connection profile id for pre-master calls (dice rolls / transactions). "" = same as connection_profile.
    wizard_profile: "",     // Connection profile id for the scenario build wizard (less agentic). "" = same as premaster chain.
    combat_profile: "",     // Connection profile id for the combat passes (ally/enemy/clash). "" = same as premaster chain.
    legacy_api: false, // LEGACY: swap the active connection profile for extension AI calls instead of per-request profiles.
    edit_mode: false, // When off, all resource/entry mutation controls are hidden (view-only, hardcore feel).
    window_opacity: 95, // Floating window background opacity in percent.

    // Notifications — status-bubble popups for game-state events. Suppressed
    // while edit mode is on (the user's own edits would be pure noise).
    notify_enabled: true,     // Master switch for every notification.
    notify_stats: true,       // Resource/attribute changes.
    notify_items: true,       // Items gained or lost.
    notify_skills: true,      // Skills used (cooldown started) and earned (tree unlocks, grants).
    notify_progression: true, // EXP grants and level-ups.
    notify_states: true,      // Deaths, knockouts, recoveries and status effects.
    notify_enemies: false,    // Also notify for enemy sheets (HP changes, skill use...).
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
    $("#gm_setting_deep_context_engines").prop("checked", !!s.deep_context_engines);
    $("#gm_setting_feat_warnings").prop("checked", !!s.feature_warnings);
    $("#gm_setting_feat_dice").prop("checked", !!s.feature_dice);
    $("#gm_setting_feat_transactions").prop("checked", !!s.feature_transactions);
    $("#gm_setting_feat_injection").prop("checked", !!s.feature_injection);
    $("#gm_setting_feat_enemies").prop("checked", !!s.feature_enemies);
    $("#gm_setting_feat_rewrite").prop("checked", !!s.feature_rewrite);
    $("#gm_setting_feat_progression").prop("checked", !!s.feature_progression);
    $("#gm_setting_feat_skill_tree").prop("checked", !!s.feature_skill_tree);
    $("#gm_setting_feat_combat").prop("checked", !!s.feature_combat);
    $("#gm_setting_feat_ally_ai").prop("checked", !!s.feature_ally_ai);
    $("#gm_setting_feat_death").prop("checked", !!s.feature_death);
    $("#gm_setting_bg_opacity").val(Number.isFinite(+s.window_opacity) ? +s.window_opacity : 95);
    $("#gm_bg_opacity_value").text(`${s.window_opacity}%`);
    $("#gm_setting_notify").prop("checked", !!s.notify_enabled);
    $("#gm_setting_notify_stats").prop("checked", !!s.notify_stats);
    $("#gm_setting_notify_items").prop("checked", !!s.notify_items);
    $("#gm_setting_notify_skills").prop("checked", !!s.notify_skills);
    $("#gm_setting_notify_progression").prop("checked", !!s.notify_progression);
    $("#gm_setting_notify_states").prop("checked", !!s.notify_states);
    $("#gm_setting_notify_enemies").prop("checked", !!s.notify_enemies);

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
    s.deep_context_engines = $("#gm_setting_deep_context_engines").prop("checked");
    s.feature_warnings = $("#gm_setting_feat_warnings").prop("checked");
    s.feature_dice = $("#gm_setting_feat_dice").prop("checked");
    s.feature_transactions = $("#gm_setting_feat_transactions").prop("checked");
    s.feature_injection = $("#gm_setting_feat_injection").prop("checked");
    s.feature_enemies = $("#gm_setting_feat_enemies").prop("checked");
    s.feature_rewrite = $("#gm_setting_feat_rewrite").prop("checked");
    s.feature_progression = $("#gm_setting_feat_progression").prop("checked");
    s.feature_skill_tree = $("#gm_setting_feat_skill_tree").prop("checked");
    s.feature_combat = $("#gm_setting_feat_combat").prop("checked");
    s.feature_ally_ai = $("#gm_setting_feat_ally_ai").prop("checked");
    s.feature_death = $("#gm_setting_feat_death").prop("checked");
    s.notify_enabled = $("#gm_setting_notify").prop("checked");
    s.notify_stats = $("#gm_setting_notify_stats").prop("checked");
    s.notify_items = $("#gm_setting_notify_items").prop("checked");
    s.notify_skills = $("#gm_setting_notify_skills").prop("checked");
    s.notify_progression = $("#gm_setting_notify_progression").prop("checked");
    s.notify_states = $("#gm_setting_notify_states").prop("checked");
    s.notify_enemies = $("#gm_setting_notify_enemies").prop("checked");
    saveSettingsDebounced();
}

export function initSettingsListeners() {
    $("#gm_setting_enabled, #gm_setting_auto_update, #gm_setting_debug_mode, #gm_setting_open_panel, #gm_setting_legacy, #gm_setting_pre_pass, " +
      "#gm_setting_feat_wizard, #gm_setting_feat_char_creator, #gm_setting_deep_context, #gm_setting_deep_context_engines, " +
      "#gm_setting_feat_warnings, #gm_setting_feat_dice, #gm_setting_feat_transactions, #gm_setting_feat_injection, " +
      "#gm_setting_feat_enemies, #gm_setting_feat_rewrite, #gm_setting_feat_progression, #gm_setting_feat_skill_tree, " +
      "#gm_setting_feat_combat, #gm_setting_feat_ally_ai, #gm_setting_feat_death, " +
      "#gm_setting_notify, #gm_setting_notify_stats, #gm_setting_notify_items, #gm_setting_notify_skills, " +
      "#gm_setting_notify_progression, #gm_setting_notify_states, #gm_setting_notify_enemies").on("change", saveSettings);
}

