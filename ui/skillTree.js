// Skill tree tab — tier-column renderer with node cards. Visible to the user
// regardless of edit mode (unlocking is gameplay, not editing); edit mode adds
// Refine / Reset / Regenerate. The first open (empty tree) and every frontier
// reach show the "want anything in specific?" popup, mirroring the wizard.

import { gmNotify } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { progression } from "../core/progression.js";
import { skillTree } from "../core/skillTree.js";

const TYPE_ICONS = {
    active: "fa-solid fa-bolt",
    passive: "fa-solid fa-shield-halved",
    stat: "fa-solid fa-dumbbell",
    upgrade: "fa-solid fa-arrow-trend-up",
};

// Characters already prompted about the frontier this session (the popup
// would otherwise re-open on every re-render until the segment is generated).
const _frontierPrompted = new Set();

export const skillTreeView = {
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

        // Edit mode toolbar: Refine / Reset / Regenerate.
        if (edit && tree.nodes.length) {
            const tools = $("<div>").addClass("gm_tree_tools");

            const refine = $("<div>").addClass("menu_button gm_small_btn")
                .append($("<i>").addClass("fa-solid fa-wand-magic-sparkles"), $("<span>").text(" Refine"));
            refine.on("click", () => this._refine(char, tree, refine));
            tools.append(refine);

            const reset = $("<div>").addClass("menu_button gm_small_btn")
                .append($("<i>").addClass("fa-solid fa-rotate-left"), $("<span>").text(" Reset Tree"));
            reset.on("click", () => {
                if (skillTree.resetTree(char.id)) {
                    gmNotify("Tree reset — points refunded, structure kept.", "success");
                } else {
                    gmNotify("Nothing to reset — no unlocked nodes.", "info");
                }
            });
            tools.append(reset);

            const regen = $("<div>").addClass("menu_button gm_small_btn")
                .append($("<i>").addClass("fa-solid fa-arrows-rotate"), $("<span>").text(" Regenerate"));
            regen.on("click", () => {
                if (!window.confirm("Wipe the whole tree and rebuild it? Unlocked nodes are refunded and their sheet entries removed.")) return;
                skillTree.resetTree(char.id);
                tree.nodes = [];
                tree.generated_tiers = 0;
                _frontierPrompted.delete(char.id);
                stateManager.emitChange("skill_tree_regenerate");
                this._openWishPopup(char, "first");
            });
            tools.append(regen);

            wrap.append(tools);
        }

        // Empty tree: first-open state with the generate button.
        if (!tree.nodes.length) {
            const empty = $("<div>").addClass("gm_empty").text("No skill tree yet.");
            const gen = $("<div>").addClass("menu_button gm_add_btn")
                .append($("<i>").addClass("fa-solid fa-sitemap"), $("<span>").text(" Generate Skill Tree"));
            gen.on("click", () => this._openWishPopup(char, "first"));
            wrap.append(empty, gen);
            container.append(wrap);
            return;
        }

        // Tier columns 1..generated_tiers (the frontier renders dark/empty
        // beyond what exists — future segments are simply not there yet).
        const cols = $("<div>").addClass("gm_tree_cols");
        for (let tier = 1; tier <= tree.generated_tiers; tier++) {
            const col = $("<div>").addClass("gm_tree_tier");
            col.append($("<div>").addClass("gm_tree_tier_label").text(`Tier ${tier}`));
            for (const node of tree.nodes.filter(n => Math.trunc(Number(n.tier) || 0) === tier)) {
                col.append(this._nodeCard(char, tree, node, edit));
            }
            cols.append(col);
        }
        wrap.append(cols);

        // Inline feedback line for unlock attempts (why a node is locked).
        const hint = $("<div>").addClass("gm_tree_hint");
        wrap.append(hint);
        wrap.data("hintEl", hint);

        container.append(wrap);

        // Frontier reached: offer the next 3 tiers (once per character until
        // a segment is generated).
        if (skillTree.shouldExtend(char.id) && !_frontierPrompted.has(char.id)) {
            _frontierPrompted.add(char.id);
            this._openWishPopup(char, "frontier");
        }
    },

    // ---------- node card ----------

    _nodeCard(char, tree, node, edit) {
        const cost = Math.max(1, Math.trunc(Number(node.cost) || 1));
        const track = progression.trackOf(char);
        const reqs = (node.requires || [])
            .map(id => tree.nodes.find(n => n.id === id))
            .filter(Boolean);
        const missingReq = reqs.find(r => !r.unlocked);

        const state = node.unlocked ? "unlocked" : (missingReq || track.skill_points < cost ? "locked" : "available");
        const card = $("<div>")
            .addClass(`gm_tree_node gm_tree_${state}`)
            .attr("title", node.unlocked
                ? (edit ? "Click to refund this node (edit mode)" : "Unlocked")
                : (missingReq ? `Requires "${missingReq.name}"` : `Cost: ${cost} skill point(s)`));

        const top = $("<div>").addClass("gm_tree_node_top");
        top.append($("<i>").addClass(TYPE_ICONS[node.type] || TYPE_ICONS.passive));
        top.append($("<span>").addClass("gm_tree_node_name").text(node.name));
        top.append($("<span>").addClass("gm_tree_node_cost").text(`${cost} SP`));
        card.append(top);

        if (node.description) card.append($("<div>").addClass("gm_tree_node_desc").text(node.description));
        if (node.type === "upgrade" && node.target) {
            card.append($("<div>").addClass("gm_tree_node_reqs").text(`Upgrades: ${node.target}`));
        }
        if (reqs.length) {
            card.append($("<div>").addClass("gm_tree_node_reqs").text(
                `Requires: ${reqs.map(r => r.name).join(", ")}`));
        }

        card.on("click", () => {
            const hint = card.closest(".gm_tree").data("hintEl");
            if (node.unlocked) {
                if (edit && skillTree.refund(char.id, node.id)) {
                    gmNotify(`"${node.name}" refunded (+${cost} skill point(s)).`, "success");
                }
                return;
            }
            const res = skillTree.unlock(char.id, node.id);
            if (res.ok) {
                gmNotify(`"${node.name}" unlocked.`, "success");
            } else if (hint) {
                hint.text(res.reason);
            } else {
                gmNotify(res.reason, "warning");
            }
        });

        return card;
    },

    // ---------- popups ----------

    // "Want anything in specific?" popup — first generation and frontier
    // extension share it; `mode` only changes the copy.
    _openWishPopup(char, mode = "first") {
        const overlay = $("<div>").addClass("gm_modal_overlay");
        const dialog = $("<div>").addClass("gm_modal");
        const title = mode === "frontier"
            ? "Extend skill tree (next 3 tiers)"
            : "Generate skill tree";
        const hint = mode === "frontier"
            ? "You reached the frontier of the current tree. Describe what you want next (or leave empty) and generate 3 more tiers."
            : "Describe what you want from this skill tree (or leave empty) and it will be generated for this character.";

        const textarea = $("<textarea>").addClass("gm_modal_textarea")
            .attr("placeholder", "e.g. fire magic focused, with some survivability passives...");
        const generate = $("<div>").addClass("menu_button gm_modal_save")
            .append($("<i>").addClass("fa-solid fa-sitemap"), $("<span>").text(" Generate"));
        const cancel = $("<div>").addClass("menu_button").text("Cancel");

        const close = () => overlay.remove();
        cancel.on("click", close);
        generate.on("click", async () => {
            generate.addClass("disabled").find("span").text(" Generating...");
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

    // Edit mode: regenerate the LAST segment with player feedback. Blocked
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

        const close = () => overlay.remove();
        cancel.on("click", close);
        go.on("click", async () => {
            go.addClass("disabled").find("span").text(" Refining...");
            // Strip the last segment, then regenerate it with the feedback.
            // On failure the stripped segment is restored untouched.
            const keptNodes = tree.nodes.filter(n => !lastSegment.includes(n));
            const previousTiers = tree.generated_tiers;
            tree.nodes = keptNodes;
            tree.generated_tiers -= skillTree.SEGMENT_TIERS;
            const nodes = await skillTree.generateSegment(char.id, String(textarea.val() || ""));
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
            $("<div>").addClass("gm_modal_hint").text("The latest 3 tiers are regenerated with your feedback. Earlier tiers stay untouched."),
            textarea,
            $("<div>").addClass("gm_modal_actions").append(cancel, go),
        );
        overlay.append(dialog);
        $("body").append(overlay);
    },
};
