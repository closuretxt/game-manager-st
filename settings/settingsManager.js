import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { defaultPresets } from "./defaultPresets.js";
import { extensionName } from "../core/constants.js";
import { stateManager } from "../core/stateManager.js";
import { OVERRIDABLE_KEYS, FEATURE_MODES } from "../core/features.js";

// Checkbox wiring: setting key -> element id in index.html. Load, save and
// listeners all iterate this table, so a new toggle is one line here.
const CHECKBOXES = {
    enabled: "gm_setting_enabled",
    auto_update: "gm_setting_auto_update",
    debug_mode: "gm_setting_debug_mode",
    open_panel_on_start: "gm_setting_open_panel",
    feature_bubble_button: "gm_setting_bubble_btn",
    feature_hotbar: "gm_setting_hotbar",
    legacy_api: "gm_setting_legacy",
    pre_pass: "gm_setting_pre_pass",
    feature_setup_wizard: "gm_setting_feat_wizard",
    feature_character_creator: "gm_setting_feat_char_creator",
    feature_spawn_review: "gm_setting_spawn_review",
    dynamic_enemy_creation: "gm_setting_dyn_enemies",
    deep_context: "gm_setting_deep_context",
    deep_context_engines: "gm_setting_deep_context_engines",
    feature_warnings: "gm_setting_feat_warnings",
    feature_dice: "gm_setting_feat_dice",
    feature_transactions: "gm_setting_feat_transactions",
    feature_injection: "gm_setting_feat_injection",
    cache_first: "gm_setting_cache_first",
    feature_enemies: "gm_setting_feat_enemies",
    feature_rewrite: "gm_setting_feat_rewrite",
    feature_skill_suggest: "gm_setting_feat_skill_suggest",
    feature_progression: "gm_setting_feat_progression",
    feature_skill_tree: "gm_setting_feat_skill_tree",
    feature_combat: "gm_setting_feat_combat",
    feature_ally_ai: "gm_setting_feat_ally_ai",
    feature_death: "gm_setting_feat_death",
    feature_roster_rotation: "gm_setting_feat_roster_rotation",
    feature_bonds: "gm_setting_feat_bonds",
    feature_chrono: "gm_setting_feat_chrono",
    tab_inventory: "gm_setting_tab_inventory",
    tab_skills: "gm_setting_tab_skills",
    tab_passives: "gm_setting_tab_passives",
    tab_statuses: "gm_setting_tab_statuses",
    tab_shared: "gm_setting_tab_shared",
    tab_custom: "gm_setting_tab_custom",
    combat_rich_clash_ui: "gm_setting_rich_clash",
    deterministic_clashes: "gm_setting_deterministic_clashes",
    roll_attachment: "gm_setting_roll_attachment",
    value_guidelines: "gm_setting_value_guidelines",
    notify_enabled: "gm_setting_notify",
    notify_stats: "gm_setting_notify_stats",
    notify_items: "gm_setting_notify_items",
    notify_skills: "gm_setting_notify_skills",
    notify_progression: "gm_setting_notify_progression",
    notify_states: "gm_setting_notify_states",
    notify_dice: "gm_setting_notify_dice",
    notify_enemies: "gm_setting_notify_enemies",
    notify_bonds: "gm_setting_notify_bonds",
    notify_attach: "gm_setting_notify_attach",
    notify_chrono: "gm_setting_notify_chrono",
    sound_enabled: "gm_setting_sound",
};

export const defaultSettings = {
    enabled: true,
    auto_update: true, // Parse AI tool-tags (change_values etc.) on received messages. Off while the system is a placeholder.
    debug_mode: false,
    open_panel_on_start: true,
    feature_bubble_button: false, // Mobile-friendly floating bubble that toggles the panel (fades into a ghost when unused).
    bubble_pos: { x: null, y: null }, // Saved bubble position (null = default bottom-right corner).
    feature_hotbar: true, // Action hotbar above the input bar: Skills/Items pills with per-character drawers and one-click action insertion.

    // Pre-pass router — LLM judges every fresh action instead of keyword triggers.
    pre_pass: true,

    // Scenario Setup Wizard — one-button LLM bootstrap of the tracked setup.
    feature_setup_wizard: true,
    max_party_size: 6, // Full character sheets the wizard may propose; extra allies go to the roster.
    wizard_chat_messages: 1, // Recent chat messages included as wizard context.

    // Character Creator — Add Character modal: instant copy from a reference
    // character or preset, or an LLM-generated sheet with a review page.
    feature_character_creator: true,

    // Spawn review — when the post-pass tracker detects a NEW character or
    // enemy (<new_characters> tag), queue a review chip instead of
    // auto-creating a minimal sheet: clicking it generates the full sheet
    // and opens the review page. Requires Character Creator + Agentic updates.
    feature_spawn_review: true,

    // Deep context — send character card, persona, author's note and activated
    // World Info to the extension's LLMs (wizard + pre/post pass). Off by
    // default: it raises the token cost of every call.
    deep_context: true,

    // Deep context for the specialist engines (dice roller + transactions)
    // only — separate toggle since those calls are frequent and cheap.
    deep_context_engines: false,

    // Agentic feature toggles — every feature can be disabled separately.
    feature_warnings: true,       // AI-managed warnings (panel note + low-priority injection).
    feature_dice: true,           // Dice rolls (pre-master LLM on skill mentions).
    feature_transactions: true,   // Fair-use transactions (pre-master LLM on shared resource mentions).
    feature_injection: true,      // {{gamemaster-*}} macros inject warnings/context into prompts.
    cache_first: true,            // Low-priority block = persistent state only; per-turn context rides in the high-priority macro.
    feature_enemies: true,        // Context-based enemies (AI-managed sheets, archived when irrelevant).
    feature_rewrite: true,        // Pre-pass rewrites vague/contradictory actions (highlighted tag + high-priority injection).
    feature_skill_suggest: true,  // Pre-pass suggests a tracked skill that fits the action (high-priority narration hint).
    feature_progression: true,    // EXP/levels/skill points (per-scenario curve, <grant_exp> tool tag).
    feature_skill_tree: true,     // Per-character skill trees (LLM-generated segments, unlocked with skill points).
    feature_combat: true,         // Combat Mode (Text): opposed resolution (ally AI + enemy AI + clash + dice).
    feature_ally_ai: true,        // ALLY AI invents actions for party members the player didn't command.
    combat_max_enemy_actions: 6,  // Sanity cap on enemy actions per combat round.
    combat_rich_clash_ui: false,  // Rich clash bubble: face-off title, role chips, VS badge. Off = simple layout.
    deterministic_clashes: false, // Clash resolver commits sheet-derived damage expressions, costs and statuses into the tier outcome lines (tracker applies them exactly). Off = descriptive outcomes only.
    roll_attachment: true,        // Roll/combat results render as file-style chips under the player's message.
    roll_duration: 1600,          // Dice roll animation length in ms (a random ±200ms variation is added per roll).
    feature_death: true,          // Permadeath: the post-pass may kill characters (<deaths> tag); only the user revives.
    feature_roster_rotation: false, // The post-pass tracker benches party characters no longer in the scene with the player and recalls benched ones who rejoin (up to the party cap).
    feature_bonds: false,         // Bonds: NPC feelings toward the player (scenario-defined bars moved only by bond statuses). On in the Romance / Slice of life modes.
    feature_chrono: false,        // Time: world clock (deltas after the anchor), daily schedules of the present cast, long-term objectives — kept by the post-pass. On in every mode preset.

    // Per-chat feature modes (core/features.js). The feature_* flags above and
    // the tab toggles below are the GLOBAL defaults ("Custom" mode); each chat
    // may pick a mode preset and override single toggles.
    default_mode: "custom",
    tab_inventory: true,
    tab_skills: true,
    tab_passives: true,
    tab_statuses: true,
    tab_shared: true,     // Resource Manager tab (shared party resources).
    tab_custom: true,

    // Standing instructions injected verbatim into the specialists' prompt
    // contexts (summaries, clock times, chronograms, house rules...).
    custom_instructions: { pre: "", post: "" },

    // Deep context outlet filter (outlets only — plain WI text is untouched).
    // "blacklist" injects every outlet except the listed ones (empty list =
    // all), "whitelist" injects only the listed ones, "off" skips lorebook /
    // outlet parsing in deep context entirely.
    deep_context_outlet_mode: "whitelist",
    deep_context_outlet_list: "", // Comma-separated outlet names for the filter above.

    // Show all to Wizard — wizard-family calls (scenario creation, character /
    // enemy generation) bypass the outlet filter and receive the full
    // activated World Info.
    deep_context_wizard_show_all: false,

    // Speaker label for the player's lines in the engines' prompt contexts.
    // Empty = the current persona name.
    player_label: "",

    // Speaker label for the AI's lines in the engines' prompt contexts.
    // Empty = the message's own character name.
    char_label: "Narrator",

    presets: structuredClone(defaultPresets),
    active_preset: "Default Preset",

    connection_profile: "", // Connection profile id for the extension's own AI calls ("" = same as current connection).
    premaster_profile: "",  // Connection profile id for pre-master calls (dice rolls / transactions). "" = same as connection_profile.
    wizard_profile: "",     // Connection profile id for the scenario build wizard (less agentic). "" = same as premaster chain.
    combat_profile: "",    // Connection profile id for the combat AI passes (ally/enemy actions). "" = same as premaster chain.
    dice_profile: "",      // Connection profile id for chance calculations (dice rolls). "" = same as premaster chain.
    enemy_creation_profile: "", // Connection profile id for automatic enemy generation (spawn-review popup flow). "" = same as wizard chain.
    dynamic_enemy_creation: false, // When on, tracker-detected enemies are auto-generated and injected — no review popup (requires Spawn review).
    legacy_api: false, // LEGACY: swap the active connection profile for extension AI calls instead of per-request profiles.
    edit_mode: false, // When off, all resource/entry mutation controls are hidden (view-only, hardcore feel).
    window_opacity: 50, // Floating window background opacity in percent.

    // Notifications — status-bubble popups for game-state events. Suppressed
    // while edit mode is on (the user's own edits would be pure noise).
    notify_enabled: true,     // Master switch for every notification.
    notify_stats: true,       // Resource/attribute changes.
    notify_items: true,       // Items gained or lost.
    notify_skills: true,      // Skills used (cooldown started) and earned (tree unlocks, grants).
    notify_progression: true, // EXP grants and level-ups.
    notify_states: true,      // Deaths, knockouts, recoveries and status effects.
    notify_dice: true,        // True-RNG dice rolls resolved from LLM-reported values.
    notify_enemies: false,    // Also notify for enemy sheets (HP changes, skill use...).
    notify_bonds: true,       // Bond changes (feelings gained/ended/settled, label rewrites).
    notify_attach: true,      // Also log the post-pass notifications under the AI message that caused them.
    notify_chrono: true,      // Time: new days, time skips of an hour or more, objectives added/updated/done.

    // Prompt guidance — shared NUMERIC VALUE GUIDELINES (core/valueGuidelines.js)
    // injected into the engine prompts (tracker, combat engines, pre-pass).
    // Off = engines keep their own local instructions; the value resolver
    // keeps parsing arithmetic and dice regardless.
    value_guidelines: false,

    // Sound FX — synthesized dice sounds (Web Audio, no assets) for rolls and
    // per-tier outcomes in the dice and combat bubbles.
    sound_enabled: true, // Master switch for sound effects.
    sound_volume: 40,    // Sound effect volume in percent.
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

    for (const [key, id] of Object.entries(CHECKBOXES)) {
        $(`#${id}`).prop("checked", !!s[key]);
    }
    $("#gm_setting_roll_duration").val(Number.isFinite(+s.roll_duration) ? +s.roll_duration : 1600);
    $("#gm_roll_duration_value").text(`${((Number(s.roll_duration) || 1600) / 1000).toFixed(1)}s`);
    $("#gm_setting_player_label").val(String(s.player_label || ""));
    $("#gm_setting_char_label").val(String(s.char_label || ""));
    $("#gm_setting_bg_opacity").val(Number.isFinite(+s.window_opacity) ? +s.window_opacity : 95);
    $("#gm_bg_opacity_value").text(`${s.window_opacity}%`);
    $("#gm_setting_sound_volume").val(Number.isFinite(+s.sound_volume) ? +s.sound_volume : 60);
    $("#gm_sound_volume_value").text(`${s.sound_volume}%`);

    // Initialize the game-state store (characters, shared resources, ids).
    stateManager.init();
    refreshFeatureUI();
}

// Writes one checkbox back to the GLOBAL settings. Per-chat changes live in
// the window's Chat Mode dialog (ui/chatModeDialog.js); for overridable keys
// the drawer edits the defaults the "Custom" mode resolves to.
function onCheckbox(key, id) {
    extension_settings[extensionName][key] = $(`#${id}`).prop("checked");
    saveSettingsDebounced();
    // The open chat may follow these defaults — let the panel re-render.
    if (OVERRIDABLE_KEYS.includes(key)) stateManager.emitChange("features");
}

// Kept for index.js's re-export: re-reads every checkbox.
export function saveSettings() {
    for (const [key, id] of Object.entries(CHECKBOXES)) {
        extension_settings[extensionName][key] = $(`#${id}`).prop("checked");
    }
    saveSettingsDebounced();
}

// Re-syncs the drawer's feature section with the global settings (after the
// window's "Save as defaults" rewrote them).
export function refreshFeatureUI() {
    const s = extension_settings[extensionName];
    const sel = $("#gm_setting_default_mode").empty();
    for (const [id, mode] of Object.entries(FEATURE_MODES)) {
        sel.append($("<option>").val(id).text(mode.label));
    }
    sel.val(FEATURE_MODES[s.default_mode] ? s.default_mode : "custom");
    for (const key of OVERRIDABLE_KEYS) {
        const id = CHECKBOXES[key];
        if (id) $(`#${id}`).prop("checked", s[key] !== false);
    }
}

export function initSettingsListeners() {
    for (const [key, id] of Object.entries(CHECKBOXES)) {
        $(`#${id}`).off("change.gmset").on("change.gmset", () => onCheckbox(key, id));
    }
    $("#gm_setting_default_mode").off("change.gm").on("change.gm", () => {
        extension_settings[extensionName].default_mode = $("#gm_setting_default_mode").val() || "custom";
        saveSettingsDebounced();
        stateManager.emitChange("features");
    });
    // Volume slider: live label + persist on input (same feel as the opacity slider).
    $("#gm_setting_sound_volume").off("input.gm").on("input.gm", () => {
        const val = Number($("#gm_setting_sound_volume").val()) || 60;
        extension_settings[extensionName].sound_volume = val;
        $("#gm_sound_volume_value").text(`${val}%`);
        saveSettingsDebounced();
    });
    // Rolling-time slider: live label + persist on input.
    $("#gm_setting_roll_duration").off("input.gm").on("input.gm", () => {
        const val = Number($("#gm_setting_roll_duration").val()) || 1600;
        extension_settings[extensionName].roll_duration = val;
        $("#gm_roll_duration_value").text(`${(val / 1000).toFixed(1)}s`);
        saveSettingsDebounced();
    });
    // Player label: persist on input (used by every engine's prompt context).
    $("#gm_setting_player_label").off("input.gm").on("input.gm", () => {
        extension_settings[extensionName].player_label = String($("#gm_setting_player_label").val() || "");
        saveSettingsDebounced();
    });
    // Character label: persist on input (used by every engine's prompt context).
    $("#gm_setting_char_label").off("input.gm").on("input.gm", () => {
        extension_settings[extensionName].char_label = String($("#gm_setting_char_label").val() || "");
        saveSettingsDebounced();
    });
}

