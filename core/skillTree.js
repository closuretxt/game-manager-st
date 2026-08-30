// Skill trees — per-character node graphs generated in 3-tier segments.
// The LLM only PROPOSES structure (names, costs, requirements); the code owns
// all the math: point spending, requirement checks and reward syncing into
// the sheet. Same contract as progression (LLMs never compute anything).
//
// A tree grows lazily: the first segment (tiers 1-3) is generated on demand,
// and whenever an unlocked node reaches the frontier the next 3 tiers can be
// generated. Unlocked rewards are synced into the sheet as normal entries
// tagged with from_tree, so they surface everywhere (injection, lists) for
// free — the tree structure itself is NEVER injected into the story prompt.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { progression } from "./progression.js";
import { genId } from "./schemas.js";
import { sendRequestViaProfile, resolveWizardProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";

// Tiers generated per LLM call (the "3 levels deep" from the spec).
const SEGMENT_TIERS = 3;
const NODE_TYPES = ["active", "passive", "stat", "upgrade"];

function settings() {
    return extension_settings[extensionName];
}

function escAttr(v) {
    return String(v ?? "")
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/"/g, "&" + "quot;");
}

// Compact sheet summary for the generation prompt (no tree dump).
function charSummary(char) {
    const track = progression.trackOf(char);
    const lines = [
        `<char name="${escAttr(char.name)}" level="${track.level}" skill_points="${track.skill_points}">`,
        `  <attributes>${(char.attributes || []).map(a => `${a.name} ${a.value}`).join(", ")}</attributes>`,
        `  <skills>${(char.skills || []).map(s => `${s.name}${s.cost ? ` (cost: ${s.cost})` : ""}${s.cooldown ? ` (cooldown: ${s.cooldown} messages)` : ""}`).join(", ") || "none"}</skills>`,
        `  <passives>${(char.passives || []).map(p => p.name).join(", ") || "none"}</passives>`,
    ];
    lines.push("</char>");
    return lines.join("\n");
}

export const skillTree = {
    SEGMENT_TIERS,

    // Master switch: global feature flag AND progression being on (trees
    // spend the points progression awards).
    isEnabled() {
        return !!settings().feature_skill_tree && progression.isEnabled();
    },

    // Lazily creates the empty tree on a party character. Returns it or null.
    ensureTree(charId) {
        const char = stateManager.getCharacter(charId);
        if (!char) return null;
        if (!char.skillTree || typeof char.skillTree !== "object") {
            char.skillTree = { generated_tiers: 0, nodes: [] };
        }
        return char.skillTree;
    },

    // ---------- generation ----------

    // Generates the NEXT 3-tier segment via the wizard-profile LLM. Returns
    // the new nodes or null on failure. `userWish` is the player's optional
    // "want anything in specific?" input (also used as refine feedback).
    async generateSegment(charId, userWish = "") {
        if (!this.isEnabled()) return null;
        const char = stateManager.getCharacter(charId);
        const tree = this.ensureTree(charId);
        if (!char || !tree) return null;

        const cfg = progression.getConfig();
        const frontier = tree.nodes.filter(n => Math.trunc(Number(n.tier) || 0) === tree.generated_tiers);
        const systemPrompt = [
            "You are the skill-tree architect for a tabletop-style roleplay manager. Design the NEXT segment of a character's skill tree.",
            "",
            "Output ONLY a <skilltree> block, one <node/> per skill tree node:",
            '  <skilltree><node id="n1" tier="4" cost="1" requires="n0" type="upgrade" target="Fireball" name="Greater Fireball" description="+1 target, halved cost"/></skilltree>',
            "",
            "Rules:",
            '- type is one of: "upgrade" (improves an EXISTING skill — set target="<exact skill name>"; description states what changes), "active" (brand-new active skill), "passive" (grants a passive effect), "stat" (raises an attribute — description MUST read like "Strength +1").',
            "- PRIORITIZE UPGRADES: the tree's backbone deepens what the character already does. Introduce a brand-new active skill ONLY when the character has few (2 or fewer) — new actives are rare milestones, never filler.",
            "- BUILDS MUST MATTER: give each branch a clear identity (burst vs sustain, offense vs defense, mobility vs control...), offer competing paths inside a tier so two players pick differently, and prefer trade-offs and signature moments over generic small bonuses.",
            "- FORK, DON'T CHAIN: open 2-4 distinct branch roots in the segment's first tier and fork branches again deeper down (a node may have several children) — the tree must WIDEN as it deepens, never run as single-file chains.",
            "- Balance against the character's LEVEL and tier: segment-entry nodes are cheap and incremental, capstones are expensive and transformative. A node should feel meaningful at the level it is unlocked, never game-breaking.",
            "- tier: integers continuing from the frontier given below. Produce exactly 3 tiers, 3-5 nodes per tier.",
            "- cost: skill points, integer >= 1, growing with power (cheap early in the segment, pricier deeper).",
            "- requires: space-separated node ids that must be unlocked first (frontier nodes and/or same-segment nodes). Segment-entry nodes should chain from the frontier when it makes sense.",
            "- Respect the character's sheet, world and the user's wish. Keep names short and descriptions under 15 words.",
            "- Never repeat nodes that already exist in the tree.",
        ].join("\n");

        const userParts = [];
        const s = settings();
        if (s.deep_context) {
            const deep = await buildDeepContext(String(userWish || ""));
            if (deep) userParts.push(deep);
        }
        userParts.push(`CHARACTER SHEET:\n${charSummary(char)}`);
        userParts.push(`EXP CURVE: exp_base=${cfg.exp_base}, exp_growth=${cfg.exp_growth}, skill_points_per_level=${cfg.skill_points_per_level}, bonus_every=${cfg.bonus_every}`);
        userParts.push(tree.generated_tiers > 0
            ? `FRONTIER (last generated tier ${tree.generated_tiers}); new tiers are ${tree.generated_tiers + 1}-${tree.generated_tiers + SEGMENT_TIERS}:\n${frontier.map(n => `  <node id="${escAttr(n.id)}" tier="${n.tier}" type="${escAttr(n.type)}" name="${escAttr(n.name)}" unlocked="${!!n.unlocked}">${escAttr(n.description)}</node>`).join("\n")}`
            : `This is the FIRST segment: tiers 1-${SEGMENT_TIERS}. Tier 1 nodes have no requirements.`);
        if (String(userWish || "").trim()) {
            userParts.push(`PLAYER WISH:\n${String(userWish).trim()}`);
        }

        try {
            const st = getContext();
            const profileId = resolveWizardProfile(st, s.wizard_profile, s.premaster_profile, s.connection_profile);
            const reply = await sendRequestViaProfile(profileId, [
                { role: "system", content: systemPrompt },
                { role: "user", content: userParts.join("\n\n") },
            ]);
            const nodes = this._parseTreeXml(String(reply || ""), tree, char);
            if (!nodes.length) {
                logDebug("skillTree: no usable <skilltree> nodes in reply");
                return null;
            }
            tree.nodes.push(...nodes);
            tree.generated_tiers += SEGMENT_TIERS;
            stateManager.emitChange("skill_tree_generated");
            logDebug(`skillTree: generated ${nodes.length} nodes for ${char.name} (frontier now tier ${tree.generated_tiers})`);
            return nodes;
        } catch (e) {
            console.error("[Game Manager] skill tree generation failed:", e);
            return null;
        }
    },

    // Extracts <skilltree> nodes from an LLM reply and sanitizes them against
    // the existing tree: tiers clamped to the next segment, requires must
    // reference existing/accepted nodes, costs >= 1, ids deduped.
    _parseTreeXml(reply, tree, char) {
        const blockMatch = /<skilltree>([\s\S]*?)<\/skilltree>/i.exec(reply);
        const body = blockMatch ? blockMatch[1] : reply;
        const existing = new Set(tree.nodes.map(n => n.id));
        const baseTier = tree.generated_tiers;
        const out = [];
        const idMap = new Map(); // LLM id -> sanitized id (for requires remapping)

        const nodeRe = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/gi;
        let m;
        while ((m = nodeRe.exec(body)) !== null) {
            const attrs = {};
            const attrRe = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;
            let a;
            while ((a = attrRe.exec(m[1] || "")) !== null) attrs[a[1].toLowerCase()] = a[2];
            const bodyText = String(m[2] ?? "").trim();

            let type = NODE_TYPES.includes(String(attrs.type || "").toLowerCase())
                ? String(attrs.type).toLowerCase() : "passive";
            // Upgrades must target an existing skill; otherwise they degrade
            // to a plain passive so the tree never references ghosts.
            let target = String(attrs.target || "").trim();
            if (type === "upgrade") {
                const known = (char?.skills || []).some(sk => String(sk.name).toLowerCase() === target.toLowerCase());
                if (!known) {
                    type = "passive";
                    target = "";
                }
            } else {
                target = "";
            }
            let tier = Math.trunc(Number(attrs.tier));
            if (!Number.isFinite(tier)) tier = baseTier + out.length + 1; // fallback: fill sequentially
            tier = Math.min(baseTier + SEGMENT_TIERS, Math.max(baseTier + 1, tier));
            const cost = Math.max(1, Math.trunc(Number(attrs.cost) || 1));
            const name = String(attrs.name || "").trim() || "New Node";
            const description = String(attrs.description ?? bodyText ?? "").trim();

            // Dedupe ids: keep the LLM's id when free, otherwise mint a new
            // one and remember the mapping so requires keep pointing right.
            let id = String(attrs.id || "").trim();
            if (!id || existing.has(id)) {
                idMap.set(id, null); // placeholder; remapped after minting
                const minted = genId();
                idMap.set(attrs.id, minted);
                id = minted;
            }
            existing.add(id);

            out.push({ id, name, tier, cost, requiresRaw: String(attrs.requires || ""), type, target, description, unlocked: false });
        }

        // Second pass: sanitize requires (must reference existing nodes, never self).
        for (const node of out) {
            const raw = node.requiresRaw;
            delete node.requiresRaw;
            node.requires = raw.split(/\s+/)
                .map(r => idMap.get(r) ?? r)
                .filter(r => r && r !== node.id && existing.has(r) && (tree.nodes.some(n => n.id === r) || out.some(n => n.id === r)));
        }
        return out;
    },

    // ---------- unlocking ----------

    // Unlocks a node: checks points and requirements, spends the points and
    // syncs the reward into the sheet. Returns { ok, reason }.
    unlock(charId, nodeId) {
        if (!this.isEnabled()) return { ok: false, reason: "Skill trees are disabled." };
        const char = stateManager.getCharacter(charId);
        const tree = char?.skillTree;
        const node = tree?.nodes?.find(n => n.id === nodeId);
        if (!node) return { ok: false, reason: "Unknown node." };
        if (node.unlocked) return { ok: false, reason: "Already unlocked." };

        const track = progression.trackOf(char);
        const cost = Math.max(1, Math.trunc(Number(node.cost) || 1));
        if (track.skill_points < cost) {
            return { ok: false, reason: `Needs ${cost} skill point(s) — you have ${track.skill_points}.` };
        }
        for (const rid of node.requires || []) {
            const req = tree.nodes.find(n => n.id === rid);
            if (req && !req.unlocked) {
                return { ok: false, reason: `Requires "${req.name}" first.` };
            }
        }
        if (!progression.spendPoints(charId, cost)) {
            return { ok: false, reason: "Could not spend skill points." };
        }

        node.unlocked = true;
        this._syncReward(char, node);
        stateManager.emitChange("skill_tree_unlock");
        return { ok: true };
    },

    // Syncs an unlocked node's reward into the sheet as a normal entry
    // (tagged from_tree so resetTree can find and remove it again).
    _syncReward(char, node) {
        const tag = { from_tree: node.id };
        if (node.type === "active") {
            const entry = stateManager.addEntry(char.id, "skill", { name: node.name, description: node.description, ...tag });
            node.applied = { kind: "entry", type: "skill", entryId: entry?.id };
        } else if (node.type === "passive") {
            const entry = stateManager.addEntry(char.id, "passive", { name: node.name, ptype: "special", description: node.description, ...tag });
            node.applied = { kind: "entry", type: "passive", entryId: entry?.id };
        } else if (node.type === "upgrade") {
            // Improves an EXISTING skill: the upgrade note is appended to the
            // skill's description (original kept on the node for refunds).
            const skill = (char.skills || []).find(sk => String(sk.name).toLowerCase() === String(node.target || "").toLowerCase());
            if (skill) {
                node.applied = { kind: "upgrade", entryId: skill.id, previousDescription: skill.description ?? "" };
                skill.description = [String(skill.description || "").trim(), `[${node.name}] ${node.description}`].filter(Boolean).join("\n");
            } else {
                // Target vanished since generation — grant it as its own skill.
                const entry = stateManager.addEntry(char.id, "skill", { name: node.name, description: node.description, ...tag });
                node.applied = { kind: "entry", type: "skill", entryId: entry?.id };
            }
        } else if (node.type === "stat") {
            // Description reads like "Strength +1" — apply to the attribute,
            // creating it when missing.
            const m = /^(.+?)\s*([+-]?\d+)$/.exec(String(node.description || "").trim());
            const attrName = (m ? m[1] : node.description || node.name).trim();
            const delta = m ? Math.trunc(Number(m[2]) || 0) : 1;
            if (delta !== 0 && stateManager.applyDelta(char.id, "attribute", attrName, { delta })) {
                node.applied = { kind: "delta", attrName, delta };
            } else {
                const entry = stateManager.addEntry(char.id, "attribute", {
                    name: attrName, value: Math.max(0, delta),
                    description: `Granted by skill tree node "${node.name}"`, ...tag,
                });
                node.applied = { kind: "entry", type: "attribute", entryId: entry?.id };
            }
        }
    },

    // Removes the reward a node granted (edit mode refunds).
    _unsyncReward(char, node) {
        const applied = node.applied;
        if (!applied) return;
        if (applied.kind === "entry" && applied.entryId) {
            // Only remove while the entry is still the tree's own (the user
            // may have edited it since — then it stays).
            const container = { skill: "skills", passive: "passives", attribute: "attributes" }[applied.type];
            const entry = (char[container] || []).find(e => e.id === applied.entryId);
            if (entry && entry.from_tree === node.id) {
                stateManager.removeEntry(char.id, applied.type, applied.entryId);
            }
        } else if (applied.kind === "upgrade" && applied.entryId) {
            // Restore the skill's pre-upgrade description — unless the entry
            // is the tree's own fallback skill, which is removed outright.
            const skill = (char.skills || []).find(e => e.id === applied.entryId);
            if (skill) {
                if (skill.from_tree === node.id) {
                    stateManager.removeEntry(char.id, "skill", skill.id);
                } else {
                    skill.description = applied.previousDescription;
                }
            }
        } else if (applied.kind === "delta") {
            stateManager.applyDelta(char.id, "attribute", applied.attrName, { delta: -applied.delta });
        }
        delete node.applied;
    },

    // Edit mode: give the points back and unmark the node (structure kept).
    refund(charId, nodeId) {
        const char = stateManager.getCharacter(charId);
        const tree = char?.skillTree;
        const node = tree?.nodes?.find(n => n.id === nodeId);
        if (!node || !node.unlocked) return false;
        this._unsyncReward(char, node);
        node.unlocked = false;
        progression.refundPoints(charId, Math.max(1, Math.trunc(Number(node.cost) || 1)));
        stateManager.emitChange("skill_tree_refund");
        return true;
    },

    // Edit mode: refund every unlocked node, keep the structure.
    resetTree(charId) {
        const char = stateManager.getCharacter(charId);
        const tree = char?.skillTree;
        if (!char || !tree) return false;
        let total = 0;
        for (const node of tree.nodes) {
            if (!node.unlocked) continue;
            this._unsyncReward(char, node);
            node.unlocked = false;
            total += Math.max(1, Math.trunc(Number(node.cost) || 1));
        }
        if (total > 0) progression.refundPoints(charId, total);
        stateManager.emitChange("skill_tree_reset");
        return total > 0;
    },

    // True when any unlocked node sits in the last generated tier — the
    // player reached the frontier and the next segment can be generated.
    shouldExtend(charId) {
        const char = stateManager.getCharacter(charId);
        const tree = char?.skillTree;
        if (!tree || !tree.generated_tiers || !tree.nodes?.length) return false;
        return tree.nodes.some(n => n.unlocked && Math.trunc(Number(n.tier) || 0) >= tree.generated_tiers);
    },
};
