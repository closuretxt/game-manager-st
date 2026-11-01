// turn.phases — party phase, then opposition (plans/combat-modules.md 4.2):
// every group led by a party member resolves first (fastest first), then the
// opposition's. Squad tactics: one message commands everyone, and the plan
// lands before the enemy answers.

import { contestSide } from "../../effects.js";
import { simultaneousQueue } from "./simultaneous.js";

export function partyPhaseQueue(ctx, groups) {
    const fast = simultaneousQueue(ctx, groups);
    const party = fast.filter(i => contestSide(ctx, groups[i]?.sides?.[0]?.actor) === "party");
    return [...party, ...fast.filter(i => !party.includes(i))];
}

export const turnPartyPhase = {
    id: "turn.phases",
    label: "Party phase, then opposition",
    hint: "All party actions resolve first, then the opposition's.",
    queue: partyPhaseQueue,
};
