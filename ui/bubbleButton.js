// Mobile-friendly floating bubble that toggles the Game Manager panel.
// Tap it to open/close the panel, HOLD and move to reposition it. Tapping
// anywhere off the GM UI fades the bubble into a ghost AND fades the panel
// out. The bubble is always clamped inside the viewport (on load, while
// dragging, and on resize) so it can never be clipped off screen.
// Enabled from the settings ("Bubble button", under Enabled).

import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { mainPanel } from "./mainPanel.js";

class BubbleButton {
    constructor() {
        this.el = null;
        this._justDragged = false;
    }

    // Master switch AND the bubble toggle must both be on.
    get enabled() {
        const s = extension_settings[extensionName];
        return !!s.enabled && !!s.feature_bubble_button;
    }

    init() {
        this.el = $("<div>")
            .attr("id", "gm_bubble_btn")
            .attr("title", "Game Manager")
            .append($("<i>").addClass("fa-solid fa-dice-d20"))
            .appendTo("body");
        this._applySavedPosition();

        // Tap: toggle the panel (a drag guard swallows the click after a move).
        this.el.on("click", () => {
            if (this._justDragged) return;
            mainPanel.toggle();
        });

        this._initHoldDrag();

        // Keep the bubble inside the viewport when it shrinks/rotates.
        $(window).off("resize.gmbubble").on("resize.gmbubble", () => this._reclamp());

        // Tap/click anywhere off the GM UI: ghost the bubble + fade the panel.
        $(document).off("pointerdown.gmbubble").on("pointerdown.gmbubble", (e) => {
            if (!this.enabled) return;
            const onGm = $(e.target).closest("#gm_bubble_btn, #gm_floating_window").length > 0
                || $(e.target).closest('[id^="gm_"], [class*="gm_"]').length > 0;
            if (onGm) {
                this.el.removeClass("gm_bubble_ghost");
                return;
            }
            this.el.addClass("gm_bubble_ghost");
            if ($("#gm_floating_window").is(":visible")) mainPanel.close();
        });

        // Hover/press restores full opacity from the ghost state.
        this.el.on("pointerenter pointerdown", () => this.el.removeClass("gm_bubble_ghost"));

        // Settings checkboxes: live enable/disable of the bubble.
        $("#gm_setting_bubble_btn, #gm_setting_enabled").off("change.gmbubble").on("change.gmbubble", () => this.refresh());

        this.refresh();
        logDebug("bubble button initialized");
    }

    // Hold (~300ms) or move >12px to enter drag mode; release drops the
    // bubble at the pointer and saves the position.
    _initHoldDrag() {
        let hold = null;
        this.el.off("pointerdown.gmbdrag").on("pointerdown.gmbdrag", (e) => {
            hold = {
                id: e.pointerId, x: e.clientX, y: e.clientY, drag: false,
                timer: setTimeout(() => { if (hold) hold.drag = true; }, 300),
            };
        });
        $(document).off("pointermove.gmbdrag").on("pointermove.gmbdrag", (e) => {
            if (!hold || e.pointerId !== hold.id) return;
            if (!hold.drag && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) < 12) return;
            hold.drag = true;
            clearTimeout(hold.timer);
            const w = this.el.outerWidth(), h = this.el.outerHeight();
            this._setPosition(e.clientX - w / 2, e.clientY - h / 2);
            e.preventDefault();
        });
        $(document).off("pointerup.gmbdrag pointercancel.gmbdrag").on("pointerup.gmbdrag pointercancel.gmbdrag", (e) => {
            if (!hold || e.pointerId !== hold.id) return;
            const wasDrag = hold.drag;
            clearTimeout(hold.timer);
            hold = null;
            if (!wasDrag) return;
            // Save the dropped position; swallow the click that follows a drag.
            this._justDragged = true;
            const s = extension_settings[extensionName];
            s.bubble_pos = { x: parseFloat(this.el.css("left")), y: parseFloat(this.el.css("top")) };
            saveSettingsDebounced();
            setTimeout(() => { this._justDragged = false; }, 250);
        });
    }

    // ---------- positioning ----------

    // Clamp a top-left coordinate so the bubble stays fully on screen.
    _clampPosition(x, y) {
        const w = this.el.outerWidth() || 48;
        const h = this.el.outerHeight() || 48;
        return {
            x: Math.min(Math.max(x, 4), Math.max(4, window.innerWidth - w - 4)),
            y: Math.min(Math.max(y, 4), Math.max(4, window.innerHeight - h - 4)),
        };
    }

    _setPosition(x, y) {
        const p = this._clampPosition(x, y);
        this.el.css({ left: p.x + "px", top: p.y + "px", right: "auto", bottom: "auto" });
    }

    // Restore the saved position (clamped against the current viewport).
    _applySavedPosition() {
        const pos = extension_settings[extensionName].bubble_pos;
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) this._setPosition(pos.x, pos.y);
    }

    // Re-clamp the current position after a viewport change.
    _reclamp() {
        if (!this.el) return;
        const x = parseFloat(this.el.css("left"));
        const y = parseFloat(this.el.css("top"));
        if (Number.isFinite(x) && Number.isFinite(y)) this._setPosition(x, y);
    }

    refresh() {
        if (!this.el) return;
        this.el.toggleClass("gm_bubble_hidden", !this.enabled);
    }
}

export const bubbleButton = new BubbleButton();
