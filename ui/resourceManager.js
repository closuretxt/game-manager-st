// Shared party-wide Resource Manager (Dinheiro, Expendable, ...).
// Managed ONLY by the user — the AI never touches these.

import { stateManager } from "../core/stateManager.js";
import { buildEntryRow, buildEditor, iconBtn } from "./characterView.js";

export const resourceManager = {
    render(container, edit = false) {
        const wrap = $("<div>").addClass("gm_list");
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text("Resource Manager"),
            $("<span>").addClass("gm_section_hint")
                .text("Party-wide resources managed only by the user — the AI will not modify these."),
        );
        if (edit) {
            const addBtn = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
            addBtn.on("click", () => stateManager.addSharedEntry());
            header.append(addBtn);
        }

        const list = $("<div>").addClass("gm_entry_list");
        const shared = stateManager.getData().sharedResources;
        for (const entry of shared) {
            list.append(buildEntryRow("shared", entry, {
                metaText: e => `×${e.qty ?? 0}`,
                showActions: edit,
                extraActions: edit ? (e, actions) => {
                    const minus = iconBtn("fa-solid fa-minus");
                    const plus = iconBtn("fa-solid fa-plus");
                    minus.on("click", () => stateManager.updateSharedEntry(e.id, { qty: (Number(e.qty) || 0) - 1 }));
                    plus.on("click", () => stateManager.updateSharedEntry(e.id, { qty: (Number(e.qty) || 0) + 1 }));
                    actions.append(minus, plus);
                } : undefined,
                onEdit: (e, row) => {
                    const editor = buildEditor("shared", e,
                        patch => stateManager.updateSharedEntry(e.id, patch),
                        () => stateManager.emitChange("cancel_edit"));
                    row.replaceWith(editor);
                },
                onDelete: e => stateManager.removeSharedEntry(e.id),
            }));
        }
        if (!shared.length) {
            list.append($("<div>").addClass("gm_empty").text("No shared resources yet."));
        }
        wrap.append(header, list);
        container.append(wrap);
    },
};