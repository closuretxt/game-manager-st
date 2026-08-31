// Character detail views: Basic Stats (resources + attributes) and generic
// schema-driven list tabs (Inventory / Skills / Passives). Also hosts the
// shared row/editor builders reused by the Custom and Resource Manager tabs.

import { GM_SCHEMA } from "../core/schemas.js";
import { stateManager } from "../core/stateManager.js";
import { progression } from "../core/progression.js";

export function iconBtn(icon) {
    return $("<div>").addClass("gm_icon_btn").append($("<i>").addClass(icon));
}

// Builds an inline edit form from the schema definition of a type.
export function buildEditor(type, entry, onSave, onCancel) {
    const def = GM_SCHEMA[type];
    const editor = $("<div>").addClass("gm_entry_editor");
    for (const field of def.fields) {
        const wrap = $("<div>").addClass("gm_field");
        let input;
        if (field.type === "textarea") {
            input = $("<textarea>").addClass("gm_input").val(entry[field.key] ?? "");
            wrap.addClass("gm_field_wide");
        } else if (field.type === "select") {
            input = $("<select>").addClass("gm_input");
            for (const opt of field.options) input.append($("<option>").val(opt).text(opt));
            input.val(entry[field.key] ?? field.default);
        } else if (field.type === "checkbox") {
            input = $("<input>").attr("type", "checkbox").prop("checked", !!entry[field.key]);
        } else {
            input = $("<input>")
                .attr("type", field.type === "number" ? "number" : "text")
                .addClass("gm_input")
                .val(entry[field.key] ?? "");
            if (field.type === "number") input.attr("step", "any");
        }
        input.attr("data-field", field.key);
        wrap.append($("<label>").text(field.label), input);
        editor.append(wrap);
    }
    const saveBtn = $("<div>").addClass("menu_button gm_small_btn").attr("title", "Save").append($("<i>").addClass("fa-solid fa-check"));
    const cancelBtn = $("<div>").addClass("menu_button gm_small_btn").attr("title", "Cancel").append($("<i>").addClass("fa-solid fa-xmark"));
    saveBtn.on("click", () => {
        const patch = {};
        editor.find("[data-field]").each(function () {
            const key = $(this).attr("data-field");
            const field = def.fields.find(f => f.key === key);
            if (field.type === "checkbox") {
                patch[key] = $(this).prop("checked");
                return;
            }
            let value = $(this).val();
            if (field.type === "number") {
                value = parseFloat(value);
                if (!Number.isFinite(value)) value = 0;
            }
            patch[key] = value;
        });
        onSave(patch);
    });
    cancelBtn.on("click", () => onCancel?.());
    editor.append($("<div>").addClass("gm_editor_actions").append(saveBtn, cancelBtn));
    return editor;
}

// Generic list row: name (+ optional badge right after it) + meta on top,
// optional description, action buttons.
export function buildEntryRow(type, entry, handlers = {}) {
    const row = $("<div>").addClass("gm_entry_row");
    const main = $("<div>").addClass("gm_entry_main");
    main.append($("<span>").addClass("gm_entry_name").text(entry.name || "(unnamed)"));
    if (handlers.nameBadge) {
        const badge = handlers.nameBadge(entry);
        if (badge) main.append(badge);
    }
    const meta = handlers.metaText ? handlers.metaText(entry) : "";
    if (meta) main.append($("<span>").addClass("gm_entry_meta").text(meta));
    const top = $("<div>").addClass("gm_entry_top").append(main);
    const actions = $("<div>").addClass("gm_entry_actions");
    if (handlers.showActions !== false) {
        if (handlers.extraActions) handlers.extraActions(entry, actions);
        const editBtn = iconBtn("fa-solid fa-pen");
        const delBtn = iconBtn("fa-solid fa-trash");
        editBtn.on("click", () => handlers.onEdit?.(entry, row));
        delBtn.on("click", () => handlers.onDelete?.(entry, row));
        actions.append(editBtn, delBtn);
    }
    top.append(actions);
    row.append(top);
    if (entry.description) row.append($("<div>").addClass("gm_entry_desc").text(entry.description));
    return row;
}

function metaFor(type, entry) {
    switch (type) {
        case "item": return `×${entry.qty ?? 1}`;
        case "skill": return entry.cost ? `Cost: ${entry.cost}` : "";
        case "passive": return `[${entry.ptype ?? "special"}]`;
        case "status": return entry.modifiers || "";
        case "custom": return entry.value ?? "";
        default: return "";
    }
}

function startInlineEdit(charId, type, entry, row) {
    const editor = buildEditor(type, entry,
        patch => stateManager.updateEntry(charId, type, entry.id, patch),
        () => stateManager.emitChange("cancel_edit"));
    row.replaceWith(editor);
}

export const characterView = {
    // ---------- Progression: EXP bar + skill points (feature-gated) ----------
    _expBar(char, edit = false) {
        if (!progression.isEnabled()) return null;
        const track = progression.trackOf(char);
        const toNext = progression.expToNext(track.level);
        const pct = Math.min(100, Math.max(0, (track.exp / toNext) * 100));

        const wrap = $("<div>").addClass("gm_list");
        wrap.append($("<div>").addClass("gm_section_header").append(
            $("<b>").text(`Level ${track.level}`),
            $("<span>").addClass("gm_section_hint").text("Experience and unspent skill points."),
        ));

        const row = $("<div>").addClass("gm_res_row");
        row.append($("<div>").addClass("gm_res_name").text("EXP"));
        row.append($("<div>").addClass("gm_res_track").append(
            $("<div>").addClass("gm_res_fill gm_prog_fill").css("width", pct + "%")));
        row.append($("<div>").addClass("gm_res_text").text(`${track.exp}/${toNext}`));
        if (track.skill_points > 0) {
            row.append($("<span>").addClass("gm_points_chip")
                .attr("title", "Unspent skill points")
                .text(`${track.skill_points} SP`));
        }
        if (track.attr_points > 0) {
            row.append($("<span>").addClass("gm_points_chip")
                .attr("title", "Unspent attribute points — spend them on attributes below (edit mode)")
                .text(`${track.attr_points} AP`));
        }

        if (edit) {
            const actions = $("<div>").addClass("gm_entry_actions");
            const expMinus = iconBtn("fa-solid fa-minus").attr("title", "Remove 10 EXP (Shift: 50)");
            expMinus.on("click", e => {
                progression.grantExp(char.id, e.shiftKey ? -50 : -10, { silent: true });
                stateManager.emitChange("progression_edit");
            });
            const expPlus = iconBtn("fa-solid fa-plus").attr("title", "Grant 10 EXP (Shift: 50)");
            expPlus.on("click", e => {
                progression.grantExp(char.id, e.shiftKey ? 50 : 10, { silent: true });
                stateManager.emitChange("progression_edit");
            });
            const spMinus = iconBtn("fa-solid fa-circle-minus").attr("title", "Spend 1 skill point");
            spMinus.on("click", () => {
                if (progression.spendPoints(char.id, 1)) stateManager.emitChange("progression_edit");
            });
            const spPlus = iconBtn("fa-solid fa-circle-plus").attr("title", "Refund 1 skill point");
            spPlus.on("click", () => {
                if (progression.refundPoints(char.id, 1)) stateManager.emitChange("progression_edit");
            });
            actions.append(expMinus, expPlus, spMinus, spPlus);
            row.append(actions);
        }

        wrap.append($("<div>").addClass("gm_entry_row").append(row));
        return wrap;
    },

    // ---------- Basic Stats: resources as bars + attributes grid ----------
    renderStats(container, char, edit = false) {
        const resDef = GM_SCHEMA.resource;
        const progBar = this._expBar(char, edit);
        if (progBar) container.append(progBar);

        const resWrap = $("<div>").addClass("gm_list");
        const resHeader = $("<div>").addClass("gm_section_header").append(
            $("<b>").text(resDef.plural),
            $("<span>").addClass("gm_section_hint").text(resDef.description),
        );
        if (edit) {
            const addRes = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
            addRes.on("click", () => stateManager.addEntry(char.id, "resource"));
            resHeader.append(addRes);
        }
        const resList = $("<div>").addClass("gm_res_list");
        for (const r of char.resources) resList.append(this._resourceRow(char, r, edit));
        if (!char.resources.length) resList.append($("<div>").addClass("gm_empty").text("No resources yet."));
        resWrap.append(resHeader, resList);
        container.append(resWrap);

        const attrDef = GM_SCHEMA.attribute;
        const attrWrap = $("<div>").addClass("gm_list");
        const attrHeader = $("<div>").addClass("gm_section_header").append(
            $("<b>").text(attrDef.plural),
            $("<span>").addClass("gm_section_hint").text(attrDef.description),
        );
        if (edit) {
            const addAttr = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
            addAttr.on("click", () => stateManager.addEntry(char.id, "attribute"));
            attrHeader.append(addAttr);
        }
        const grid = $("<div>").addClass("gm_attr_grid");
        for (const a of char.attributes) grid.append(this._attributeChip(char, a, edit));
        if (!char.attributes.length) grid.append($("<div>").addClass("gm_empty").text("No attributes yet."));
        attrWrap.append(attrHeader, grid);
        container.append(attrWrap);
    },

    _resourceRow(char, r, edit = false) {
        const min = Number(r.min) || 0;
        const max = Number.isFinite(Number(r.max)) ? Number(r.max) : 100;
        const value = Number(r.value) || 0;
        const span = Math.max(1, max - min);
        const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100));

        const rowWrap = $("<div>").addClass("gm_entry_row");
        const row = $("<div>").addClass("gm_res_row");
        row.append($("<div>").addClass("gm_res_name").attr("title", r.name).text(r.name));
        row.append($("<div>").addClass("gm_res_track").append(
            $("<div>").addClass("gm_res_fill").css("width", pct + "%")));
        row.append($("<div>").addClass("gm_res_text").text(`${value}/${max}`));

        if (edit) {
            const actions = $("<div>").addClass("gm_entry_actions");
            const minus = iconBtn("fa-solid fa-minus");
            const plus = iconBtn("fa-solid fa-plus");
            minus.on("click", e => stateManager.applyDelta(char.id, "resource", r.name, { delta: e.shiftKey ? -5 : -1, silent: true }));
            plus.on("click", e => stateManager.applyDelta(char.id, "resource", r.name, { delta: e.shiftKey ? 5 : 1, silent: true }));
            const editBtn = iconBtn("fa-solid fa-pen");
            const delBtn = iconBtn("fa-solid fa-trash");
            editBtn.on("click", () => startInlineEdit(char.id, "resource", r, rowWrap));
            delBtn.on("click", () => stateManager.removeEntry(char.id, "resource", r.id));
            actions.append(minus, plus, editBtn, delBtn);
            row.append(actions);
        }
        rowWrap.append(row);
        return rowWrap;
    },

    _attributeChip(char, a, edit = false) {
        const wrap = $("<div>").addClass("gm_entry_row");
        const chip = $("<div>").addClass("gm_attr_chip");
        chip.append($("<span>").addClass("gm_attr_name").text(a.name));
        chip.append($("<span>").addClass("gm_attr_value").text(a.value));
        // Attribute-point raise: standard usage, available OUTSIDE edit mode —
        // shown whenever the character has unspent AP (cost scales with the
        // current value). The refund stays edit-mode only.
        if (progression.isEnabled() && progression.getConfig().attr_points_per_level > 0) {
            const track = progression.trackOf(char);
            const apActions = $("<div>").addClass("gm_entry_actions");
            if (track.attr_points > 0) {
                const cost = progression.attrCostFor(a.value);
                const apUp = iconBtn("fa-solid fa-circle-up")
                    .attr("title", `Raise ${a.name} by 1 (cost: ${cost} AP)`);
                apUp.on("click", () => {
                    if (progression.spendAttrPoint(char.id, a.name)) stateManager.emitChange("progression_edit");
                });
                apActions.append(apUp);
            }
            if (edit) {
                const apDown = iconBtn("fa-solid fa-circle-down")
                    .attr("title", `Lower ${a.name} by 1 (refunds 1 AP)`);
                apDown.on("click", () => {
                    if (progression.refundAttrPoint(char.id, a.name)) stateManager.emitChange("progression_edit");
                });
                apActions.append(apDown);
            }
            if (apActions.children().length) chip.append(apActions);
        }

        if (edit) {
            const actions = $("<div>").addClass("gm_entry_actions");
            const minus = iconBtn("fa-solid fa-minus");
            const plus = iconBtn("fa-solid fa-plus");
            const editBtn = iconBtn("fa-solid fa-pen");
            const delBtn = iconBtn("fa-solid fa-trash");
            minus.on("click", () => stateManager.applyDelta(char.id, "attribute", a.name, { delta: -1, silent: true }));
            plus.on("click", () => stateManager.applyDelta(char.id, "attribute", a.name, { delta: 1, silent: true }));
            editBtn.on("click", () => startInlineEdit(char.id, "attribute", a, wrap));
            delBtn.on("click", () => stateManager.removeEntry(char.id, "attribute", a.id));
            actions.append(minus, plus, editBtn, delBtn);
            chip.append(actions);
        }
        wrap.append(chip);
        return wrap;
    },

    // ---------- generic schema-driven list (Inventory / Skills / Passives) ----------
    // headerExtra: optional jQuery element appended to the section header
    // (e.g. the Skill Tree launcher on the Skills tab).
    renderList(container, char, type, edit = false, headerExtra = null) {
        const def = GM_SCHEMA[type];
        const wrap = $("<div>").addClass("gm_list");
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text(def.plural),
            $("<span>").addClass("gm_section_hint").text(def.description));
        if (edit) {
            const addBtn = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
            addBtn.on("click", () => stateManager.addEntry(char.id, type));
            header.append(addBtn);
        }
        if (headerExtra) header.append(headerExtra);

        const list = $("<div>").addClass("gm_entry_list");
        for (const entry of char[def.container]) {
            list.append(buildEntryRow(type, entry, {
                metaText: e => metaFor(type, e),
                // Skill cooldown badge: clock + number after the name. Red
                // while under cooldown (number = messages left), neutral when
                // ready (number = configured cooldown length).
                nameBadge: type === "skill" ? e => {
                    const cd = Math.trunc(Number(e.cooldown) || 0);
                    if (cd <= 0) return null;
                    const left = Math.trunc(Number(e.cooldown_left) || 0);
                    const on = left > 0;
                    return $("<span>")
                        .addClass("gm_cd" + (on ? " gm_cd_on" : ""))
                        .attr("title", on ? `On cooldown: ${left} message(s) left` : `Cooldown: ${cd} message(s)`)
                        .append(
                            $("<i>").addClass("fa-regular fa-clock"),
                            $("<span>").text(String(on ? left : cd)),
                        );
                } : null,
                showActions: edit,
                onEdit: (e, row) => startInlineEdit(char.id, type, e, row),
                onDelete: e => stateManager.removeEntry(char.id, type, e.id),
            }));
        }
        if (!char[def.container].length) {
            list.append($("<div>").addClass("gm_empty").text(`No ${def.plural.toLowerCase()} yet.`));
        }
        wrap.append(header, list);
        container.append(wrap);
    },
};