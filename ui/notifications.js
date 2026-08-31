// Notifications — optional popups (via the status bubble above the input bar)
// for game-state events: stat and resource changes, items gained/lost, skills
// used or earned, EXP grants, level-ups, deaths, knockouts and status effects.
//
// Instead of threading notification calls through every subsystem, this module
// WRAPS the mutating stateManager/progression methods at init time: each wrap
// runs the original mutation first, then reads the fresh state to compose the
// message. Mutations stay notification-agnostic; uninstalling the feature is
// just not calling init().
//
// Gated per category in the settings drawer (Interface → Notifications).
// UI-originated edits (sheet +/- buttons, EXP nudges, revive) pass
// silent: true — popups for the user's own clicks would be pure noise.
// Game-driven changes notify regardless of edit mode.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { logDebug } from "../core/debug.js";
import { stateManager } from "../core/stateManager.js";
import { progression } from "../core/progression.js";
import { statusBubble } from "./statusBubble.js";

function settings() {
    return extension_settings[extensionName];
}

// Master gate: extension on, notifications on, and the event's category
// enabled. Edit mode does NOT suppress notifications — only UI-originated
// mutations do (they pass silent: true); game-driven changes (AI tool tags,
// combat, transactions) always notify so the player sees outcomes live.
function allowed(category) {
    const s = settings();
    return !!(s.enabled && s.notify_enabled && s[category]);
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

// Escapes a dynamic value before it goes into a notification line (the
// bubble renders highlighted lines as HTML).
function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "\u0026amp;")
        .replace(/</g, "\u0026lt;")
        .replace(/>/g, "\u0026gt;")
        .replace(/"/g, "\u0026quot;");
}

// Inline highlight spans (styled in style.css under .gm_status_line).
const hl = {
    name: v => `<span class="gm_n_name">${esc(v)}</span>`,   // actor names
    pos: v => `<span class="gm_n_pos">${esc(v)}</span>`,     // gains, heals, level-ups
    neg: v => `<span class="gm_n_neg">${esc(v)}</span>`,     // losses, damage
    val: v => `<span class="gm_n_val">${esc(v)}</span>`,     // tracked names / values
    dim: v => `<span class="gm_n_dim">${esc(v)}</span>`,     // secondary info
};

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
            if (opts?.silent) return; // manual sheet edit — user's own click
            if (!ok || (type !== "resource" && type !== "attribute")) return;
            if (!allowed("notify_stats") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            if (!char) return;
            const entry = char[type === "resource" ? "resources" : "attributes"]
                ?.find(e => String(e.name).toLowerCase() === String(name).toLowerCase());
            const hasDelta = opts.delta !== undefined && opts.delta !== null && opts.delta !== "";
            const d = Math.trunc(Number(opts.delta) || 0);
            const change = hasDelta ? (d >= 0 ? hl.pos(signed(opts.delta)) : hl.neg(signed(opts.delta))) : `→ ${hl.val(opts.value)}`;
            const now = entry ? hl.dim(` (now ${entry.value})`) : "";
            statusBubble.notify(`${hl.name(char.name)} · ${hl.val(name)}: ${change}${now}`, 14000, true);
        });

        // ---------- items ----------
        wrapMethod(stateManager, "addItem", ([charId, { name, qty = 1 } = {}], ok) => {
            if (!ok || !allowed("notify_items") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            statusBubble.notify(`${hl.name(char?.name ?? "?")} gained ${hl.val(name)} ${hl.pos(`x${signed(qty)}`)}`, 14000, true);
        });
        wrapMethod(stateManager, "removeItem", ([charId, name, qty = null], ok) => {
            if (!ok || !allowed("notify_items") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            statusBubble.notify(`${hl.name(char?.name ?? "?")} lost ${hl.val(name)}${qty != null ? ` ${hl.neg(`x${qty}`)}` : ""}`, 14000, true);
        });

        // ---------- skills used (cooldown started) ----------
        wrapMethod(stateManager, "useSkill", ([charId, skillName], ok) => {
            if (!ok || !allowed("notify_skills") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            statusBubble.notify(`${hl.name(char?.name ?? "?")} used ${hl.val(skillName)}`, 14000, true);
        });

        // ---------- skills / passives earned (sheet entries added) ----------
        // Covers skill tree unlocks, LLM-granted skills and manual additions —
        // anything that lands a skill/passive entry on a PARTY sheet.
        wrapMethod(stateManager, "addEntry", ([characterId, type, overrides = {}]) => {
            if (overrides?.silent) return; // manual sheet edit / tree unlock
            if (type !== "skill" && type !== "passive") return;
            if (!allowed("notify_skills") || !stateManager.getCharacter(characterId)) return;
            const char = stateManager.getCharacter(characterId);
            statusBubble.notify(`${hl.name(char.name)} earned ${hl.val(type)}: ${hl.val(overrides.name ?? "?")}`, 16000, true);
        });

        // ---------- EXP & level-ups ----------
        wrapMethod(progression, "grantExp", ([characterId, amount, opts = {}], result) => {
            if (opts?.silent) return; // manual EXP edit — user's own click
            if (!result?.applied) return;
            if (!allowed("notify_progression") || !actorAllowed(characterId)) return;
            const char = stateManager.getSheet(characterId);
            if (!char) return;
            if (result.levels > 0) {
                const track = progression.trackOf(char);
                statusBubble.notify(`${hl.name(char.name)} reached ${hl.pos(`level ${track.level}`)}! ${hl.pos(`${signed(amount)} EXP`)}, ${hl.dim(`${track.skill_points} skill point(s) available`)}`, 18000, true);
            } else {
                statusBubble.notify(`${hl.name(char.name)} gained ${hl.pos(`${signed(amount)} EXP`)}`, 14000, true);
            }
        });

        // ---------- character states (death, knockout, recovery) ----------
        wrapMethod(stateManager, "setState", ([idOrName, mode, reason, opts = {}], result) => {
            if (opts?.silent) return; // manual state edit
            if (!result || !allowed("notify_states") || !actorAllowed(result.id)) return;
            if (mode === "dead") {
                statusBubble.notify(`☠ ${hl.name(result.name)} has died${reason ? hl.dim(` — ${reason}`) : ""}`, 18000, true);
            } else if (mode === "ko") {
                statusBubble.notify(`${hl.name(result.name)} was knocked out${reason ? hl.dim(` — ${reason}`) : ""}`, 16000, true);
            } else {
                statusBubble.notify(`${hl.name(result.name)}: ${hl.val(mode)}`, 16000, true);
            }
        });
        wrapMethod(stateManager, "clearState", ([idOrName, opts = {}], result) => {
            if (opts?.silent) return; // manual revive — user's own click
            if (!result || !allowed("notify_states") || !actorAllowed(result.id)) return;
            statusBubble.notify(`${hl.name(result.name)} recovered`, 14000, true);
        });

        // ---------- status effects ----------
        wrapMethod(stateManager, "updateStatus", ([charId, { name, modifiers } = {}], ok) => {
            if (!ok || !allowed("notify_states") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            statusBubble.notify(`${hl.name(char?.name ?? "?")}: ${hl.val(name)} applied${modifiers ? hl.dim(` (${modifiers})`) : ""}`, 14000, true);
        });
        wrapMethod(stateManager, "removeStatusByName", ([charId, name], ok) => {
            if (!ok || !allowed("notify_states") || !actorAllowed(charId)) return;
            const char = stateManager.getSheet(charId);
            statusBubble.notify(`${hl.name(char?.name ?? "?")}: ${hl.val(name)} ended`, 14000, true);
        });

        logDebug("notifications: wired to state mutations");
    },
};
