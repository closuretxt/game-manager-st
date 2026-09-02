// Shared SKILL WRITING GUIDELINES injected into every prompt that creates
// skills: the skill-tree architect (core/skillTree.js) and the character
// generator/refinement passes (core/characterGenerator.js). One source of
// truth so skills read the same everywhere — concrete numbers, explicit
// scaling, zero ambiguity for the code-owned engines to parse and enforce.

export const skillGuidelines = () => [
    "SKILL WRITING GUIDELINES — apply to every skill, active effect and combat passive:",
    "- LEVEL 1 BALANCE: base Health is 100 (range 0-100) at level 1 — a level-1 skill typically deals 5-15 damage or heals a similar amount, so fights last several turns. Level-1 attribute values normally average around 5 per attribute (a total budget of about 20 across all attributes), with a focused specialist pushing one attribute to 6-8 at the cost of the others. These are defaults, not laws: gritty or survival settings run lower, high-power settings higher; mirror reference characters and the existing party when they are given, and when the prompt supplies an explicit attribute budget or level table, follow THAT over these numbers.",
    "- NO AMBIGUITY: never \"some damage\", \"a bit\", \"moderate\", \"chance to\" — every effect states exact numbers a player can resolve at the table without asking.",
    "- Base value first: state the concrete baseline, e.g. \"deals 10 damage\", \"heals 8\", \"grants +2 Aim\".",
    "- State what it SCALES with: name the attribute(s) and the step, e.g. \"deals 10 damage, +3 per point of Strength\" or \"+1 per 2 Dexterity\".",
    "- Quantify everything that matters: range, targets, area, duration (\"30 feet\", \"2 targets\", \"lasts 3 turns\").",
    "- Name resource costs explicitly, with the amount (\"costs 10 Mana\", \"spends 1 Ammo per shot\").",
    "- Trade-offs read as numbers too: what it costs, what it risks, and what it deliberately does NOT do.",
].join("\n");
