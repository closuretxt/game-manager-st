// turn.duel — blind stances (plans/combat-modules.md 4.2): every action is a
// Strike, a Feint or a Guard (read from its words). Strike beats Feint,
// Feint beats Guard, Guard beats Strike. In an opposed group, the side whose
// stance wins rolls with advantage (the loser's roll: disadvantage). Both
// sides declare blind, so it is a mind game. Order as simultaneous; only
// dice rules that roll with advantage feel it.

import { simultaneousQueue } from "./simultaneous.js";

const DUEL_GUARD_RE = /\b(guard\w*|block\w*|parr\w*|defend\w*|brace\w*|shield\w*|counter\w*|wait\w*)\b/i;
const DUEL_FEINT_RE = /\b(feint\w*|trick\w*|bait\w*|fake\w*|deceiv\w*|misdirect\w*|lure\w*)\b/i;
const DUEL_BEATS = { Strike: "Feint", Feint: "Guard", Guard: "Strike" };

export function duelStance(action) {
    const text = String(action ?? "");
    if (DUEL_FEINT_RE.test(text)) return "Feint";
    if (DUEL_GUARD_RE.test(text)) return "Guard";
    return "Strike";
}

export function duelBeforeRoll(ctx, group, roll) {
    const [a, b] = group?.sides || [];
    if (!a || !b || !roll) return;
    const sa = duelStance(a.action);
    const sb = duelStance(b.action);
    if (DUEL_BEATS[sa] === sb) {
        roll.adv += 1;
        roll.notes.push(`${a.actor}'s ${sa} beats ${b.actor}'s ${sb}`);
    } else if (DUEL_BEATS[sb] === sa) {
        roll.adv -= 1;
        roll.notes.push(`${b.actor}'s ${sb} beats ${a.actor}'s ${sa}`);
    }
}

const DUEL_ORACLE_RULES = [
    "DUEL STANCES: every action is a Strike, a Feint or a Guard. Strike beats Feint, Feint beats Guard, Guard beats Strike; the engine gives the winning stance advantage. Keep each side's declared action words in its <side action> so the stance can be read, and pair the duelists in ONE group.",
];

export const turnDuel = {
    id: "turn.duel",
    label: "Duel stances",
    hint: "Strike > Feint > Guard > Strike: the winning stance rolls with advantage.",
    shapes: ["clash"],
    queue: simultaneousQueue,
    beforeRoll: duelBeforeRoll,
    oracleRules: DUEL_ORACLE_RULES,
};
