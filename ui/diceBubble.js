// Dice roll bubble — a floating pseudo-message that appears over the chat the
// moment a skill roll is triggered. Shows a spinning dice while the pre-master
// LLM streams; tier options appear one by one; the winning tier is highlighted
// and the bubble closes itself. Purely visual feedback, no chat pollution.

class DiceBubble {
    constructor() {
        this.el = null;
        this.tierEls = new Map();
        this.spinning = false;
        this._closeTimer = null;
    }

    _build(statusText) {
        this.close(true);
        this.el = $("<div>").attr("id", "gm_dice_bubble").appendTo("body");
        this.head = $("<div>").addClass("gm_dice_head");
        this.icon = $("<i>").addClass("fa-solid fa-dice-d6");
        this.status = $("<span>").addClass("gm_dice_status").text(statusText || "");
        this.head.append(this.icon, this.status);
        this.tiers = $("<div>").addClass("gm_dice_tiers");
        this.el.append(this.head, this.tiers);
        this.spinning = true;
        return this;
    }

    show(statusText) {
        this._build(statusText);
        return this;
    }

    addTier(tier) {
        if (!this.el || this.tierEls.has(tier.name)) return;
        const pct = Math.round(Number(tier.chance) || 0);
        const row = $("<div>").addClass("gm_dice_tier");
        row.append(
            $("<span>").addClass("gm_dice_tier_name").text(tier.name),
            $("<span>").addClass("gm_dice_tier_chance").text(`${pct}%`),
        );
        this.tiers.append(row);
        this.tierEls.set(tier.name, row);
    }

    // Highlights the winning tier and schedules the bubble's dismissal.
    resolve(winner) {
        this.spinning = false;
        if (!this.el) return;
        this.icon.removeClass("fa-spin gm_dice_rolling");
        this.icon.addClass("fa-solid fa-circle-check gm_dice_win");
        for (const [name, row] of this.tierEls) {
            row.toggleClass("gm_dice_tier_win", name === winner.name);
        }
        this.status.text(`${winner.name}: ${winner.outcome}`);
        this._scheduleClose(4200);
    }

    resolveNoRoll() {
        this.spinning = false;
        if (!this.el) return;
        this.icon.removeClass("fa-spin gm_dice_rolling");
        this.status.text("No roll needed.");
        this._scheduleClose(1500);
    }

    _scheduleClose(ms) {
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.close(), ms);
    }

    close(instant = false) {
        clearTimeout(this._closeTimer);
        if (!this.el) return;
        const el = this.el;
        this.el = null;
        this.tierEls.clear();
        this.spinning = false;
        if (instant) {
            el.remove();
        } else {
            el.addClass("gm_dice_fadeout");
            setTimeout(() => el.remove(), 400);
        }
    }
}

export const diceBubble = new DiceBubble();