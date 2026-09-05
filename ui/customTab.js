// Custom tab — party-wide AI-managed gimmicks (planted seeds, ongoing
// effects, etc). The agent can create/update these; the user can also edit
// them manually (edit mode).
//
// Bottom section (edit mode ONLY): Open Threads — untracked/unfinished
// things and secrets the post-pass leaves for itself (ongoing trips,
// half-done actions). Invisible to the player; the pre-pass and post-pass
// see them, the story prompt does not.

import { stateManager } from "../core/stateManager.js";
import { buildEntryRow, openInlineEditor, openEditors } from "./characterView.js";

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
            const row = buildEntryRow("custom", entry, {
                metaText: e => e.value ?? "",
                showActions: edit,
                onEdit: (e, row) => openInlineEditor("custom", e, row,
                    patch => stateManager.updateCustomEntry(e.id, patch),
                    () => stateManager.emitChange("cancel_edit")),
                onDelete: e => stateManager.removeCustomEntry(e.id),
            });
            // Re-open an editor that was still unresolved before this render.
            let el = row;
            if (edit && openEditors.has(entry.id)) {
                el = openInlineEditor("custom", entry, row,
                    patch => stateManager.updateCustomEntry(entry.id, patch),
                    () => stateManager.emitChange("cancel_edit"));
            }
            list.append(el);
        }
        if (!custom.length) {
            list.append($("<div>").addClass("gm_empty").text("No custom features yet."));
        }
        wrap.append(header, list);
        container.append(wrap);

        // Open Threads — edit mode only: the player must never see these.
        if (edit) this.renderThreads(container);
    },

    renderThreads(container) {
        const threads = stateManager.getData().threads || [];
        const wrap = $("<div>").addClass("gm_list gm_threads");
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text("Open Threads"),
            $("<span>").addClass("gm_section_hint")
                .text("Untracked/unfinished things and secrets the AI leaves for itself. Never shown to the story engine directly."),
        );
        const addBtn = $("<div>").addClass("menu_button gm_add_btn").append(
            $("<i>").addClass("fa-solid fa-plus"), $("<span>").text(" Add"));
        addBtn.on("click", () => stateManager.setThread({ name: "New Thread", text: "", ref: "" }));
        header.append(addBtn);

        const list = $("<div>").addClass("gm_entry_list");
        for (const t of threads) {
            const row = $("<div>").addClass("gm_entry_row gm_thread_row");
            const main = $("<div>").addClass("gm_entry_main");
            main.append($("<b>").text(t.name));
            if (t.ref) main.append($("<span>").addClass("gm_thread_ref").text(t.ref));
            if (t.text) main.append($("<div>").addClass("gm_thread_text").text(t.text));
            const del = $("<div>").addClass("menu_button gm_icon_button").append($("<i>").addClass("fa-solid fa-trash"));
            del.on("click", () => stateManager.removeThread(t.id));
            row.append(main, del);
            list.append(row);
        }
        if (!threads.length) {
            list.append($("<div>").addClass("gm_empty").text("No open threads."));
        }
        wrap.append(header, list);
        container.append(wrap);
    },
};