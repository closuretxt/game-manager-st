// Tool-tag parser — the AI reports game-state changes as XML blocks that look
// like tool calls. All tags are OPTIONAL on any given turn: if the AI doesn't
// emit them, nothing changes. Malformed/unknown data is skipped with a debug
// log rather than breaking the turn.
//
// Supported blocks (see docs/TOOL_TAGS.md for the full reference):
//   <change_values>   — resource/attribute deltas or absolute values
//   <set_attributes>  — attribute values
//   <add_items>       — add items to a character's inventory
//   <remove_items>    — remove items (qty optional: default removes all)
//   <update_custom>   — create/update AI-managed custom features
//   <set_statuses>    — apply temporary per-character statuses (with modifiers)
//   <clear_statuses>  — remove statuses whose condition ended
//   <use_skills>      — report active skills a character used; the CODE starts
//                       their cooldowns (LLMs never manage cooldowns themselves)
//   <grant_exp>       — report EXP a character earned; the CODE computes
//                       level-ups and skill points (LLMs never do the math)
//   <warnings>        — set/clear player warnings (imminent needs like food)
//   <threads>         — set/clear open threads (untracked/unfinished things,
//                       secrets; edit-mode-only UI, pre/post-pass see them)
//   <enemies>         — add/update/remove context-based enemies (removed ones
//                       are archived, not deleted, and restored on return)
// Every block may contain a <char>Name</char> (or <target>) tag to scope it;
// when omitted the active character is used. <warnings> and <threads> are
// party-level and <char> resolves party characters AND enemies.

import { stateManager } from "./stateManager.js";
import { progression } from "./progression.js";
import { logDebug } from "./debug.js";

const BLOCK_TAGS = ["change_values", "set_attributes", "add_items", "remove_items", "update_custom", "set_statuses", "clear_statuses", "use_skills", "grant_exp", "warnings", "threads", "enemies"];
const BLOCK_RE = new RegExp(`<(${BLOCK_TAGS.join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");
const INNER_RE = /<(char|target|resource|item|attribute|entry|status|warning|warning_clear|thread|thread_clear|passive|skill|exp)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
const ENEMY_RE = /<enemy\b([^>]*?)(?:\/>|>([\s\S]*?)<\/enemy>)/gi;

// Shared with the other LLM-output parsers (prePass, setupWizard).
export function decodeEntities(str) {
    return String(str ?? "")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

export function parseAttrs(raw) {
    const out = {};
    const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
    return out;
}

// Returns [{ type, char, actions: [{ tag, attrs, content }] }]
export function parseToolBlocks(text) {
    const blocks = [];
    if (!text) return blocks;
    let m;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(text)) !== null) {
        const block = { type: m[1].toLowerCase(), char: null, actions: [], raw: m[2] };
        let inner;
        INNER_RE.lastIndex = 0;
        while ((inner = INNER_RE.exec(m[2])) !== null) {
            const tag = inner[1].toLowerCase();
            const attrs = parseAttrs(inner[2] || "");
            const content = decodeEntities((inner[3] ?? "").trim());
            if (tag === "char" || tag === "target") {
                block.char = attrs.name || content || block.char;
            } else {
                block.actions.push({ tag, attrs, content });
            }
        }
        blocks.push(block);
    }
    return blocks;
}

function applyAction(blockType, char, action) {
    const { tag, attrs, content } = action;
    const name = attrs.name ?? attrs.resource ?? attrs.item ?? attrs.attribute ?? attrs.entry ?? "";
    switch (tag) {
        case "resource":
            return stateManager.applyDelta(char.id, "resource", name, { delta: attrs.delta, value: attrs.value });
        case "attribute":
            return stateManager.applyDelta(char.id, "attribute", name, { delta: attrs.delta, value: attrs.value });
        case "item":
            if (blockType === "add_items") {
                return stateManager.addItem(char.id, { name, qty: attrs.qty ?? 1, description: attrs.description ?? content ?? "" });
            }
            if (blockType === "remove_items") {
                return stateManager.removeItem(char.id, name, attrs.qty ?? null);
            }
            return false;
        case "entry":
            // Custom features are party-wide; no character scoping needed.
            if (blockType === "update_custom") {
                return stateManager.updateCustom({ name, value: attrs.value ?? content, description: attrs.description ?? "" });
            }
            return false;
        case "status":
            // Statuses are temporary per-character conditions.
            if (blockType === "set_statuses") {
                return stateManager.updateStatus(char.id, { name, modifiers: attrs.modifiers ?? "", effect: attrs.effect ?? attrs.description ?? content ?? "" });
            }
            if (blockType === "clear_statuses") {
                return stateManager.removeStatusByName(char.id, name);
            }
            return false;
        case "skill":
            // Skill USES reported by the post-pass — the code owns cooldowns.
            if (blockType === "use_skills") {
                return stateManager.useSkill(char.id, name);
            }
            return false;
        case "exp":
            // EXP grants reported by the post-pass — the code owns level-ups
            // and skill points. Counts as applied even without a level-up.
            if (blockType === "grant_exp") {
                return progression.grantExp(char.id, attrs.amount ?? content).applied;
            }
            return false;
        case "warning":
            if (blockType === "warnings") {
                return stateManager.setWarning({ name, text: attrs.text ?? content });
            }
            return false;
        case "warning_clear":
            if (blockType === "warnings") {
                return stateManager.clearWarning(name);
            }
            return false;
        case "thread":
            // Open threads are party-level untracked/unfinished things.
            if (blockType === "threads") {
                return stateManager.setThread({ name, text: attrs.text ?? content, ref: attrs.ref ?? "" });
            }
            return false;
        case "thread_clear":
            if (blockType === "threads") {
                return stateManager.clearThread(name);
            }
            return false;
        default:
            return false;
    }
}

// Applies nested <resource>/<attribute>/<passive>/<skill>/<status>/<item>
// tags (plus flat hp="30" / hp_delta="-7" shortcuts) to an enemy sheet.
function applyEnemyInner(enemy, inner, attrs) {
    let applied = 0;
    if (attrs.hp !== undefined && attrs.hp !== "") {
        if (stateManager.applyDelta(enemy.id, "resource", "HP", { value: attrs.hp })) applied++;
        else if (stateManager.addEntry(enemy.id, "resource", { name: "HP", value: Number(attrs.hp) || 0, min: 0, max: Number(attrs.hp_max) || Number(attrs.hp) || 100 })) applied++;
    }
    if (attrs.hp_delta !== undefined && attrs.hp_delta !== "") {
        if (stateManager.applyDelta(enemy.id, "resource", "HP", { delta: attrs.hp_delta })) applied++;
    }
    INNER_RE.lastIndex = 0;
    let im;
    while ((im = INNER_RE.exec(inner)) !== null) {
        const tag = im[1].toLowerCase();
        const a = parseAttrs(im[2] || "");
        const content = decodeEntities((im[3] ?? "").trim());
        const n = a.name ?? "";
        if (!n) continue;
        if (tag === "resource") {
            if (stateManager.applyDelta(enemy.id, "resource", n, { delta: a.delta, value: a.value })) applied++;
            else if (stateManager.addEntry(enemy.id, "resource", { name: n, value: Number(a.value) || 0, min: 0, max: Number(a.max) || 100 })) applied++;
        } else if (tag === "attribute") {
            if (stateManager.applyDelta(enemy.id, "attribute", n, { delta: a.delta, value: a.value })) applied++;
            else if (stateManager.addEntry(enemy.id, "attribute", { name: n, value: Number(a.value) || 0 })) applied++;
        } else if (tag === "passive") {
            stateManager.addEntry(enemy.id, "passive", { name: n, ptype: a.ptype || "special", description: a.description ?? content ?? "" });
            applied++;
        } else if (tag === "skill") {
            stateManager.addEntry(enemy.id, "skill", { name: n, cost: a.cost ?? "", description: a.description ?? content ?? "" });
            applied++;
        } else if (tag === "status") {
            if (stateManager.updateStatus(enemy.id, { name: n, modifiers: a.modifiers ?? "", effect: a.effect ?? content ?? "" })) applied++;
        } else if (tag === "item") {
            if (stateManager.addItem(enemy.id, { name: n, qty: a.qty ?? 1, description: a.description ?? content ?? "" })) applied++;
        }
    }
    return applied;
}

// Applies an <enemies> block: <enemy action="add|update|remove" name="...">.
// add creates the enemy (restoring its archived sheet when the same enemy
// reappears); remove archives it — never deletes — so it can come back.
function applyEnemiesBlock(raw) {
    if (!raw) return 0;
    let applied = 0;
    ENEMY_RE.lastIndex = 0;
    let m;
    while ((m = ENEMY_RE.exec(raw)) !== null) {
        const attrs = parseAttrs(m[1] || "");
        const name = attrs.name ?? "";
        const action = String(attrs.action || "update").toLowerCase();
        if (!name) continue;
        if (action === "remove") {
            const enemy = stateManager.getEnemy(name);
            if (enemy) {
                stateManager.removeEnemy(enemy.id);
                applied++;
            }
            continue;
        }
        let enemy = stateManager.getEnemy(name);
        if (!enemy) {
            enemy = stateManager.addEnemy(name);
            applied++;
        } else if (action === "add") {
            applied++;
        }
        applied += applyEnemyInner(enemy, m[2] ?? "", attrs);
    }
    return applied;
}

// Applies parsed blocks to the state. Returns the number of applied actions.
export function applyToolBlocks(blocks, { autoCreateChars = false } = {}) {
    let applied = 0;
    for (const block of blocks) {
        // Enemies have their own nested format — handled separately.
        if (block.type === "enemies") {
            applied += applyEnemiesBlock(block.raw);
            continue;
        }
        // Warnings are party-level — no character scoping.
        if (block.type === "warnings") {
            for (const action of block.actions) {
                if (applyAction(block.type, null, action)) applied++;
            }
            continue;
        }
        // Open threads are party-level — no character scoping.
        if (block.type === "threads") {
            for (const action of block.actions) {
                if (applyAction(block.type, null, action)) applied++;
            }
            continue;
        }
        const char = block.char ? stateManager.getSheet(block.char) : stateManager.getActiveCharacter();
        if (!char) {
            if (autoCreateChars && block.char) {
                const created = stateManager.addCharacter(block.char, null);
                for (const action of block.actions) if (applyAction(block.type, created, action)) applied++;
            } else {
                logDebug("toolParser: skipping block for unknown character:", block.char || "(none)");
            }
            continue;
        }
        for (const action of block.actions) {
            if (applyAction(block.type, char, action)) applied++;
        }
    }
    if (applied > 0) stateManager.emitChange("tool_parser");
    return applied;
}