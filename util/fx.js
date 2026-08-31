// Shared popup motion helpers.

// Fade an overlay out, then remove it from the DOM. Safe to call twice —
// a second call while the fade is running is ignored (the first timeout
// still removes the element).
export function fadeOutRemove($el, ms = 160) {
    if (!$el || !$el.length || $el.hasClass("gm_fade_out")) return;
    $el.addClass("gm_fade_out");
    setTimeout(() => $el.remove(), ms);
}
