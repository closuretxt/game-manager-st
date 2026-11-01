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

// ---------- rivals (race / scores), 3.7 ----------

export const RACE_BRAIN_IDS = ["front-runner", "stalker", "closer", "pacer"];
export const SCORES_BRAIN_IDS = ["safe", "showy", "erratic"];

// A rival's style: the sheet's `brain` when it is one of the kind's, else a
// stable pick from the name (the same rival always runs the same way).
export function rivalBrainOf(kind, rival) {
    const ids = kind === "race" ? RACE_BRAIN_IDS : SCORES_BRAIN_IDS;
    const own = String(rival?.sheet?.brain || "").toLowerCase();
    if (ids.includes(own)) return own;
    let h = 0;
    for (const ch of String(rival?.name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return ids[h % ids.length];
}

// info: { phase, ahead(name) -> runner ahead | null, round }.
export function rivalBrainAction(kind, rival, info) {
    const brain = rivalBrainOf(kind, rival);
    const name = rival.name;
    const act = (title, text) => ({ enemy: name, speed: 0, title, text });
    if (kind === "race") {
        const phase = info?.phase || "start";
        const ahead = info?.ahead ? info.ahead(name) : null;
        const final = phase === "final stretch";
        switch (brain) {
            case "front-runner":
                return ahead ? act("Take the lead", `${name} pushes hard to get past ${ahead}.`) : act(final ? "Hold the lead" : "Push the pace", `${name} keeps the pace high at the front.`);
            case "stalker":
                if (final && ahead) return act(`Overtake ${ahead}`, `${name} swings out to pass ${ahead}.`);
                return act(ahead ? `Track ${ahead}` : "Hold position", `${name} sits just behind ${ahead || "the field"}, saving energy.`);
            case "closer":
                return final ? act("Spurt", `${name} unleashes an all-out spurt for the line.`) : act("Conserve", `${name} hangs back and conserves stamina.`);
            default:
                return final ? act("Push the pace", `${name} lifts the pace for the finish.`) : act("Steady pace", `${name} holds an even, steady rhythm.`);
        }
    }
    const showy = brain === "showy" || (brain === "erratic" && (Number(info?.round) || 0) % 2 === 1);
    return showy
        ? act("Showpiece", `${name} gambles on a bold, flashy showpiece.`)
        : act("Safe performance", `${name} sticks to a clean, safe performance.`);
}

export function rivalBrainActions(kind, rivals, info, max = 6) {
    const list = (rivals || []).slice(0, Math.max(1, Math.trunc(Number(max) || 6)));
    return list.map(r => rivalBrainAction(kind, r, info));
}

export function brainActions(enemies, party, ratio, max = 6) {
    const list = (enemies || []).slice(0, Math.max(1, Math.trunc(Number(max) || 6)));
    return list.map(e => brainAction(e, enemies || [], party || [], ratio));
}
