// turn.simultaneous — everyone declares, the round resolves fastest first
// (plans/combat-modules.md 4.2). A group acts at its fastest side's speed;
// ties keep the oracle's order. Default for every shape.

export function simultaneousQueue(ctx, groups) {
    const speedOf = g => Math.max(0, ...(g?.sides || []).map(sd => Math.trunc(Number(sd.speed) || 0)));
    return (groups || [])
        .map((g, i) => ({ i, speed: speedOf(g) }))
        .sort((a, b) => (b.speed - a.speed) || (a.i - b.i))
        .map(x => x.i);
}

export const turnSimultaneous = {
    id: "turn.simultaneous",
    label: "Simultaneous",
    queue: simultaneousQueue,
};
