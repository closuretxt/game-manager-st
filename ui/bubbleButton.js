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

        // Keep the bubble inside the viewport when it shrinks/rotates. The
        // visual viewport listener also catches mobile keyboard/zoom changes.
        $(window).off("resize.gmbubble").on("resize.gmbubble", () => { this._reclamp(); this._ensureVisible(); });
        if (window.visualViewport) {
            $(window.visualViewport).off("resize.gmbubble").on("resize.gmbubble", () => { this._reclamp(); this._ensureVisible(); });
        }

        // Tap: toggle the panel (a drag guard swallows the click after a move).
        this.el.on("click", () => {
            if (this._justDragged) return;
            mainPanel.toggle();
        });

        this._initHoldDrag();

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
        this._logState("init");
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
    // Prefers the visual viewport (pinch-zoom/keyboard safe on mobile),
    // falling back to the layout viewport.
    _clampPosition(x, y) {
        const w = this.el.outerWidth() || 48;
        const h = this.el.outerHeight() || 48;
        const vv = window.visualViewport;
        const vw = vv ? vv.width + (vv.offsetLeft || 0) : window.innerWidth;
        const vh = vv ? vv.height + (vv.offsetTop || 0) : window.innerHeight;
        return {
            x: Math.min(Math.max(x, 4), Math.max(4, vw - w - 4)),
            y: Math.min(Math.max(y, 4), Math.max(4, vh - h - 4)),
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

    // Settings: clear the saved position and snap back to the CSS default
    // bottom-right corner. Also called by the panel's "Reset" button.
    resetPosition(save = true) {
        const s = extension_settings[extensionName];
        s.bubble_pos = { x: null, y: null };
        this.el.css({ left: "", top: "", right: "", bottom: "" });
        if (save) saveSettingsDebounced();
    }

    // Self-heal: if the bubble ended up fully outside the viewport (e.g. a
    // position saved on a desktop-sized screen), snap back to the default
    // corner so it can never be lost.
    _ensureVisible() {
        if (!this.el || !this.enabled || this.el.hasClass("gm_bubble_hidden")) return;
        const r = this.el[0].getBoundingClientRect();
        const off = r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth;
        if (off) {
            console.info("[Game Manager] Bubble was off-screen — resetting its position.", r);
            this.resetPosition();
        }
    }

    // Field diagnostics: dumps the bubble's real geometry, computed styles
    // and the viewport metrics. Used to diagnose "bubble invisible" reports
    // from mobile users (proves whether the element exists but sits
    // off-screen vs. is display:none vs. was never created).
    _logState(label) {
        const el = this.el && this.el[0];
        if (!el) { console.info("[Game Manager] bubble state:", label, "ELEMENT MISSING"); return; }
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const info = {
            label,
            enabled: this.enabled,
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            offscreen: r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth,
            display: cs.display, opacity: cs.opacity, zIndex: cs.zIndex, visibility: cs.visibility,
            inline: { left: el.style.left, top: el.style.top, right: el.style.right, bottom: el.style.bottom },
            savedPos: extension_settings[extensionName].bubble_pos,
            window: { iw: window.innerWidth, ih: window.innerHeight },
            visualViewport: window.visualViewport
                ? { w: window.visualViewport.width, h: window.visualViewport.height, scale: window.visualViewport.scale }
                : null,
        };
        logDebug("bubble state", info);
        return info;
    }

    refresh() {
        if (!this.el) return;
        this.el.toggleClass("gm_bubble_hidden", !this.enabled);
        this._ensureVisible();
    }
}

export const bubbleButton = new BubbleButton();
