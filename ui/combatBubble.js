// Combat bubble — side-by-side visual feedback for Combat Mode (Text).
// One bubble floats centered above the chat input bar (same spot as the dice
// bubble); each clash group renders as a card with the two sides facing each
// other (party left, enemies right) and its 4 chance tiers streaming in one
// by one. While a group rolls, a highlight sweeps its tiers (slot-machine)
// and the head icon cycles dice faces — the winning tier then pops with a
// glow per group.
//
// The permanent record is DOM-only: attachCombatToMessage appends file-style
// result chips to the player's message WITHOUT editing its text — the LLM
// receives the resolved round through the high-priority injection instead.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { appendResultChip, rollAttachment } from "./diceBubble.js";

const DICE_FACES = ["fa-dice-one", "fa-dice-two", "fa-dice-three", "fa-dice-four", "fa-dice-five", "fa-dice-six"];

// Rich clash UI (setting): face-off titles, role chips, VS badges and
// stronger side tints. Off = the simple layout — plain title, plain sides.
const richUI = () => !!extension_settings[extensionName]?.combat_rich_clash_ui;

class CombatBubble {
    constructor() {
        this.el = null;
        this.groupsEl = null;
        this._groupEls = [];
        this._faceTimer = null;
        this._faceIndex = 0;
        this._rollTimers = new Map(); // group index -> slot-machine interval
        this._closeTimer = null;
        this._actionCount = 0; // stagger counter for the action strip
    }

    // Head icon cycles dice faces while the pipeline is rolling (same feel
    // as the dice bubble).
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

    // Keeps the bubble pinned to the newest content as it streams in.
    _scrollBottom() {
        if (this.el) this.el.scrollTop(this.el[0].scrollHeight);
    }

    // Centers the bubble horizontally over the chat input bar, hugging its top edge.
    _position() {
        const sf = document.getElementById("send_form");
        if (!sf) return;
        const rect = sf.getBoundingClientRect();
        const width = this.el.outerWidth() || 340;
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
        this._scrollBottom();
    }

    _build(statusText) {
        this.close(true);
        this.el = $("<div>").attr("id", "gm_combat_bubble").appendTo("body");
        this.head = $("<div>").addClass("gm_dice_head");
        // Assessment stage (clash resolution): a shaking fist. The icon only
        // becomes cycling dice faces once the groups start rolling.
        this.icon = $("<i>").addClass("fa-solid fa-hand-fist gm_dice_rolling");
        this.status = $("<span>").addClass("gm_dice_status").text(statusText || "");
        this.status.append($("<span>").addClass("gm_dice_shimmer"));
        this.head.append(this.icon, this.status);
        // Persistent action strip lives ABOVE the group cards: a party column
        // that starts alone (full width) and an enemy column that shoves in
        // later. Actions never disappear once shown.
        this.actionsEl = $("<div>").addClass("gm_combat_actions");
        this.partyCol = $("<div>").addClass("gm_combat_actions_col gm_combat_actions_party");
        this.actionsEl.append(this.partyCol);
        this.groupsEl = $("<div>").addClass("gm_combat_groups");
        this.el.append(this.head, this.actionsEl, this.groupsEl);
        this._groupEls = [];
        this._actionCount = 0;
        this.enemyCol = null;
        if (richUI()) this.el.addClass("gm_rich");
        this._position();
        return this;
    }

    show(statusText) {
        this._build(statusText);
        return this;
    }

    // Updates the stage text while keeping the rendered groups.
    update(statusText) {
        if (!this.el) return this.show(statusText);
        this.status.contents().first().replaceWith(statusText || "");
        return this;
    }

    // Staged reveal, phase 1: the party's action cards stream in one by one
    // (staggered slide-in) the moment the ALLY AI pass finishes — no waiting
    // for the clash resolver.
    showActions(partyActions) {
        if (!this.el) return;
        this.partyCol.empty();
        this._actionCount = 0;
        this._addActions(partyActions || [], "party");
    }

    // Phase 2: enemy cards push in after the ENEMY AI finishes — a second
    // column whose flex-grow animates 0 -> 1, visibly SHOVING the party
    // cards aside. Nothing is removed.
    addEnemyActions(enemyActions) {
        if (!this.el || !enemyActions?.length) return;
        if (!this.enemyCol) {
            this.enemyCol = $("<div>").addClass("gm_combat_actions_col gm_combat_actions_enemy");
            this.enemyCol.css("flex-grow", 0.001);
            // Rich mode: bold VS badge between the two facing columns.
            if (richUI()) this.actionsEl.append($("<div>").addClass("gm_combat_vs").text("VS"));
            this.actionsEl.append(this.enemyCol);
            requestAnimationFrame(() => this.enemyCol.css("flex-grow", 1));
        }
        this._addActions(enemyActions, "enemy");
    }

    _addActions(actions, who) {
        const col = who === "enemy" ? this.enemyCol : this.partyCol;
        for (const a of actions) {
            const card = $("<div>").addClass(`gm_combat_action_card gm_combat_action_card_${who}`);
            // Header row (actor + speed) with the action text below at full
            // card width — no skinny mid-column wrapping.
            const head = $("<div>").addClass("gm_combat_card_head");
            if (richUI()) head.append($("<span>").addClass("gm_combat_role").text(who === "enemy" ? "Enemy" : "Party"));
            head.append(
                $("<span>").addClass("gm_combat_actor").text(a.actor),
                $("<span>").addClass("gm_combat_speed").text(`SPD ${a.speed}`),
            );
            card.append(head, $("<div>").addClass("gm_combat_action").text(a.action || ""));
            card.css("animation-delay", `${((this._actionCount++) * 0.18).toFixed(2)}s`);
            col.append(card);
        }
        if (actions.length) this._position();
        this._scrollBottom();
    }

    // Renders/refreshes the group cards from a (possibly partial) streamed
    // group list. The action strip above already shows who does what, so a
    // group card is just its face-off title + chance tiers tweening in.
    syncGroups(groups) {
        if (!this.el || !Array.isArray(groups)) return;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const sig = `${g.title}|${g.tiers.length}`;
            let entry = this._groupEls[i];
            if (!entry) {
                const card = $("<div>").addClass("gm_combat_group");
                const title = $("<div>").addClass("gm_combat_group_title");
                const tiers = $("<div>").addClass("gm_dice_tiers");
                card.append(title, tiers);
                this.groupsEl.append(card);
                entry = { card, title, tiers, tierEls: new Map(), titleText: "", sig: "" };
                this._groupEls[i] = entry;
            }
            // The title streams in AFTER the card exists — refresh on change.
            if (entry.titleText !== g.title) {
                entry.titleText = g.title;
                fillTitle(entry.title, g.title);
            }
            if (entry.sig === sig) continue;
            entry.sig = sig;
            // Tiers are only ADDED as they stream in (tweening one by one) —
            // rebuilding rows would flicker and stale the slot-machine sweep.
            this.stopGroupRoll(i);
            for (const tier of g.tiers) {
                if (entry.tierEls.has(tier.name)) continue;
                const pct = Math.max(0, Math.min(100, Math.round(Number(tier.chance) || 0)));
                const row = $("<div>").addClass("gm_dice_tier gm_tier_in");
                const bar = $("<div>").addClass("gm_dice_tier_bar").css("width", "0%");
                row.append(
                    $("<div>").addClass("gm_dice_tier_bar_wrap").append(bar),
                    $("<span>").addClass("gm_dice_tier_name").text(tier.name),
                    $("<span>").addClass("gm_dice_tier_chance").text(`${pct}%`),
                );
                entry.tiers.append(row);
                entry.tierEls.set(tier.name, { row, bar, pct });
                requestAnimationFrame(() => bar.css("width", pct + "%"));
            }
        }
        this._position();
    }

    // Slot-machine phase for one group: a highlight sweeps the tier rows
    // until resolveGroup lands on the winner.
    startGroupRoll(index) {
        const entry = this._groupEls[index];
        if (!entry || !entry.tierEls.size) return;
        this.stopGroupRoll(index);
        // First spin: swap the assessment fist for cycling dice faces.
        if (!this._faceTimer) this._startDiceCycle();
        const names = [...entry.tierEls.keys()];
        let i = 0;
        const timer = setInterval(() => {
            for (const [name, info] of entry.tierEls) {
                info.row.toggleClass("gm_dice_tier_rolling", name === names[i % names.length]);
            }
            i++;
        }, 130);
        this._rollTimers.set(index, timer);
    }

    stopGroupRoll(index) {
        const timer = this._rollTimers.get(index);
        if (!timer) return;
        clearInterval(timer);
        this._rollTimers.delete(index);
        const entry = this._groupEls[index];
        if (entry) {
            for (const info of entry.tierEls.values()) info.row.removeClass("gm_dice_tier_rolling");
        }
    }

    // Stops the sweep and highlights the winning tier of one group with a pop.
    resolveGroup(index, winner) {
        this.stopGroupRoll(index);
        const entry = this._groupEls[index];
        if (!entry) return;
        for (const [name, info] of entry.tierEls) {
            const isWinner = name === winner.name;
            info.row.toggleClass("gm_dice_tier_win", isWinner);
            if (isWinner) info.bar.addClass("gm_dice_tier_bar_win");
        }
        entry.card.addClass("gm_combat_group_resolved");
        this._position();
    }

    // Pipeline finished — stop the dice cycle, swap the icon for a check and
    // fade out.
    done(text) {
        if (!this.el) return;
        clearInterval(this._faceTimer);
        this._faceTimer = null;
        this.icon.removeClass(DICE_FACES.join(" ")).removeClass("fa-hand-fist gm_dice_rolling").addClass("fa-check");
        this.status.find(".gm_dice_shimmer").remove();
        this.status.text(text || "Combat resolved.");
        this.el.addClass("gm_dice_resolved");
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.close(), 15000);
        this._position();
    }

    close(instant = false) {
        clearTimeout(this._closeTimer);
        this._closeTimer = null;
        clearInterval(this._faceTimer);
        this._faceTimer = null;
        for (const index of [...this._rollTimers.keys()]) this.stopGroupRoll(index);
        if (!this.el) return;
        const el = this.el;
        this.el = null;
        this.groupsEl = null;
        this._groupEls = [];
        if (instant) {
            el.remove();
        } else {
            el.addClass("gm_dice_fadeout");
            setTimeout(() => el.remove(), 400);
        }
    }
}

// Renders the group title as a face-off: the "A vs B" pattern splits into a
// green party half and a red enemy half around a small VS separator, so the
// opposition reads at a glance instead of as one long text line.
const VS_SPLIT = /\s+(?:vs\.?|versus)\s+/i;

function fillTitle(el, title) {
    el.empty();
    // Face-off split only in rich mode; simple mode keeps the plain title.
    const parts = richUI() ? String(title).split(VS_SPLIT) : [String(title)];
    if (parts.length === 2) {
        el.append(
            $("<span>").addClass("gm_combat_title_side gm_combat_title_party").text(parts[0]),
            $("<span>").addClass("gm_combat_title_vs").text("VS"),
            $("<span>").addClass("gm_combat_title_side gm_combat_title_enemy").text(parts[1]),
        );
    } else {
        el.text(title);
    }
}

// Result chips attached to a chat message: one file-style chip per clash
// group (title + winning tier + outcome). The message text (msg.mes) is NEVER
// modified — the LLM gets the round via the high-priority injection. Gated by
// the "Roll attachments" setting (off = nothing is attached). Safe to call
// repeatedly (idempotent per mesId).
export function attachCombatToMessage(mesId, groups, winners) {
    if (!rollAttachment()) return;
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!mesEl || mesEl.querySelector(".gm_roll_file")) return; // already rendered
    (groups || []).forEach((g, i) => {
        const w = winners?.[i];
        if (!w) return;
        const pct = Math.max(0, Math.min(100, Math.round(Number(w.chance) || 0)));
        appendResultChip(mesEl, {
            icon: "fa-hand-fist",
            title: g.title,
            tier: `${w.name} (${pct}%)`,
            outcome: w.outcome,
        });
    });
}

export const combatBubble = new CombatBubble();
