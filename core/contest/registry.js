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

export const CONTEST_MODULES = {
    "shape.clash": shapeClash,
    "turn.simultaneous": turnSimultaneous,
    "turn.initiative": turnInitiative,
    "dice.oracle": diceOracle,
    "dice.d20": diceD20,
    "cons.oracle": consOracle,
    "mut.escalation": mutEscalation,
    "mut.crit_effects": mutCritEffects,
    "mut.momentum": mutMomentum,
};

// kind -> preset id -> slots. `legacy` runs the pre-rework pipeline
// (core/combatEngine.js) during the transition.
export const CONTEST_PRESETS = {
    clash: {
        universal: { label: "Universal", shape: "shape.clash", turn: "turn.simultaneous", dice: "dice.oracle", consequence: "cons.oracle", mutators: [] },
        heroic: { label: "Heroic", shape: "shape.clash", turn: "turn.initiative", dice: "dice.d20", consequence: "cons.oracle", mutators: ["mut.escalation", "mut.crit_effects", "mut.momentum"] },
        legacy: { label: "Legacy", legacy: true, shape: "shape.clash" },
    },
};

export const CONTEST_DEFAULT_PRESET = { clash: "universal" };

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
