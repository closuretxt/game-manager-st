// Standard Card dialog — edits the chat's card (core/cardTemplates.js) and
// which party characters follow it. Works on a draft: nothing touches state
// until Save, which syncs every linked sheet in one change (Cancel drops it).

import { gmNotify } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import {
    TEMPLATE_CONTAINERS, hasTemplate, getTemplate, templateDraft, templateFromSheet, syncTemplate, setEnemiesFollowCard,
} from "../core/cardTemplates.js";
import { fadeOutRemove } from "../util/fx.js";
import { confirmAction } from "./confirmModal.js";
import { sheetEditor } from "./sheetEditor.js";

// Linked copies a save would delete: card fields dropped from the draft.
function removalCount(d, draft, links, enemies) {
    const kept = new Set(TEMPLATE_CONTAINERS.flatMap(k => draft[k].map(f => f.id)));
    const tpl = getTemplate(d);
    if (!tpl) return 0;
    const gone = new Set(TEMPLATE_CONTAINERS.flatMap(k => (tpl[k] || []).map(f => f.id)).filter(id => !kept.has(id)));
    const sheets = [
        ...(d.characters || []).filter(c => links.get(c.id)),
        ...(enemies && d.cardEnemies ? [...(d.enemies || []), ...(d.enemyArchive || [])] : []),
    ];
    let n = 0;
    for (const c of sheets) {
        for (const k of TEMPLATE_CONTAINERS) n += (c[k] || []).filter(e => gone.has(e.tid)).length;
    }
    return n;
}

export function openCardTemplateDialog() {
    const d = stateManager.getData();
    let draft = templateDraft(d);
    // A brand-new card links the whole party by default.
    const fresh = !hasTemplate(d);
    const links = new Map((d.characters || []).map(c => [c.id, fresh || !!c.template_link]));
    let enemies = !!d.cardEnemies;

    const overlay = $("<div>").addClass("gm_modal_overlay");
    const dialog = $("<div>").addClass("gm_modal gm_card_modal");
    const body = $("<div>");
    let off = null;
    const close = () => {
        off?.();
        fadeOutRemove(overlay);
    };

    const render = () => {
        body.empty();
        const chars = d.characters || [];

        if (chars.length) {
            const from = $("<select>").addClass("text_pole");
            from.append($("<option>").val("").text("Start from a character's sheet..."));
            for (const c of chars) from.append($("<option>").val(c.id).text(c.name));
            from.on("change", () => {
                const c = chars.find(x => x.id === from.val());
                if (!c) return;
                draft = templateFromSheet(c);
                render();
            });
            body.append(from);
        }

        body.append(sheetEditor(draft, {
            containers: TEMPLATE_CONTAINERS,
            onAdd: render,
            onDelete: render,
        }));

        if (chars.length) {
            body.append($("<div>").addClass("gm_settings_subhead").text("Characters following the card"));
            const grid = $("<div>").addClass("gm_settings_grid");
            for (const c of chars) {
                const box = $("<input>").attr("type", "checkbox").prop("checked", !!links.get(c.id));
                box.on("change", () => links.set(c.id, box.prop("checked")));
                grid.append($("<label>").addClass("checkbox_label").append(box, $("<span>").text(c.name)));
            }
            body.append(grid);
        }

        // Enemies: one chat-wide switch (active and archived enemies, plus
        // every new one the tracker or the creator adds).
        const enemyBox = $("<input>").attr("type", "checkbox").prop("checked", enemies);
        enemyBox.on("change", () => {
            enemies = enemyBox.prop("checked");
        });
        body.append($("<label>").addClass("checkbox_label")
            .attr("title", "Every enemy (current, archived and new) carries the card fields and follows card edits; values stay per enemy")
            .append(enemyBox, $("<span>").text("Enemies follow the card too")));
    };

    const save = async () => {
        const removed = removalCount(d, draft, links, enemies);
        if (removed) {
            const ok = await confirmAction({
                title: "Remove fields from linked sheets?",
                message: `${removed} entr${removed === 1 ? "y" : "ies"} on linked characters belong to card fields you removed and will be deleted with their values.`,
                confirmLabel: " Remove",
            });
            if (!ok) return;
        }
        for (const c of d.characters || []) {
            if (links.get(c.id)) c.template_link = true;
            else delete c.template_link;
        }
        // Turning the option off first keeps the sync away from enemies;
        // turning it on after the sync conforms them to the saved card.
        if (!enemies) setEnemiesFollowCard(d, false);
        const stats = syncTemplate(d, draft);
        if (enemies && hasTemplate(d)) setEnemiesFollowCard(d, true);
        stateManager.emitChange("card_template");
        gmNotify(hasTemplate(d)
            ? `Standard card saved — ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed on linked sheets.`
            : "Standard card removed — sheets keep their entries.", "success");
        close();
    };

    const remove = $("<div>").addClass("menu_button")
        .attr("title", "Delete the card. Every sheet keeps its entries; nothing follows a card anymore.")
        .text("Delete card");
    remove.on("click", async () => {
        const ok = await confirmAction({
            title: "Delete the standard card?",
            message: "Characters keep every entry they have; they just stop following card edits.",
            confirmLabel: " Delete",
        });
        if (!ok) return;
        syncTemplate(d, {});
        for (const c of d.characters || []) delete c.template_link;
        for (const r of d.roster || []) delete r.template_link;
        stateManager.emitChange("card_template");
        close();
    });

    render();
    // The draft belongs to this state object — drop it if the chat switches
    // or a rollback swaps the data underneath.
    off = stateManager.onChange((reason) => {
        if (reason === "chat_loaded" || reason === "restore") close();
    });

    dialog.append(
        $("<b>").text("Standard Card"),
        $("<div>").addClass("gm_modal_hint").text(
            "The resources, attributes and details every linked character carries. Renames, ranges and descriptions "
            + "reach every linked sheet; values stay per character (the values here are starting values for new characters). "
            + "The Setup Wizard, Character Creator and new-character reviews follow it."),
        body,
        $("<div>").addClass("gm_modal_actions").append(
            ...(hasTemplate(d) ? [remove] : []),
            $("<div>").addClass("menu_button").text("Cancel").on("click", close),
            $("<div>").addClass("menu_button gm_modal_save").text("Save").on("click", save),
        ),
    );
    overlay.append(dialog).appendTo("body");
    overlay.on("mousedown", e => { if (e.target === overlay[0]) close(); });
}
