// Small popover menu anchored to a button (used by the sheet action
// consolidations: Move To / Preset). Items: { icon, label, action }.
// One menu at a time — opening removes any other, outside click dismisses.

export function popoverMenu(btn, items) {
    // Toggle: clicking the anchor again closes the open menu.
    const existing = btn.find(".gm_pop_menu");
    if (existing.length) {
        existing.remove();
        return;
    }
    closePopovers();

    const menu = $("<div>").addClass("gm_pop_menu");
    for (const item of items) {
        const row = $("<div>").addClass("gm_pop_item");
        if (item.icon) row.append($("<i>").addClass(item.icon));
        row.append($("<span>").text(item.label));
        row.on("click", e => {
            e.stopPropagation();
            closePopovers();
            item.action?.();
        });
        menu.append(row);
    }
    btn.append(menu);

    // Clamp: flip to right-aligned when the menu would overflow the window
    // edge (e.g. the Preset button sits at the far right of the sheet row).
    const rect = menu[0].getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
        menu.css({ left: "auto", right: "0" });
    }

    // Outside click dismisses (capture so it beats other handlers).
    $(document).on("mousedown.gm_pop", e => {
        if (!$(e.target).closest(".gm_pop_menu").length) closePopovers();
    });
}

export function closePopovers() {
    $(".gm_pop_menu").remove();
    $(document).off("mousedown.gm_pop");
}
