// Dice roll bubble — visual feedback for the pre-master flow.
// Phase 1 (rolling): a bubble floats centered ABOVE the chat input bar; a dice
// cycles through its faces while shaking, tier options stream in one by one
// with animated chance bars.
// Phase 2 (result): the winner pops with a glow; a compact result bubble is
// also attached to the player's message IN THE DOM ONLY (the message text
// itself is never edited) — the LLM receives the result through the
// high-priority injection instead.

const DICE_FACES = ["fa-dice-one", "fa-dice-two", "fa-dice-three", "fa-dice-four", "fa-dice-five", "fa-dice-six"];

class DiceBubble {
    constructor() {
        this.el = null;
        this.tierEls = new Map();
        this._faceTimer = null;
        this._closeTimer = null;
        this._faceIndex = 0;
    }

    // Centers the bubble horizontally over the chat input bar, hugging its top edge.
    _position() {
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

    _startDiceCycle() {
        this._faceIndex = 0;
        clearInterval(this._faceTimer);
        this._faceTimer = setInterval(() => {
            this._faceIndex = (this._faceIndex + 1) % DICE_FACES.length;
            this.icon
                .removeClass(DICE_FACES.join(" "))
                .addClass(DICE_FACES[this._faceIndex]);
        }, 130);
    }

    _stopDiceCycle() {
        clearInterval(this._faceTimer);
        this._faceTimer = null;
        this.icon
            .removeClass(DICE_FACES.join(" "))
            .removeClass("gm_dice_rolling")
            .addClass(DICE_FACES[Math.floor(Math.random() * DICE_FACES.length)]);
    }

    _build(statusText) {
        this.close(true);
        this.el = $("<div>").attr("id", "gm_dice_bubble").appendTo("body");
        this.head = $("<div>").addClass("gm_dice_head");
        this.icon = $("<i>").addClass("fa-solid gm_dice_rolling").addClass(DICE_FACES[0]);
        this.status = $("<span>").addClass("gm_dice_status").text(statusText || "");
        this.status.append($("<span>").addClass("gm_dice_shimmer"));
        this.head.append(this.icon, this.status);
        this.tiers = $("<div>").addClass("gm_dice_tiers");
        this.el.append(this.head, this.tiers);
        this._startDiceCycle();
        this._position();
        return this;
    }

    show(statusText) {
        this._build(statusText);
        return this;
    }

    addTier(tier) {
        if (!this.el || this.tierEls.has(tier.name)) return;
        const pct = Math.max(0, Math.min(100, Math.round(Number(tier.chance) || 0)));
        const row = $("<div>").addClass("gm_dice_tier");
        const bar = $("<div>").addClass("gm_dice_tier_bar").css("width", "0%");
        row.append(
            $("<div>").addClass("gm_dice_tier_bar_wrap").append(bar),
            $("<span>").addClass("gm_dice_tier_name").text(tier.name),
            $("<span>").addClass("gm_dice_tier_chance").text(`${pct}%`),
        );
        this.tiers.append(row);
        this.tierEls.set(tier.name, { row, bar, pct });
        // Animate the chance bar in.
        requestAnimationFrame(() => bar.css("width", pct + "%"));
        this._position();
    }

    // Highlights the winning tier with a pop, shows the outcome, and closes.
    resolve(winner) {
        if (!this.el) return;
        this._stopDiceCycle();
        this.icon.addClass("gm_dice_win_pop");
        for (const [name, info] of this.tierEls) {
            const isWinner = name === winner.name;
            info.row.toggleClass("gm_dice_tier_win", isWinner);
            if (isWinner) info.bar.addClass("gm_dice_tier_bar_win");
        }
        this.status.find(".gm_dice_shimmer").remove();
        this.status.text(`${winner.name} — ${winner.outcome}`);
        this.el.addClass("gm_dice_resolved");
        this._scheduleClose(4200);
    }

    resolveNoRoll() {
        if (!this.el) return;
        this._stopDiceCycle();
        this.status.find(".gm_dice_shimmer").remove();
        this.status.text("No roll needed.");
        this.el.addClass("gm_dice_resolved");
        this._scheduleClose(1500);
    }

    _scheduleClose(ms) {
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.close(), ms);
    }

    close(instant = false) {
        clearTimeout(this._closeTimer);
        clearInterval(this._faceTimer);
        this._faceTimer = null;
        if (!this.el) return;
        const el = this.el;
        this.el = null;
        this.tierEls.clear();
        if (instant) {
            el.remove();
        } else {
            el.addClass("gm_dice_fadeout");
            setTimeout(() => el.remove(), 400);
        }
    }
}

// DOM-only result bubble attached to a chat message. The message text (msg.mes)
// is NEVER modified — this is purely visual; the LLM gets the result via the
// high-priority injection. Safe to call repeatedly (idempotent per mesId).
export function attachRollToMessage(mesId, title, winner) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!mesEl) return;
    if (mesEl.querySelector(".gm_roll_tag")) return; // already rendered
    const pct = Math.max(0, Math.min(100, Math.round(Number(winner.chance) || 0)));
    const tag = $("<div>").addClass("gm_roll_tag");
    tag.append(
        $("<i>").addClass("fa-solid fa-dice-d6"),
        $("<b>").text(title),
        $("<span>").addClass("gm_roll_tag_tier").text(`${winner.name} (${pct}%)`),
        $("<span>").addClass("gm_roll_tag_outcome").text(winner.outcome),
    );
    const target = mesEl.querySelector(".mes_text");
    if (target) $(target).after(tag);
}

export const diceBubble = new DiceBubble();