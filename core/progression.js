// Progression — per-scenario EXP/level system. The LLM only REPORTS experience
// grants (via the <grant_exp> tool tag); the code owns all the math: level-ups,
// carry-over EXP and skill/attribute-point awards. Same contract as skill
// cooldowns.
//
// The curve is configured PER SCENARIO (d.progression, proposed by the Setup
// Wizard or edited by hand) and gated behind the feature_progression setting.
//
// Attribute points are a second, optional currency: spent BY THE PLAYER in the
// sheet's edit mode to raise attributes (never by the LLM). attrBudgetForLevel
// anchors generation — enemies spawn with level-appropriate attribute totals,
// so spending points stays meaningful against the opposition.

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
    attr_points_per_level: 0, // attribute points per level (0 = system off)
    attr_cost_every: 10, // raising costs +1 point per N current value (0 = flat)
    attr_starting_budget: 20, // expected TOTAL attribute points at level 1
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
            attr_points: Math.max(0, Math.trunc(Number(p.attr_points) || 0)),
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
        let attrPoints = track.attr_points;
        let levels = 0;

        while (exp >= this.expToNext(level)) {
            exp -= this.expToNext(level);
            level++;
            levels++;
            points += Math.max(0, Math.trunc(Number(cfg.skill_points_per_level) || 0));
            attrPoints += Math.max(0, Math.trunc(Number(cfg.attr_points_per_level) || 0));
            const bonusEvery = Math.trunc(Number(cfg.bonus_every) || 0);
            if (bonusEvery > 0 && level % bonusEvery === 0) points += 1;
        }
        // A negative grant never de-levels or leaves negative EXP.
        if (exp < 0) exp = 0;

        char.progression = { level, exp, skill_points: points, attr_points: attrPoints };
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

    // ---------- attribute points ----------
    // Cost (in attribute points) to raise an attribute currently at `value`
    // by 1. Grows with the attribute when attr_cost_every > 0, keeping the
    // "no hard caps" rule honest without a hard ceiling.
    attrCostFor(value) {
        const cfg = this.getConfig();
        const v = Math.max(0, Math.trunc(Number(value) || 0));
        const every = Math.trunc(Number(cfg.attr_cost_every) || 0);
        return every > 0 ? 1 + Math.floor(v / every) : 1;
    },

    // Spends attribute points to raise one attribute by 1 (edit mode).
    // Returns success — false when the system is off, the character or
    // attribute is unknown, or the points don't cover the cost.
    spendAttrPoint(characterId, attrName) {
        if (!this.isEnabled() || this.getConfig().attr_points_per_level <= 0) return false;
        const char = stateManager.getSheet(characterId);
        if (!char || !attrName) return false;
        const needle = String(attrName).toLowerCase();
        const entry = (char.attributes || []).find(a => String(a.name).toLowerCase() === needle);
        if (!entry) return false;
        const track = this.trackOf(char);
        const cost = this.attrCostFor(entry.value);
        if (track.attr_points < cost) return false;
        char.progression = { ...track, attr_points: track.attr_points - cost };
        stateManager.applyDelta(char.id, "attribute", entry.name, { delta: 1, silent: true });
        return true;
    },

    // Refunds one attribute point and lowers the attribute by 1 (edit mode).
    // Returns success — false when the attribute is missing or already 0.
    refundAttrPoint(characterId, attrName) {
        if (!this.isEnabled()) return false;
        const char = stateManager.getSheet(characterId);
        if (!char || !attrName) return false;
        const needle = String(attrName).toLowerCase();
        const entry = (char.attributes || []).find(a => String(a.name).toLowerCase() === needle);
        if (!entry || (Number(entry.value) || 0) <= 0) return false;
        const track = this.trackOf(char);
        char.progression = { ...track, attr_points: track.attr_points + 1 };
        stateManager.applyDelta(char.id, "attribute", entry.name, { delta: -1, silent: true });
        return true;
    },

    // Expected TOTAL attribute points for a level-N character: the anchor
    // generation prompts use so enemies spawn level-appropriate. The LLM
    // never computes this — it only receives the resulting number.
    attrBudgetForLevel(level) {
        const cfg = this.getConfig();
        const l = Math.max(1, Math.trunc(Number(level) || 1));
        const start = Math.max(0, Math.trunc(Number(cfg.attr_starting_budget) || 0));
        const perLevel = Math.max(0, Math.trunc(Number(cfg.attr_points_per_level) || 0));
        return start + (l - 1) * perLevel;
    },

    // Average party level (1 when the party is empty or progression is off).
    partyLevel() {
        const d = stateManager.getData();
        const levels = (d.characters || []).map(c => this.trackOf(c).level);
        return levels.length ? Math.round(levels.reduce((a, b) => a + b, 0) / levels.length) : 1;
    },
};
