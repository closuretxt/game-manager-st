// Combat bubble — side-by-side visual feedback for Combat Mode (Text).
// One bubble floats centered above the chat input bar (same spot as the dice
// bubble); each clash group renders as a card with the two sides facing each
// other (party left, enemies right) and its 4 chance tiers streaming in one
// by one. While a group rolls, a highlight sweeps its tiers (slot-machine)
// and the head icon cycles dice faces — the winning tier then pops with a
// glow per group.
//
// The permanent record is DOM-only: attachCombatToMessage appends a compact
// result tag to the player's message WITHOUT editing its text — the LLM
// receives the resolved round through the high-priority injection instead.

const DICE_FACES = ["fa-dice-one", "fa-dice-two", "fa-dice-three", "fa-dice-four", "fa-dice-five", "fa-dice-six"];

class CombatBubble {
    constructor() {
        this.el = null;
        this.groupsEl = null;
        this._groupEls = [];
        this._faceTimer = null;
        this._faceIndex = 0;
        this._rollTimers = new Map(); // group index -> slot-machine interval
        this._closeTimer = null;
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
        this.groupsEl = $("<div>").addClass("gm_combat_groups");
        this.el.append(this.head, this.groupsEl);
        this._groupEls = [];
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

    // Renders/refreshes the group cards from a (possibly partial) streamed
    // group list. A card is rebuilt only when its tier count changed, so
    // streaming tiers appear without flickering the rest.
    syncGroups(groups) {
        if (!this.el || !Array.isArray(groups)) return;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const sig = `${g.title}|${g.sides.length}|${g.tiers.length}`;
            let entry = this._groupEls[i];
            if (!entry) {
                const card = $("<div>").addClass("gm_combat_group");
                card.append($("<div>").addClass("gm_combat_group_title").text(g.title));
                const sides = $("<div>").addClass("gm_combat_sides");
                for (const s of g.sides) {
                    sides.append($("<div>").addClass(`gm_combat_side gm_combat_side_${s.who === "enemy" ? "enemy" : "party"}`).append(
                        $("<div>").addClass("gm_combat_actor").text(s.actor),
                        $("<div>").addClass("gm_combat_action").text(s.action || ""),
                        $("<div>").addClass("gm_combat_speed").text(`SPD ${s.speed}`),
                    ));
                }
                const tiers = $("<div>").addClass("gm_dice_tiers");
                card.append(sides, tiers);
                this.groupsEl.append(card);
                entry = { card, tiers, tierEls: new Map(), sig: "" };
                this._groupEls[i] = entry;
            }
            if (entry.sig === sig) continue;
            entry.sig = sig;
            // Rebuilt rows would leave the slot-machine sweeping stale nodes.
            this.stopGroupRoll(i);
            entry.tiers.empty();
            entry.tierEls.clear();
            for (const tier of g.tiers) {
                const pct = Math.max(0, Math.min(100, Math.round(Number(tier.chance) || 0)));
                const row = $("<div>").addClass("gm_dice_tier");
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

// DOM-only result tag attached to a chat message: one compact line per clash
// group (title + winning tier + outcome). The message text (msg.mes) is NEVER
// modified — the LLM gets the round via the high-priority injection. Safe to
// call repeatedly (idempotent per mesId).
export function attachCombatToMessage(mesId, groups, winners) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!mesEl || mesEl.querySelector(".gm_combat_tag")) return;
    const tag = $("<div>").addClass("gm_combat_tag");
    tag.append($("<i>").addClass("fa-solid fa-hand-fist"));
    const body = $("<div>").addClass("gm_combat_tag_body");
    (groups || []).forEach((g, i) => {
        const w = winners?.[i];
        if (!w) return;
        body.append($("<div>").addClass("gm_combat_tag_line").append(
            $("<b>").text(g.title),
            $("<span>").addClass("gm_roll_tag_tier").text(`${w.name} (${Math.round(Number(w.chance) || 0)}%)`),
            $("<span>").addClass("gm_roll_tag_outcome").text(w.outcome),
        ));
    });
    tag.append(body);
    const target = mesEl.querySelector(".mes_text");
    if (target) $(target).after(tag);
}

export const combatBubble = new CombatBubble();
