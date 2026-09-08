// Shared NUMERIC VALUE GUIDELINES injected into every prompt that reports
// numeric values: the agentic tracker (core/agentRunner.js), the combat
// engines (allyAI, enemyAI, clashResolver, diceRoller) and the pre-pass
// router (core/prePass.js). One source of truth like skillGuidelines — when
// a new value feature is added to core/valueResolver.js, add ONE line here
// instead of editing five prompts.
//
// Prompt injection is TOGGLEABLE (value_guidelines setting, default on):
// when off, every engine receives "" — the value resolver keeps parsing
// arithmetic and dice regardless, only the prompt teaching changes.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";

export const valueGuidelines = () => {
    if (extension_settings[extensionName]?.value_guidelines === false) return "";
    return [
    "NUMERIC VALUE GUIDELINES — apply to every numeric value you report (delta, value, qty, amount, chance terms):",
    "- ARITHMETIC: values may be pure arithmetic expressions (\"15-9+2\", \"(18/2)-3\", \"2*4\") — the engine evaluates them EXACTLY. When a number is composed of several sheet terms, report the EXPRESSION instead of a pre-summed guess (e.g. delta=\"-(6+3+2)\" for base damage + attribute + passive).",
    "- DICE (TRUE RNG): values may contain dice notation — \"1d20\", \"2d6+3\", \"(2d10)*2\" — the engine rolls REAL random dice. NEVER simulate, guess or fake randomness yourself: when the outcome is genuinely random, write the dice and let the engine roll it.",
    "- RANGES: an effect that can vary (\"deals 1 to 10 damage\") becomes the die that spans it: 1d10, or 2d6+3 for 5-15.",
    "- ALREADY DEFINED: when a sheet, skill or effect already states its exact value or dice (\"18 damage + 4 per point of STR\", \"2d6 slashing\"), report THAT definition as-is — never replace a defined term with your own dice or estimate. The dice/RANGES rules are ONLY for values nothing on the sheets defines.",
    "- NO SHEET BASIS: a generic move with NO tracked skill and NO damage term (a bare punch, kick, elbow, headbutt, shove) never gets a full-power invented expression. Treat it as narrative flavor (no value) when the narration does not stress a real impact; when a hit clearly lands, anchor it in the ACTOR'S OWN BUILD — roughly 10–20% of their weakest damage-dealing skill, or a small fraction of the relevant attribute when they have no damaging skills at all.",
    "- CHANCE TRIGGERS: a percentage chance becomes a coin die inside the expression — 50% = 1d2 (result 1 = trigger), 25% = 1d4, 10% = 1d10 (result 1 = trigger). A 50% chance to halve 8 damage: delta=\"-(8/1d2)\" (d2=1 → 8, d2=2 → 4).",
    "- TRANSPARENCY: every die the engine rolls shows the player a visible \"Dice Rolled ... -> result\" notification — prefer honest dice over invented averages.",
    ].join("\n");
};