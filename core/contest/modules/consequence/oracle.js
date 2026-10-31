// cons.oracle — the rolled tier's effects land exactly as the oracle wrote
// them (plans/combat-modules.md 4.4). Default.

export function oracleEffects(ctx, group, outcome) {
    const tier = (group?.tiers || [])[outcome?.tierIndex];
    return Array.isArray(tier?.effects) ? tier.effects.map(e => ({ ...e })) : [];
}

export const consOracle = {
    id: "cons.oracle",
    label: "As adjudicated",
    hint: "Effects land exactly as the oracle wrote them for the rolled tier.",
    effects: oracleEffects,
};
