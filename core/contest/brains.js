// Scripted opposition (plans/combat-modules.md 3.7): 0-call behaviors for the
// enemy side. Used when the opposition call fails (instead of everyone just
// attacking) and when the ruleset picks them (opts.opposition = "brains").
// Pure: the caller hands in the sheets and a condition reader.
//
// brainActions(enemies, party, ratio, max) -> [{ enemy, speed, title, text, target }]
//   enemies / party: sheets still able to act / be targeted
//   ratio(sheet) -> 0..1 of the stakes resource, or null when it has none

// A sheet's `brain` field wins; otherwise its name, traits, passives and
// skills hint at one. Order matters: a "frenzied shaman" heals first.
const BRAIN_HINTS = [
    ["healer", /\b(heal\w*|priest\w*|cleric|shaman|medic|druid|mend\w*)\b/i],
    ["caster", /\b(mage|wizard|witch|sorcer\w*|warlock|caster|necromancer|spell\w*)\b/i],
    ["coward", /\b(coward\w*|thief|cutpurse|rat|scaveng\w*|craven)\b/i],
    ["berserker", /\b(berserk\w*|rag\w*|frenz\w*|feral|beast|wolf|wolves)\b/i],
    ["skirmisher", /\b(archer|bow|scout|rogue|assassin|skirmish\w*|hunter|sniper)\b/i],
    ["guardian", /\b(guard\w*|knight|shield\w*|sentinel|protector|paladin)\b/i],
];

export const BRAIN_IDS = ["brute", "berserker", "skirmisher", "guardian", "healer", "coward", "caster"];

export function brainOf(sheet) {
    const own = String(sheet?.brain || "").toLowerCase();
    if (BRAIN_IDS.includes(own)) return own;
    const text = [
        sheet?.name,
        ...(sheet?.traits || []).map(t => `${t.name} ${t.value ?? ""}`),
        ...(sheet?.passives || []).map(p => p.name),
        ...(sheet?.skills || []).map(s => s.name),
    ].join(" ");
    for (const [id, re] of BRAIN_HINTS) if (re.test(text)) return id;
    return "brute";
}

function brainReady(skill) {
    return !(Number(skill?.cooldown_left) > 0);
}

function brainSkill(sheet, re) {
    return (sheet?.skills || []).find(s => brainReady(s) && (!re || re.test(String(s.name))));
}

// Targets: the healthiest (front-liner) or the weakest party member.
function brainPick(list, ratio, weakest) {
    let best = null, bestR = 0;
    for (const s of list) {
        const r = ratio(s) ?? 1;
        if (!best || (weakest ? r < bestR : r > bestR)) {
            best = s;
            bestR = r;
        }
    }
    return best;
}

const BRAIN_HEAL_RE = /heal|mend|cure|restor|regen/i;

export function brainAction(enemy, enemies, party, ratio) {
    const brain = brainOf(enemy);
    const own = ratio(enemy) ?? 1;
    const strong = brainPick(party, ratio, false);
    const weak = brainPick(party, ratio, true);
    const act = (title, text, target) => ({ enemy: enemy.name, speed: 0, title, text, target: target?.name || "" });
    if (!strong) return act("Hold", `${enemy.name} holds its ground.`, null);
    switch (brain) {
        case "berserker":
            return own < 0.5
                ? act("Frenzied attack", `${enemy.name} throws itself at ${weak.name} with reckless fury.`, weak)
                : act("All-out attack", `${enemy.name} goes all-out on ${weak.name}.`, weak);
        case "skirmisher":
            return act("Hit and run", `${enemy.name} strikes at ${weak.name} and slips back out of reach.`, weak);
        case "guardian": {
            const hurt = enemies.filter(e => e !== enemy && (ratio(e) ?? 1) < 0.5);
            if (hurt.length) {
                const ward = brainPick(hurt, ratio, true);
                return act(`Guard ${ward.name}`, `${enemy.name} steps in front of ${ward.name} to shield it.`, ward);
            }
            return act("Attack", `${enemy.name} presses ${strong.name}.`, strong);
        }
        case "healer": {
            const hurt = enemies.filter(e => (ratio(e) ?? 1) < 0.5);
            if (hurt.length) {
                const ward = brainPick(hurt, ratio, true);
                const skill = brainSkill(enemy, BRAIN_HEAL_RE);
                return act(skill ? skill.name : "Heal", `${enemy.name} tends to ${ward === enemy ? "its own wounds" : ward.name}${skill ? ` with ${skill.name}` : ""}.`, ward);
            }
            return act("Attack", `${enemy.name} lashes out at ${weak.name}.`, weak);
        }
        case "coward":
            if (own < 0.3) return act("Flee", `${enemy.name} turns and tries to escape.`, null);
            return act("Cheap shot", `${enemy.name} goes for ${weak.name} while they are distracted.`, weak);
        case "caster": {
            const skill = brainSkill(enemy, null);
            if (skill && !BRAIN_HEAL_RE.test(String(skill.name))) return act(skill.name, `${enemy.name} uses ${skill.name} on ${strong.name}.`, strong);
            return act("Attack", `${enemy.name} attacks ${strong.name}.`, strong);
        }
        default:
            return act("Heavy attack", `${enemy.name} attacks ${strong.name} head-on.`, strong);
    }
}

export function brainActions(enemies, party, ratio, max = 6) {
    const list = (enemies || []).slice(0, Math.max(1, Math.trunc(Number(max) || 6)));
    return list.map(e => brainAction(e, enemies || [], party || [], ratio));
}
