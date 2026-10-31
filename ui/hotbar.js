// Action hotbar — Skills/Items pills floating above the chat input bar.
// Clicking a pill opens a drawer panel with one always-open group per party
// character (the MC first). Each entry expands to show its details; the +
// button drops its name into the input bar ("Use X to " when empty — for
// non-MC characters "{Name} uses X to " instead). Enabled from the settings
// ("Action Hotbar", under Enabled). While a contest runs, a Fight pill lists
// the shape's basic actions as quick actions (core/contest/quick.js).

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { stateManager } from "../core/stateManager.js";
import { logDebug } from "../core/debug.js";
import { containerEnabled, gmSettings } from "../core/features.js";
import { contestActive, contestRuleset } from "../core/contest/contest.js";
import { quickActions, setQuickAction, clearQuickActions, quickPhrase } from "../core/contest/quick.js";
import { contestKey } from "../core/contest/effects.js";

// The Fight pill: quick actions while a contest runs (not under Legacy).
const fightShown = () => !!gmSettings().feature_combat && contestActive()
    && (stateManager.getData().enemies || []).length > 0 && !contestRuleset("clash").legacy;

// `container` = the tab-toggleable sheet container (core/features.js); a pill
// whose container is hidden for this chat disappears with it. `when` = an
// extra visibility gate.
const HOTBAR_TABS = [
    { id: "skills", label: "Skills", icon: "fa-solid fa-bolt", container: "skills" },
    { id: "items", label: "Items", icon: "fa-solid fa-box-open", container: "inventory" },
    { id: "fight", label: "Fight", icon: "fa-solid fa-hand-fist", when: fightShown },
];
const visibleTabs = () => HOTBAR_TABS.filter(t => (!t.container || containerEnabled(t.container)) && (!t.when || t.when()));

class Hotbar {
    constructor() {
        this.root = null;  // pill row
        this.panel = null; // drawer panel
        this.activeTab = "skills";
        this._open = false;
        this._resizeObserver = null;
    }

    // Master switch AND the hotbar toggle must both be on.
    get enabled() {
        const s = extension_settings[extensionName];
        return !!s.enabled && !!s.feature_hotbar;
    }

    init() {
        this.root = $("<div>").attr("id", "gm_hotbar").appendTo("body");
        this.panel = $("<div>").attr("id", "gm_hotbar_panel").appendTo("body");

        //
        for (const tab of HOTBAR_TABS) {
            const pill = $("<div>")
                .addClass("gm_hotbar_pill")
                .attr("data-tab", tab.id)
                .attr("title", `Open the ${tab.label.toLowerCase()} of every party character`)
                .append($("<i>").addClass(tab.icon), $("<span>").text(tab.label))
                .on("click", () => this.toggle(tab.id));
            this.root.append(pill);
        }

        // Click anywhere off the hotbar closes the panel.
        $(document).off("pointerdown.gmhotbar").on("pointerdown.gmhotbar", (e) => {
            if (!this._open) return;
            if ($(e.target).closest("#gm_hotbar, #gm_hotbar_panel").length) return;
            this.close();
        });

        // Keep pills/panel glued to the input bar on any layout change.
        $(window).off("resize.gmhotbar").on("resize.gmhotbar", () => this._position());
        this._resizeObserver = new ResizeObserver(() => this._position());
        const sf = document.getElementById("send_form");
        if (sf) this._resizeObserver.observe(sf);

        // Re-render on any tracked-state change (skills granted, cooldowns ticked, party swaps).
        // Feature/chat changes may hide pills, so the pill row refreshes too.
        // Contest start/end shows or hides the Fight pill; a chat switch
        // forgets unsent quick actions.
        stateManager.onChange((reason) => {
            if (reason === "chat_loaded") clearQuickActions();
            if (reason === "features" || reason === "chat_loaded" || reason === "contest_round" || reason === "contest_end") this.refresh();
            else if (this._open) this._renderPanel();
        });

        // Settings checkboxes: live enable/disable.
        $("#gm_setting_hotbar, #gm_setting_enabled").off("change.gmhotbar").on("change.gmhotbar", () => this.refresh());

        //
        this.refresh();
        logDebug("hotbar initialized");
    }

    // Shows/hides the pills; keeps the open panel in sync with settings.
    refresh() {
        const tabs = visibleTabs();
        const on = this.enabled && tabs.length > 0;
        this.root.toggle(on);
        if (!on) return this.close();
        this.root.children().each((_, el) => {
            $(el).toggle(tabs.some(t => t.id === $(el).attr("data-tab")));
        });
        if (!tabs.some(t => t.id === this.activeTab)) {
            this.activeTab = tabs[0].id;
            if (this._open) return this.close();
        }
        // Highlight only the open tab — no pill stays lit while the panel is closed.
        this.root.children().each((_, el) => {
            $(el).toggleClass("active", this._open && $(el).attr("data-tab") === this.activeTab);
        });
        // Pending quick actions show as a count on the Fight pill.
        const pending = quickActions().length;
        const fight = this.root.children('[data-tab="fight"]');
        fight.find(".gm_quick_badge").remove();
        if (pending) fight.append($("<span>").addClass("gm_quick_badge").text(String(pending)));
        if (this._open) {
            this._renderPanel();
            clearTimeout(this._closeTimer);
            this.panel.removeClass("gm_hotbar_fadeout").addClass("open");
        }
        this._position();
    }

    toggle(tabId) {
        if (this._open && this.activeTab === tabId) return this.close();
        this.activeTab = tabId;
        this._open = true;
        clearTimeout(this._closeTimer);
        this.refresh();
    }

    // Closes the panel with a fade-out; pills lose their active highlight.
    close() {
        if (!this._open) return;
        this._open = false;
        this.root.children().removeClass("active");
        // Keep it displayed during the fade-out, then hide it.
        this.panel.addClass("gm_hotbar_fadeout");
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.panel.removeClass("open gm_hotbar_fadeout"), 240);
    }

    // Anchors the pill row just above the send form and the panel above it.
    _position() {
        if (!this.root || !this.enabled) return;
        const sf = document.getElementById("send_form");
        if (!sf) return;
        const rect = sf.getBoundingClientRect();
        const pillH = this.root.outerHeight() || 30;
        // Pills hug the input bar's left corner.
        this.root.css({
            left: Math.max(rect.left, 12) + "px",
            top: "auto",
            bottom: (window.innerHeight - rect.top + 5) + "px",
        });

        //
        // Frame width: input bar minus 20px, then cut by another 20%.
        const pw = Math.round(Math.min(Math.max(rect.width - 20, 260), 460) * 0.8);
        this.panel.css({
            left: Math.max(rect.left, 12) + "px",
            width: pw + "px",
            top: "auto",
            bottom: (window.innerHeight - rect.top + 5 + pillH + 7) + "px",
        });
    }

    // Rebuilds the panel: one always-open group per character (MC first).
    _renderPanel() {
        this.panel.empty();
        const tab = HOTBAR_TABS.find(t => t.id === this.activeTab) || HOTBAR_TABS[0];
        this.panel.append($("<div>").addClass("gm_hotbar_head").text(tab.label));
        if (tab.id === "fight") return this._renderFight();
        const chars = stateManager.getCharacters();

        //
        if (!chars.length) {
            this.panel.append($("<div>").addClass("gm_hotbar_empty").text("No party characters tracked yet."));
            return;
        }

        //
        chars.forEach((char, idx) => {
            const entries = this.activeTab === "skills" ? (char.skills || []) : (char.inventory || []);
            const group = $("<div>").addClass("gm_hotbar_group open");

            // Collapsible group header — one per character (MC first), open by default.
            group.append($("<div>").addClass("gm_hotbar_group_head")
                .append(
                    $("<i>").addClass("fa-solid fa-chevron-down gm_hotbar_chev"),
                    $("<i>").addClass(idx === 0 ? "fa-solid fa-user" : "fa-solid fa-user-group"),
                    $("<span>").text(char.name || "Unnamed")
                )
                .on("click", () => group.toggleClass("open")));

            //
            const body = $("<div>").addClass("gm_hotbar_group_body");
            const inner = $("<div>").addClass("gm_hotbar_group_inner");
            if (!entries.length) {
                inner.append($("<div>").addClass("gm_hotbar_empty")
                    .text(this.activeTab === "skills" ? "No skills tracked." : "No items tracked."));
            } else {
                for (const entry of entries) inner.append(this._buildRow(char, entry, idx === 0));
            }
            this.panel.append(group.append(body.append(inner)));
        });
    }

    // Fight panel: the shape's basic actions per party character still in
    // the fight; targeted actions list one row per target. A click stores
    // the intent (core/contest/quick.js) — clicking it again clears it.
    _renderFight() {
        const shape = contestRuleset("clash").shape;
        const actions = shape?.basicActions || [];
        const d = stateManager.getData();
        const out = d.contest?.out || {};
        const all = stateManager.getCharacters();
        const chars = all.filter(c => !c.state && !out[contestKey(c.name)]);
        const enemies = (d.enemies || []).filter(e => !e.state);
        const pending = quickActions();
        if (pending.length) {
            this.panel.append($("<div>").addClass("gm_hotbar_meta").css({ cursor: "pointer", margin: "0 0 6px" })
                .attr("title", "Forget the chosen actions")
                .text(`${pending.length} action(s) ready for your next message — click to clear`)
                .on("click", () => { clearQuickActions(); this.refresh(); }));
        }
        if (!chars.length) {
            this.panel.append($("<div>").addClass("gm_hotbar_empty").text("Nobody in the party can act."));
            return;
        }
        chars.forEach((char) => {
            // The MC leads the sheet list (hotbar convention).
            const isPlayer = char === all[0];
            const group = $("<div>").addClass("gm_hotbar_group open");
            group.append($("<div>").addClass("gm_hotbar_group_head")
                .append(
                    $("<i>").addClass("fa-solid fa-chevron-down gm_hotbar_chev"),
                    $("<i>").addClass(isPlayer ? "fa-solid fa-user" : "fa-solid fa-user-group"),
                    $("<span>").text(char.name || "Unnamed"),
                )
                .on("click", () => group.toggleClass("open")));
            const inner = $("<div>").addClass("gm_hotbar_group_inner");
            const mine = pending.find(p => p.actor === char.name);
            for (const a of actions) {
                const targets = a.target === "enemy" ? enemies.map(e => e.name)
                    : a.target === "party" ? chars.filter(c => c !== char).map(c => c.name)
                        : [""];
                for (const target of targets.length ? targets : [""]) {
                    const intent = { actor: char.name, action: a.label, target, isPlayer };
                    const set = !!mine && mine.action === a.label && mine.target === target;
                    const row = $("<div>").addClass("gm_hotbar_row").toggleClass("gm_quick_set", set)
                        .attr("title", set ? "Chosen — click to clear" : "Choose this action for the next message")
                        .append(
                            $("<i>").addClass(a.icon || "fa-solid fa-hand-fist"),
                            $("<span>").addClass("gm_hotbar_name").text(target ? `${a.label} ${target}` : a.label),
                        )
                        .on("click", () => this._quick(intent, set));
                    inner.append($("<div>").addClass("gm_hotbar_item").append(row));
                }
            }
            this.panel.append(group.append($("<div>").addClass("gm_hotbar_group_body").append(inner)));
        });
    }

    // Stores (or clears) one quick action; the phrase goes into the input
    // bar only when it is empty, so typed text is never touched.
    _quick(intent, clear) {
        if (clear) {
            const rest = quickActions().filter(p => p.actor !== intent.actor);
            clearQuickActions();
            for (const p of rest) setQuickAction(p);
        } else {
            setQuickAction(intent);
            const ta = document.getElementById("send_textarea");
            if (ta && !String(ta.value ?? "").trim()) {
                ta.value = quickPhrase(intent);
                ta.setSelectionRange(ta.value.length, ta.value.length);
                $("#send_textarea").trigger("input");
                ta.focus();
            }
        }
        this.refresh();
    }

    // One entry row: chevron + name + info chip + insert button. The whole
    // row toggles the details — only the plus button bypasses it.
    _buildRow(char, entry, isMc) {
        const item = $("<div>").addClass("gm_hotbar_item");
        const name = String(entry?.name || "").trim() || "Unnamed";
        const onCooldown = this.activeTab === "skills" && (Number(entry.cooldown_left) || 0) > 0;
        const row = $("<div>").addClass("gm_hotbar_row").toggleClass("gm_hotbar_dim", onCooldown)
            .on("click", () => item.toggleClass("open"));

        //
        row.append($("<i>").addClass("fa-solid fa-chevron-down gm_hotbar_chev"));

        //
        row.append($("<span>").addClass("gm_hotbar_name").text(name));

        // Info chip — skills: cost + cooldown left; items: qty.
        const chip = $("<span>").addClass("gm_hotbar_chip");
        if (this.activeTab === "skills") {
            const cost = String(entry.cost || "").trim();
            if (cost) chip.append($("<span>").text(cost));
            if (onCooldown) chip.append($("<span>")
                .append($("<i>").addClass("fa-solid fa-hourglass-half"), document.createTextNode(String(Math.trunc(Number(entry.cooldown_left))))));
        } else {
            const qty = Number(entry.qty);
            if (Number.isFinite(qty)) chip.append($("<span>").text(`×${qty}`));
        }
        if (chip.children().length) row.append(chip);

        // Plus: drop the entry name into the input bar (does NOT toggle details).
        row.append($("<i>").addClass("fa-solid fa-plus gm_hotbar_add")
            .attr("title", "Add to your action")
            .on("click", (e) => {
                e.stopPropagation();
                this._insert(char, name, isMc);
            }));

        //
        // Details live in a collapsible grid row so they slide like the groups.
        item.append(row, $("<div>").addClass("gm_hotbar_details")
            .append($("<div>").addClass("gm_hotbar_details_inner").html(this._detailsHtml(entry))));
        return item;
    }

    // Detail block shown when a row is expanded — escaped FIRST, then light
    // markdown (**bold**, __bold__, *italic*) with accent-tinted meta lines.
    _detailsHtml(entry) {
        const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const fmt = (t) => esc(t)
            .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
            .replace(/__(.+?)__/g, "<b>$1</b>")
            .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
            .replace(/(^|\n)(Cost:[^\n]*|Cooldown:[^\n]*)/g, '$1<span class="gm_hotbar_meta">$2</span>');

        //
        const bits = [];
        if (this.activeTab === "skills") {
            const cost = String(entry.cost || "").trim();
            const cd = Math.trunc(Number(entry.cooldown)) || 0;
            if (cost || cd > 0) {
                const parts = [];
                if (cost) parts.push(`Cost: ${esc(cost)}`);
                if (cd > 0) parts.push(`Cooldown: ${cd} message${cd > 1 ? "s" : ""}`);
                bits.push(`<div class="gm_hotbar_meta">${parts.join(" · ")}</div>`);
            }
        }
        const desc = String(entry?.description || "").trim();
        bits.push(`<div class="gm_hotbar_desc">${desc ? fmt(desc) : "No details."}</div>`);
        return bits.join("");
    }

    // Drops the entry name into the input bar (see module header for phrasing).
    _insert(char, name, isMc) {
        const ta = document.getElementById("send_textarea");
        if (!ta || !name) return;
        const cur = String(ta.value ?? "");
        if (!cur.trim()) {
            ta.value = isMc ? `Use ${name} to ` : `${char.name || "Ally"} uses ${name} to `;
        } else {
            ta.value = cur + (/\s$/.test(cur) ? "" : " ") + name;
        }
        ta.setSelectionRange(ta.value.length, ta.value.length);
        $("#send_textarea").trigger("input");
        ta.focus();
    }
}

export const hotbar = new Hotbar();
