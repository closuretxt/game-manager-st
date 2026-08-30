// Floating, draggable, resizable Game Manager window.
// Tabs: Party (home) | Resource Manager | Custom.
// All mutation controls (add/edit/delete, +/-) are hidden unless edit mode
// (the lock toggle in the header) is enabled — view-only by default for a
// hardcore feel. Window geometry/open-state persist in extension settings
// (global, not per-chat); z-index is kept deliberately low.

import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../core/constants.js";
import { gmNotify, logDebug } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { manualRun } from "../inject/postTurn.js";
import { getCharacterAvatar, clearAvatarCache } from "../util/avatars.js";
import { settingsUI } from "./settingsUI.js";
import { characterView } from "./characterView.js";
import { customTab } from "./customTab.js";
import { resourceManager } from "./resourceManager.js";
import { setupWizard } from "./setupWizard.js";
import { characterCreator } from "./characterCreator.js";
import { iconBtn } from "./characterView.js";

const TABS = [
    { id: "party", label: "Party", icon: "fa-solid fa-users" },
    { id: "enemies", label: "Enemies", icon: "fa-solid fa-skull" },
    { id: "shared", label: "Resource Manager", icon: "fa-solid fa-coins" },
    { id: "custom", label: "Custom", icon: "fa-solid fa-seedling" },
];

// Sub-tabs inside a character sheet (they can hold a lot of entries).
const CHAR_TABS = [
    { id: "stats", label: "Basic Stats", icon: "fa-solid fa-heart-pulse" },
    { id: "inventory", label: "Inventory", icon: "fa-solid fa-box-open" },
    { id: "skills", label: "Skills", icon: "fa-solid fa-bolt" },
    { id: "passives", label: "Passives", icon: "fa-solid fa-shield-halved" },
    { id: "statuses", label: "Statuses", icon: "fa-solid fa-face-dizzy" },
];

class MainPanel {
    constructor() {
        this.root = null;
        this.activeTab = "party";
        this.selectedCharacterId = null;
        this.activeCharTab = "stats";
        this.selectedEnemyId = null;
        this.activeEnemyTab = "stats";
        this._resizeTimer = null;
        this._resizeObserver = null;
    }

    get _window() {
        // Window geometry/open-state are global UI prefs (settings), not chat data.
        const s = extension_settings[extensionName];
        s.window_state = s.window_state || {};
        return s.window_state;
    }

    get editMode() {
        return !!extension_settings[extensionName].edit_mode;
    }

    // ---------- lifecycle ----------
    init() {
        this.root = $("#gm_floating_window");
        const win = this._window;

        if (win.w && win.h) this.root.css({ width: win.w + "px", height: win.h + "px" });
        this.root.css({ left: (win.x ?? this._defaultX()) + "px", top: (win.y ?? 70) + "px" });
        this._clampIntoViewport();

        this._initDrag();
        this._initResize();
        this._initOpacitySetting();
        this.applyBackgroundOpacity();

        $("#gm_btn_close").on("click", () => this.close());
        $("#gm_btn_minimize").on("click", () => this.toggleMinimize());
        $("#gm_btn_edit").on("click", () => this.toggleEditMode());
        $("#gm_btn_rerun").on("click", async () => {
            gmNotify("Running agent pass...", "info");
            const applied = await manualRun();
            gmNotify(applied ? `Agent pass applied ${applied} change(s).` : "Agent pass: no changes.", "success");
        });
        $("#gm_open_panel").on("click", () => this.open());

        const shouldOpen = win.open ?? extension_settings[extensionName].open_panel_on_start;
        if (shouldOpen) this.open(false);
        else this.root.hide();

        stateManager.onChange(() => this.render());
        stateManager.onChange((reason) => {
            if (reason === "chat_loaded") clearAvatarCache();
        });
        this.render();
        logDebug("main panel initialized");
    }

    // ---------- background opacity ----------
    // Tints the window with the theme's blur tint color at the user-chosen
    // alpha, so transparency follows the current ST theme.
    applyBackgroundOpacity() {
        const pct = Number(extension_settings[extensionName].window_opacity ?? 95) / 100;
        const raw = (getComputedStyle(document.documentElement)
            .getPropertyValue("--SmartThemeBlurTintColor") || "").trim()
            || "rgba(23, 23, 28, 0.97)";
        const [r, g, b] = this._parseColor(raw);
        this.root.css("background-color", `rgba(${r}, ${g}, ${b}, ${pct})`);
    }

    _parseColor(str) {
        str = String(str).trim();
        if (str.startsWith("#")) {
            let hex = str.slice(1);
            if (hex.length === 3 || hex.length === 4) {
                hex = hex.slice(0, 3).split("").map(c => c + c).join("");
            }
            return [
                parseInt(hex.slice(0, 2), 16) || 0,
                parseInt(hex.slice(2, 4), 16) || 0,
                parseInt(hex.slice(4, 6), 16) || 0,
            ];
        }
        const m = str.match(/rgba?\(([^)]+)\)/);
        if (m) {
            return m[1].split(",").slice(0, 3).map(v => parseFloat(v) || 0);
        }
        return [23, 23, 28]; // neutral dark fallback
    }

    _initOpacitySetting() {
        $("#gm_setting_bg_opacity").off("input.gm").on("input.gm", () => {
            const val = Number($("#gm_setting_bg_opacity").val()) || 95;
            extension_settings[extensionName].window_opacity = val;
            $("#gm_bg_opacity_value").text(`${val}%`);
            saveSettingsDebounced();
            if (this.root) this.applyBackgroundOpacity();
        });
    }

    _defaultX() {
        return Math.max(10, window.innerWidth - 460);
    }

    _clampIntoViewport() {
        const w = this.root.outerWidth() || 400;
        const h = this.root.outerHeight() || 300;
        let x = parseFloat(this.root.css("left")) || 0;
        let y = parseFloat(this.root.css("top")) || 0;
        x = Math.min(Math.max(x, -(w - 90)), window.innerWidth - 90);
        y = Math.min(Math.max(y, 0), window.innerHeight - 60);
        this.root.css({ left: x + "px", top: y + "px" });
    }

    open(persist = true) {
        this.root.removeClass("gm_minimized").show();
        if (persist !== false) {
            const win = this._window;
            win.open = true;
            win.minimized = false;
            saveSettingsDebounced();
        }
        this.render();
    }

    close() {
        this.root.hide();
        const win = this._window;
        win.open = false;
        saveSettingsDebounced();
    }

    toggle() {
        if (this.root.is(":visible")) this.close();
        else this.open();
    }

    toggleMinimize() {
        this.root.toggleClass("gm_minimized");
        const win = this._window;
        win.minimized = this.root.hasClass("gm_minimized");
        saveSettingsDebounced();
    }

    toggleEditMode() {
        const s = extension_settings[extensionName];
        s.edit_mode = !s.edit_mode;
        saveSettingsDebounced();
        this.render();
    }

    // ---------- geometry ----------
    _saveGeometry() {
        const win = this._window;
        win.w = this.root.outerWidth();
        win.h = this.root.outerHeight();
        win.x = parseFloat(this.root.css("left"));
        win.y = parseFloat(this.root.css("top"));
        saveSettingsDebounced();
    }

    _initDrag() {
        let dragging = null;
        $("#gm_window_header").off("mousedown.gmdrag").on("mousedown.gmdrag", (e) => {
            if ($(e.target).closest(".gm_window_btn").length) return;
            const rect = this.root[0].getBoundingClientRect();
            dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
            e.preventDefault();
        });
        $(document).off("mousemove.gmdrag").on("mousemove.gmdrag", (e) => {
            if (!dragging) return;
            const w = this.root.outerWidth() || 400;
            const x = Math.min(Math.max(e.clientX - dragging.dx, -(w - 90)), window.innerWidth - 90);
            const y = Math.min(Math.max(e.clientY - dragging.dy, 0), window.innerHeight - 60);
            this.root.css({ left: x + "px", top: y + "px" });
        });
        $(document).off("mouseup.gmdrag").on("mouseup.gmdrag", () => {
            if (!dragging) return;
            dragging = null;
            this._saveGeometry();
        });
    }

    _initResize() {
        if (typeof ResizeObserver === "undefined") return;
        this._resizeObserver = new ResizeObserver(() => {
            if (!this.root.is(":visible")) return;
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this._saveGeometry(), 250);
        });
        this._resizeObserver.observe(this.root[0]);
    }

    // ---------- rendering ----------
    render() {
        if (!this.root) return;
        // Enemies tab only exists when the feature is on AND there is something
        // to show (active enemies, or edit mode to add/archive them).
        const s = extension_settings[extensionName];
        const enemyCount = (stateManager.getData().enemies || []).length;
        if (this.activeTab === "enemies" && !(s.feature_enemies && (enemyCount || this.editMode))) {
            this.activeTab = "party";
        }
        this._refreshEditButton();
        this._renderWarnings();
        this._renderTabs();
        this._renderContent();
    }

    // Player-facing note strip: AI-managed warnings ("food runs out in ~2 days").
    _renderWarnings() {
        const strip = $("#gm_warning_strip").empty();
        const warnings = stateManager.getData().warnings || [];
        if (!warnings.length || this.root.hasClass("gm_minimized")) return;
        for (const w of warnings) {
            const row = $("<div>").addClass("gm_warning_row");
            row.append($("<i>").addClass("fa-solid fa-triangle-exclamation"));
            row.append($("<span>").text(w.text || w.name));
            const dismiss = $("<i>").addClass("fa-solid fa-xmark gm_warning_dismiss");
            dismiss.on("click", (e) => {
                e.stopPropagation();
                stateManager.removeWarning(w.id);
            });
            row.append(dismiss);
            strip.append(row);
        }
    }

    _refreshEditButton() {
        $("#gm_btn_edit").find("i").attr("class", this.editMode ? "fa-solid fa-lock-open" : "fa-solid fa-lock");
        $("#gm_btn_rerun").toggle(this.editMode);
    }

    _renderTabs() {
        const bar = $("#gm_tab_bar").empty();
        const s = extension_settings[extensionName];
        const enemyCount = (stateManager.getData().enemies || []).length;
        for (const tab of TABS) {
            // Enemies tab hidden entirely when unused — no trace in the UI.
            if (tab.id === "enemies" && !(s.feature_enemies && (enemyCount || this.editMode))) continue;
            const btn = $("<div>")
                .addClass("gm_tab")
                .toggleClass("active", tab.id === this.activeTab)
                .append($("<i>").addClass(tab.icon), $("<span>").text(tab.label));
            btn.on("click", () => {
                this.activeTab = tab.id;
                this.render();
            });
            bar.append(btn);
        }
    }

    _renderContent() {
        const content = $("#gm_tab_content").empty();
        const edit = this.editMode;
        switch (this.activeTab) {
            case "shared":
                resourceManager.render(content, edit);
                break;
            case "custom":
                customTab.render(content, edit);
                break;
            case "enemies": {
                const enemy = this.selectedEnemyId ? stateManager.getEnemy(this.selectedEnemyId) : null;
                if (enemy) this._renderEnemySheet(content, enemy, edit);
                else this._renderEnemyList(content, edit);
                break;
            }
            case "party":
            default: {
                const char = this.selectedCharacterId ? stateManager.getCharacter(this.selectedCharacterId) : null;
                if (char) this._renderCharacterSheet(content, char, edit);
                else this._renderPartyList(content, edit);
                break;
            }
        }
    }

    // ---------- Party tab: character list (home) ----------
    // Avatar with layered fallbacks: icon placeholder until resolved, icon
    // again if the resolved picture fails to load. Never leaves a broken <img>.
    // Matches the ST character of the same name for its picture.
    _buildAvatar(name, large = false) {
        const wrap = $("<div>").addClass("gm_avatar").toggleClass("gm_avatar_lg", large);
        const icon = $("<i>").addClass("fa-solid fa-user");
        const img = $("<img>").attr("alt", "").hide();
        img.on("error", () => {
            img.hide().removeAttr("src");
            icon.show();
        });
        wrap.append(icon, img);
        getCharacterAvatar(name).then(url => {
            if (url && img.length) {
                img.attr("src", url).show();
                icon.hide();
            }
        }).catch(() => { /* keep placeholder */ });
        return wrap;
    }

    _renderPartyList(content, edit) {
        const s = extension_settings[extensionName];
        const wrap = $("<div>").addClass("gm_list");
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text("Party"),
            $("<span>").addClass("gm_section_hint").text("Tracked characters. Select one to open their sheet."),
        );
        if (edit) {
            if (s.feature_setup_wizard) {
                const wizardBtn = $("<div>").addClass("menu_button gm_add_btn").append(
                    $("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Setup Scenario"));
                wizardBtn.on("click", () => setupWizard.open());
                header.append(wizardBtn);
            }
            const addBtn = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add Character"));
            addBtn.on("click", () => {
                // Character Creator modal (instant copy or LLM-generated sheet
                // with review); legacy prompt flow when the feature is off.
                if (s.feature_character_creator) {
                    characterCreator.onApplied = (char) => {
                        this.selectedCharacterId = char.id;
                        this.render();
                    };
                    characterCreator.open();
                    return;
                }
                const name = window.prompt("Character name:");
                if (name?.trim()) {
                    const c = stateManager.addCharacter(name.trim(), settingsUI.getTemplateEntries());
                    this.selectedCharacterId = c.id;
                }
            });
            header.append(addBtn);

            // Party cap — max full sheets the Setup Wizard proposes; extra
            // allies go to the roster. Lives here (edit mode only) instead of
            // the settings drawer.
            const capWrap = $("<div>").addClass("gm_cap_wrap")
                .attr("title", "Max full character sheets the Setup Wizard proposes; extra allies go to the roster");
            capWrap.append($("<span>").text("Cap"));
            const capInput = $("<input>")
                .addClass("gm_input gm_cap_input")
                .attr({ type: "number", min: "1", max: "20", step: "1" })
                .val(Math.max(1, Math.trunc(Number(s.max_party_size) || 6)));
            capInput.on("change", () => {
                s.max_party_size = Math.max(1, Math.trunc(Number(capInput.val()) || 6));
                capInput.val(s.max_party_size);
                saveSettingsDebounced();
            });
            capWrap.append(capInput);
            header.append(capWrap);
        }

        const list = $("<div>").addClass("gm_entry_list");
        const chars = stateManager.getCharacters();
        for (const c of chars) {
            const row = $("<div>").addClass("gm_entry_row gm_party_row");
            const top = $("<div>").addClass("gm_entry_top");

            const nameWrap = $("<div>").addClass("gm_entry_main");
            nameWrap.append(this._buildAvatar(c.name));
            nameWrap.append($("<span>").addClass("gm_entry_name").text(c.name));
            top.append(nameWrap);

            const chips = $("<div>").addClass("gm_party_summary");
            for (const r of c.resources.slice(0, 4)) {
                chips.append($("<span>").addClass("gm_party_chip").text(`${r.name} ${r.value}/${r.max}`));
            }
            top.append(chips);
            row.append(top);
            row.on("click", () => {
                this.selectedCharacterId = c.id;
                this.render();
            });
            list.append(row);
        }
        if (!chars.length) {
            list.append($("<div>").addClass("gm_empty")
                .text("No characters yet. Unlock edit mode (lock icon in the header) to add one."));
        }
        wrap.append(header, list);
        content.append(wrap);

        this._renderRoster(content, edit);
    }

    // ---------- Roster: lightweight allies (collapsed chips, never injected) ----------
    _renderRoster(content, edit) {
        const roster = stateManager.getData().roster || [];
        const wrap = $("<div>").addClass("gm_list");
        wrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text(`Roster (${roster.length})`),
            $("<span>").addClass("gm_section_hint").text("Allies not fully tracked — promote to Party to track one."),
        ));

        const chips = $("<div>").addClass("gm_roster_chips");
        for (const ally of roster) {
            const chip = $("<div>").addClass("gm_roster_chip").attr("title", ally.note || ally.name);
            chip.append($("<span>").text(ally.name));
            if (edit) {
                const promote = iconBtn("fa-solid fa-user-plus")
                    .attr("title", ally.sheet ? "Promote to Party (restores their last sheet)" : "Promote to Party");
                promote.on("click", (e) => {
                    e.stopPropagation();
                    const c = stateManager.promoteRosterEntry(ally.id);
                    if (c) this.selectedCharacterId = c.id;
                });
                const toEnemy = iconBtn("fa-solid fa-skull").attr("title", "Move to Enemies (keeps their sheet)");
                toEnemy.on("click", (e) => {
                    e.stopPropagation();
                    stateManager.rosterToEnemy(ally.id);
                });
                const del = iconBtn("fa-solid fa-xmark").attr("title", "Remove");
                del.on("click", (e) => {
                    e.stopPropagation();
                    stateManager.removeRosterEntry(ally.id);
                });
                chip.append(promote, toEnemy, del);
            }
            chips.append(chip);
        }
        if (!roster.length) {
            chips.append($("<div>").addClass("gm_empty").text("No roster allies."));
        }
        wrap.append(chips);
        content.append(wrap);
    }

    // ---------- Enemies tab: active enemy list ----------
    // Not in edit mode each enemy is a collapsed flavor row ("2 resources,
    // 1 passive, 1 status") that expands to the full read-only sheet; edit
    // mode shows resource chips, conversion buttons and the archive.
    _enemyFlavor(e) {
        const parts = [];
        if (e.resources?.length) parts.push(`${e.resources.length} resource${e.resources.length > 1 ? "s" : ""}`);
        if (e.attributes?.length) parts.push(`${e.attributes.length} attribute${e.attributes.length > 1 ? "s" : ""}`);
        if (e.skills?.length) parts.push(`${e.skills.length} skill${e.skills.length > 1 ? "s" : ""}`);
        if (e.passives?.length) parts.push(`${e.passives.length} passive${e.passives.length > 1 ? "s" : ""}`);
        if (e.statuses?.length) parts.push(`${e.statuses.length} status${e.statuses.length > 1 ? "es" : ""}`);
        return parts.join(", ") || "No details yet";
    }

    _renderEnemyList(content, edit) {
        const enemies = stateManager.getEnemies();
        const wrap = $("<div>").addClass("gm_list");
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text("Enemies"),
            $("<span>").addClass("gm_section_hint").text("Context-based threats. Removed ones are archived and return with their last state."),
        );
        if (edit) {
            const addBtn = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add Enemy"));
            addBtn.on("click", () => {
                const name = window.prompt("Enemy name:");
                if (name?.trim()) {
                    const e = stateManager.addEnemy(name.trim(), settingsUI.getTemplateEntries());
                    this.selectedEnemyId = e.id;
                }
            });
            header.append(addBtn);
        }

        const list = $("<div>").addClass("gm_entry_list");
        for (const e of enemies) {
            list.append(this._buildEnemyRow(e, edit));
        }
        if (!enemies.length) {
            list.append($("<div>").addClass("gm_empty")
                .text("No enemies in the scene. They appear automatically when the story introduces threats."));
        }
        wrap.append(header, list);
        content.append(wrap);

        if (edit) this._renderEnemyArchive(content);
    }

    _buildEnemyRow(e, edit) {
        const row = $("<div>").addClass("gm_entry_row gm_party_row");
        const top = $("<div>").addClass("gm_entry_top");

        const nameWrap = $("<div>").addClass("gm_entry_main");
        nameWrap.append($("<i>").addClass("fa-solid fa-skull").css({ marginRight: "6px", opacity: 0.85 }));
        nameWrap.append($("<span>").addClass("gm_entry_name").text(e.name));
        top.append(nameWrap);

        if (edit) {
            const chips = $("<div>").addClass("gm_party_summary");
            for (const r of (e.resources || []).slice(0, 4)) {
                chips.append($("<span>").addClass("gm_party_chip").text(`${r.name} ${r.value}/${r.max}`));
            }
            top.append(chips);
        } else {
            // Flavor-only summary; the full sheet stays one click away.
            top.append($("<span>").addClass("gm_section_hint").text(this._enemyFlavor(e)));
        }
        row.append(top);

        if (edit) {
            const actions = $("<div>").addClass("gm_entry_actions");
            const toParty = iconBtn("fa-solid fa-user-plus").attr("title", "Move to Party (keeps their sheet)");
            toParty.on("click", (ev) => {
                ev.stopPropagation();
                stateManager.enemyToCharacter(e.id);
                this.selectedEnemyId = null;
            });
            const toRoster = iconBtn("fa-solid fa-user-group").attr("title", "Move to Roster (keeps their sheet)");
            toRoster.on("click", (ev) => {
                ev.stopPropagation();
                stateManager.enemyToRoster(e.id);
                this.selectedEnemyId = null;
            });
            const archive = iconBtn("fa-solid fa-box-archive").attr("title", "Archive (restored automatically if they return)");
            archive.on("click", (ev) => {
                ev.stopPropagation();
                stateManager.removeEnemy(e.id);
                this.selectedEnemyId = null;
            });
            actions.append(toParty, toRoster, archive);
            top.append(actions);
            row.on("click", () => {
                this.selectedEnemyId = e.id;
                this.activeEnemyTab = "stats";
                this.render();
            });
        } else {
            // View mode: expandable read-only detail (every stat visible).
            const detail = $("<div>").addClass("gm_enemy_detail").hide();
            row.append(detail);
            row.on("click", () => {
                if (detail.is(":visible")) {
                    detail.hide();
                    return;
                }
                detail.empty();
                const body = $("<div>");
                characterView.renderStats(body, e, false);
                for (const container of ["inventory", "skills", "passives", "statuses"]) {
                    if (e[container]?.length) {
                        const type = { inventory: "item", skills: "skill", passives: "passive", statuses: "status" }[container];
                        characterView.renderList(body, e, type, false);
                    }
                }
                detail.append(body).show();
            });
        }
        return row;
    }

    // Archived enemies: collapsed chip strip, edit mode only.
    _renderEnemyArchive(content) {
        const archive = stateManager.getData().enemyArchive || [];
        const wrap = $("<div>").addClass("gm_list");
        wrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text(`Archived (${archive.length})`),
            $("<span>").addClass("gm_section_hint").text("Removed enemies — restored automatically if they return."),
        ));

        const chips = $("<div>").addClass("gm_roster_chips");
        for (const e of archive) {
            const chip = $("<div>").addClass("gm_roster_chip").attr("title", this._enemyFlavor(e));
            chip.append($("<span>").text(e.name));
            const restore = iconBtn("fa-solid fa-rotate-left").attr("title", "Restore to scene");
            restore.on("click", (ev) => {
                ev.stopPropagation();
                stateManager.restoreEnemy(e.id);
            });
            const del = iconBtn("fa-solid fa-xmark").attr("title", "Delete permanently");
            del.on("click", (ev) => {
                ev.stopPropagation();
                stateManager.purgeEnemy(e.id);
            });
            chip.append(restore, del);
            chips.append(chip);
        }
        if (!archive.length) {
            chips.append($("<div>").addClass("gm_empty").text("No archived enemies."));
        }
        wrap.append(chips);
        content.append(wrap);
    }

    // ---------- Enemies tab: enemy sheet (with its own sub-tabs) ----------
    _renderEnemySheet(content, enemy, edit) {
        const header = $("<div>").addClass("gm_sheet_header");
        header.append($("<i>").addClass("fa-solid fa-skull").css({ fontSize: "1.4em", opacity: 0.85 }));
        header.append($("<b>").addClass("gm_sheet_name").text(enemy.name));
        content.append(header);

        const backRow = $("<div>").addClass("gm_sheet_top");
        const back = $("<div>").addClass("gm_back_btn").append(
            $("<i>").addClass("fa-solid fa-arrow-left"), $("<span>").text(" Enemies"));
        back.on("click", () => {
            this.selectedEnemyId = null;
            this.activeEnemyTab = "stats";
            this.render();
        });
        backRow.append(back);
        if (edit) {
            // Spacer pushes the sheet actions right, away from "back".
            backRow.append($("<div>").addClass("gm_wizard_spacer"));

            const toParty = $("<div>").addClass("gm_back_btn").append(
                $("<i>").addClass("fa-solid fa-user-plus"), $("<span>").text(" To Party"));
            toParty.on("click", () => {
                stateManager.enemyToCharacter(enemy.id);
                this.selectedEnemyId = null;
            });
            backRow.append(toParty);

            const toRoster = $("<div>").addClass("gm_back_btn").append(
                $("<i>").addClass("fa-solid fa-user-group"), $("<span>").text(" To Roster"));
            toRoster.on("click", () => {
                stateManager.enemyToRoster(enemy.id);
                this.selectedEnemyId = null;
            });
            backRow.append(toRoster);
        }
        content.append(backRow);

        const bar = $("<div>").addClass("gm_tab_bar gm_char_tab_bar");
        for (const tab of CHAR_TABS) {
            const btn = $("<div>")
                .addClass("gm_tab")
                .toggleClass("active", tab.id === this.activeEnemyTab)
                .append($("<i>").addClass(tab.icon), $("<span>").text(tab.label));
            btn.on("click", () => {
                this.activeEnemyTab = tab.id;
                this.render();
            });
            bar.append(btn);
        }
        content.append(bar);

        const body = $("<div>");
        switch (this.activeEnemyTab) {
            case "inventory":
                characterView.renderList(body, enemy, "item", edit);
                break;
            case "skills":
                characterView.renderList(body, enemy, "skill", edit);
                break;
            case "passives":
                characterView.renderList(body, enemy, "passive", edit);
                break;
            case "statuses":
                characterView.renderList(body, enemy, "status", edit);
                break;
            case "stats":
            default:
                characterView.renderStats(body, enemy, edit);
                break;
        }
        content.append(body);
    }

    // ---------- Party tab: character sheet (with its own sub-tabs) ----------
    _renderCharacterSheet(content, char, edit) {
        const header = $("<div>").addClass("gm_sheet_header");
        header.append(this._buildAvatar(char.name, true));
        header.append($("<b>").addClass("gm_sheet_name").text(char.name));
        content.append(header);

        const backRow = $("<div>").addClass("gm_sheet_top");
        const back = $("<div>").addClass("gm_back_btn").append(
            $("<i>").addClass("fa-solid fa-arrow-left"), $("<span>").text(" Party"));
        back.on("click", () => {
            this.selectedCharacterId = null;
            this.activeCharTab = "stats";
            this.render();
        });
        backRow.append(back);
        if (edit) {
            // Spacer pushes the sheet actions right, away from "back".
            backRow.append($("<div>").addClass("gm_wizard_spacer"));

            // Defection: a party member moves to the enemy side, sheet intact.
            const toEnemy = $("<div>").addClass("gm_back_btn").append(
                $("<i>").addClass("fa-solid fa-skull"), $("<span>").text(" To Enemy"));
            toEnemy.on("click", () => {
                stateManager.characterToEnemy(char.id);
                this.selectedCharacterId = null;
            });
            backRow.append(toEnemy);

            // Demote to roster — keeps the full sheet so a later promotion
            // inherits the last state (mission-based party swaps).
            const toRoster = $("<div>").addClass("gm_back_btn").append(
                $("<i>").addClass("fa-solid fa-user-group"), $("<span>").text(" To Roster"));
            toRoster.on("click", () => {
                stateManager.demoteCharacter(char.id);
                this.selectedCharacterId = null;
            });
            backRow.append(toRoster);

            const applyPreset = $("<div>").addClass("gm_back_btn").append(
                $("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Apply Preset"));
            applyPreset.on("click", () => settingsUI.applyTemplateToCharacter(char));
            backRow.append(applyPreset);
        }
        content.append(backRow);

        const bar = $("<div>").addClass("gm_tab_bar gm_char_tab_bar");
        for (const tab of CHAR_TABS) {
            const btn = $("<div>")
                .addClass("gm_tab")
                .toggleClass("active", tab.id === this.activeCharTab)
                .append($("<i>").addClass(tab.icon), $("<span>").text(tab.label));
            btn.on("click", () => {
                this.activeCharTab = tab.id;
                this.render();
            });
            bar.append(btn);
        }
        content.append(bar);

        const body = $("<div>");
        switch (this.activeCharTab) {
            case "inventory":
                characterView.renderList(body, char, "item", edit);
                break;
            case "skills":
                characterView.renderList(body, char, "skill", edit);
                break;
            case "passives":
                characterView.renderList(body, char, "passive", edit);
                break;
            case "statuses":
                characterView.renderList(body, char, "status", edit);
                break;
            case "stats":
            default:
                characterView.renderStats(body, char, edit);
                break;
        }
        content.append(body);
    }
}

export const mainPanel = new MainPanel();