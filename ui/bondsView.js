// Bonds UI — the per-character Bonds section (on the character page, under
// the stats) and the chat's bar-definition dialog (party header, edit mode).
// Data and rules live in core/bonds.js; everything here goes through the
// stateManager wrappers so changes emit and persist like any other edit.

import { getContext } from "../../../../extensions.js";
import { stateManager, playerNames } from "../core/stateManager.js";
import { gmSettings } from "../core/features.js";
import { BOND_PRESETS, BOND_STAGES, DEFAULT_BOND_THRESHOLDS, bondConfig, bondDefs, formatEffects, isPlayerSheet, stageOf, stageDef, eligibleStages, defaultStageNotesText } from "../core/bonds.js";
import { fadeOutRemove } from "../util/fx.js";
import { confirmAction } from "./confirmModal.js";
import { openPromptEditor } from "./promptEditor.js";
import { iconBtn } from "./characterView.js";

const nowIdx = () => Math.max(0, (getContext()?.chat?.length || 1) - 1);

export function bondsVisible() {
    return !!gmSettings().feature_bonds;
}

// Character-page section. Read-only outside edit mode.
export function renderBondSection(container, char, edit) {
    if (!bondsVisible() || isPlayerSheet(char, playerNames())) return;
    const d = stateManager.getData();
    const defs = bondDefs(d);
    const wrap = $("<div>").addClass("gm_list gm_bond_section");
    wrap.append($("<div>").addClass("gm_section_header").append(
        $("<b>").append($("<i>").addClass("fa-solid fa-heart-circle-check"), " Bond"),
        $("<span>").addClass("gm_section_hint").text("Where they stand with you"),
    ));
    if (!defs.length) {
        wrap.append($("<div>").addClass("gm_empty").text(edit
            ? "No bond bars in this chat yet — set them with the Bonds button on the Party page, or let the Setup Wizard propose them."
            : "No bond bars in this chat yet."));
        container.append(wrap);
        return;
    }
    // Display falls back to start values until the first post-pass creates the bond.
    const bond = char.bond || { stage: "stranger", values: {}, statuses: [], history: [] };

    // Stage: what the story model plays. Edit mode = the user is the GM (no gate).
    const stageRow = $("<div>").addClass("gm_bond_stage");
    if (edit) {
        const sel = $("<select>").addClass("gm_input gm_bond_stage_select");
        for (const st of BOND_STAGES) sel.append($("<option>").val(st.key).text(st.name));
        sel.val(stageOf(char)).on("change", () => stateManager.setBondStageManual(char.id, sel.val()));
        const grad = $("<input>").attr("type", "checkbox").prop("checked", !!bond.graduated)
            .on("change", () => stateManager.setBondGraduated(char.id, grad.prop("checked")));
        stageRow.append(sel, $("<label>").addClass("checkbox_label").attr("title", "Graduated bonds are settled: nothing is injected for them anymore")
            .append(grad, $("<span>").text("Graduated")));
    } else {
        stageRow.append($("<b>").text(stageDef(stageOf(char)).name));
        if (bond.graduated) stageRow.append($("<span>").addClass("gm_section_hint").text(" · graduated (no longer injected)"));
    }
    if (char.bond) {
        const eligible = eligibleStages(d, char).map(k => stageDef(k).name);
        if (eligible.length) stageRow.append($("<span>").addClass("gm_section_hint").text(` · can level up to ${eligible.join(" or ")}`));
    }
    wrap.append(stageRow);

    const bars = $("<div>").addClass("gm_bond_bars");
    for (const def of defs) {
        const v = bond.values?.[def.id] ?? def.start;
        const row = $("<div>").addClass("gm_bond_bar").attr("title", def.description || def.name);
        row.append($("<span>").addClass("gm_bond_name").text(def.name));
        row.append($("<div>").addClass("gm_bond_track").append($("<div>").addClass("gm_bond_fill").css("width", `${v}%`)));
        if (edit) {
            const input = $("<input>").addClass("gm_input gm_bond_value").attr({ type: "number", min: 0, max: 100 }).val(v);
            input.on("change", () => stateManager.setBondValue(char.id, def.id, input.val()));
            row.append(input);
        } else {
            row.append($("<span>").addClass("gm_bond_value_text").text(v));
        }
        bars.append(row);
    }
    wrap.append(bars);

    const statuses = bond.statuses || [];
    if (statuses.length) {
        const list = $("<div>").addClass("gm_bond_feelings");
        for (const s of statuses) {
            const item = $("<div>").addClass("gm_bond_feeling");
            const top = $("<div>").addClass("gm_bond_feeling_top").append(
                $("<b>").text(s.name),
                $("<span>").addClass("gm_bond_effect").text(formatEffects(s.effects, defs)),
            );
            if (edit) {
                const end = iconBtn("fa-solid fa-xmark").attr("title", "Resolve this thread (its effect is taken back)");
                end.on("click", () => stateManager.endBondStatus(char.id, s.name, nowIdx()));
                top.append(end);
            }
            item.append(top);
            const sub = [s.note, s.ends ? `Ends: ${s.ends}` : ""].filter(Boolean).join(" · ");
            if (sub) item.append($("<div>").addClass("gm_entry_desc").text(sub));
            list.append(item);
        }
        wrap.append($("<div>").addClass("gm_section_hint").text("Open threads"), list);
    }

    if ((bond.history || []).length) {
        const hist = $("<details>").addClass("gm_bond_history");
        hist.append($("<summary>").text(`Past threads (${bond.history.length})`));
        for (const h of bond.history) {
            hist.append($("<div>").addClass("gm_entry_desc").text(
                `${h.name}${h.effect ? ` (${h.effect})` : ""} — ${h.outcome === "settled" ? "settled for good" : "ended, taken back"}`));
        }
        wrap.append(hist);
    }
    container.append(wrap);
}

// Party-header dialog: the chat's bars + options. Edits a draft; Save applies.
export function openBondsDialog() {
    const cfg = bondConfig(stateManager.getData());
    const draft = cfg.defs.map(x => ({ ...x }));
    const opts = { inject: cfg.inject, settle: cfg.settle, step: cfg.step, notes: cfg.notes, placement: cfg.placement, reattach: cfg.reattach, thresholds: { ...cfg.thresholds } };
    const overlay = $("<div>").addClass("gm_modal_overlay");
    const dialog = $("<div>").addClass("gm_modal gm_bonds_modal");
    const close = () => fadeOutRemove(overlay);
    const list = $("<div>").addClass("gm_entry_list");
    const num = (v, lo, hi, dec = 0) => {
        const n = Number(v);
        const f = 10 ** dec;
        return Math.min(hi, Math.max(lo, Math.round((Number.isFinite(n) ? n : 0) * f) / f));
    };

    // One small labelled number input (bar start / weights, thresholds).
    const field = (label, title, value, lo, hi, step, onSet, dec = 0) => {
        const input = $("<input>").addClass("gm_input gm_bond_start").attr({ type: "number", min: lo, max: hi, step, title }).val(value);
        input.on("change", () => { const v = num(input.val(), lo, hi, dec); input.val(v); onSet(v); });
        return $("<label>").addClass("gm_bond_field").attr("title", title).append($("<span>").text(label), input);
    };

    const renderList = () => {
        list.empty();
        draft.forEach((b, i) => {
            const name = $("<input>").addClass("gm_input").attr("placeholder", "Bar name").val(b.name).on("input", () => { b.name = name.val(); });
            const desc = $("<input>").addClass("gm_input").attr("placeholder", "What raises or lowers it").val(b.description || "").on("input", () => { b.description = desc.val(); });
            const del = iconBtn("fa-solid fa-trash").on("click", () => { draft.splice(i, 1); renderList(); });
            const weights = $("<div>").addClass("gm_bond_weights").append(
                field("Start", "Start value for a new bond", b.start ?? 20, 0, 100, 1, v => { b.start = v; }),
                field("Close", "How much this bar counts toward closeness (Stranger … Best friend); negative counts against", b.weight ?? 0.5, -1, 1, 0.1, v => { b.weight = v; }, 2),
                field("Romance", "How much this bar counts toward a Crush; negative counts against. No bar with a positive weight = no Crush", b.romance ?? 0, -1, 1, 0.1, v => { b.romance = v; }, 2),
                field("Hostility", "How much this bar counts toward Wary / Hostile; negative counts against", b.hostility ?? 0, -1, 1, 0.1, v => { b.hostility = v; }, 2),
            );
            list.append($("<div>").addClass("gm_entry_row").append(
                $("<div>").addClass("gm_entry_top").append(
                    $("<div>").addClass("gm_entry_main").append(name),
                    $("<div>").addClass("gm_entry_actions").append(del),
                ),
                desc,
                weights,
            ));
        });
        if (!draft.length) list.append($("<div>").addClass("gm_empty").text("No bars — start from a preset or add one."));
    };
    renderList();

    const add = $("<div>").addClass("menu_button gm_small_btn").append($("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Bar"));
    add.on("click", () => { draft.push({ name: "", start: 20, weight: 0.5, romance: 0, hostility: 0, description: "" }); renderList(); });
    const presets = $("<div>").addClass("gm_bond_presets").append(add);
    for (const [key, p] of Object.entries(BOND_PRESETS)) {
        const btn = $("<div>").addClass("menu_button gm_small_btn").text(p.label).attr("title", `Replace the list with: ${p.defs.map(x => x.name).join(", ")}`);
        btn.on("click", () => {
            draft.splice(0, draft.length, ...structuredClone(BOND_PRESETS[key].defs));
            renderList();
        });
        presets.append(btn);
    }

    const notesBtn = $("<div>").addClass("menu_button gm_small_btn")
        .append($("<i>").addClass("fa-solid fa-file-pen"), $("<span>"));
    const refreshNotes = () => notesBtn.attr("title", "The role note the story model plays for each stage")
        .toggleClass("gm_prompt_custom", !!opts.notes.trim())
        .find("span").text(` Stage notes${opts.notes.trim() ? " (custom)" : ""}`);
    refreshNotes();
    notesBtn.on("click", () => openPromptEditor({
        title: "Stage notes",
        hint: "One line per stage, \"Stage: note\". The story model reads the note of each character's current stage (never bars or numbers). A stage left out keeps its built-in note. Saved with this dialog.",
        placeholders: ["{{user}} = your persona's name"],
        value: opts.notes,
        defaultText: defaultStageNotesText(),
        onSave: text => { opts.notes = text; refreshNotes(); },
    }));

    const thresholds = $("<div>").addClass("gm_bond_weights");
    for (const st of BOND_STAGES) {
        if (!(st.key in DEFAULT_BOND_THRESHOLDS)) continue;
        const axis = { close: "closeness", romance: "romance", hostility: "hostility" }[st.axis];
        thresholds.append(field(st.name, `${axis} score (0-100) that makes ${st.name} reachable. Going up still needs the tracker to level the relationship up.`,
            opts.thresholds[st.key], 1, 100, 1, v => { opts.thresholds[st.key] = v; }));
    }

    const injectBox = $("<input>").attr("type", "checkbox").prop("checked", !!opts.inject);
    const placement = $("<select>").addClass("gm_input")
        .append($("<option>").val("low").text("Low priority block (party, while they change)"))
        .append($("<option>").val("message").text("Attached to the message (visible, scrolls out with it)"))
        .val(opts.placement);
    const settle = $("<input>").addClass("gm_input gm_cap_input").attr({ type: "number", min: 2, max: 500 }).val(opts.settle);
    const step = $("<input>").addClass("gm_input gm_cap_input").attr({ type: "number", min: 1, max: 50 }).val(opts.step);
    const reattach = $("<input>").addClass("gm_input gm_cap_input").attr({ type: "number", min: 4, max: 500 }).val(opts.reattach);

    dialog.append(
        $("<b>").text("Bonds"),
        $("<div>").addClass("gm_modal_hint").text("Where each NPC stands with the player. The story model only sees each character's stage and the open threads between them; the bars ground the progression — a stage becomes reachable at its threshold, and the tracker levels the relationship up when the story shows the character accepts it. Graduated bonds (settled Best friend / Crush) are no longer injected."),
        list,
        presets,
        $("<div>").addClass("gm_section_hint").text("Stage thresholds"),
        thresholds,
        $("<div>").addClass("gm_bond_presets").append(notesBtn),
        $("<label>").addClass("checkbox_label").append(injectBox, $("<span>").text("Inject bonds into the story prompt")),
        $("<label>").addClass("gm_cap_wrap").append($("<span>").text("Where"), placement),
        $("<label>").addClass("gm_cap_wrap").attr("title", "Attached placement: messages before a character in the scene gets their line attached again").append($("<span>").text("Re-attach after (messages)"), reattach),
        $("<label>").addClass("gm_cap_wrap").attr("title", "Messages a thread must stay unchanged before it settles").append($("<span>").text("Settle after (messages)"), settle),
        $("<label>").addClass("gm_cap_wrap").attr("title", "Largest change one thread may make to one bar").append($("<span>").text("Max change per thread"), step),
    );

    const save = async () => {
        const next = draft.filter(b => String(b.name || "").trim());
        const removed = cfg.defs.filter(x => !next.some(n => n.id === x.id));
        if (removed.length && !(await confirmAction({
            title: "Remove bars?",
            message: `${removed.map(x => x.name).join(", ")} will be removed from every character's bond.`,
        }))) return;
        stateManager.setBondOptions({
            inject: injectBox.prop("checked"), placement: placement.val(), notes: opts.notes, thresholds: opts.thresholds,
            settle: Number(settle.val()), step: Number(step.val()), reattach: Number(reattach.val()),
        });
        stateManager.setBondDefs(next);
        close();
    };
    dialog.append($("<div>").addClass("gm_modal_actions").append(
        $("<div>").addClass("menu_button").text("Cancel").on("click", close),
        $("<div>").addClass("menu_button gm_modal_save").text("Save").on("click", save),
    ));
    overlay.append(dialog).appendTo("body");
    overlay.on("mousedown", e => { if (e.target === overlay[0]) close(); });
}
