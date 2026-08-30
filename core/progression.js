// Progression — per-scenario EXP/level system. The LLM only REPORTS experience
// grants (via the <grant_exp> tool tag); the code owns all the math: level-ups,
// carry-over EXP and skill-point awards. Same contract as skill cooldowns.
//
// The curve is configured PER SCENARIO (d.progression, proposed by the Setup
// Wizard or edited by hand) and gated behind the feature_progression setting.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";

// Defaults used whenever the scenario does not override them.
export const DEFAULT_PROGRESSION = {
    enabled: true,
    exp_base: 100,   // EXP needed for the first level-up
    exp_growth: 1.25, // multiplier per level (exp_base * growth^(level-1))
    skill_points_per_level: 1,
    bonus_every: 5,  // +1 extra point every N levels (0 = off)
    exp_guidelines: "", // plain-language calibration for the post-pass LLM
};

function settings() {
    return extension_settings[extensionName];
}

export const progression = {
    // ---------- config ----------
    getConfig() {
        const d = stateManager.getData();
        return { ...DEFAULT_PROGRESSION, ...(d.progression && typeof d.progression === "object" ? d.progression : {}) };
    },

    setConfig(patch) {
        const d = stateManager.getData();
        d.progression = { ...this.getConfig(), ...patch };
        stateManager.emitChange("progression_config");
    },

    // Master switch: global feature flag AND per-scenario opt-in.
    isEnabled() {
        return !!settings().feature_progression && !!this.getConfig().enabled;
    },

    // ---------- math ----------
    // EXP needed to go from `level` to `level + 1`.
    expToNext(level) {
        const cfg = this.getConfig();
        const l = Math.max(1, Math.trunc(Number(level) || 1));
        return Math.max(1, Math.round(cfg.exp_base * Math.pow(cfg.exp_growth, l - 1)));
    },

    // Normalized progression track for a character (party or enemy).
    trackOf(char) {
        const p = char?.progression && typeof char.progression === "object" ? char.progression : {};
        return {
            level: Math.max(1, Math.trunc(Number(p.level) || 1)),
            exp: Math.max(0, Math.trunc(Number(p.exp) || 0)),
            skill_points: Math.max(0, Math.trunc(Number(p.skill_points) || 0)),
        };
    },

    // Grants EXP to a character (party or enemy). Multi-level-ups carry over
    // and award skill points (plus a bonus point every `bonus_every` levels).
    // Returns { applied, levels } — applied is false when the feature is off,
    // the character is unknown or the amount is not a usable number.
    grantExp(characterId, amount) {
        if (!this.isEnabled()) return { applied: false, levels: 0 };
        const char = stateManager.getSheet(characterId);
        const amt = Math.trunc(Number(amount));
        if (!char || !Number.isFinite(amt) || amt === 0) return { applied: false, levels: 0 };

        const cfg = this.getConfig();
        const track = this.trackOf(char);
        let level = track.level;
        let exp = track.exp + amt;
        let points = track.skill_points;
        let levels = 0;

        while (exp >= this.expToNext(level)) {
            exp -= this.expToNext(level);
            level++;
            levels++;
            points += Math.max(0, Math.trunc(Number(cfg.skill_points_per_level) || 0));
            const bonusEvery = Math.trunc(Number(cfg.bonus_every) || 0);
            if (bonusEvery > 0 && level % bonusEvery === 0) points += 1;
        }
        // A negative grant never de-levels or leaves negative EXP.
        if (exp < 0) exp = 0;

        char.progression = { level, exp, skill_points: points };
        if (levels > 0) logDebug(`progression: ${char.name} reached level ${level} (+${amt} EXP, +${levels} level(s))`);
        return { applied: true, levels };
    },

    // Spends skill points (edit mode / future skill trees). Returns success.
    spendPoints(characterId, count = 1) {
        const char = stateManager.getSheet(characterId);
        if (!char) return false;
        const n = Math.max(1, Math.trunc(Number(count) || 1));
        const track = this.trackOf(char);
        if (track.skill_points < n) return false;
        char.progression = { ...track, skill_points: track.skill_points - n };
        return true;
    },

    // Refunds skill points (edit mode). Returns success.
    refundPoints(characterId, count = 1) {
        const char = stateManager.getSheet(characterId);
        if (!char) return false;
        const n = Math.max(1, Math.trunc(Number(count) || 1));
        const track = this.trackOf(char);
        char.progression = { ...track, skill_points: track.skill_points + n };
        return true;
    },
};
