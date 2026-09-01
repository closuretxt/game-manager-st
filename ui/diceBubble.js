// Dice roll bubble — visual feedback for the pre-master flow.
// Phase 1 (rolling): a bubble floats centered ABOVE the chat input bar; a dice
// cycles through its faces while shaking, tier options stream in one by one
// with animated chance bars.
// Phase 2 (result): the winner pops with a glow; the result is also attached
// to the player's message as a file-style chip (ST's own message-file markup,
// DOM only — the message text itself is never edited) — the LLM receives the
// result through the high-priority injection instead.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { onMessageRendered } from "../util/messageDom.js";

const DICE_FACES = ["fa-dice-one", "fa-dice-two", "fa-dice-three", "fa-dice-four", "fa-dice-five", "fa-dice-six"];

// Roll attachments (setting): render roll/combat results as file-style chips
// under the player's message. Off = nothing is attached.
export const rollAttachment = () => !!extension_settings[extensionName]?.roll_attachment;

class DiceBubble {
    constructor() {
        this.el = null;
        this.tierEls = new Map();
        this._faceTimer = null;
        this._sweepTimer = null;
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

    // Slot-machine sweep (same feel as the combat bubble's group roll): a
    // highlight cycles the tier rows until resolve() lands on the winner.
    // Started at roll time (startRoll from the dice roller), not while tiers
    // stream in; the name list is re-read every tick so tiers that streamed
    // in late are swept too. Idempotent while running.
    startRoll() {
        if (!this.el || !this.tierEls.size || this._sweepTimer) return;
        let i = 0;
        this._sweepTimer = setInterval(() => {
            const names = [...this.tierEls.keys()];
            if (!names.length) return;
            for (const [name, info] of this.tierEls) {
                info.row.toggleClass("gm_dice_tier_rolling", name === names[i % names.length]);
            }
            i++;
        }, 130);
    }

    stopRoll() {
        clearInterval(this._sweepTimer);
        this._sweepTimer = null;
        for (const info of this.tierEls.values()) info.row.removeClass("gm_dice_tier_rolling");
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
        this.stopRoll();
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
        this.stopRoll();
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
        clearInterval(this._sweepTimer);
        this._sweepTimer = null;
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

// Builds one file-style chip from ST's own message-file template and appends
// it to the message's .mes_file_wrapper (fallback: after .mes_text). Purely
// visual — no file is uploaded and msg.mes is never touched.
export function appendResultChip(mesEl, { icon = "fa-dice-d6", title, tier, outcome }) {
    const chip = $("#message_file_template .mes_file_container").clone();
    if (!chip.length) {
        console.warn("[Game Manager] roll attachment: #message_file_template not found in this ST version — chip skipped");
        return false;
    }
    chip.addClass("gm_roll_file");
    // Tier-driven hue: failures read red, successes read green.
    chip.addClass(/failure/i.test(tier) ? "gm_tier_bad" : /success/i.test(tier) ? "gm_tier_good" : "");
    chip.find(".mes_file_icon").removeClass("fa-file-alt").addClass(icon);
    chip.find(".mes_file_name").text(title).attr("title", title);
    chip.find(".mes_file_size").text(tier).attr("title", tier);
    // The template's open/delete buttons belong to real files — chips are read-only.
    chip.find(".mes_file_open, .mes_file_delete").remove();
    chip.append($("<div>").addClass("gm_roll_file_outcome").text(outcome));
    const wrap = mesEl.querySelector(".mes_file_wrapper");
    if (wrap) $(wrap).append(chip);
    else $(mesEl.querySelector(".mes_text")).after(chip);
    logDebug("roll attachment: chip appended", { title, tier, wrapper: !!wrap });
    return true;
}

// Result chip attached to a chat message (ST message-file style, DOM-only).
// The message text (msg.mes) is NEVER modified — this is purely visual; the
// LLM gets the result via the high-priority injection. Gated by the "Roll
// attachments" setting (off = nothing is attached). Safe to call repeatedly
// (idempotent per mesId). Waits for the message to render: the dice flow runs
// while the player's message is still held unrendered by ST.
export function attachRollToMessage(mesId, title, winner) {
    if (!rollAttachment()) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(winner.chance) || 0)));
    onMessageRendered(mesId, (mesEl) => {
        if (mesEl.querySelector(".gm_roll_file")) return; // already rendered
        appendResultChip(mesEl, {
            icon: "fa-dice-d6",
            title,
            tier: `${winner.name} (${pct}%)`,
            outcome: winner.outcome,
        });
    });
}

export const diceBubble = new DiceBubble();