// mut.exploding — max faces roll again and add (plans/combat-modules.md
// 4.5). Sets the roll's explode flag; the dice rules that have faces honor
// it: 2d6 bands (a six), pools (a six adds a die), the deck (a King draws
// again). Step dice always explode; d20, percentile and the oracle's odds
// ignore it.

export function explodingBeforeRoll(ctx, group, roll) {
    if (roll) roll.explode = true;
}

export const mutExploding = {
    id: "mut.exploding",
    label: "Exploding dice",
    hint: "Max faces roll again and add (2d6 bands, pools, deck).",
    beforeRoll: explodingBeforeRoll,
};
