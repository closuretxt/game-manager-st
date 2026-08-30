// Injection core — builds the minimal XML context blocks exposed through the
// {{gamemaster-low-priority}} and {{gamemaster-high-priority}} macros.
//
// Low priority (persistent context, non-immediate): active warnings and the
// values of shared resources flagged "always inject". Rendered only when
// something actually exists — an empty buffer returns "" so unused macros
// cost zero tokens ("only inject when relevant").
//
// High priority (immediate, one-shot): pending roll results and transaction
// reports queued by the pre-master flows. Consumed once by the macro at prompt
// build time; if the macro is not placed in the prompt the buffer is re-emitted
// until consumed, so a result is never silently lost.
//
// Everything here is gated by the feature_injection setting in the macros.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { stateManager } from "./stateManager.js";

let _pendingHigh = [];
let _pendingLow = [];

function enabled() {
    const s = extension_settings[extensionName];
    return !!(s.enabled && s.feature_injection);
}

function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------- high priority (one-shot queue) ----------

// Queues an immediate report (roll result / transaction) for the next prompt.
export function queueHigh(xmlBlock) {
    if (!xmlBlock) return;
    _pendingHigh.push(xmlBlock);
}

// Queues a ONE-SHOT low-priority line (e.g. a shared resource value the
// pre-pass flagged as relevant this turn). Rendered by the next low-priority
// build, then dropped — unlike always-inject values, it does not persist.
export function queueLowOnce(line) {
    if (!line || !enabled()) return;
    _pendingLow.push(line);
}

export function clearLow() {
    _pendingLow = [];
}

// Returns everything queued so far and drains the queue.
export function consumeHigh() {
    if (!enabled() || _pendingHigh.length === 0) return "";
    const out = _pendingHigh.join("\n");
    _pendingHigh = [];
    return `<gamemaster_result note="Outcomes just resolved by the game system (dice rolls, transactions). Treat as ground truth; narrate accordingly, do not repeat the numbers or the tags themselves.">\n${out}\n</gamemaster_result>`;
}

export function clearHigh() {
    _pendingHigh = [];
}

// ---------- low priority (persistent context) ----------

// Builds the persistent context block: warnings + always-inject shared values.
export function buildLowPriority() {
    if (!enabled()) return "";
    const d = stateManager.getData();
    const parts = [];

    for (const w of d.warnings || []) {
        parts.push(`  <warning name="${esc(w.name)}">${esc(w.text || "")}</warning>`);
    }

    for (const r of d.sharedResources || []) {
        if (r.always_inject) {
            parts.push(`  <resource name="${esc(r.name)}" value="${esc(r.qty)}"/>`);
        }
    }

    // Context-based enemies: compact state summary, only when the feature is
    // on AND enemies exist — zero tokens otherwise.
    const s = extension_settings[extensionName];
    if (s.feature_enemies && (d.enemies || []).length) {
        parts.push(`<enemies note="Active enemies in the scene; their state is ground truth.">`);
        for (const e of d.enemies) {
            const res = (e.resources || []).map(r => `${r.name} ${r.value}/${r.max}`).join(", ");
            const st = (e.statuses || []).map(x => x.name).join(", ");
            const state = [res, st].filter(Boolean).join("; ");
            parts.push(`  <enemy name="${esc(e.name)}"${state ? ` state="${esc(state)}"` : ""}/>`);
        }
        parts.push(`</enemies>`);
    }

    // One-shot lines queued by the pre-pass for THIS turn only.
    if (_pendingLow.length) {
        parts.push(..._pendingLow.splice(0, _pendingLow.length));
    }

    if (!parts.length) return "";
    return `<gamemaster_context note="Ground-truth tracked state the story engine must not recount or track itself; warnings describe imminent needs.">\n${parts.join("\n")}\n</gamemaster_context>`;
}