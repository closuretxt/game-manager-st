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
    getContestRulesets, setContestRulesets,
} from "../core/features.js";
import {
    CONTEST_MODULES, CONTEST_PRESETS, CONTEST_RULESET_OPTIONS, resolveRuleset, editRuleset, sanitizeRulesets, slotModules,
} from "../core/contest/registry.js";
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
    if (getFeature("feature_combat")) renderRulesetBuilder(body);
}

// ---------- contest ruleset builder (core/contest/registry.js) ----------
// One tab per contest kind; every change goes through editRuleset, which
// keeps the stored ruleset minimal (only what differs from the preset).

let _rulesetKind = "clash";
const KIND_LABELS = { clash: "Fights", race: "Races", scores: "Contests", challenge: "Challenges" };
const SLOT_LABELS = { turn: "Turn order", dice: "Dice", consequence: "Consequences" };

function editRules(patch) {
    const s = extension_settings[extensionName];
    setContestRulesets(editRuleset(getContestRulesets(), _rulesetKind, { ...patch, fallbackPreset: s.contest_preset }));
    changed();
}

// One option control; `value` is what the ruleset holds (undefined = default).
function optionControl(opt, value, onSet) {
    const current = value ?? opt.default;
    let input;
    if (opt.type === "select") {
        input = $("<select>").addClass("text_pole");
        for (const [v, l] of opt.choices || []) input.append($("<option>").val(v).text(l));
        input.val(String(current));
        input.on("change", () => onSet(input.val() === String(opt.default) ? "" : input.val()));
    } else if (opt.type === "number") {
        input = $("<input>").addClass("text_pole").attr({ type: "number", min: opt.min, max: opt.max, step: 1 }).val(current);
        input.on("change", () => {
            const n = Math.trunc(Number(input.val()));
            if (!Number.isFinite(n)) return onSet("");
            const clamped = Math.max(opt.min ?? n, Math.min(opt.max ?? n, n));
            onSet(clamped === opt.default ? "" : clamped);
        });
    } else {
        input = $("<input>").addClass("text_pole").attr({ type: "text", placeholder: String(opt.default ?? "") }).val(value ?? "");
        input.on("change", () => onSet(String(input.val()).trim()));
    }
    const row = $("<div>").addClass("gm_field gm_field_inline").append($("<label>").text(opt.label), input);
    if (opt.hint) row.attr("title", opt.hint);
    return row;
}

function moduleOptions(moduleId, opts) {
    const mod = CONTEST_MODULES[moduleId];
    if (!mod?.options?.length) return null;
    const box = $("<div>").addClass("gm_ruleset_opts");
    const held = opts?.[moduleId] || {};
    for (const opt of mod.options) {
        box.append(optionControl(opt, held[opt.key], v => editRules({ opt: opt.key, module: moduleId, value: v })));
    }
    return box;
}

function renderRulesetBuilder(body) {
    const s = extension_settings[extensionName];
    const kinds = Object.keys(CONTEST_PRESETS);
    if (!kinds.includes(_rulesetKind)) _rulesetKind = kinds[0];
    const all = getContestRulesets() || {};
    const raw = all[_rulesetKind] || {};
    const rs = resolveRuleset(all, _rulesetKind, s.contest_preset);
    const presets = CONTEST_PRESETS[_rulesetKind];

    body.append($("<div>").addClass("gm_settings_subhead")
        .attr("title", "How contests resolve in this chat. Saved with the chat, outside the game state: rolling back a message never changes the rules.")
        .text("Combat rules"));
    if (kinds.length > 1) {
        const tabs = $("<div>").addClass("gm_ruleset_tabs");
        for (const k of kinds) {
            tabs.append($("<div>").addClass("menu_button").toggleClass("active", k === _rulesetKind).text(KIND_LABELS[k] || k)
                .on("click", () => { _rulesetKind = k; changed(); }));
        }
        body.append(tabs);
    }
    if (s.combat_legacy) {
        body.append($("<div>").addClass("gm_modal_hint").text("The global Legacy combat toggle is on: every chat runs the old pipeline until it is switched off in the settings drawer."));
    }

    const globalId = presets[s.contest_preset] && !presets[s.contest_preset].legacy ? s.contest_preset : "universal";
    const presetSel = $("<select>").addClass("text_pole");
    presetSel.append($("<option>").val("").text(`Default: ${presets[globalId]?.label || globalId}`));
    for (const [id, p] of Object.entries(presets)) presetSel.append($("<option>").val(id).text(p.label || id));
    presetSel.val(presets[raw.preset] ? raw.preset : "");
    presetSel.on("change", () => editRules({ preset: presetSel.val() }));
    body.append($("<div>").addClass("gm_field gm_field_inline").append($("<label>").text("Preset"), presetSel));

    if (rs.legacy) {
        body.append($("<div>").addClass("gm_modal_hint").text("Legacy runs the pre-rework pipeline: no slots or options."));
    } else {
        const changedSlots = [];
        for (const slot of Object.keys(SLOT_LABELS)) {
            const sel = $("<select>").addClass("text_pole");
            for (const m of slotModules(slot)) sel.append($("<option>").val(m.id).text(m.label).attr("title", m.hint));
            sel.val(rs[slot]?.id || "");
            sel.on("change", () => editRules({ slot, value: sel.val() }));
            const row = $("<div>").addClass("gm_field gm_field_inline").append($("<label>").text(SLOT_LABELS[slot]), sel);
            if (rs[slot]?.hint) row.attr("title", rs[slot].hint);
            if (slot in raw) { row.addClass("gm_mode_changed"); changedSlots.push(slot); }
            body.append(row);
            const opts = rs[slot] ? moduleOptions(rs[slot].id, raw.opts) : null;
            if (opts) body.append(opts);
        }

        const on = new Set(rs.mutators.map(m => m.id));
        const grid = $("<div>").addClass("gm_settings_grid");
        for (const m of slotModules("mutators")) {
            const box = $("<input>").attr("type", "checkbox").prop("checked", on.has(m.id));
            box.on("change", () => editRules({ mutator: m.id, on: box.prop("checked") }));
            const row = $("<label>").addClass("checkbox_label").attr("title", m.hint).append(box, $("<span>").text(m.label));
            if (Array.isArray(raw.mutators)) row.addClass("gm_mode_changed");
            grid.append(row);
        }
        body.append($("<div>").addClass("gm_section_hint").text("Extras"), grid);
        for (const m of rs.mutators) {
            const opts = moduleOptions(m.id, raw.opts);
            if (opts) body.append($("<div>").addClass("gm_section_hint").text(m.label), opts);
        }

        for (const opt of CONTEST_RULESET_OPTIONS) {
            body.append(optionControl(opt, raw.opts?.[opt.key], v => editRules({ opt: opt.key, value: v })));
        }
    }

    const exportBtn = $("<div>").addClass("menu_button").attr("title", "Copy this chat's combat rules as JSON").text("Export");
    exportBtn.on("click", async () => {
        const json = JSON.stringify(getContestRulesets() || {}, null, 2);
        try {
            await navigator.clipboard.writeText(json);
            gmNotify("Combat rules copied to the clipboard.", "success");
        } catch {
            window.prompt("Copy the combat rules:", json);
        }
    });
    const importBtn = $("<div>").addClass("menu_button").attr("title", "Paste combat rules JSON (replaces this chat's rules)").text("Import");
    importBtn.on("click", () => {
        const text = window.prompt("Paste combat rules JSON:");
        if (!text?.trim()) return;
        let parsed = null;
        try { parsed = sanitizeRulesets(JSON.parse(text)); } catch { parsed = null; }
        if (!parsed) return gmNotify("That is not a combat rules JSON.", "error");
        setContestRulesets(parsed);
        changed();
        gmNotify("Combat rules imported.", "success");
    });
    const resetBtn = $("<div>").addClass("menu_button").attr("title", "Forget this chat's combat rules — it follows the drawer's default again").text("Reset rules");
    resetBtn.on("click", () => editRules({ reset: true }));
    body.append($("<div>").addClass("gm_modal_actions").append(exportBtn, importBtn, resetBtn));
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
