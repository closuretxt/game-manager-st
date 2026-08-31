// Notifications — optional toastr popups for game-state events: stat and
// resource changes, items gained/lost, skills used or earned, EXP grants,
// level-ups, deaths, knockouts and status effects.
//
// Instead of threading notification calls through every subsystem, this module
// WRAPS the mutating stateManager/progression methods at init time: each wrap
// runs the original mutation first, then reads the fresh state to compose the
// message. Mutations stay notification-agnostic; uninstalling the feature is
// just not calling init().
//
// Gated per category in the settings drawer (Interface → Notifications).
// Suppressed while edit mode is on — the user is actively editing sheets and
// popups for their own clicks would be pure noise.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug, gmNotify } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { progression } from "../core/progression.js";

function settings() {
    return extension_settings[extensionName];
}

// Master gate: extension on, notifications on, not in edit mode, and the
// event's category enabled.
function allowed(category) {
    const s = settings();
    return !!(s.enabled && s.notify_enabled && !s.edit_mode && s[category]);
}

// Party characters notify by default; enemies only with notify_enemies.
function actorAllowed(charId) {
    if (stateManager.getCharacter(charId)) return true;
    return !!settings().notify_enemies;
}

function signed(n) {
    const v = Math.trunc(Number(n) || 0);
    return v >= 0 ? `+${v}` : `${v}`;
}

// Wraps a method: runs the original, then fires `after(args, result)` guarded
// so a notification bug can never break the mutation itself.
function wrapMethod(obj, method, after) {
    const original = obj[method];
    obj[method] = function (...args) {
        const result = original.apply(obj, args);
        try {
            after(args, result);
        } catch (e) {
            console.error("[Game Manager] notification failed:", e);
        }
        return result;
    };
}

export const notifications = {
    init() {
        // ---------- stats & resources (applyDelta) ----------
        wrapMethod(stateManager, "applyDelta", ([charId, type, name, opts = {}], ok) => {
            if (!ok || (type !== "resource" && type !== "attribute")) return;
            if (!allowed("notify_stats") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            if (!char) return;
            const entry = char[type === "resource" ? "resources" : "attributes"]
                ?.find(e => String(e.name).toLowerCase() === String(name).toLowerCase());
            const hasDelta = opts.delta !== undefined && opts.delta !== null && opts.delta !== "";
            const change = hasDelta ? signed(opts.delta) : `→ ${opts.value}`;
            const now = entry ? ` (now ${entry.value})` : "";
            gmNotify(`${char.name} · ${name}: ${change}${now}`, type === "attribute" ? "success" : "info");
        });

        // ---------- items ----------
        wrapMethod(stateManager, "addItem", ([charId, { name, qty = 1 } = {}], ok) => {
            if (!ok || !allowed("notify_items") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            gmNotify(`${char?.name ?? "?"} gained ${name} x${signed(qty)}`, "success");
        });
        wrapMethod(stateManager, "removeItem", ([charId, name, qty = null], ok) => {
            if (!ok || !allowed("notify_items") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            gmNotify(`${char?.name ?? "?"} lost ${name}${qty != null ? ` x${qty}` : ""}`, "warning");
        });

        // ---------- skills used (cooldown started) ----------
        wrapMethod(stateManager, "useSkill", ([charId, skillName], ok) => {
            if (!ok || !allowed("notify_skills") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            gmNotify(`${char?.name ?? "?"} used ${skillName}`, "info");
        });

        // ---------- skills / passives earned (sheet entries added) ----------
        // Covers skill tree unlocks, LLM-granted skills and manual additions —
        // anything that lands a skill/passive entry on a PARTY sheet.
        wrapMethod(stateManager, "addEntry", ([characterId, type, overrides = {}]) => {
            if (type !== "skill" && type !== "passive") return;
            if (!allowed("notify_skills") || !stateManager.getCharacter(characterId)) return;
            const char = stateManager.getCharacter(characterId);
            gmNotify(`${char.name} earned ${type}: ${overrides.name ?? "?"}`, "success");
        });

        // ---------- EXP & level-ups ----------
        wrapMethod(progression, "grantExp", ([characterId, amount], result) => {
            if (!result?.applied) return;
            if (!allowed("notify_progression") || !actorAllowed(characterId)) return;
            const char = stateManager.getSheet(characterId);
            if (!char) return;
            if (result.levels > 0) {
                const track = progression.trackOf(char);
                gmNotify(`${char.name} reached level ${track.level}! (${signed(amount)} EXP, ${track.skill_points} skill point(s) available)`, "success", 6000);
            } else {
                gmNotify(`${char.name} gained ${signed(amount)} EXP`, "info");
            }
        });

        // ---------- character states (death, knockout, recovery) ----------
        wrapMethod(stateManager, "setState", ([idOrName, mode, reason], result) => {
            if (!result || !allowed("notify_states") || !actorAllowed(result.id)) return;
            if (mode === "dead") {
                gmNotify(`${result.name} has died${reason ? ` — ${reason}` : ""}`, "error", 8000);
            } else if (mode === "ko") {
                gmNotify(`${result.name} was knocked out${reason ? ` — ${reason}` : ""}`, "warning");
            } else {
                gmNotify(`${result.name}: ${mode}`, "warning");
            }
        });
        wrapMethod(stateManager, "clearState", ([idOrName], result) => {
            if (!result || !allowed("notify_states") || !actorAllowed(result.id)) return;
            gmNotify(`${result.name} recovered`, "success");
        });

        // ---------- status effects ----------
        wrapMethod(stateManager, "updateStatus", ([charId, { name, modifiers } = {}], ok) => {
            if (!ok || !allowed("notify_states") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            gmNotify(`${char?.name ?? "?"}: ${name} applied${modifiers ? ` (${modifiers})` : ""}`, "info");
        });
        wrapMethod(stateManager, "removeStatusByName", ([charId, name], ok) => {
            if (!ok || !allowed("notify_states") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            gmNotify(`${char?.name ?? "?"}: ${name} ended`, "info");
        });

        logDebug("notifications: wired to state mutations");
    },
};
