// Status bubble — live feedback for the pre-turn pipeline.
// The story generation waits for the pre-pass LLM, during which the UI looks
// frozen; this bubble floats above the input bar and narrates every stage
// (judging the action, rolling dice, checking transactions...) so the player
// always knows what the game system is doing.

class StatusBubble {
    constructor() {
        this.el = null;
        this.head = null;
        this.icon = null;
        this.status = null;
        this.lines = null;
        this._closeTimer = null;
        this._isNotification = false;
    }

    // Hugs the top edge of the send form, centered (same anchor as the dice bubble).
    _position() {
        if (!this.el) return;
        const sf = document.getElementById("send_form");
        if (!sf) return;
        const rect = sf.getBoundingClientRect();
        const width = this.el.outerWidth() || 280;
        const left = Math.min(
            Math.max(rect.left + rect.width / 2 - width / 2, 12),
            Math.max(window.innerWidth - width - 12, 12)
        );
        this.el.css({
            left: left + "px",
            bottom: (window.innerHeight - rect.top + 12) + "px",
            top: "auto",
            right: "auto",
        });
    }

    _build(text) {
        this.close(true);
        clearTimeout(this._closeTimer);
        this._isNotification = false;
        this.el = $("<div>").attr("id", "gm_status_bubble").appendTo("body");
        this.head = $("<div>").addClass("gm_status_head");
        this.icon = $("<i>").addClass("fa-solid fa-compass gm_status_spin");
        this.status = $("<span>").addClass("gm_status_text").text(text || "");
        this.head.append(this.icon, this.status);
        this.lines = $("<div>").addClass("gm_status_lines");
        this.el.append(this.head, this.lines);
        this._position();
        return this;
    }

    // Shows (or updates) the bubble with a spinner — the pipeline is working.
    show(text) {
        if (!this.el) this._build(text);
        else this.status.text(text || "");
        this._isNotification = false;
        this.icon.attr("class", "fa-solid fa-compass gm_status_spin");
        this.el.removeClass("gm_status_done");
        this._position();
        return this;
    }

    // Updates the stage text while keeping accumulated result lines.
    update(text) {
        if (!this.el) return this.show(text);
        this.status.text(text || "");
        this._position();
        return this;
    }

    // Appends a permanent result line (e.g. "Dinheiro: -6 → 94 · ...").
    // `html` accepts pre-escaped markup (notification highlights).
    result(text, html = false) {
        if (!this.el) this.show("");
        if (!text) return this;
        this.lines.append(this._line(text, html));
        this._position();
        return this;
    }

    // Builds one result line — plain text by default, HTML when the caller
    // already escaped every dynamic value (notifications.js highlight spans).
    _line(text, html) {
        const line = $("<div>").addClass("gm_status_line");
        if (html) line.html(String(text));
        else line.text(String(text));
        return line;
    }

    // Pipeline finished — swap the spinner for a check and fade out.
    done(text) {
        if (!this.el) {
            if (text) this.show(text);
            else return this;
        }
        if (text) this.status.text(text);
        this.icon.attr("class", "fa-solid fa-circle-check gm_status_check");
        this.el.addClass("gm_status_done");
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.close(), 2600);
        this._position();
        return this;
    }

    // Standalone notification (notifications feature): shows a line in the
    // bubble WITHOUT a pipeline running. When the pipeline bubble is already
    // up, the line simply joins its results; otherwise a lightweight bubble
    // with a check icon is created and auto-closes after `timeout` ms.
    notify(text, timeout = 4000, html = false) {
        if (!text) return this;
        if (this.el && !this._isNotification) {
            // Pipeline bubble active — piggyback on its result lines.
            return this.result(text, html);
        }
        if (!this.el) {
            this._build("");
            this._isNotification = true;
            this.icon.attr("class", "fa-solid fa-circle-check gm_status_check");
            this.el.addClass("gm_status_done");
        }
        this.lines.append(this._line(text, html));
        this._position();
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.close(), timeout);
        return this;
    }

    close(instant = false) {
        clearTimeout(this._closeTimer);
        const wasNotification = this._isNotification;
        this._isNotification = false;
        if (!this.el) return;
        const el = this.el;
        this.el = null;
        this.head = null;
        this.icon = null;
        this.status = null;
        this.lines = null;
        if (instant) {
            el.remove();
        } else {
            // Notifications fade out slower with a downward drift; pipeline
            // bubbles pop out fast.
            el.addClass(wasNotification ? "gm_note_fadeout" : "gm_dice_fadeout");
            setTimeout(() => el.remove(), wasNotification ? 700 : 400);
        }
    }
}

export const statusBubble = new StatusBubble();
