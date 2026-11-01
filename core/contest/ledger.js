// Round results -> the three audiences (plans/combat-modules.md 3.10, 3.11):
//   storyBlock    the story LLM: resolution-ordered lines, consequences and a
//                 standing IN WORDS, one static rule line. Never a number.
//   postPassBlock the tracker: every applied effect WITH numbers, marked as
//                 already applied so it is never reported twice.
//   chipRows      the player's results chips: tier, roll and effect numbers.
// Pure: no SillyTavern imports.

import { contestKey } from "./effects.js";

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

// The move's name only. Party acts arrive as "Sharky's Bite on Scout B —
// follow up to finish the dazed scout": the part after the dash is the
// intent the oracle judged, and handed to the story it reads as what happened.
function storyAction(action) {
    return String(action ?? "").split(" — ")[0].trim();
}

export function storyBlock(shape, round) {
    const tag = shape?.storyTag || "contest_round";
    const lineTag = shape?.lineTag || "result";
    const lines = [];
    for (const g of round?.groups || []) {
        for (const l of g.lines || []) {
            const attrs = [`actor="${ledgerAttr(l.actor)}"`, `action="${ledgerAttr(storyAction(l.action))}"`];
            if (l.versus) attrs.push(`versus="${ledgerAttr(l.versus)}"`);
            attrs.push(`result="${ledgerAttr(l.result)}"`);
            if (l.landed) attrs.push(`landed="${ledgerAttr(l.landed)}"`);
            if (l.fell) attrs.push(`fell="${ledgerAttr(l.fell)}"`);
            if (l.status) attrs.push(`status="${ledgerAttr(l.status)}"`);
            lines.push(`<${lineTag} ${attrs.join(" ")}>${ledgerText(l.text)}</${lineTag}>`);
        }
    }
    if (!lines.length) return "";
    const tagAttrs = Object.entries(round.attrs || {})
        .filter(([k, v]) => /^[a-z][\w-]*$/i.test(k) && v !== "" && v !== null && v !== undefined)
        .map(([k, v]) => ` ${k}="${ledgerAttr(v)}"`).join("");
    const out = [`<${tag}${tagAttrs}>`, shape?.rule || "These results are final: narrate them as they are."];
    out.push(...lines);
    for (const ev of round.events || []) if (ev) out.push(`<event>${ledgerText(ev)}</event>`);
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

// How the outcome was rolled: the dice module's own words (d20 14 +5 = 19 vs
// DC 15) or the oracle's tier odds.
export function outcomeDetail(o, long) {
    if (!o) return "";
    if (o.detail) return o.detail;
    return long ? `${o.chance}% tier, roll ${o.roll}` : `${o.chance}%, roll ${o.roll}`;
}

function groupHeading(g) {
    const who = (g.sides || []).map(sd => `${sd.actor} (${sd.action})`).join(" vs ");
    if (g.status === "interrupted") return `${who}: Interrupted`;
    const o = g.outcome;
    return `${who}: ${o.name} (${outcomeDetail(o, true)})`;
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

// A group's applied effects in short form, plus falls no state effect named.
export function groupEffectShorts(g) {
    // A number that did not move (already at max, a band already set) is noise.
    const fx = (g?.records || [])
        .filter(r => r.status === "applied" && !((r.kind === "resource" || r.kind === "track") && r.applied === 0))
        .map(effectShort);
    for (const f of g?.fell || []) {
        if (!(g.records || []).some(r => r.kind === "state" && r.status === "applied" && r.target === f.name)) fx.push(`${f.name} ${f.word}`);
    }
    return fx;
}

// ---------- Round cards: the player's readable view ----------
// One card per group, in plain words for someone who never played a table
// game: who did what to whom, a result badge, what happened, the roll as
// "needed 14, got 15", and the effects grouped per character. The dice math
// (`math`) stays available as a tooltip. Feeds the bubble, the chat message
// and the HUD log (ui/roundCard.js renders it).

const CARD_TONES = { crit: "great", hit: "good", graze: "mixed", miss: "bad", fumble: "awful" };
const CARD_MEANINGS = {
    crit: "The best possible result.",
    hit: "It worked.",
    graze: "It half-worked, or worked at a cost.",
    miss: "It did not work.",
    fumble: "It went wrong.",
};
const CARD_RANGE_WORDS = ["now in melee range", "now close by", "now far away"];
// Tracks the player never needs to read (the ladder's rung shows as a status).
const CARD_HIDDEN_TRACKS = new Set(["harm"]);

function cardSigned(n) {
    return n > 0 ? `+${n}` : `${n}`;
}

// The roll in words, from whatever the dice module recorded.
export function plainRoll(o) {
    if (!o) return "";
    if (/impossible/.test(String(o.detail || ""))) return "it could not work, whatever the roll";
    const add = (Number(o.mod) || 0) + (Number(o.bonus) || 0);
    const twice = o.adv > 0 ? ", best of two" : o.adv < 0 ? ", worst of two" : "";
    if (Number.isFinite(o.dc) && Number.isFinite(o.roll)) {
        const how = o.card ? `played ${o.card}` : Number.isFinite(o.face) ? `rolled ${o.face}` : "";
        const parts = [how, add ? `${cardSigned(add)} bonus` : "", twice.slice(2)].filter(Boolean).join(", ");
        return `needed ${o.dc}, got ${o.roll}${parts ? ` (${parts})` : ""}`;
    }
    if (Number.isFinite(o.target) && Number.isFinite(o.face)) return `needed ${o.target} or lower, rolled ${o.face}${twice}`;
    if (Number.isFinite(o.pool)) {
        const theirs = Number.isFinite(o.opp) && o.opp ? `, they got ${o.face - o.roll}` : "";
        return `${o.face} of ${o.pool} dice hit${theirs}`;
    }
    if (Number.isFinite(o.die)) return o.roll > 0 ? `beat them by ${o.roll}` : o.roll < 0 ? `behind by ${-o.roll}` : "a tie";
    if (o.bands && Number.isFinite(o.roll)) return `got ${o.roll} (10+ works, 7-9 half-works)`;
    if (Number.isFinite(o.chance) && o.chance > 0) return `had a ${o.chance}% chance`;
    return "";
}

// One applied record as a chip: { text, tone, hint? }. Tones: hurt, heal,
// cost (the actor's own spend), status, out, info.
function cardEffect(r, actor) {
    // A cost = the actor spending on themself; a blow the other side lands
    // on the actor is still damage.
    const own = contestKey(r.target) === contestKey(actor) && contestKey(r.by || actor) === contestKey(actor);
    switch (r.kind) {
        case "resource": {
            const tone = r.applied > 0 ? "heal" : own ? "cost" : "hurt";
            return { text: `${cardSigned(r.applied)} ${r.name}`, tone, hint: `${r.before} → ${r.after}` };
        }
        case "track": {
            if (CARD_HIDDEN_TRACKS.has(String(r.name).toLowerCase())) return null;
            if (String(r.name).toLowerCase() === "range") return { text: CARD_RANGE_WORDS[r.after] || `distance ${r.after}`, tone: "info" };
            return { text: `${cardSigned(r.applied)} ${r.name}`, tone: "info", hint: `${r.before} → ${r.after}` };
        }
        case "status": return r.remove ? { text: `no longer ${r.name}`, tone: "info" } : { text: r.name, tone: "status", hint: r.modifiers || "" };
        case "skill": return { text: `used ${r.name}`, tone: "cost", hint: "now on cooldown" };
        case "item": return r.qty > 0 ? { text: `got ${r.qty} ${r.name}`, tone: "heal" } : { text: `used ${-r.qty} ${r.name}`, tone: "cost" };
        case "state": return { text: CARD_STATE_WORDS[r.name] || r.name, tone: "out" };
        default: return { text: `${r.kind} ${r.name}`, tone: "info" };
    }
}

const CARD_STATE_WORDS = { dead: "dead", ko: "knocked out", down: "down", fled: "fled", yielded: "gave up", out: "out" };

// Effects grouped per character, the people acted on first, the actor's
// own costs last: [{ who, items: [...] }].
function cardEffects(g, actor) {
    const by = new Map();
    const push = (who, item) => {
        if (!item) return;
        const k = contestKey(who);
        if (!by.has(k)) by.set(k, { who, items: [] });
        const list = by.get(k).items;
        if (!list.some(x => x.text === item.text)) list.push(item);
    };
    for (const r of g?.records || []) {
        if (r.status !== "applied") continue;
        if ((r.kind === "resource" || r.kind === "track") && r.applied === 0) continue;
        push(r.target, cardEffect(r, actor));
    }
    for (const f of g?.fell || []) push(f.name, { text: CARD_STATE_WORDS[f.mode] || f.word || f.mode, tone: "out" });
    const out = [...by.values()];
    const me = contestKey(actor);
    return [...out.filter(e => contestKey(e.who) !== me), ...out.filter(e => contestKey(e.who) === me)];
}

// The move as the card shows it. Ally/enemy plans are often whole sentences
// ("Follow Aaru's shots with Waveless Splash/Sharky's Bite on nearest dazed
// scout"); a short plan reads fine as is, a long one is replaced by the skill
// the character actually used, the full plan kept for the hover.
const CARD_MOVE_MAX = 40;
function cardMove(g, side) {
    const plan = storyAction(side?.action);
    if (plan.length <= CARD_MOVE_MAX) return { text: plan, hint: "" };
    const k = contestKey(side.actor);
    const used = (g?.records || []).find(r => r.kind === "skill" && r.status === "applied" && contestKey(r.target) === k);
    return used ? { text: used.name, hint: plan } : { text: plan, hint: "" };
}

export function roundCards(round) {
    const groups = (round?.groups || []).map(g => {
        const first = g.sides?.[0] || {};
        const line = g.lines?.[0] || {};
        const move = cardMove(g, first);
        const against = g.sides?.[1]?.action ? cardMove(g, g.sides[1]) : { text: "", hint: "" };
        const card = {
            who: first.actor || "",
            move: move.text,
            moveHint: [move.hint, against.hint && `${g.sides[1].actor}: ${against.hint}`].filter(Boolean).join("\n"),
            target: line.versus || "",
            against: against.text,
            story: (g.lines || []).map(l => l.text).filter(Boolean).join(" "),
            effects: cardEffects(g, first.actor),
            tags: [...(g.notes || [])],
        };
        if (g.status === "interrupted") return { ...card, result: "Interrupted", tone: "none", meaning: "They were taken out before they could act." };
        const o = g.outcome || {};
        if (o.rerolledFrom) card.tags.unshift(`First try: ${o.rerolledFrom.name}${o.rerolledFrom.plain ? ` (${o.rerolledFrom.plain})` : ""}`);
        return { ...card, result: o.name || "", tone: CARD_TONES[o.key] || "none", meaning: CARD_MEANINGS[o.key] || "", roll: o.plain || plainRoll(o), math: outcomeDetail(o, false), face: Number.isFinite(o.face) ? o.face : null };
    });
    // Who acted, in the order they acted.
    const order = [];
    for (const c of groups) if (c.who && !order.includes(c.who)) order.push(c.who);
    return { order, notes: [...(round?.notes || [])], events: [...(round?.events || [])], groups };
}

// The plain-text form (copy, message log): one short paragraph per card.
export function roundCardText(card) {
    const head = `${card.who}${card.move ? `: ${card.move}` : ""}${card.target ? ` → ${card.target}` : ""}`;
    const res = [card.result, card.roll].filter(Boolean).join(", ");
    const fx = (card.effects || []).map(e => `${e.who} ${e.items.map(i => i.text).join(", ")}`).join("; ");
    return [`${head}${res ? ` — ${res}` : ""}`, card.story, fx, ...(card.tags || [])].filter(Boolean).join("\n");
}

// The quick-battle reply's text (inject/quickBattle.js): what the chat keeps
// in place of a narrated reply, so later story turns read what happened. The
// message itself shows the cards; this is the prompt's view of it.
export function quickReplyText(cards, roundNo, over = false) {
    const parts = [`[Quick battle, round ${roundNo}]`];
    for (const c of cards?.groups || []) parts.push(roundCardText(c));
    for (const ev of cards?.events || []) parts.push(ev);
    if (over) parts.push("The fight is over.");
    return parts.join("\n\n");
}

// One chip per group: { title, tier, outcome, icon? }. Round notes
// (initiative...) lead as their own chip; group notes (escalation, momentum)
// follow the tier. `icon` = the dice module's chip icon.
export function chipRows(round, icon = "") {
    const lead = (round?.notes || []).length ? [{ title: "Round", tier: round.notesLabel || "Turn order", outcome: round.notes.join(" · ") }] : [];
    return [...lead, ...(round?.groups || []).map(g => {
        const title = g.title || (g.sides || []).map(sd => sd.actor).join(" vs ");
        const notes = (g.notes || []).length ? ` · ${g.notes.join(" · ")}` : "";
        const tier = g.status === "interrupted" ? "Interrupted" : `${g.outcome.name} (${outcomeDetail(g.outcome, false)})${notes}`;
        const text = (g.lines || []).map(l => l.text).join(" ");
        const fx = groupEffectShorts(g);
        const row = { title, tier, outcome: fx.length ? `${text} [${fx.join(" · ")}]` : text };
        if (icon && g.status !== "interrupted") row.icon = icon;
        return row;
    })];
}
