// Scroll keeper — preserves the scroll position of the wizard-style modals
// across full re-renders. The Scenario Setup Wizard and the Character Creator
// rebuild their whole overlay DOM on every change (_renderReview), which
// resets .gm_wizard_body's scrollTop to 0 and yanks the user back to the top.
//
// Usage: captureModalScroll(overlayId) right BEFORE the old overlay is
// removed, restoreModalScroll(overlayId) AFTER the new content is attached.
// Keyed by overlay id so the two modals never interfere.

const saved = new Map();

export function captureModalScroll(overlayId) {
    const el = document.querySelector(`#${overlayId} .gm_wizard_body`);
    if (el) saved.set(overlayId, el.scrollTop);
    else saved.delete(overlayId);
}

export function restoreModalScroll(overlayId) {
    const top = saved.get(overlayId);
    saved.delete(overlayId);
    if (!top) return;
    const el = document.querySelector(`#${overlayId} .gm_wizard_body`);
    if (el) el.scrollTop = top;
}
