// Skill tree popup — fullscreen modal with a real top-down node graph.
// Visible to the user regardless of edit mode (unlocking is gameplay, not
// editing); edit mode adds Refine / Reset / Regenerate. Nodes inherit from
// their `requires` parents: connector curves flow downward from roots to
// capstones and are colored by the child's state, so the build path reads at
// a glance. The tab itself shows a compact launcher; the tree lives in the
// popup. Frontier reaches show the "want anything in specific?" popup.

import { gmNotify } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { progression } from "../core/progression.js";
import { skillTree } from "../core/skillTree.js";
import { fadeOutRemove } from "../util/fx.js";

const TYPE_ICONS = {
    active: "fa-solid fa-bolt",
    passive: "fa-solid fa-shield-halved",
    stat: "fa-solid fa-dumbbell",
    upgrade: "fa-solid fa-arrow-trend-up",
};

const TYPE_LABELS = {
    active: "Active",
    passive: "Passive",
    stat: "Attribute",
    upgrade: "Upgrade",
};

// Tree canvas layout metrics (px).
const NODE_W = 150; // horizontal slot per node
const ROW_H = 120; // vertical distance between tier centers
const GUTTER = 60; // left gutter for the tier labels
const FADE_H = 80; // ghost-bubble dissolve zone under the frontier row

// Branch hues: every root (tier 1) claims one hue and its whole build path
// inherits it, so competing branches read apart at a glance.
const BRANCH_COLORS = ["#ffd75e", "#ff6a3d", "#58d68d", "#5aa9ff", "#c07bff", "#ff7ad0", "#6fe0c8", "#ffb84d"];

const SVG_NS = "http://www.w3.org/2000/svg";

// Characters already prompted about the frontier this session (the popup
// would otherwise re-open on every re-render until the segment is generated).
const _frontierPrompted = new Set();

export const skillTreeView = {
    // Live popup state (one at a time): element refs + { charId, edit, selectedId }.
    _popup: null,

    // ---------- tab launcher ----------

    // The tab shows a compact summary; the actual tree lives in the popup
    // (open()). A popup already open for this character is refreshed here so
    // unlocks/generation (which emit changes) stay in sync.
    render(container, char, edit = false) {
        if (!skillTree.isEnabled()) return;
        const tree = skillTree.ensureTree(char.id);
        if (!tree) return;
        const track = progression.trackOf(char);

        const wrap = $("<div>").addClass("gm_list gm_tree");

        // Header: title + unspent points chip.
        const header = $("<div>").addClass("gm_section_header").append(
            $("<b>").text("Skill Tree"),
            $("<span>").addClass("gm_section_hint").text("Unlock nodes with skill points — rewards join the sheet."),
        );
        header.append($("<span>")
            .addClass("gm_tree_points" + (track.skill_points > 0 ? " gm_tree_points_ready" : ""))
            .text(`${track.skill_points} skill point${track.skill_points === 1 ? "" : "s"}`));
        wrap.append(header);

        // Summary + launcher button.
        const unlocked = tree.nodes.filter(n => n.unlocked).length;
        wrap.append($("<div>").addClass("gm_tree_summary").text(tree.nodes.length
            ? `${unlocked} of ${tree.nodes.length} nodes unlocked across ${tree.generated_tiers} tiers.`
            : "No skill tree yet — generate one to start building."));

        const open = $("<div>").addClass("menu_button gm_add_btn")
            .append($("<i>").addClass("fa-solid fa-sitemap"), $("<span>").text(" Open Skill Tree"));
        open.on("click", () => this.open(char, edit));
        wrap.append(open);

        container.append(wrap);
        this.syncPopup(char.id);
    },

    // Keep a live popup for this character in sync with state changes that
    // emit outside the popup (unlocks, generation, sheet edits).
    syncPopup(charId) {
        if (this._popup && this._popup.charId === charId) this._refresh();
    },

    // ---------- popup ----------

    open(char, edit = false) {
        if (!skillTree.isEnabled()) return;
        const tree = skillTree.ensureTree(char.id);
        if (!tree) return;

        this.close();

        const overlay = $("<div>").addClass("gm_modal_overlay gm_stree_overlay");
        const dialog = $("<div>").addClass("gm_stree");

        // Header row: title, points chip, close.
        const points = $("<span>").addClass("gm_tree_points");
        const closeBtn = $("<div>").addClass("gm_icon_btn gm_stree_close")
            .attr("title", "Close")
            .append($("<i>").addClass("fa-solid fa-xmark"));
        const headRow = $("<div>").addClass("gm_stree_header_row").append(
            $("<div>").addClass("gm_stree_title").append(
                $("<i>").addClass("fa-solid fa-sitemap"),
                $("<b>").text(`Skill Tree — ${char.name}`),
            ),
            $("<div>").addClass("gm_stree_spacer"),
            points,
            closeBtn,
        );

        // Edit mode toolbar (Refine / Reset / Regenerate) sits under the title.
        const tools = $("<div>").addClass("gm_tree_tools gm_stree_tools");
        const header = $("<div>").addClass("gm_stree_header").append(headRow, tools);

        // Canvas: the tree itself (SVG links + node orbs), scroll/pan area.
        const canvasWrap = $("<div>").addClass("gm_stree_canvas_wrap");

        // Footer: selected-node detail + hint line + extend button.
        const detail = $("<div>").addClass("gm_stree_detail");
        const hint = $("<div>").addClass("gm_tree_hint");
        const extend = $("<div>").addClass("menu_button gm_small_btn gm_stree_extend")
            .append($("<i>").addClass("fa-solid fa-arrows-down-to-line"), $("<span>").text(" Extend Tree (+6 tiers)"))
            .hide();
        const bottom = $("<div>").addClass("gm_stree_bottom").append(hint, extend);
        const footer = $("<div>").addClass("gm_stree_footer").append(detail, bottom);

        dialog.append(header, canvasWrap, footer);
        overlay.append(dialog);
        overlay.on("click", (e) => { if (e.target === overlay[0]) this.close(); });
        closeBtn.on("click", () => this.close());
        extend.on("click", () => this._openWishPopup(char, "frontier"));
        $("body").append(overlay);

        this._popup = { overlay, canvasWrap, detail, hint, bottom, extend, tools, points, charId: char.id, edit, selectedId: null };
        this._refresh();
    },

    close() {
        if (!this._popup) return;
        fadeOutRemove(this._popup.overlay);
        this._popup = null;
    },

    // Rebuilds the popup contents from current state (called on open and on
    // every state change while it is open).
    _refresh() {
        const p = this._popup;
        if (!p) return;
        const char = stateManager.getCharacter(p.charId);
        const tree = char?.skillTree;
        if (!char || !tree) { this.close(); return; }
        const track = progression.trackOf(char);

        // Points chip.
        p.points
            .toggleClass("gm_tree_points_ready", track.skill_points > 0)
            .text(`${track.skill_points} skill point${track.skill_points === 1 ? "" : "s"}`);

        // Edit mode toolbar: Refine / Reset / Regenerate.
        p.tools.empty().toggle(!!p.edit && tree.nodes.length > 0);
        if (p.edit && tree.nodes.length) {
            const refine = $("<div>").addClass("menu_button gm_small_btn")
                .append($("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Refine"));
            refine.on("click", () => this._refine(char, tree, refine));
            p.tools.append(refine);

            const reset = $("<div>").addClass("menu_button gm_small_btn")
                .append($("<i>").addClass("fa-solid fa-rotate-left"), $("<span>").text(" Reset Tree"));
            reset.on("click", () => {
                if (skillTree.resetTree(char.id)) {
                    gmNotify("Tree reset — points refunded, structure kept.", "success");
                } else {
                    gmNotify("Nothing to reset — no unlocked nodes.", "info");
                }
            });
            p.tools.append(reset);

            const regen = $("<div>").addClass("menu_button gm_small_btn")
                .append($("<i>").addClass("fa-solid fa-arrows-rotate"), $("<span>").text(" Regenerate"));
            regen.on("click", () => {
                if (!window.confirm("Wipe the whole tree and rebuild it? Unlocked nodes are refunded and their sheet entries removed.")) return;
                skillTree.resetTree(char.id);
                tree.nodes = [];
                tree.generated_tiers = 0;
                p.selectedId = null;
                _frontierPrompted.delete(char.id);
                stateManager.emitChange("skill_tree_regenerate");
                this._openWishPopup(char, "first");
            });
            p.tools.append(regen);
        }

        // Canvas: empty state or the tree graph.
        p.canvasWrap.empty();
        if (!tree.nodes.length) {
            const empty = $("<div>").addClass("gm_stree_empty");
            const gen = $("<div>").addClass("menu_button gm_add_btn")
                .append($("<i>").addClass("fa-solid fa-sitemap"), $("<span>").text(" Generate Skill Tree"));
            gen.on("click", () => this._openWishPopup(char, "first"));
            empty.append(
                $("<i>").addClass("fa-solid fa-sitemap"),
                $("<b>").text("No skill tree yet."),
                $("<div>").addClass("gm_modal_hint").text("Describe what you want from this tree (or leave it to fate) and generate it for this character."),
                gen,
            );
            p.canvasWrap.append(empty);
        } else {
            this._renderTree(p, char, tree);
        }

        // Detail panel + extend button. The bottom row (hint + extend) is
        // collapsed entirely while both are empty/hidden, so the detail box
        // sits flush with the popup's bottom frame.
        this._renderDetail(p, char, tree);
        p.extend.toggle(skillTree.shouldExtend(char.id));
        p.bottom.toggle(!!p.hint.text() || p.extend.is(":visible"));

        // Frontier reached: offer the next 6 tiers (once per character until
        // a segment is generated).
        if (skillTree.shouldExtend(char.id) && !_frontierPrompted.has(char.id)) {
            _frontierPrompted.add(char.id);
            this._openWishPopup(char, "frontier");
        }
    },

    // ---------- tree graph ----------

    // Node state: unlocked / available (affordable + requirements met) /
    // locked (dark — missing points or requirements).
    _nodeState(char, tree, node) {
        if (node.unlocked) return "unlocked";
        const track = progression.trackOf(char);
        const cost = Math.max(1, Math.trunc(Number(node.cost) || 1));
        const missingReq = (node.requires || []).some(id => {
            const req = tree.nodes.find(n => n.id === id);
            return req && !req.unlocked;
        });
        return missingReq || track.skill_points < cost ? "locked" : "available";
    },

    _renderTree(p, char, tree) {
        // Group nodes into tier rows (tier 1 at the top, frontier at bottom).
        const rows = [];
        for (let tier = 1; tier <= tree.generated_tiers; tier++) {
            const row = tree.nodes.filter(n => Math.trunc(Number(n.tier) || 0) === tier);
            if (row.length) rows.push(row);
        }

        // Barycenter ordering: within each tier, sort nodes by the average
        // slot of their parents so branch lines don't cross.
        const slotOf = new Map(); // node id -> index within its row
        rows.forEach((row, ti) => {
            if (ti > 0) {
                const scored = row.map((n, i) => {
                    const parentSlots = (n.requires || [])
                        .map(id => slotOf.get(id))
                        .filter(s => s !== undefined);
                    const bary = parentSlots.length
                        ? parentSlots.reduce((a, b) => a + b, 0) / parentSlots.length
                        : i;
                    return { n, bary };
                });
                scored.sort((a, b) => a.bary - b.bary);
                row.length = 0;
                for (const s of scored) row.push(s.n);
            }
            row.forEach((n, i) => slotOf.set(n.id, i));
        });

        // Positions: each row spreads evenly across the node area; rows stack
        // downward with connector room between them. Orb size grows with cost
        // (roots get a hub bonus) — bigger ball, bigger commitment.
        const radiusOf = n => {
            const cost = Math.max(1, Math.trunc(Number(n.cost) || 1));
            return 20 + Math.min(cost, 6) * 3 + (Math.trunc(Number(n.tier)) === 1 ? 4 : 0);
        };
        const maxCount = Math.max(...rows.map(r => r.length), 1);
        const areaW = maxCount * NODE_W;
        // Symmetric gutters keep the node area centered over the labels.
        const canvasW = GUTTER + areaW + GUTTER;
        const canvasH = 48 + (rows.length - 1) * ROW_H + 84 + FADE_H;
        const pos = new Map(); // node id -> { cx, cy, r }
        const rowCy = ti => 48 + ti * ROW_H;
        rows.forEach((row, ti) => {
            const cy = rowCy(ti);
            row.forEach((n, i) => {
                const cx = GUTTER + areaW * (i + 0.5) / row.length;
                pos.set(n.id, { cx, cy, r: radiusOf(n) });
            });
        });

        // Branch identity: each tier-1 root claims one hue; descendants
        // inherit their first parent's hue so a build path keeps its color.
        const rootColor = new Map();
        let colorIdx = 0;
        for (const row of rows) {
            for (const n of row) {
                const parentId = (n.requires || []).find(id => rootColor.has(id));
                rootColor.set(n.id, parentId
                    ? rootColor.get(parentId)
                    : BRANCH_COLORS[colorIdx++ % BRANCH_COLORS.length]);
            }
        }

        const canvas = $("<div>").addClass("gm_stree_canvas")
            .css({ width: canvasW, height: canvasH });
        const svg = $(document.createElementNS(SVG_NS, "svg"))
            .addClass("gm_stree_links")
            .attr({ width: canvasW, height: canvasH });
        canvas.append(svg);

        // Tier labels in the left gutter.
        rows.forEach((row, ti) => {
            canvas.append($("<div>").addClass("gm_stree_tier_label")
                .css({ top: rowCy(ti) })
                .text(`Tier ${Math.trunc(Number(row[0].tier)) || ti + 1}`));
        });

        // Connector lines: rim to rim, colored by the child's branch hue and
        // brightened by its state (the inheritance lines of the build).
        for (const n of tree.nodes) {
            const child = pos.get(n.id);
            if (!child) continue;
            const state = this._nodeState(char, tree, n);
            const color = state === "locked" ? "#4a4a55" : rootColor.get(n.id) || "#4a4a55";
            for (const rid of n.requires || []) {
                const parent = pos.get(rid);
                if (!parent) continue;
                const dx = child.cx - parent.cx;
                const dy = child.cy - parent.cy;
                const len = Math.hypot(dx, dy) || 1;
                const ux = dx / len;
                const uy = dy / len;
                const line = document.createElementNS(SVG_NS, "line");
                line.setAttribute("x1", parent.cx + ux * (parent.r + 2));
                line.setAttribute("y1", parent.cy + uy * (parent.r + 2));
                line.setAttribute("x2", child.cx - ux * (child.r + 2));
                line.setAttribute("y2", child.cy - uy * (child.r + 2));
                line.setAttribute("stroke", color);
                line.setAttribute("stroke-width", state === "unlocked" ? 2.5 : 2);
                line.setAttribute("stroke-opacity", state === "unlocked" ? 0.95 : state === "available" ? 0.6 : 0.35);
                svg.append(line);
            }
        }

        // Node orbs on top of the links.
        for (const n of tree.nodes) {
            const xy = pos.get(n.id);
            if (xy) canvas.append(this._nodeOrb(p, char, tree, n, xy, rootColor.get(n.id)));
        }

        //

        // Frontier fade: ghost bubbles drift below the last tier, linked to
        // the frontier nodes by dashed inheritance lines, so the tree reads
        // as "continues downward" instead of dying at the frontier row.
        const lastRow = rows[rows.length - 1];
        const lastCy = rowCy(rows.length - 1);
        const ghosts = [
            { fx: 0.20, r: 13, o: 0.30, dy: 96 },
            { fx: 0.45, r: 9, o: 0.24, dy: 118 },
            { fx: 0.66, r: 15, o: 0.28, dy: 104 },
            { fx: 0.86, r: 8, o: 0.20, dy: 128 },
            { fx: 0.32, r: 6, o: 0.14, dy: 146 },
            { fx: 0.55, r: 7, o: 0.12, dy: 152 },
        ];
        ghosts.forEach((g, i) => {
            const gx = GUTTER + areaW * g.fx;
            const gy = lastCy + g.dy;
            // Each ghost hangs off the frontier node closest to its column,
            // inheriting its hue — a dashed preview of the next tier.
            let parent = lastRow[0];
            let best = Infinity;
            for (const n of lastRow) {
                const d = Math.abs(pos.get(n.id).cx - gx);
                if (d < best) { best = d; parent = n; }
            }
            const pp = pos.get(parent.id);
            const hue = rootColor.get(parent.id) || "#8a8a95";
            const gdx = gx - pp.cx;
            const gdy = gy - pp.cy;
            const glen = Math.hypot(gdx, gdy) || 1;
            const gux = gdx / glen;
            const guy = gdy / glen;
            const line = document.createElementNS(SVG_NS, "line");
            line.setAttribute("x1", pp.cx + gux * (pp.r + 2));
            line.setAttribute("y1", pp.cy + guy * (pp.r + 2));
            line.setAttribute("x2", gx - gux * (g.r + 2));
            line.setAttribute("y2", gy - guy * (g.r + 2));
            line.setAttribute("stroke", hue);
            line.setAttribute("stroke-width", 1.5);
            line.setAttribute("stroke-dasharray", "4 5");
            line.setAttribute("stroke-opacity", 0.35);
            svg.append(line);

            canvas.append($("<div>").addClass("gm_stree_ghost")
                .css({
                    left: gx - g.r,
                    top: gy - g.r,
                    width: g.r * 2,
                    height: g.r * 2,
                    "--bc": hue,
                    "--go": g.o,
                    animationDelay: `${(i * 0.7).toFixed(1)}s`,
                }));
        });

        // "???" tier label in the gutter — the tier that doesn't exist yet.
        canvas.append($("<div>").addClass("gm_stree_tier_label gm_stree_tier_unknown")
            .css({ top: lastCy + 118 })
            .text("???"));
        canvas.append($("<div>").addClass("gm_stree_fade"));

        p.canvasWrap.append(canvas);
    },

    _nodeOrb(p, char, tree, node, xy, color) {
        const cost = Math.max(1, Math.trunc(Number(node.cost) || 1));
        const state = this._nodeState(char, tree, node);
        const d = xy.r * 2;

        // Wrapper centered on the orb (badges + name label live around it).
        const wrap = $("<div>")
            .addClass(`gm_stree_node gm_stree_${state}`)
            .css({ left: xy.cx - NODE_W / 2, top: xy.cy - 58 })
            .attr("title", `${node.name} — ${node.unlocked ? "unlocked" : `cost: ${cost} SP`}`)
            .toggleClass("gm_stree_selected", p.selectedId === node.id)
            .toggleClass("gm_stree_just", !!(p.fx && p.fx.id === node.id && Date.now() - p.fx.t < 2000));
        wrap[0].style.setProperty("--bc", color || "#8a8a95");

        // The ball itself: icon centered, rim + glow in the branch hue.
        wrap.append($("<div>").addClass("gm_stree_orb")
            .css({ width: d, height: d, left: NODE_W / 2 - xy.r, top: 58 - xy.r })
            .append($("<i>").addClass(TYPE_ICONS[node.type] || TYPE_ICONS.passive)));

        // Cost pill on the bottom rim; lock badge on locked nodes.
        wrap.append($("<span>").addClass("gm_stree_node_cost")
            .css({ top: 58 + xy.r - 7 }).text(cost));
        if (state === "locked") {
            wrap.append($("<span>").addClass("gm_stree_node_lock")
                .css({ top: 58 - xy.r - 5, left: NODE_W / 2 - xy.r - 5 })
                .append($("<i>").addClass("fa-solid fa-lock")));
        }

        // Name label under the orb.
        wrap.append($("<span>").addClass("gm_stree_node_name")
            .css({ top: 58 + xy.r + 12 }).text(node.name));

        // Selecting a node shows its details (and actions) in the footer.
        wrap.on("click", () => {
            p.selectedId = node.id;
            p.canvasWrap.find(".gm_stree_node").removeClass("gm_stree_selected");
            wrap.addClass("gm_stree_selected");
            this._renderDetail(p, char, tree);
        });
        return wrap;
    },

    // ---------- detail panel ----------

    _renderDetail(p, char, tree) {
        const box = p.detail.empty();
        const node = tree.nodes.find(n => n.id === p.selectedId);

        if (!node) {
            box.append($("<div>").addClass("gm_stree_detail_empty")
                .text("Select a node to inspect it — unlock it here when you can afford it."));
            this._detailSwap(box);
            return;
        }

        const cost = Math.max(1, Math.trunc(Number(node.cost) || 1));
        const state = this._nodeState(char, tree, node);
        const reqs = (node.requires || [])
            .map(id => tree.nodes.find(n => n.id === id))
            .filter(Boolean);

        const info = $("<div>").addClass("gm_stree_detail_info").append(
            $("<div>").addClass("gm_stree_detail_head").append(
                $("<i>").addClass(TYPE_ICONS[node.type] || TYPE_ICONS.passive),
                $("<b>").text(node.name),
                $("<span>").addClass("gm_stree_detail_type").text(TYPE_LABELS[node.type] || node.type),
                $("<span>").addClass("gm_stree_detail_cost").text(`${cost} SP`),
            ),
        );
        if (node.description) info.append($("<div>").addClass("gm_stree_detail_desc").text(node.description));
        if (node.type === "upgrade" && node.target) {
            info.append($("<div>").addClass("gm_stree_detail_meta").text(`Upgrades: ${node.target}`));
        }
        if (reqs.length) {
            info.append($("<div>").addClass("gm_stree_detail_meta").text(
                `Requires: ${reqs.map(r => r.unlocked ? r.name : `${r.name} (locked)`).join(", ")}`));
        }
        box.append(info);

        // Action: refund (edit mode) / unlocked badge / unlock button.
        const action = $("<div>").addClass("gm_stree_detail_action");
        if (node.unlocked) {
            if (p.edit) {
                const refund = $("<div>").addClass("menu_button gm_small_btn")
                    .append($("<i>").addClass("fa-solid fa-rotate-left"), $("<span>").text(" Refund"));
                refund.on("click", () => {
                    if (skillTree.refund(char.id, node.id)) {
                        gmNotify(`"${node.name}" refunded (+${cost} skill point(s)).`, "success");
                    }
                });
                action.append(refund);
            } else {
                action.append($("<span>").addClass("gm_stree_detail_done")
                    .append($("<i>").addClass("fa-solid fa-circle-check"), $("<span>").text(" Unlocked")));
            }
        } else {
            const unlock = $("<div>").addClass("gm_stree_unlock_btn")
                .toggleClass("disabled", state === "locked")
                .append($("<i>").addClass("fa-solid fa-unlock"), $("<span>").text(` Unlock — ${cost} SP`));
            unlock.on("click", () => {
                // Flag BEFORE unlocking: emitChange refreshes the popup
                // synchronously inside unlock(), and the flag drives the
                // burst animation on the fresh orb.
                p.fx = { id: node.id, t: Date.now() };
                const res = skillTree.unlock(char.id, node.id);
                if (res.ok) {
                    this._playUnlockSound();
                } else {
                    p.fx = null;
                    p.hint.text(res.reason);
                    p.bottom.show();
                    gmNotify(res.reason, "warning");
                    this._playErrorSound();
                }
            });
            action.append(unlock);
        }
        box.append(action);
        this._detailSwap(box);
    },

    // Fade/slide the detail content in whenever the inspected node changes —
    // the class is retriggered per render (reflow hack) so switching nodes
    // reads as a transition instead of an instant swap.
    _detailSwap(box) {
        box.removeClass("gm_stree_detail_swap");
        void box[0].offsetWidth;
        box.addClass("gm_stree_detail_swap");
    },

    // ---------- effects ----------

    // Tiny synthesized chime for unlocks (no audio assets needed).
    _playUnlockSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const now = ctx.currentTime;
            [523.25, 659.25, 783.99].forEach((freq, i) => {
                const t = now + i * 0.08;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "triangle";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t);
                osc.stop(t + 0.4);
            });
            setTimeout(() => ctx.close(), 1500);
        } catch { /* no audio available — ignore */ }
    },

    // Low buzz for rejected unlocks.
    _playErrorSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(160, now);
            osc.frequency.exponentialRampToValueAtTime(90, now + 0.18);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.22);
            setTimeout(() => ctx.close(), 600);
        } catch { /* no audio available — ignore */ }
    },

    // ---------- popups ----------

    // "Want anything in specific?" popup — first generation and frontier
    // extension share it; `mode` only changes the copy.
    _openWishPopup(char, mode = "first") {
        const overlay = $("<div>").addClass("gm_modal_overlay");
        const dialog = $("<div>").addClass("gm_modal");
        const title = mode === "frontier"
            ? "Extend skill tree (next 6 tiers)"
            : "Generate skill tree";
        const hint = mode === "frontier"
            ? "You reached the frontier of the current tree. Describe what you want next (or leave empty) and generate 6 more tiers."
            : "Describe what you want from this skill tree (or leave empty) and it will be generated for this character.";

        const textarea = $("<textarea>").addClass("gm_modal_textarea")
            .attr("placeholder", "e.g. fire magic focused, with some survivability passives...");
        const generate = $("<div>").addClass("menu_button gm_modal_save")
            .append($("<i>").addClass("fa-solid fa-sitemap"), $("<span>").text(" Generate"));
        const cancel = $("<div>").addClass("menu_button").text("Cancel");

        const close = () => fadeOutRemove(overlay);
        cancel.on("click", close);
        generate.on("click", async () => {
            generate.addClass("disabled gm_busy").find("span").text(" Generating...");
            const nodes = await skillTree.generateSegment(char.id, String(textarea.val() || ""));
            if (!nodes) {
                gmNotify("Skill tree generation failed — check the connection profile.", "error");
                generate.removeClass("disabled").find("span").text(" Generate");
                return;
            }
            gmNotify(`Generated ${nodes.length} skill tree node(s).`, "success");
            close();
        });

        dialog.append(
            $("<b>").text(title),
            $("<div>").addClass("gm_modal_hint").text(hint),
            textarea,
            $("<div>").addClass("gm_modal_actions").append(cancel, generate),
        );
        overlay.append(dialog);
        $("body").append(overlay);
    },

    // Edit mode: refine the LAST segment with player feedback. Blocked
    // while any of its nodes is unlocked (refund those first).
    async _refine(char, tree, btn) {
        const lastSegment = tree.nodes.filter(n => Math.trunc(Number(n.tier) || 0) > tree.generated_tiers - skillTree.SEGMENT_TIERS);
        if (lastSegment.some(n => n.unlocked)) {
            gmNotify("Refund the unlocked nodes of the latest tiers before refining.", "warning");
            return;
        }

        const overlay = $("<div>").addClass("gm_modal_overlay");
        const dialog = $("<div>").addClass("gm_modal");
        const textarea = $("<textarea>").addClass("gm_modal_textarea")
            .attr("placeholder", "What should change in the latest tiers?");
        const cancel = $("<div>").addClass("menu_button").text("Cancel");
        const go = $("<div>").addClass("menu_button gm_modal_save")
            .append($("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Refine"));

        const close = () => fadeOutRemove(overlay);
        cancel.on("click", close);
        go.on("click", async () => {
            go.addClass("disabled gm_busy").find("span").text(" Refining...");
            // Snapshot the segment, strip it, then regenerate it with the
            // feedback — the snapshot is fed back so the LLM refines the
            // existing nodes instead of inventing a fresh segment. On
            // failure the stripped segment is restored untouched.
            const previousSegment = lastSegment.map(n => ({ id: n.id, tier: n.tier, cost: n.cost, requires: (n.requires || []).slice(), type: n.type, target: n.target, name: n.name, description: n.description }));
            const keptNodes = tree.nodes.filter(n => !lastSegment.includes(n));
            const previousTiers = tree.generated_tiers;
            tree.nodes = keptNodes;
            tree.generated_tiers -= skillTree.SEGMENT_TIERS;
            const nodes = await skillTree.generateSegment(char.id, String(textarea.val() || ""), previousSegment);
            if (!nodes) {
                tree.nodes = tree.nodes.concat(lastSegment);
                tree.generated_tiers = previousTiers;
                stateManager.emitChange("skill_tree_refine_failed");
                gmNotify("Refinement failed — keeping the current tree.", "error");
                close();
                return;
            }
            gmNotify(`Refined: ${nodes.length} node(s) regenerated.`, "success");
            close();
        });

        dialog.append(
            $("<b>").text("Refine skill tree"),
            $("<div>").addClass("gm_modal_hint").text("The latest 6 tiers are refined with your feedback: existing nodes are kept and adjusted, not rebuilt. Earlier tiers stay untouched."),
            textarea,
            $("<div>").addClass("gm_modal_actions").append(cancel, go),
        );
        overlay.append(dialog);
        $("body").append(overlay);
    },
};
