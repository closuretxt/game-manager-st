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
//   <warnings>        — set/clear player warnings (imminent needs like food)
// Every block may contain a <char>Name</char> (or <target>) tag to scope it;
// when omitted the active character is used. <warnings> is party-level.

import { stateManager } from "./stateManager.js";
import { logDebug } from "./debug.js";

const BLOCK_TAGS = ["change_values", "set_attributes", "add_items", "remove_items", "update_custom", "warnings"];
const BLOCK_RE = new RegExp(`<(${BLOCK_TAGS.join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");
const INNER_RE = /<(char|target|resource|item|attribute|entry|warning|warning_clear)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;

function decodeEntities(str) {
    return String(str ?? "")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function parseAttrs(raw) {
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
        const block = { type: m[1].toLowerCase(), char: null, actions: [] };
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
        default:
            return false;
    }
}

// Applies parsed blocks to the state. Returns the number of applied actions.
export function applyToolBlocks(blocks, { autoCreateChars = false } = {}) {
    let applied = 0;
    for (const block of blocks) {
        // Warnings are party-level — no character scoping.
        if (block.type === "warnings") {
            for (const action of block.actions) {
                if (applyAction(block.type, null, action)) applied++;
            }
            continue;
        }
        const char = block.char ? stateManager.getCharacter(block.char) : stateManager.getActiveCharacter();
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