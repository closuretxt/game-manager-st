// Round results -> the three audiences (plans/combat-modules.md 3.10, 3.11):
//   storyBlock    the story LLM: resolution-ordered lines, consequences and a
//                 standing IN WORDS, one static rule line. Never a number.
//   postPassBlock the tracker: every applied effect WITH numbers, marked as
//                 already applied so it is never reported twice.
//   chipRows      the player's results chips: tier, roll and effect numbers.
// Pure: no SillyTavern imports.

// Entity strings built by concatenation: some tooling decodes entity
// literals on write and silently turns escapers into no-ops (CLAUDE.md).
function ledgerAttr(v) {
    return String(v ?? "")
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/"/g, "&" + "quot;");
}

function ledgerText(v) {
    return String(v ?? "")
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/\s+/g, " ")
        .trim();
}

export function storyBlock(shape, round) {
    const tag = shape?.storyTag || "contest_round";
    const lineTag = shape?.lineTag || "result";
    const lines = [];
    for (const g of round?.groups || []) {
        for (const l of g.lines || []) {
            const attrs = [`actor="${ledgerAttr(l.actor)}"`, `action="${ledgerAttr(l.action)}"`];
            if (l.versus) attrs.push(`versus="${ledgerAttr(l.versus)}"`);
            attrs.push(`result="${ledgerAttr(l.result)}"`);
            if (l.fell) attrs.push(`fell="${ledgerAttr(l.fell)}"`);
            if (l.status) attrs.push(`status="${ledgerAttr(l.status)}"`);
            lines.push(`<${lineTag} ${attrs.join(" ")}>${ledgerText(l.text)}</${lineTag}>`);
        }
    }
    if (!lines.length) return "";
    const out = [`<${tag}>`, shape?.rule || "These results are final: narrate them as they are."];
    out.push(...lines);
    if (round.standing) out.push(`<standing>${ledgerText(round.standing)}</standing>`);
    if (round.over) out.push("The contest is over.");
    out.push(`</${tag}>`);
    return out.join("\n");
}

const LEDGER_STATE_WORDS = { dead: "dead", ko: "knocked out", down: "down (removed from the scene)", fled: "fled (removed from the scene)", yielded: "yielded", out: "out of the contest" };

// One applied effect in tracker words, numbers included.
export function effectSummary(r) {
    switch (r.kind) {
        case "resource":
        case "track": {
            const sign = r.applied >= 0 ? "+" : "";
            return `${r.target} ${r.name} ${r.before} → ${r.after} (${sign}${r.applied})`;
        }
        case "status": return r.remove ? `${r.target} status cleared: ${r.name}` : `${r.target} status: ${r.name}${r.modifiers ? ` (${r.modifiers})` : ""}`;
        case "skill": return `${r.target} used skill: ${r.name} (cooldown started)`;
        case "item": return r.qty > 0 ? `${r.target} gained ${r.qty} ${r.name}` : `${r.target} used ${-r.qty} ${r.name}`;
        case "state": return `${r.target}: ${LEDGER_STATE_WORDS[r.name] || r.name}`;
        default: return `${r.target}: ${r.kind} ${r.name}`;
    }
}

// Short chip form: "Goblin A Health -12".
export function effectShort(r) {
    if (r.kind === "resource" || r.kind === "track") return `${r.target} ${r.name} ${r.applied >= 0 ? "+" : ""}${r.applied}`;
    if (r.kind === "skill") return `${r.target}: ${r.name}`;
    if (r.kind === "state") return `${r.target} ${LEDGER_STATE_WORDS[r.name]?.split(" (")[0] || r.name}`;
    return effectSummary(r);
}

function groupHeading(g) {
    const who = (g.sides || []).map(sd => `${sd.actor} (${sd.action})`).join(" vs ");
    if (g.status === "interrupted") return `${who}: Interrupted`;
    const o = g.outcome;
    return `${who}: ${o.name} (${o.chance}% tier, roll ${o.roll})`;
}

export function postPassBlock(round, { degraded = false, roundNo = 0 } = {}) {
    const out = [`<contest_ledger round="${Math.max(0, Math.trunc(Number(roundNo) || 0))}">`];
    if (degraded) {
        out.push("The engine could not adjudicate effects this round: the outcome lines decided who succeeded, but no numbers were committed. Account this round's damage, costs and statuses from the outcome lines and the narration as usual.");
    } else {
        out.push("ALREADY APPLIED to the snapshot: every change listed here was committed by the game engine before the story ran. NEVER report these again. Anything the narration adds beyond the round (looting, dialogue consequences, time, things outside the fight) is still yours to track.");
    }
    for (const g of round?.groups || []) {
        out.push(`- ${ledgerText(groupHeading(g))}`);
        for (const r of g.records || []) {
            if (r.status === "applied") out.push(`  - ${ledgerText(effectSummary(r))}`);
            else if (r.status === "wasted") out.push(`  - (no effect: ${ledgerText(r.target)} was already ${ledgerText(r.reason)})`);
        }
        for (const f of g.fell || []) {
            if (!(g.records || []).some(r => r.kind === "state" && r.status === "applied" && r.target === f.name)) {
                out.push(`  - ${ledgerText(f.name)}: ${ledgerText(LEDGER_STATE_WORDS[f.mode] || f.mode)}`);
            }
        }
    }
    if (round?.over) out.push("The contest ended this round.");
    out.push("</contest_ledger>");
    return out.join("\n");
}

// One chip per group: { title, tier, outcome }.
export function chipRows(round) {
    return (round?.groups || []).map(g => {
        const title = g.title || (g.sides || []).map(sd => sd.actor).join(" vs ");
        const tier = g.status === "interrupted" ? "Interrupted" : `${g.outcome.name} (${g.outcome.chance}%, roll ${g.outcome.roll})`;
        const text = (g.lines || []).map(l => l.text).join(" ");
        const fx = (g.records || []).filter(r => r.status === "applied").map(effectShort);
        for (const f of g.fell || []) {
            if (!(g.records || []).some(r => r.kind === "state" && r.status === "applied" && r.target === f.name)) fx.push(`${f.name} ${f.word}`);
        }
        return { title, tier, outcome: fx.length ? `${text} [${fx.join(" · ")}]` : text };
    });
}
