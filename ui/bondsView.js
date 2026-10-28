// Bonds UI — the per-character Bonds section (on the character page, under
// the stats) and the chat's bar-definition dialog (party header, edit mode).
// Data and rules live in core/bonds.js; everything here goes through the
// stateManager wrappers so changes emit and persist like any other edit.

import { getContext } from "../../../../extensions.js";
import { stateManager, playerNames } from "../core/stateManager.js";
import { gmSettings } from "../core/features.js";
import { BOND_PRESETS, bondConfig, bondDefs, bondBand, formatEffects, isPlayerSheet } from "../core/bonds.js";
import { fadeOutRemove } from "../util/fx.js";
import { confirmAction } from "./confirmModal.js";
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
        $("<span>").addClass("gm_section_hint").text("How they feel about you"),
    ));
    if (!defs.length) {
        wrap.append($("<div>").addClass("gm_empty").text(edit
            ? "No bond bars in this chat yet — set them with the Bonds button on the Party page, or let the Setup Wizard propose them."
            : "No bond bars in this chat yet."));
        container.append(wrap);
        return;
    }
    // Display falls back to start values until the first post-pass creates the bond.
    const bond = char.bond || { label: "", values: {}, statuses: [], history: [] };

    if (edit) {
        const label = $("<input>").addClass("gm_input gm_bond_label").attr("placeholder", "Relationship (e.g. wary ally, warming up)").val(bond.label || "");
        label.on("change", () => stateManager.setBondLabel(char.id, label.val()));
        wrap.append(label);
    } else if (bond.label) {
        wrap.append($("<div>").addClass("gm_bond_label_text").text(bond.label));
    }

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
            row.append($("<span>").addClass("gm_bond_value_text").attr("title", bondBand(v)).text(v));
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
                const end = iconBtn("fa-solid fa-xmark").attr("title", "End this feeling (its effect is taken back)");
                end.on("click", () => stateManager.endBondStatus(char.id, s.name, nowIdx()));
                top.append(end);
            }
            item.append(top);
            const sub = [s.note, s.ends ? `Ends: ${s.ends}` : ""].filter(Boolean).join(" · ");
            if (sub) item.append($("<div>").addClass("gm_entry_desc").text(sub));
            list.append(item);
        }
        wrap.append(list);
    }

    if ((bond.history || []).length) {
        const hist = $("<details>").addClass("gm_bond_history");
        hist.append($("<summary>").text(`Past feelings (${bond.history.length})`));
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
    const opts = { inject: cfg.inject, settle: cfg.settle, step: cfg.step };
    const overlay = $("<div>").addClass("gm_modal_overlay");
    const dialog = $("<div>").addClass("gm_modal gm_bonds_modal");
    const close = () => fadeOutRemove(overlay);
    const list = $("<div>").addClass("gm_entry_list");

    const renderList = () => {
        list.empty();
        draft.forEach((b, i) => {
            const name = $("<input>").addClass("gm_input").attr("placeholder", "Bar name").val(b.name).on("input", () => { b.name = name.val(); });
            const start = $("<input>").addClass("gm_input gm_bond_start").attr({ type: "number", min: 0, max: 100, title: "Start value for a new bond" }).val(b.start ?? 20)
                .on("change", () => { b.start = Math.min(100, Math.max(0, Math.trunc(Number(start.val()) || 0))); start.val(b.start); });
            const desc = $("<input>").addClass("gm_input").attr("placeholder", "What raises or lowers it").val(b.description || "").on("input", () => { b.description = desc.val(); });
            const del = iconBtn("fa-solid fa-trash").on("click", () => { draft.splice(i, 1); renderList(); });
            list.append($("<div>").addClass("gm_entry_row").append(
                $("<div>").addClass("gm_entry_top").append(
                    $("<div>").addClass("gm_entry_main").append(name, start),
                    $("<div>").addClass("gm_entry_actions").append(del),
                ),
                desc,
            ));
        });
        if (!draft.length) list.append($("<div>").addClass("gm_empty").text("No bars — start from a preset or add one."));
    };
    renderList();

    const add = $("<div>").addClass("menu_button gm_small_btn").append($("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Bar"));
    add.on("click", () => { draft.push({ name: "", start: 20, description: "" }); renderList(); });
    const presets = $("<div>").addClass("gm_bond_presets").append(add);
    for (const [key, p] of Object.entries(BOND_PRESETS)) {
        const btn = $("<div>").addClass("menu_button gm_small_btn").text(p.label).attr("title", `Replace the list with: ${p.defs.map(x => x.name).join(", ")}`);
        btn.on("click", () => {
            draft.splice(0, draft.length, ...structuredClone(BOND_PRESETS[key].defs));
            renderList();
        });
        presets.append(btn);
    }

    const injectBox = $("<input>").attr("type", "checkbox").prop("checked", !!opts.inject);
    const settle = $("<input>").addClass("gm_input gm_cap_input").attr({ type: "number", min: 2, max: 500 }).val(opts.settle);
    const step = $("<input>").addClass("gm_input gm_cap_input").attr({ type: "number", min: 1, max: 50 }).val(opts.step);

    dialog.append(
        $("<b>").text("Bonds"),
        $("<div>").addClass("gm_modal_hint").text("How each NPC feels about the player. The bars only move through feelings the post-pass reports; a feeling left alone settles into the bars for good, an ended one is taken back."),
        list,
        presets,
        $("<label>").addClass("checkbox_label").append(injectBox, $("<span>").text("Inject bonds of the characters in the scene into the story prompt (each turn, with what changed last turn)")),
        $("<label>").addClass("gm_cap_wrap").attr("title", "Messages a feeling must stay unchanged before it settles").append($("<span>").text("Settle after (messages)"), settle),
        $("<label>").addClass("gm_cap_wrap").attr("title", "Largest change one feeling may make to one bar").append($("<span>").text("Max change per feeling"), step),
    );

    const save = async () => {
        const next = draft.filter(b => String(b.name || "").trim());
        const removed = cfg.defs.filter(x => !next.some(n => n.id === x.id));
        if (removed.length && !(await confirmAction({
            title: "Remove bars?",
            message: `${removed.map(x => x.name).join(", ")} will be removed from every character's bond.`,
        }))) return;
        stateManager.setBondOptions({ inject: injectBox.prop("checked"), settle: Number(settle.val()), step: Number(step.val()) });
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
