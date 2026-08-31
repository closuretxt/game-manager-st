// Scenario Setup Wizard modal.
// Step 1: paste a scenario (or leave empty to use the recent chat) -> Generate.
// Step 2: review the proposal as a concise editable tree — trim the party,
// promote/remove roster allies, tweak names/values — then Apply (replace or
// merge), or Refine: feed the (edited) proposal back through the LLM for a
// deeper pass, recursively, until it is good enough (Rollback undoes the last
// refine). NOTHING touches the state before Apply.
// The in-progress session (scenario + proposal + refine history) is mirrored
// into the chat metadata, so a crash or accidental close restores the wizard
// exactly where it was on the next open. If the stored shape ever stops
// matching, the session is simply voided — no compatibility shims.

import { extension_settings, getContext } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../core/constants.js";
import { gmNotify, logDebug } from "../core/debug.js";
import { generateProposal, refineProposal, applyProposal } from "../core/setupWizard.js";
import { captureModalScroll, restoreModalScroll } from "../util/scrollKeeper.js";
import { fadeOutRemove } from "../util/fx.js";
import { iconBtn } from "./characterView.js";
import { sheetEditor } from "./sheetEditor.js";

const CONTAINER_LABELS = {
    resources: "res",
    attributes: "attr",
    inventory: "items",
    skills: "skills",
    passives: "passives",
    statuses: "statuses",
};

export const setupWizard = {
    _proposal: null,

    // ---------- crash-safe session (chat metadata mirror) ----------
    _sessionSave() {
        try {
            const st = getContext();
            if (!st?.chatMetadata) return;
            const gm = (st.chatMetadata.game_manager = st.chatMetadata.game_manager || {});
            gm.wizard = {
                ts: Date.now(),
                scenario: this._scenario || "",
                proposal: this._proposal || null,
                refinements: this._refinements || 0,
                history: this._history || [],
            };
            st.saveMetadata();
        } catch (e) {
            console.error("[Game Manager] wizard session save failed:", e);
        }
    },

    _sessionQueue() {
        clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => this._sessionSave(), 800);
    },

    _sessionLoad() {
        try {
            const saved = getContext()?.chatMetadata?.game_manager?.wizard;
            if (!saved || typeof saved !== "object") return null;
            const p = saved.proposal;
            // Format drift -> void everything, start fresh.
            if (p && (!Array.isArray(p.party) || !Array.isArray(p.roster)
                || !Array.isArray(p.sharedResources) || !Array.isArray(p.custom) || !Array.isArray(p.warnings))) {
                this._sessionClear();
                return null;
            }
            return saved;
        } catch {
            return null;
        }
    },

    _sessionClear() {
        clearTimeout(this._persistTimer);
        try {
            const st = getContext();
            if (st?.chatMetadata?.game_manager?.wizard) {
                delete st.chatMetadata.game_manager.wizard;
                st.saveMetadata();
            }
        } catch (e) {
            console.error("[Game Manager] wizard session clear failed:", e);
        }
    },

    open() {
        const s = extension_settings[extensionName];
        if (!s.enabled || !s.feature_setup_wizard) return;
        this._proposal = null;
        this._scenario = "";
        this._refinements = 0;
        this._history = [];
        this._expanded = new Set();
        // Resume an interrupted session (crash, accidental close) if one exists.
        const saved = this._sessionLoad();
        if (saved) {
            this._scenario = String(saved.scenario || "");
            this._refinements = Number(saved.refinements) || 0;
            this._history = Array.isArray(saved.history) ? saved.history : [];
            if (saved.proposal) {
                this._proposal = saved.proposal;
                gmNotify("Restored the unfinished setup from this chat.", "info");
                this._renderReview();
                return;
            }
        }
        this._renderInput();
    },

    close() {
        fadeOutRemove($("#gm_wizard_overlay"));
        this._proposal = null;
    },

    // Explicit discard/reset: wipes the mirrored session too.
    _discard() {
        this._sessionClear();
        this.close();
    },

    _overlay() {
        // Replace the overlay element WITHOUT going through close() — close()
        // nulls this._proposal, which the review step still needs.
        // Keep the scroll position alive across the rebuild (see scrollKeeper).
        captureModalScroll("gm_wizard_overlay");
        $("#gm_wizard_overlay").remove();
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
        const s = extension_settings[extensionName];
        const modal = this._overlay();
        this._header(modal, "Scenario Setup");

        const body = $("<div>").addClass("gm_wizard_body");
        body.append($("<div>").addClass("gm_section_hint")
            .text("Describe the scenario — or leave empty to use the recent chat."));

        const ta = $("<textarea>").addClass("gm_input gm_wizard_scenario")
            .attr("placeholder", "e.g. I command a base with dozens of shipgirls. Food, fuel and repairs matter; the sea is dangerous...")
            .val(this._scenario || "");
        ta.on("input", () => {
            this._scenario = String(ta.val() || "").trim();
            this._sessionQueue();
        });
        body.append(ta);

        // How much recent chat the setup LLM sees as context (0 = none).
        const chatRow = $("<div>").addClass("gm_field gm_field_inline");
        const chatInput = $("<input>")
            .addClass("gm_input")
            .attr({ type: "number", min: "0", max: "100", step: "1", title: "Recent chat messages included as context for the setup LLM" })
            .val(Math.max(0, Math.trunc(Number(s.wizard_chat_messages) || 0)));
        chatInput.on("change", () => {
            s.wizard_chat_messages = Math.max(0, Math.trunc(Number(chatInput.val()) || 0));
            chatInput.val(s.wizard_chat_messages);
            saveSettingsDebounced();
        });
        chatRow.append($("<label>").text("Include Messages"), chatInput);
        body.append(chatRow);

        const actions = $("<div>").addClass("gm_wizard_actions");
        const cancel = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-xmark"), $("<span>").text(" Cancel"));
        cancel.on("click", () => this._discard());
        const generate = $("<div>").addClass("menu_button gm_small_btn gm_accent_btn").append(
            $("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Generate Setup"));
        generate.on("click", async () => {
            generate.addClass("disabled gm_busy").find("span").text(" Generating...");
            this._scenario = String(ta.val() || "").trim();
            const proposal = await generateProposal(this._scenario);
            if (!proposal) {
                gmNotify("Setup generation failed — check the connection profile.", "error");
                generate.removeClass("disabled gm_busy").find("span").text(" Generate Setup");
                return;
            }
            this._proposal = proposal;
            this._history = [];
            this._sessionSave();
            this._renderReview();
        });
        actions.append(cancel, generate);
        body.append(actions);
        modal.append(body);
    },

    // Expanded proposal sheet: shared schema-driven editor (ui/sheetEditor.js),
    // re-rendering the review on structural changes.
    _sheetEditor(char) {
        return sheetEditor(char, {
            onAdd: () => this._renderReview(),
            onDelete: () => this._renderReview(),
            onChange: () => this._sessionQueue(),
        });
    },


    // ---------- step 2: review / edit tree ----------
    _renderReview() {
        const modal = this._overlay();
        if (!this._expanded) this._expanded = new Set();
        // Mirror the current proposal (and any structural edits) into the chat.
        this._sessionSave();
        const refinedTag = this._refinements ? ` (refined ×${this._refinements})` : "";
        this._header(modal, `Review Setup — ${this._proposal.scenarioName}${refinedTag}`);
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
            const open = this._expanded.has(char);
            const chevron = iconBtn(open ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-right")
                .attr("title", "Toggle sheet");
            chevron.on("click", () => {
                if (open) this._expanded.delete(char);
                else this._expanded.add(char);
                this._renderReview();
            });
            const name = $("<input>").addClass("gm_input").val(char.name);
            name.on("input", () => {
                char.name = name.val();
                this._sessionQueue();
            });
            const summary = Object.keys(CONTAINER_LABELS)
                .filter(k => (char[k] || []).length)
                .map(k => `${char[k].length} ${CONTAINER_LABELS[k]}`)
                .join(", ") || "empty sheet";
            const del = iconBtn("fa-solid fa-trash");
            del.on("click", () => {
                this._expanded.delete(char);
                p.party.splice(i, 1);
                this._renderReview();
            });
            row.append(
                $("<div>").addClass("gm_entry_top").append(
                    $("<div>").addClass("gm_entry_main").append(chevron, name),
                    $("<div>").addClass("gm_entry_actions").append(del),
                ),
                $("<div>").addClass("gm_entry_desc").text(summary),
            );
            if (open) row.append(this._sheetEditor(char));
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
            name.on("input", () => {
                ally.name = name.val();
                this._sessionQueue();
            });
            const note = $("<input>").addClass("gm_input").val(ally.note || "");
            note.on("input", () => {
                ally.note = note.val();
                this._sessionQueue();
            });
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
            ...p.sharedResources.map(e => ({ icon: "fa-solid fa-coins", text: `${e.name} ×${e.qty ?? 0}${e.always_inject ? " (always inject)" : ""}${e.description ? ` — ${e.description}` : ""}`, arr: p.sharedResources, source: e })),
            ...p.custom.map(e => ({ icon: "fa-solid fa-seedling", text: `${e.name}: ${e.value || ""}${e.description ? ` — ${e.description}` : ""}`, arr: p.custom, source: e })),
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

        // Progression — optional per-scenario EXP/level config.
        const progWrap = $("<div>").addClass("gm_list");
        progWrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text("Progression"),
            $("<span>").addClass("gm_section_hint").text("Per-scenario EXP curve and skill points (optional)."),
        ));
        if (!p.progression) {
            const addProg = $("<div>").addClass("menu_button gm_small_btn").append(
                $("<i>").addClass("fa-solid fa-arrow-trend-up"), $("<span>").text(" Add progression"));
            addProg.on("click", () => {
                p.progression = { enabled: true, exp_base: 100, exp_growth: 1.25, skill_points_per_level: 1, bonus_every: 5, attr_points_per_level: 0, attr_cost_every: 10, attr_starting_budget: 20, exp_guidelines: "" };
                this._renderReview();
            });
            progWrap.append($("<div>").addClass("gm_empty").text("No progression proposed."), addProg);
        } else {
            const prog = p.progression;
            const row = $("<div>").addClass("gm_wizard_compact");
            const num = (key, title, min, step) => {
                const input = $("<input>").addClass("gm_input gm_prog_input")
                    .attr({ type: "number", min: String(min), step: String(step), title })
                    .val(prog[key]);
                input.on("input", () => {
                    const n = Number(input.val());
                    if (Number.isFinite(n)) prog[key] = n;
                    this._sessionQueue();
                });
                return input;
            };
            const enabled = $("<input>").attr("type", "checkbox")
                .prop("checked", prog.enabled !== false)
                .attr("title", "Enabled for this scenario");
            enabled.on("change", () => {
                prog.enabled = enabled.prop("checked");
                this._sessionQueue();
            });
            row.append($("<label>").append(enabled, $("<span>").text(" On")));
            row.append(num("exp_base", "EXP base (first level-up)", 1, 1));
            row.append(num("exp_growth", "EXP growth per level (multiplier)", 1, 0.01));
            row.append(num("skill_points_per_level", "Skill points per level", 0, 1));
            row.append(num("bonus_every", "Bonus point every N levels (0 = off)", 0, 1));
            row.append(num("attr_points_per_level", "Attribute points per level (0 = off)", 0, 1));
            row.append(num("attr_cost_every", "Attribute cost growth: +1 cost per N current value (0 = flat)", 0, 1));
            row.append(num("attr_starting_budget", "Starting attribute budget (total points at level 1)", 0, 1));
            const del = iconBtn("fa-solid fa-trash").attr("title", "Remove progression");
            del.on("click", () => {
                delete p.progression;
                this._renderReview();
            });
            row.append(del);
            progWrap.append(row);

            const guidelines = $("<textarea>").addClass("gm_input gm_wizard_scenario")
                .attr("placeholder", "EXP guidelines for the post-pass LLM: how much EXP trivial actions, minor victories and major challenges give...")
                .val(prog.exp_guidelines || "");
            guidelines.on("input", () => {
                prog.exp_guidelines = String(guidelines.val() || "");
                this._sessionQueue();
            });
            progWrap.append(guidelines);
        }
        body.append(progWrap);

        // Refine — recursive self-improvement pass on the current proposal.
        const refineWrap = $("<div>").addClass("gm_list");
        refineWrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text("Refine"),
            $("<span>").addClass("gm_section_hint").text("Feed this proposal back to the LLM to deepen it — your edits above are the base."),
        ));
        const feedback = $("<textarea>").addClass("gm_input gm_wizard_scenario")
            .attr("placeholder", "Optional: what to improve? e.g. 'grittier sheets, add fuel logistics' (empty = general deepening)");
        refineWrap.append(feedback);
        const refineActions = $("<div>").addClass("gm_wizard_actions");
        const refineBtn = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-arrows-rotate"),
            $("<span>").text(this._refinements ? ` Refine Again (×${this._refinements})` : " Refine"));
        refineBtn.on("click", async () => {
            refineBtn.addClass("disabled gm_busy").find("span").text(" Refining...");
            const refined = await refineProposal(this._proposal, String(feedback.val() || "").trim(), this._scenario);
            if (!refined) {
                gmNotify("Refinement failed — keeping the current proposal.", "error");
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

        // Rollback — undo the last refine, restoring the previous proposal
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
        const reset = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-trash-can"), $("<span>").text(" Reset"));
        reset.on("click", () => {
            this._discard();
            this._proposal = null;
            this._scenario = "";
            this._refinements = 0;
            this._history = [];
            this._expanded = new Set();
            this._renderInput();
        });
        const cancel = $("<div>").addClass("menu_button gm_small_btn").append(
            $("<i>").addClass("fa-solid fa-xmark"), $("<span>").text(" Discard"));
        cancel.on("click", () => this._discard());
        const apply = $("<div>").addClass("menu_button gm_small_btn gm_accent_btn").append(
            $("<i>").addClass("fa-solid fa-check"), $("<span>").text(" Apply"));
        apply.on("click", () => {
            const mode = body.find("input[name=gm_wizard_mode]:checked").val() || "replace";
            applyProposal(this._proposal, mode);
            gmNotify(`Setup applied (${mode}): ${this._proposal.party.length} party, ${this._proposal.roster.length} roster.`, "success");
            logDebug("setupWizard: applied from review modal");
            this._sessionClear();
            this.close();
        });
        actions.append(reset, cancel, apply);
        body.append(actions);

        modal.append(body);
        restoreModalScroll("gm_wizard_overlay");
    },
};
