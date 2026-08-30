// Shared schema-driven sheet editor, used by the Scenario Setup Wizard and the
// Character Creator review pages. Renders every character container with
// inline entry editors; edits write straight into the entry objects.

import { GM_SCHEMA, CHARACTER_CONTAINERS, CONTAINER_TYPES, defaultEntry } from "../core/schemas.js";
import { iconBtn } from "./characterView.js";

//

// One entry as an editable block: scalar fields inline, the description
// full-width below (always visible, like the live sheets). Edits write
// straight into the entry object; onChange fires after every edit.
export function entryInputs(type, entry, onDelete, onChange = () => {}) {
    const box = $("<div>").addClass("gm_wizard_sheet_entry");
    const row = $("<div>").addClass("gm_wizard_sheet_row");
    for (const field of GM_SCHEMA[type].fields) {
        if (field.key === "description") continue;
        let input;
        if (field.type === "select") {
            input = $("<select>").addClass("gm_input");
            for (const opt of field.options) input.append($("<option>").val(opt).text(opt));
            input.val(entry[field.key] ?? field.default);
        } else if (field.type === "checkbox") {
            input = $("<input>").attr("type", "checkbox")
                .prop("checked", !!entry[field.key]).attr("title", field.label);
        } else {
            input = $("<input>")
                .attr("type", field.type === "number" ? "number" : "text")
                .addClass("gm_input")
                .attr("placeholder", field.label)
                .attr("title", field.label)
                .val(entry[field.key] ?? "");
        }
        input.on(field.type === "checkbox" ? "change" : "input", () => {
            if (field.type === "number") {
                const n = parseFloat(input.val());
                entry[field.key] = Number.isFinite(n) ? n : 0;
            } else if (field.type === "checkbox") {
                entry[field.key] = input.prop("checked");
            } else {
                entry[field.key] = String(input.val() ?? "");
            }
            onChange();
        });
        row.append(input);
    }
    const del = iconBtn("fa-solid fa-trash");
    del.on("click", onDelete);
    row.append(del);
    box.append(row);
    const desc = $("<input>").attr("type", "text")
        .addClass("gm_input gm_wizard_sheet_desc")
        .attr("placeholder", "Description — what this tracks / why it matters")
        .val(entry.description ?? "");
    desc.on("input", () => {
        entry.description = String(desc.val() ?? "");
        onChange();
    });
    box.append(desc);
    return box;
}

//

// Expanded sheet: every container with inline schema-driven entry editors,
// so the user can see and tweak exactly what was proposed. onAdd/onDelete
// re-render the host view; onChange fires on field edits.
export function sheetEditor(char, { onAdd = () => {}, onDelete = () => {}, onChange = () => {} } = {}) {
    const wrap = $("<div>").addClass("gm_wizard_sheet");
    for (const container of CHARACTER_CONTAINERS) {
        const type = CONTAINER_TYPES[container];
        const def = GM_SCHEMA[type];
        if (!Array.isArray(char[container])) char[container] = [];
        const add = iconBtn("fa-solid fa-plus").attr("title", `Add ${def.label}`);
        add.on("click", () => {
            char[container].push(defaultEntry(type));
            onAdd();
        });
        const sec = $("<div>").addClass("gm_wizard_sheet_sec").append(
            $("<div>").addClass("gm_wizard_sheet_head").append(
                $("<i>").addClass(def.icon),
                $("<span>").text(def.plural),
                $("<div>").addClass("gm_wizard_spacer"),
                add,
            ),
        );
        const list = $("<div>").addClass("gm_wizard_sheet_list");
        for (const entry of char[container]) {
            list.append(entryInputs(type, entry, () => {
                const idx = char[container].indexOf(entry);
                if (idx !== -1) char[container].splice(idx, 1);
                onDelete();
            }, onChange));
        }
        if (!char[container].length) list.append($("<div>").addClass("gm_empty").text("—"));
        sec.append(list);
        wrap.append(sec);
    }
    return wrap;
}
