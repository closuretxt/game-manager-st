// Shared SKILL WRITING GUIDELINES injected into every prompt that creates
// skills: the skill-tree architect (core/skillTree.js) and the character
// generator/refinement passes (core/characterGenerator.js). One source of
// truth so skills read the same everywhere — concrete numbers, explicit
// scaling, zero ambiguity for the code-owned engines to parse and enforce.

export const skillGuidelines = () => [
    "SKILL WRITING GUIDELINES — apply to ground every skill, active effect, combat passive, item and consumable:",
    "- LEVEL 1 BALANCE: base Health is 100 (range 0-100) at level 1 — a level-1 skill typically deals 5-15 damage or heals a similar amount, so fights last several turns. Level-1 attribute values normally average around 5 per attribute (a total budget of about 20 across all attributes), with a focused specialist pushing one attribute to 6-8 at the cost of the others. These are defaults, not laws: gritty or survival settings run lower, high-power settings higher; mirror reference characters and the existing party when they are given, and when the prompt supplies an explicit attribute budget or level table, follow THAT over these numbers.",
    "- NO AMBIGUITY: never \"some damage\", \"a bit\", \"moderate\", \"chance to\" — every effect states exact numbers a player can resolve at the table without asking.",
    "- Base value first: state the concrete baseline, e.g. \"deals 10 damage\", \"heals 8\", \"grants +2 Aim\".",
    "- SCALING IS THE CORE OF EVERY SKILL: state what it SCALES with FIRST-class importance — name the attribute(s) and the step, e.g. \"deals 10 damage, +3 per point of Strength\" or \"+1 per 2 Dexterity\". A skill MAY scale with MULTIPLE attributes at once — state each one and its step separately (\"deals 2d6 damage, +1 per point of Strength AND +1 per 2 Dexterity\", \"heals 5 + half the caster's Wisdom + 1 per 3 Intelligence\"). Every non-flat component of a skill names its attribute: no scaling means the skill stays flat forever, which must be a deliberate choice, not an omission.",
    "- Quantify everything that matters: range, targets, area, duration (\"30 feet\", \"2 targets\", \"lasts 3 turns\").",
    "- DICE, NOT GUESSES: when an effect's power should vary, use real dice notation instead of inventing a number — \"2d6+3 damage\" instead of \"about 10 damage\", \"1d10\" for 1-10. The engine rolls true random dice (1d20, 2d6+3, (2d10)*2 all work); scaling steps may be dice too (\"+1d4 per point of Power\"). Percentage chances become coin dice: 50% = 1d2, 25% = 1d4, 10% = 1d10 (result 1 = trigger).",
    "- Name resource costs explicitly, with the amount (\"costs 10 Mana\", \"spends 1 Ammo per shot\").",
    "- Trade-offs read as numbers too: what it costs, what it risks, and what it deliberately does NOT do.",
    "- ALWAYS STATE FAILURE CHANCE: the engine assumes by default that any effect CAN fail and resolves it with a roll, so an effect that can never fail must say so explicitly (\"cannot fail\", \"always hits\", \"guaranteed\"). Anything with a risk of failure states the exact chance or roll needed (\"70% chance to hit\", \"fails on a roll below 8\").",
    "- Passives and items follow the same rules: a passive states its constant bonus and when it applies; an item or consumable states its effect, uses/charges, and whether its effect can fail. No passive or item is exempt from the failure-chance rule.",
].join("\n");
