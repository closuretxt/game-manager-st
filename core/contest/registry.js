// Module registry + ruleset resolution (plans/combat-modules.md 3.2, 3.4).
// A ruleset picks one module per slot for one contest kind; presets are
// starting points. Rulesets are chat configuration, not game state: they live
// in chatMetadata.game_manager.features.contest (outside `data`, so snapshot
// rollbacks never revert a rules change). Pure: no SillyTavern imports.

import { shapeClash } from "./modules/shape/clash.js";
import { turnSimultaneous } from "./modules/turn/simultaneous.js";
import { diceOracle } from "./modules/dice/oracle.js";
import { consOracle } from "./modules/consequence/oracle.js";
import { turnInitiative } from "./modules/turn/initiative.js";
import { diceD20 } from "./modules/dice/d20.js";
import { mutEscalation } from "./modules/mutators/escalation.js";
import { mutCritEffects } from "./modules/mutators/critEffects.js";
import { mutMomentum } from "./modules/mutators/momentum.js";
import { shapeRace } from "./modules/shape/race.js";
import { shapeScores } from "./modules/shape/scores.js";
import { shapeChallenge } from "./modules/shape/challenge.js";
import { consTrack } from "./modules/consequence/track.js";
import { mutPhases } from "./modules/mutators/phases.js";
import { mutSpurt } from "./modules/mutators/spurt.js";
import { mutDrafting } from "./modules/mutators/drafting.js";
import { mutJudges } from "./modules/mutators/judges.js";
import { turnPartyPhase } from "./modules/turn/partyPhase.js";
import { turnTimeline } from "./modules/turn/timeline.js";
import { turnAp } from "./modules/turn/ap.js";
import { turnDuel } from "./modules/turn/duel.js";
import { turnPlayerFacing } from "./modules/turn/playerFacing.js";
import { diceBands2d6 } from "./modules/dice/bands.js";
import { dicePool } from "./modules/dice/pool.js";
import { dicePercentile } from "./modules/dice/percentile.js";
import { diceStep } from "./modules/dice/step.js";
import { diceDeck } from "./modules/dice/deck.js";
import { diceHomebrew } from "./modules/dice/homebrew.js";
import { consLadder } from "./modules/consequence/ladder.js";
import { mutBreak } from "./modules/mutators/break.js";
import { mutExploding } from "./modules/mutators/exploding.js";
import { mutAdvantage } from "./modules/mutators/advantage.js";
import { mutMorale } from "./modules/mutators/morale.js";
import { mutRange } from "./modules/mutators/range.js";
import { mutChain } from "./modules/mutators/chain.js";
import { mutLimit } from "./modules/mutators/limit.js";
import { mutClocks } from "./modules/mutators/clocks.js";
import { mutDeathsDoor } from "./modules/mutators/deathsDoor.js";

// Registry order is also the order mutators run in (editRuleset sorts by it).
export const CONTEST_MODULES = {
    "shape.clash": shapeClash,
    "shape.race": shapeRace,
    "shape.scores": shapeScores,
    "shape.challenge": shapeChallenge,
    "turn.simultaneous": turnSimultaneous,
    "turn.initiative": turnInitiative,
    "turn.phases": turnPartyPhase,
    "turn.timeline": turnTimeline,
    "turn.ap": turnAp,
    "turn.duel": turnDuel,
    "turn.player_facing": turnPlayerFacing,
    "dice.oracle": diceOracle,
    "dice.d20": diceD20,
    "dice.bands_2d6": diceBands2d6,
    "dice.pool": dicePool,
    "dice.percentile": dicePercentile,
    "dice.step": diceStep,
    "dice.deck": diceDeck,
    "dice.homebrew": diceHomebrew,
    "cons.oracle": consOracle,
    "cons.track": consTrack,
    "cons.ladder": consLadder,
    "mut.escalation": mutEscalation,
    "mut.crit_effects": mutCritEffects,
    "mut.momentum": mutMomentum,
    "mut.phases": mutPhases,
    "mut.spurt": mutSpurt,
    "mut.drafting": mutDrafting,
    "mut.judges": mutJudges,
    "mut.advantage": mutAdvantage,
    "mut.exploding": mutExploding,
    "mut.range": mutRange,
    "mut.chain": mutChain,
    "mut.break": mutBreak,
    "mut.limit": mutLimit,
    "mut.clocks": mutClocks,
    "mut.morale": mutMorale,
    "mut.deaths_door": mutDeathsDoor,
};

// kind -> preset id -> slots. `legacy` runs the pre-rework pipeline
// (core/combatEngine.js) during the transition; it exists for fights only.
export const CONTEST_PRESETS = {
    clash: {
        universal: { label: "Universal", shape: "shape.clash", turn: "turn.simultaneous", dice: "dice.oracle", consequence: "cons.oracle", mutators: [] },
        heroic: { label: "Heroic", shape: "shape.clash", turn: "turn.initiative", dice: "dice.d20", consequence: "cons.oracle", mutators: ["mut.escalation", "mut.crit_effects", "mut.momentum"] },
        gritty: { label: "Gritty", shape: "shape.clash", turn: "turn.simultaneous", dice: "dice.pool", consequence: "cons.ladder", mutators: ["mut.advantage", "mut.morale"] },
        story: { label: "Story-first", shape: "shape.clash", turn: "turn.player_facing", dice: "dice.bands_2d6", consequence: "cons.oracle", mutators: ["mut.clocks"] },
        tactical: { label: "Tactical", shape: "shape.clash", turn: "turn.timeline", dice: "dice.step", consequence: "cons.oracle", mutators: ["mut.range", "mut.chain", "mut.break"] },
        duelist: { label: "Duelist", shape: "shape.clash", turn: "turn.duel", dice: "dice.step", consequence: "cons.ladder", mutators: ["mut.momentum", "mut.exploding"] },
        legacy: { label: "Legacy", legacy: true, shape: "shape.clash" },
    },
    race: {
        universal: { label: "Universal race", shape: "shape.race", turn: "turn.simultaneous", dice: "dice.oracle", consequence: "cons.track", mutators: ["mut.phases"] },
        classic: { label: "Classic race", shape: "shape.race", turn: "turn.simultaneous", dice: "dice.oracle", consequence: "cons.track", mutators: ["mut.phases", "mut.spurt", "mut.drafting"] },
        percentile: { label: "Race (percentile)", shape: "shape.race", turn: "turn.simultaneous", dice: "dice.percentile", consequence: "cons.track", mutators: ["mut.phases", "mut.spurt", "mut.drafting", "mut.limit"] },
    },
    scores: {
        universal: { label: "Universal contest", shape: "shape.scores", turn: "turn.simultaneous", dice: "dice.oracle", consequence: "cons.track", mutators: ["mut.judges"] },
    },
    challenge: {
        universal: { label: "Universal challenge", shape: "shape.challenge", turn: "turn.simultaneous", dice: "dice.oracle", consequence: "cons.track", mutators: [] },
    },
};

export const CONTEST_DEFAULT_PRESET = { clash: "universal", race: "universal", scores: "universal", challenge: "universal" };

// The kinds besides fights are offered to the pre-pass only while enabled in
// the chat's rulesets (on by default; opts.enabled = "off" hides one).
export function contestKindEnabled(rulesets, kind) {
    if (kind === "clash") return true;
    if (!CONTEST_PRESETS[kind]) return false;
    return rulesets?.[kind]?.opts?.enabled !== "off";
}

export function enabledContestKinds(rulesets) {
    return Object.keys(CONTEST_PRESETS).filter(k => contestKindEnabled(rulesets, k));
}

const CONTEST_SLOTS = ["shape", "turn", "dice", "consequence"];

// Resolves the chat's ruleset for a contest kind into module objects. Unknown
// presets fall back to `fallbackPreset` (the drawer's global default), then
// the kind's default; unknown module ids to the preset's own pick — a stale
// or hand-edited ruleset degrades, never breaks.
export function resolveRuleset(rulesets, kind = "clash", fallbackPreset = null) {
    const presets = CONTEST_PRESETS[kind] || CONTEST_PRESETS.clash;
    const raw = (rulesets && typeof rulesets === "object" ? rulesets[kind] : null) || {};
    const presetId = presets[raw.preset] ? raw.preset
        : presets[fallbackPreset] ? fallbackPreset
            : (CONTEST_DEFAULT_PRESET[kind] || "universal");
    const preset = presets[presetId];
    const out = { kind, preset: presetId, legacy: !!preset.legacy, mutators: [], opts: {} };
    for (const slot of CONTEST_SLOTS) {
        const pick = raw[slot] && CONTEST_MODULES[raw[slot]] ? raw[slot] : preset[slot];
        out[slot] = CONTEST_MODULES[pick] || null;
    }
    out.mutators = (Array.isArray(raw.mutators) ? raw.mutators : preset.mutators || [])
        .map(id => CONTEST_MODULES[id])
        .filter(Boolean);
    out.opts = raw.opts && typeof raw.opts === "object" ? raw.opts : {};
    return out;
}

// True when a resolved ruleset's modules differ from its preset's picks (the
// HUD then says "Heroic (custom)"). Options alone do not count.
export function rulesetIsCustom(ruleset) {
    const preset = CONTEST_PRESETS[ruleset?.kind]?.[ruleset?.preset];
    if (!preset || preset.legacy) return false;
    if (CONTEST_SLOTS.some(slot => (ruleset[slot]?.id || null) !== (preset[slot] || null))) return true;
    const mine = (ruleset.mutators || []).map(m => m.id).sort().join(",");
    return mine !== (preset.mutators || []).slice().sort().join(",");
}

// ---------- ruleset builder (ui/chatModeDialog.js) ----------

// Ruleset-wide options (stored at opts[key]); module options live at
// opts[moduleId][key] and come from each module's `options`.
export const CONTEST_RULESET_OPTIONS = [
    { key: "stakes", label: "Stakes resource", type: "text", default: "Health", hint: "The resource a fighter falls at (Health, Composure, Morale...)." },
    { key: "opposition", label: "Opposition", type: "select", default: "llm", choices: [["llm", "LLM, blind to your move"], ["brains", "Scripted behaviors (no call)"]] },
];

const CONTEST_ENABLED_OPTION = { key: "enabled", label: "Offered in this chat", type: "select", default: "on", choices: [["on", "On: the router may start one"], ["off", "Off"]] };

// Ruleset-wide options per kind (fights keep CONTEST_RULESET_OPTIONS).
export function contestRulesetOptions(kind) {
    switch (kind) {
        case "race": return [
            CONTEST_ENABLED_OPTION,
            { key: "stakes", label: "Stamina resource", type: "text", default: "Stamina", hint: "The resource pushing and spurting drain. Running dry slows a runner; it never knocks them out." },
            { key: "opposition", label: "Rival runners", type: "select", default: "llm", choices: [["llm", "LLM, blind to your move"], ["brains", "Scripted tactics (no call)"]] },
        ];
        case "scores": return [
            CONTEST_ENABLED_OPTION,
            { key: "stakes", label: "Strain resource", type: "text", default: "", hint: "Optional resource a performance can drain (Composure, Energy...). Empty = none." },
            { key: "opposition", label: "Rival competitors", type: "select", default: "llm", choices: [["llm", "LLM, blind to your move"], ["brains", "Scripted styles (no call)"]] },
        ];
        case "challenge": return [
            CONTEST_ENABLED_OPTION,
            { key: "stakes", label: "Stakes resource", type: "text", default: "Health", hint: "The resource the situation can hurt (falls, burns...)." },
        ];
        default: return CONTEST_RULESET_OPTIONS;
    }
}

// The modules a slot can pick, by id prefix; with a kind, only the ones made
// for it (a module without `shapes` fits every kind).
export function slotModules(slot, kind = null) {
    const prefix = { turn: "turn.", dice: "dice.", consequence: "cons.", mutators: "mut." }[slot] || `${slot}.`;
    return Object.keys(CONTEST_MODULES)
        .filter(id => id.startsWith(prefix))
        .filter(id => !kind || !Array.isArray(CONTEST_MODULES[id].shapes) || CONTEST_MODULES[id].shapes.includes(kind))
        .map(id => ({ id, label: CONTEST_MODULES[id].label || id, hint: CONTEST_MODULES[id].hint || "" }));
}

function sameList(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Applies one builder change to a copy of the chat's rulesets and keeps the
// stored ruleset minimal: a slot or mutator list equal to the preset's is
// dropped, so a preset fix reaches every chat that did not change that slot.
// patch: { preset } | { slot, value } | { mutator, on } | { opt, module?, value } | { reset: true }.
// preset "" = follow the global default. Changing the preset forgets slot and
// mutator overrides but keeps the options (stakes...).
export function editRuleset(rulesets, kind, patch) {
    const all = rulesets && typeof rulesets === "object" ? JSON.parse(JSON.stringify(rulesets)) : {};
    const raw = all[kind] && typeof all[kind] === "object" ? all[kind] : {};
    const presets = CONTEST_PRESETS[kind] || CONTEST_PRESETS.clash;
    const p = patch || {};
    if (p.reset) {
        delete all[kind];
        return all;
    }
    if ("preset" in p) {
        if (presets[p.preset]) raw.preset = p.preset;
        else delete raw.preset;
        for (const slot of [...CONTEST_SLOTS, "mutators"]) delete raw[slot];
    }
    // Slot values are compared against the preset the chat actually uses.
    const presetId = presets[raw.preset] ? raw.preset : (p.fallbackPreset && presets[p.fallbackPreset] ? p.fallbackPreset : (CONTEST_DEFAULT_PRESET[kind] || "universal"));
    const preset = presets[presetId];
    if (p.slot && CONTEST_SLOTS.includes(p.slot) && p.slot !== "shape") {
        if (!CONTEST_MODULES[p.value] || p.value === preset[p.slot]) delete raw[p.slot];
        else raw[p.slot] = p.value;
    }
    if (p.mutator && CONTEST_MODULES[p.mutator]) {
        const base = Array.isArray(raw.mutators) ? raw.mutators : (preset.mutators || []);
        const next = base.filter(id => id !== p.mutator);
        if (p.on) next.push(p.mutator);
        // Registry order, so the same set always compares (and runs) the same.
        const ordered = Object.keys(CONTEST_MODULES).filter(id => next.includes(id));
        const presetOrdered = Object.keys(CONTEST_MODULES).filter(id => (preset.mutators || []).includes(id));
        if (sameList(ordered, presetOrdered)) delete raw.mutators;
        else raw.mutators = ordered;
    }
    if (p.opt) {
        const opts = raw.opts && typeof raw.opts === "object" ? raw.opts : {};
        const bucket = p.module ? (opts[p.module] && typeof opts[p.module] === "object" ? opts[p.module] : {}) : opts;
        const blank = p.value === "" || p.value === null || p.value === undefined;
        if (blank) delete bucket[p.opt];
        else bucket[p.opt] = p.value;
        if (p.module) {
            if (Object.keys(bucket).length) opts[p.module] = bucket;
            else delete opts[p.module];
        }
        if (Object.keys(opts).length) raw.opts = opts;
        else delete raw.opts;
    }
    if (Object.keys(raw).length) all[kind] = raw;
    else delete all[kind];
    return all;
}

// Import: keeps only known kinds, presets and module ids, and plain option
// values — a pasted ruleset can never inject anything the builder can't make.
export function sanitizeRulesets(input) {
    const src = input && typeof input === "object" && !Array.isArray(input) ? input : null;
    if (!src) return null;
    const plain = v => (typeof v === "string" ? v.slice(0, 200) : (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" ? v : undefined);
    const out = {};
    for (const kind of Object.keys(CONTEST_PRESETS)) {
        const raw = src[kind];
        if (!raw || typeof raw !== "object") continue;
        const rs = {};
        if (CONTEST_PRESETS[kind][raw.preset]) rs.preset = raw.preset;
        for (const slot of CONTEST_SLOTS) {
            if (slot !== "shape" && typeof raw[slot] === "string" && slotModules(slot).some(m => m.id === raw[slot])) rs[slot] = raw[slot];
        }
        if (Array.isArray(raw.mutators)) rs.mutators = raw.mutators.filter(id => slotModules("mutators").some(m => m.id === id));
        if (raw.opts && typeof raw.opts === "object") {
            const opts = {};
            for (const [k, v] of Object.entries(raw.opts)) {
                if (CONTEST_MODULES[k] && v && typeof v === "object" && !Array.isArray(v)) {
                    const mod = {};
                    for (const [mk, mv] of Object.entries(v)) {
                        // Crit tables stay importable as data (mut.crit_effects).
                        if (mk === "tables" && mv && typeof mv === "object") mod.tables = JSON.parse(JSON.stringify(mv));
                        else if (plain(mv) !== undefined) mod[mk] = plain(mv);
                    }
                    if (Object.keys(mod).length) opts[k] = mod;
                } else if (plain(v) !== undefined) {
                    opts[k] = plain(v);
                }
            }
            if (Object.keys(opts).length) rs.opts = opts;
        }
        if (Object.keys(rs).length) out[kind] = rs;
    }
    return out;
}
