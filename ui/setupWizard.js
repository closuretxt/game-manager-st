// Scenario Setup Wizard modal.
// Step 1: paste a scenario (or leave empty to use the recent chat) -> Generate.
// Step 2: review the proposal as a concise editable tree — trim the party,
// promote/remove roster allies, tweak names/values — then Apply (replace or
// merge) or discard. NOTHING touches the state before Apply.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { gmNotify, logDebug } from "../core/debug.js";
import { generateProposal, applyProposal } from "../core/setupWizard.js";
import { iconBtn } from "./characterView.js";

const CONTAINER_LABELS = {
    resources: "res",
    attributes: "attr",
    inventory: "items",
    skills: "skills",
    passives: "passives",
};

export const setupWizard = {
    _proposal: null,

    open() {
        const s = extension_settings[extensionName];
        if (!s.enabled || !s.feature_setup_wizard) return;
        this._proposal = null;
        this._renderInput();
    },

    close() {
        $("#gm_wizard_overlay").remove();
        this._proposal = null;
    },

    _overlay() {
        this.close();
        const overlay = $("<div>").attr("id", "gm_wizard_overlay");
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
            $("<i>").addClass("fa-solid fa-wand-magic-sparkles"),
            $("<b>").text(title),
            $("<div>").addClass("gm_wizard_spacer"),
        );
        const closeBtn = iconBtn("fa-solid fa-xmark");
        closeBtn.on("click", () => this.close());
        head.append(closeBtn);
        modal.append(head);
    },

    // ---------- step 1: scenario input ----------
    _renderInput() {
        const modal = this._overlay();
        this._header(modal, "Scenario Setup");

        const body = $("<div>").addClass("gm_wizard_body");
        body.append($("<div>").addClass("gm_section_hint")
            .text("Describe the scenario or character (setting, party, survival pressures). Leave empty to infer from the recent chat."));

        const ta = $("<textarea>").addClass("gm_input gm_wizard_scenario")
            .attr("placeholder", "e.g. Azur Lane: I command a base with dozens of shipgirls. Food, fuel and repairs matter; the sea is dangerous...");
        body.append(ta);

        const actions = $("<div>").addClass("gm_wizard_actions");
        const cancel = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-xmark"), $("<span>").text(" Cancel"));
        cancel.on("click", () => this.close());
        const generate = $("<div>").addClass("menu_button gm_small_btn gm_accent_btn").append(
            $("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Generate Setup"));
        generate.on("click", async () => {
            generate.addClass("disabled").find("span").text(" Generating...");
            const proposal = await generateProposal(String(ta.val() || "").trim());
            if (!proposal) {
                gmNotify("Setup generation failed — check the connection profile.", "error");
                this.close();
                return;
            }
            this._proposal = proposal;
            this._renderReview();
        });
        actions.append(cancel, generate);
        body.append(actions);
        modal.append(body);
    },

    // ---------- step 2: review / edit tree ----------
    _renderReview() {
        const modal = this._overlay();
        this._header(modal, `Review Setup — ${this._proposal.scenarioName}`);
        const p = this._proposal;

        const body = $("<div>").addClass("gm_wizard_body");

        // Party — full sheets, capped.
        const partyWrap = $("<div>").addClass("gm_list");
        partyWrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text(`Party (${p.party.length})`),
            $("<span>").addClass("gm_section_hint").text("Fully tracked characters."),
        ));
        const partyList = $("<div>").addClass("gm_entry_list");
        p.party.forEach((char, i) => {
            const row = $("<div>").addClass("gm_entry_row");
            const name = $("<input>").addClass("gm_input").val(char.name);
            name.on("input", () => { char.name = name.val(); });
            const summary = Object.keys(CONTAINER_LABELS)
                .filter(k => (char[k] || []).length)
                .map(k => `${char[k].length} ${CONTAINER_LABELS[k]}`)
                .join(", ") || "empty sheet";
            const del = iconBtn("fa-solid fa-trash");
            del.on("click", () => {
                p.party.splice(i, 1);
                this._renderReview();
            });
            row.append(
                $("<div>").addClass("gm_entry_top").append(
                    $("<div>").addClass("gm_entry_main").append(name),
                    $("<div>").addClass("gm_entry_actions").append(del),
                ),
                $("<div>").addClass("gm_entry_desc").text(summary),
            );
            partyList.append(row);
        });
        if (!p.party.length) partyList.append($("<div>").addClass("gm_empty").text("No party members proposed."));
        partyWrap.append(partyList);
        body.append(partyWrap);

        // Roster — lightweight allies.
        const rosterWrap = $("<div>").addClass("gm_list");
        rosterWrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text(`Roster (${p.roster.length})`),
            $("<span>").addClass("gm_section_hint").text("Lightweight allies — promote to Party to fully track."),
        ));
        const rosterList = $("<div>").addClass("gm_entry_list");
        p.roster.forEach((ally, i) => {
            const row = $("<div>").addClass("gm_entry_row");
            const name = $("<input>").addClass("gm_input").val(ally.name);
            name.on("input", () => { ally.name = name.val(); });
            const note = $("<input>").addClass("gm_input").val(ally.note || "");
            note.on("input", () => { ally.note = note.val(); });
            const promote = iconBtn("fa-solid fa-user-plus").attr("title", "Promote to Party");
            promote.on("click", () => {
                p.party.push({ name: ally.name, resources: [], attributes: [], inventory: [], skills: [], passives: [] });
                p.roster.splice(i, 1);
                this._renderReview();
            });
            const del = iconBtn("fa-solid fa-trash");
            del.on("click", () => {
                p.roster.splice(i, 1);
                this._renderReview();
            });
            row.append(
                $("<div>").addClass("gm_entry_top").append(
                    $("<div>").addClass("gm_entry_main").append(name),
                    $("<div>").addClass("gm_entry_actions").append(promote, del),
                ),
                note,
            );
            rosterList.append(row);
        });
        if (!p.roster.length) rosterList.append($("<div>").addClass("gm_empty").text("No roster allies proposed."));
        rosterWrap.append(rosterList);
        body.append(rosterWrap);

        // Shared resources / custom / warnings — compact one-line summaries.
        const compact = $("<div>").addClass("gm_list");
        compact.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text("Party-wide"),
            $("<span>").addClass("gm_section_hint").text("Shared resources, custom features, warnings."),
        ));
        const compactList = $("<div>").addClass("gm_entry_list");
        const compactRows = [
            ...p.sharedResources.map(e => ({ icon: "fa-solid fa-coins", text: `${e.name} ×${e.qty ?? 0}${e.always_inject ? " (always inject)" : ""}`, arr: p.sharedResources, source: e })),
            ...p.custom.map(e => ({ icon: "fa-solid fa-seedling", text: `${e.name}: ${e.value || ""}`, arr: p.custom, source: e })),
            ...p.warnings.map(e => ({ icon: "fa-solid fa-triangle-exclamation", text: `${e.name} — ${e.text || ""}`, arr: p.warnings, source: e })),
        ];
        for (const item of compactRows) {
            const row = $("<div>").addClass("gm_entry_row gm_wizard_compact");
            row.append($("<i>").addClass(item.icon));
            row.append($("<span>").text(item.text));
            const del = iconBtn("fa-solid fa-trash");
            del.on("click", () => {
                const idx = item.arr.indexOf(item.source);
                if (idx !== -1) item.arr.splice(idx, 1);
                this._renderReview();
            });
            row.append(del);
            compactList.append(row);
        }
        if (!compactRows.length) compactList.append($("<div>").addClass("gm_empty").text("Nothing party-wide proposed."));
        compact.append(compactList);
        body.append(compact);

        // Apply mode + actions.
        const modeRow = $("<div>").addClass("gm_wizard_mode").append(
            $("<label>").append(
                $("<input>").attr("type", "radio").attr("name", "gm_wizard_mode").val("replace").prop("checked", true),
                $("<span>").text(" Replace current setup"),
            ),
            $("<label>").append(
                $("<input>").attr("type", "radio").attr("name", "gm_wizard_mode").val("merge"),
                $("<span>").text(" Merge into current"),
            ),
        );
        body.append(modeRow);

        const actions = $("<div>").addClass("gm_wizard_actions");
        const cancel = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-xmark"), $("<span>").text(" Discard"));
        cancel.on("click", () => this.close());
        const apply = $("<div>").addClass("menu_button gm_small_btn gm_accent_btn").append(
            $("<i>").addClass("fa-solid fa-check"), $("<span>").text(" Apply"));
        apply.on("click", () => {
            const mode = body.find("input[name=gm_wizard_mode]:checked").val() || "replace";
            applyProposal(this._proposal, mode);
            gmNotify(`Setup applied (${mode}): ${this._proposal.party.length} party, ${this._proposal.roster.length} roster.`, "success");
            logDebug("setupWizard: applied from review modal");
            this.close();
        });
        actions.append(cancel, apply);
        body.append(actions);

        modal.append(body);
    },
};
