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
    "- CHANCE TRIGGERS: a percentage chance becomes a coin die inside the expression — 50% = 1d2 (result 1 = trigger), 25% = 1d4, 10% = 1d10 (result 1 = trigger). A 50% chance to halve 8 damage: delta=\"-(8/1d2)\" (d2=1 → 8, d2=2 → 4).",
    "- TRANSPARENCY: every die the engine rolls shows the player a visible \"Dice Rolled ... -> result\" notification — prefer honest dice over invented averages.",
    ].join("\n");
};
