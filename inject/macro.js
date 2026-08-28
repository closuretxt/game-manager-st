// Macro registration — the injection vehicle per the spec.
//   {{gamemaster-low-priority}}  — persistent context: warnings, always-inject
//                                  shared resource values (XML, minimal).
//   {{gamemaster-high-priority}} — one-shot immediate reports: dice roll
//                                  results, transaction checks (XML, minimal).
// Both macros return "" when nothing is relevant or injection is disabled.

import { macros as macroSystem } from "../../../../macros/macro-system.js";
import { logDebug } from "../core/debug.js";
import { buildLowPriority, consumeHigh } from "../core/injection.js";

const _registered = new Set();

function safeRegister(key, description, handler) {
    try {
        macroSystem.registry.registerMacro(key, {
            category: macroSystem.category?.MISC ?? "misc",
            description,
            handler,
        });
        _registered.add(key);
    } catch (e) {
        console.warn(`[Game Manager] Failed to register macro ${key}:`, e);
    }
}

export function initMacros() {
    safeRegister("gamemaster-low-priority", "Game Manager low-priority context: warnings + always-inject shared resources. Empty when nothing is relevant.", () => {
        return buildLowPriority();
    });
    safeRegister("gamemaster-high-priority", "Game Manager high-priority reports: pending roll results and transactions. Consumed once per generation.", () => {
        return consumeHigh();
    });
    logDebug("macros registered:", [..._registered]);
}