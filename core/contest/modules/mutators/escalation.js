// mut.escalation — the party's rolls get +1 per round after the first,
// capped (default +6) (plans/combat-modules.md 4.5). Long fights tilt toward
// the heroes. When an enemy rolls against a party member, the bonus works as
// defense instead (-N on the enemy's roll). Only dice modules that read
// roll.bonus use it (dice.d20); the oracle's odds ignore it.

import { contestSide } from "../../effects.js";

export function escalationBonus(ctx) {
    const cap = Number(ctx?.opts?.["mut.escalation"]?.max);
    const max = Number.isFinite(cap) && cap >= 0 ? Math.trunc(cap) : 6;
    // contest.round counts COMMITTED rounds: round 1 is resolving at 0.
    return Math.min(max, Math.max(0, Math.trunc(Number(ctx?.contest?.round) || 0)));
}

export function escalationBeforeRoll(ctx, group, roll) {
    const bonus = escalationBonus(ctx);
    if (!bonus || !roll) return;
    const sides = group?.sides || [];
    if (!sides.length) return;
    if (contestSide(ctx, sides[0].actor) === "party") {
        roll.bonus += bonus;
        roll.notes.push(`Escalation +${bonus}`);
    } else if (sides.slice(1).some(sd => contestSide(ctx, sd.actor) === "party")) {
        roll.bonus -= bonus;
        roll.notes.push(`Escalation -${bonus} (party defends)`);
    }
}

// Contest HUD meter: the bonus the NEXT round's party rolls get.
export function escalationHud(ctx) {
    const cap = Number(ctx?.opts?.["mut.escalation"]?.max);
    const max = Number.isFinite(cap) && cap >= 0 ? Math.trunc(cap) : 6;
    return { label: "Escalation", value: escalationBonus(ctx), max, text: `+${escalationBonus(ctx)}` };
}

export const mutEscalation = {
    id: "mut.escalation",
    label: "Escalation",
    hint: "+1 to party rolls per round fought (d20 rules only).",
    options: [{ key: "max", label: "Max bonus", type: "number", min: 0, max: 20, default: 6 }],
    beforeRoll: escalationBeforeRoll,
    hud: escalationHud,
};
