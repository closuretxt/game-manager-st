// Custom tab — party-wide AI-managed gimmicks (planted seeds, ongoing
// effects, etc). The agent can create/update these; the user can also edit
// them manually (edit mode).

import { stateManager } from "../core/stateManager.js";
import { buildEntryRow, buildEditor } from "./characterView.js";

export const customTab = {
    render(container, edit = false) {
        const wrap = $("<div>").addClass("gm_list");
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text("Custom"),
            $("<span>").addClass("gm_section_hint")
                .text("Party-wide features managed by the AI during roleplay (e.g. planted seeds)."),
        );
        if (edit) {
            const addBtn = $("<div>").addClass("menu_button gm_add_btn").append(
                $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
            addBtn.on("click", () => stateManager.addCustomEntry());
            header.append(addBtn);
        }

        const list = $("<div>").addClass("gm_entry_list");
        const custom = stateManager.getData().custom;
        for (const entry of custom) {
            list.append(buildEntryRow("custom", entry, {
                metaText: e => e.value ?? "",
                showActions: edit,
                onEdit: (e, row) => {
                    const editor = buildEditor("custom", e,
                        patch => stateManager.updateCustomEntry(e.id, patch),
                        () => stateManager.emitChange("cancel_edit"));
                    row.replaceWith(editor);
                },
                onDelete: e => stateManager.removeCustomEntry(e.id),
            }));
        }
        if (!custom.length) {
            list.append($("<div>").addClass("gm_empty").text("No custom features yet."));
        }
        wrap.append(header, list);
        container.append(wrap);
    },
};