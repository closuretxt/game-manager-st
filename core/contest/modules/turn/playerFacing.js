// turn.player_facing — the opposition never rolls (plans/combat-modules.md
// 4.2): no opposition call at all (1 LLM call per round). The oracle plays
// the opponents inside the party's own groups: every group is led by a party
// member, rolling to act or to resist what the opposition does to them, and
// the failure tiers carry the opposition's blows. Order as simultaneous.

import { simultaneousQueue } from "./simultaneous.js";

const PLAYER_FACING_ORACLE_RULES = [
    "PLAYER-FACING ROUND: the opposition never rolls and declares nothing — you play it. Every group's FIRST side is a party member. Each party action is its own group; when an opponent in <sheets> would threaten a party member who did not act against it, add a group where that party member rolls to resist or avoid it. Decide the opponents' moves from the scene and their sheets: their hits, tricks and escapes go in the FAILURE tiers as effects by the opponent; success tiers are the party member's effects.",
];

export const turnPlayerFacing = {
    id: "turn.player_facing",
    label: "Player-facing",
    hint: "Only the party rolls (to act and to resist); the oracle plays the opposition. No opposition call.",
    opposition: false,
    queue: simultaneousQueue,
    oracleRules: PLAYER_FACING_ORACLE_RULES,
};
