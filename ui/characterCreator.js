// Add Character / Add Enemy modal + LLM review page.
// CREATE: instant, no LLM — clones a reference character's sheet (fresh ids)
// or falls back to the active preset template. GENERATE: one LLM call proposes
// a full sheet (name + details + reference sheets as context) and opens a
// review page with the same features as the Scenario Setup Wizard (editable
// sheet editor, refine with feedback, rollback). NOTHING touches state until
// Create/Apply. ENEMY MODE applies through stateManager.addEnemy and carries
// a level picker that calibrates the generated sheet to the party's
// progression.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { gmNotify, logDebug } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { progression } from "../core/progression.js";
import { CHARACTER_CONTAINERS, genId } from "../core/schemas.js";
import { generateCharacterProposal, refineCharacterProposal } from "../core/characterGenerator.js";
import { captureModalScroll, restoreModalScroll } from "../util/scrollKeeper.js";
import { fadeOutRemove } from "../util/fx.js";
import { settingsUI } from "./settingsUI.js";
import { sheetEditor } from "./sheetEditor.js";
import { iconBtn } from "./characterView.js";

export const characterCreator = {
    _name: "",
    _details: "",
    _reference: "",   // "party:<id>" | "roster:<id>" | "enemy:<id>" | ""
    _mode: "party",   // "party" | "enemy"
    _level: null,     // enemy mode: target level (progression calibration)
    _proposal: null,  // sanitized char (wizard party-entry shape)
    _history: [],     // previous proposals for rollback
    _refinements: 0,
    onApplied: null,  // set by the host (mainPanel): (char) => select + render

    open({ mode = "party" } = {}) {
        const s = extension_settings[extensionName];
        if (!s.enabled || !s.feature_character_creator) return;
        this._name = "";
        this._details = "";
        this._reference = "";
        this._mode = mode === "enemy" ? "enemy" : "party";
        this._level = null;
        this._proposal = null;
        this._history = [];
        this._refinements = 0;
        this._renderInput();
    },

    _isEnemy() {
        return this._mode === "enemy";
    },

    close() {
        fadeOutRemove($("#gm_creator_overlay"));
        this._proposal = null;
    },

    //

    // Reference options: party characters (full sheets) + roster allies that
    // carry a saved sheet (demoted party members keep theirs).
    _referenceOptions() {
        const d = stateManager.getData();
        const opts = [];
        for (const c of d.characters || []) {
            opts.push({ value: `party:${c.id}`, label: c.name, sheet: c });
        }
        for (const r of d.roster || []) {
            if (r.sheet) opts.push({ value: `roster:${r.id}`, label: `${r.name} (roster)`, sheet: r.sheet });
        }
        // Enemy mode: existing enemies are the most faithful templates.
        if (this._isEnemy()) {
            for (const e of d.enemies || []) {
                opts.push({ value: `enemy:${e.id}`, label: `${e.name} (enemy)`, sheet: e });
            }
        }
        return opts;
    },

    _resolveReference() {
        if (!this._reference) return null;
        return this._referenceOptions().find(o => o.value === this._reference) || null;
    },

    // Fresh-id clone of a reference sheet (Create path — no LLM).
    _cloneSheet(sheet) {
        const out = {};
        for (const key of CHARACTER_CONTAINERS) {
            out[key] = (sheet?.[key] || []).map(e => ({ ...structuredClone(e), id: genId() }));
        }
        return out;
    },

    _overlay() {
        // Keep the scroll position alive across the rebuild (see scrollKeeper).
        captureModalScroll("gm_creator_overlay");
        $("#gm_creator_overlay").remove();
        const overlay = $("<div>").attr("id", "gm_creator_overlay");
        const modal = $("<div>").addClass("gm_wizard_modal");
        overlay.append(modal);
        overlay.on("mousedown", (e) => {
            if (e.target === overlay[0]) this.close();
        });
        $("body").append(overlay);
        return modal;
    },

    _header(modal, title) {
        const head = $("<div>").addClass("gm_wizard_head").append(
            $("<i>").addClass(this._isEnemy() ? "fa-solid fa-skull" : "fa-solid fa-user-plus"),
            $("<b>").text(title),
            $("<div>").addClass("gm_wizard_spacer"),
        );
        const closeBtn = iconBtn("fa-solid fa-xmark");
        closeBtn.on("click", () => this.close());
        head.append(closeBtn);
        modal.append(head);
    },

    //

    // ---------- step 1: brief input ----------
    _renderInput() {
        const modal = this._overlay();
        this._header(modal, "Add Character");

        const body = $("<div>").addClass("gm_wizard_body");
        body.append($("<div>").addClass("gm_section_hint")
            .text(this._isEnemy()
                ? "Create instantly from a reference or the preset — or let the LLM build the threat."
                : "Create instantly from a reference or the preset — or let the LLM build the sheet."));

        const name = $("<input>").addClass("gm_input")
            .attr({ type: "text", placeholder: "Character name", title: "Character name" })
            .val(this._name);
        name.on("input", () => {
            this._name = String(name.val() || "").trim();
        });
        body.append(name);

        const details = $("<textarea>").addClass("gm_input gm_wizard_scenario")
            .attr("placeholder", "Character details — role, personality, combat style, what makes them different... (optional)")
            .val(this._details);
        details.on("input", () => {
            this._details = String(details.val() || "");
        });
        body.append(details);

        // Reference picker — copy similar stats from an existing character.
        const refRow = $("<div>").addClass("gm_field gm_field_inline");
        const refSel = $("<select>").addClass("gm_input")
            .attr("title", "Copy the stat structure of an existing character");
        refSel.append($("<option>").val("").text("Reference: none (preset template)"));
        for (const opt of this._referenceOptions()) {
            refSel.append($("<option>").val(opt.value).text(`Reference: ${opt.label}`));
        }
        refSel.val(this._reference);
        refSel.on("change", () => {
            this._reference = String(refSel.val() || "");
        });
        refRow.append($("<label>").text("Copy from"), refSel);
        body.append(refRow);

        // Level picker (enemy mode, progression on): calibrates the generated
        // sheet to a chosen threat level instead of the party's average.
        if (this._isEnemy() && progression.isEnabled()) {
            const lvlRow = $("<div>").addClass("gm_field gm_field_inline");
            const lvlInput = $("<input>").addClass("gm_input")
                .attr({ type: "number", min: 1, title: "Enemy level — calibrates the generated sheet against the party's progression" })
                .val(this._level ?? progression.partyLevel());
            lvlInput.on("input", () => {
                this._level = Math.max(1, Math.trunc(Number(lvlInput.val()) || 1));
            });
            lvlRow.append($("<label>").text("Level"), lvlInput);
            body.append(lvlRow);
        }

        const actions = $("<div>").addClass("gm_wizard_actions");
        const cancel = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-xmark"), $("<span>").text(" Cancel"));
        cancel.on("click", () => this.close());
        const create = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Create"));
        create.on("click", () => this._create());
        const generate = $("<div>").addClass("menu_button gm_small_btn gm_accent_btn").append(
            $("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Generate"));
        generate.on("click", () => this._generate(generate));
        actions.append(cancel, create, generate);
        body.append(actions);
        modal.append(body);
    },

    //

    // Enemy apply path: addEnemy restores archived sheets with the same name;
    // the chosen level is stamped onto the (new or restored) progression track.
    _applyEnemy(template) {
        const enemy = stateManager.addEnemy(this._name, template);
        if (progression.isEnabled()) {
            enemy.progression = { ...progression.trackOf(enemy), level: this._level ?? progression.partyLevel() };
        }
        return enemy;
    },

    // Create: instant — reference clone or preset template, no LLM.
    _create() {
        if (!this._name) {
            gmNotify("Give the character a name first.", "error");
            return;
        }
        const ref = this._resolveReference();
        const template = ref ? this._cloneSheet(ref.sheet) : settingsUI.getTemplateEntries();
        const char = this._isEnemy() ? this._applyEnemy(template) : stateManager.addCharacter(this._name, template);
        logDebug(`characterCreator: created "${char.name}" (${this._mode}) from ${ref ? `reference ${ref.label}` : "preset template"}`);
        gmNotify(`Created ${char.name}${ref ? ` (copy of ${ref.label})` : ""}.`, "success");
        this._finish(char);
    },

    // Generate: LLM proposal -> review page.
    async _generate(btn) {
        if (!this._name) {
            gmNotify("Give the character a name first.", "error");
            return;
        }
        btn.addClass("disabled gm_busy").find("span").text(" Generating...");
        const char = await generateCharacterProposal(this._brief());
        if (!char) {
            gmNotify("Character generation failed — check the connection profile.", "error");
            btn.removeClass("disabled gm_busy").find("span").text(" Generate");
            return;
        }
        this._proposal = char;
        this._history = [];
        this._refinements = 0;
        this._renderReview();
    },

    // Brief for the generator calls; references resolve to their sheets.
    // Enemy mode tags the kind and the target level for progression anchoring.
    _brief() {
        const refs = this._reference ? [this._resolveReference()].filter(Boolean) : [];
        const brief = { name: this._name, details: this._details, references: refs.map(r => r.sheet) };
        if (this._isEnemy()) {
            brief.kind = "enemy";
            if (progression.isEnabled()) brief.level = this._level ?? progression.partyLevel();
        }
        return brief;
    },

    //

    // ---------- step 2: review (same features as the Scenario Wizard) ----------
    _renderReview() {
        const modal = this._overlay();
        const char = this._proposal;
        const refinedTag = this._refinements ? ` (refined ×${this._refinements})` : "";
        this._header(modal, `Review Character — ${char.name}${refinedTag}`);

        const body = $("<div>").addClass("gm_wizard_body");

        // Editable sheet — same editor the Scenario Wizard review uses.
        const wrap = $("<div>").addClass("gm_list");
        wrap.append(sheetEditor(char, {
            onAdd: () => this._renderReview(),
            onDelete: () => this._renderReview(),
        }));
        body.append(wrap);

        // Refine — recursive self-improvement pass on the current sheet.
        const refineWrap = $("<div>").addClass("gm_list");
        refineWrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text("Refine"),
            $("<span>").addClass("gm_section_hint").text("Feed this sheet back to the LLM to deepen it — your edits above are the base."),
        ));
        const feedback = $("<textarea>").addClass("gm_input gm_wizard_scenario")
            .attr("placeholder", "Optional: what to improve? e.g. 'grittier, more ammo-focused' (empty = general deepening)");
        refineWrap.append(feedback);
        const refineActions = $("<div>").addClass("gm_wizard_actions");
        const refineBtn = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-arrows-rotate"),
            $("<span>").text(this._refinements ? ` Refine Again (×${this._refinements})` : " Refine"));
        refineBtn.on("click", async () => {
            refineBtn.addClass("disabled gm_busy").find("span").text(" Refining...");
            const refined = await refineCharacterProposal(this._proposal, String(feedback.val() || "").trim(), this._brief());
            if (!refined) {
                gmNotify("Refinement failed — keeping the current sheet.", "error");
                refineBtn.removeClass("disabled gm_busy").find("span")
                    .text(this._refinements ? ` Refine Again (×${this._refinements})` : " Refine");
                return;
            }
            this._history.push(this._proposal);
            if (this._history.length > 5) this._history.shift();
            this._proposal = refined;
            this._refinements++;
            this._renderReview();
        });
        refineActions.append(refineBtn);

        // Rollback — undo the last refine, restoring the previous sheet
        // (with any hand edits made before it).
        const rollbackBtn = $("<div>").addClass("menu_button gm_small_btn")
            .toggleClass("disabled", !this._history.length)
            .append($("<i>").addClass("fa-solid fa-rotate-left"), $("<span>").text(" Rollback"));
        rollbackBtn.on("click", () => {
            if (!this._history.length) return;
            this._proposal = this._history.pop();
            this._refinements = Math.max(0, this._refinements - 1);
            this._renderReview();
        });
        refineActions.append(rollbackBtn);
        refineWrap.append(refineActions);
        body.append(refineWrap);

        const actions = $("<div>").addClass("gm_wizard_actions");
        const cancel = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-xmark"), $("<span>").text(" Discard"));
        cancel.on("click", () => this.close());
        const apply = $("<div>").addClass("menu_button gm_small_btn gm_accent_btn").append(
            $("<i>").addClass("fa-solid fa-check"), $("<span>").text(" Apply"));
        apply.on("click", () => {
            const sheet = this._cloneSheet(this._proposal);
            const created = this._isEnemy() ? this._applyEnemy(sheet) : stateManager.addCharacter(this._name, sheet);
            gmNotify(`Created ${created.name} from the generated sheet.`, "success");
            logDebug(`characterCreator: applied generated sheet (${this._mode})`);
            this._finish(created);
        });
        actions.append(cancel, apply);
        body.append(actions);

        modal.append(body);
        restoreModalScroll("gm_creator_overlay");
    },

    //

    _finish(char) {
        this.close();
        if (typeof this.onApplied === "function") this.onApplied(char);
    },
};
