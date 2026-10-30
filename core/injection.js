// Injection core — builds the minimal XML context blocks exposed through the
// {{gamemaster-low-priority}} and {{gamemaster-high-priority}} macros.
//
// Low priority (persistent context, non-immediate): active warnings and the
// values of shared resources flagged "always inject". Rendered only when
// something actually exists — an empty buffer returns "" so unused macros
// cost zero tokens ("only inject when relevant").
//
// High priority (immediate, one-shot): pending roll results, transaction
// reports and skill-use suggestions queued by the pre-master flows. Consumed
// once by the macro at prompt build time. Anything the macro did not consume
// is discarded at the next pre-turn (discardPending): a roll from an earlier
// turn must never reach a later prompt as if it had just been resolved.
//
// Everything here is gated by the feature_injection setting in the macros.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName, CHARACTER_STATES } from "./constants.js";
import { gmSettings, containerEnabled } from "./features.js";
import { logDebug } from "./debug.js";
import { stateManager, playerNames } from "./stateManager.js";
import { resolveResourceMax } from "./resourceScaler.js";
import { bondConfig, bondInjectionLine, bondGuideText, isPlayerSheet } from "./bonds.js";
import { isMentioned } from "./rosterRotation.js";
import { clockInjectionText, scheduleInjectionLines, objectiveInjectionLines, nameTag, chronoGuideText } from "./chrono.js";
import { CHARACTER_CONTAINERS } from "./schemas.js";
import { scenarioBriefInjection } from "./scenarioBrief.js";

let _pendingHigh = [];
let _pendingLow = [];

// Record of what the macros actually injected into THIS turn's story prompt:
// the drained high-priority payload and the one-shot low-priority lines. The
// post-pass tracker reads it (getLastInjections) so its LLM sees the same
// ground-truth results the story engine saw — raw chat text alone never
// contains the roll numbers or transaction outcomes. Reset per generation by
// resetInjectionRecord (called from handlePreTurn), so a turn where the macro
// was not placed (or nothing was queued) never leaks the previous turn's data.
let _lastHigh = "";
let _lastLow = "";

// Previous generation's record, preserved when resetInjectionRecord clears
// the current one. Exposed to the pre-master engines (dice roller) so they
// judge the action knowing what the game system injected LAST turn.
let _prevHigh = "";
let _prevLow = "";

function enabled() {
    const s = gmSettings();
    return !!(s.enabled && s.feature_injection);
}

// Element-body escaper: story text keeps its literal quotes (no &quot; noise
// in prose-facing blocks); only &, < and > must go.
function txt(v) {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

const oneLine = v => String(v ?? "").replace(/\s+/g, " ").trim();

// STORY-FACING FORMAT: everything the story engine reads is plain, name-keyed
// XML — <tokai_teio><outfit>...</outfit></tokai_teio> — with any guidance as
// a plain sentence inside the block, never note="..." attributes. Attribute
// soup reads like a database dump and bleeds into prose; short named tags read
// like labelled facts. The tracker-facing snapshot (sheetXml) keeps its own
// format: its model must echo exact names back into tool tags.
function block(tag, guidance, lines) {
    return [`<${tag}>`, ...(guidance ? [guidance] : []), ...lines, `</${tag}>`].join("\n");
}

// What a tracked entry reads as in the story prompt. Descriptions stay out:
// only always-inject entries land here, and their value is the fact.
function entryText(section, e, c) {
    switch (section) {
        case "resources": {
            const max = resolveResourceMax(c, e);
            return Number.isFinite(max) ? `${e.value ?? 0}/${max}` : String(e.value ?? 0);
        }
        case "attributes": return String(e.value ?? 0);
        case "traits": {
            // The explanation is tracker-side unless the entry opts in.
            const explain = e.inject_description ? oneLine(e.description) : "";
            return `${String(e.value ?? "")}${explain ? ` (${explain})` : ""}`;
        }
        case "inventory": return (e.qty ?? 1) !== 1 ? `carrying ${e.qty}` : "carrying";
        case "skills": return (Number(e.cooldown_left) || 0) > 0 ? "on cooldown" : "ready";
        case "statuses": return String(e.modifiers || "").trim() || "active";
        default: return "active";
    }
}

// One character as a name-keyed block: their state (dead / knocked out) and
// always-inject entries, one labelled line each. "" when there is nothing.
function characterBlock(c, mode) {
    const lines = [];
    if (mode) {
        const reason = oneLine(c.state?.reason);
        lines.push(`<state>${txt(mode.status.replace(/_/g, " "))}${reason ? ` (${txt(reason)})` : ""}</state>`);
    }
    if (mode?.status !== "dead") {
        for (const k of CHARACTER_CONTAINERS) {
            if (!containerEnabled(k)) continue;
            for (const e of (c[k] || []).filter(x => x.always_inject)) {
                const val = oneLine(entryText(k, e, c));
                const tag = nameTag(e.name, "detail");
                lines.push(`<${tag}>${txt(val)}</${tag}>`);
            }
        }
    }
    if (!lines.length) return "";
    const tag = nameTag(c.name);
    return lines.length === 1 ? `<${tag}>${lines[0]}</${tag}>` : block(tag, "", lines);
}

// The player's persona name, for wording like "toward Aaru".
function personaName() {
    return String(getContext()?.name1 || "").trim() || "the player";
}

// ---------- high priority (one-shot queue) ----------

// Queues an immediate report (roll result / transaction / rewrite / skill
// suggestion) for the next prompt.
export function queueHigh(xmlBlock) {
    if (!xmlBlock) return;
    _pendingHigh.push(xmlBlock);
}

// Stash of this turn's queued payloads, keyed by the id of the AI message it
// belongs to. Swipes/regenerates never re-run the pre-pass, and the previous
// generation's macros already consumed both buffers — so the re-generated
// prompt would lose the roll / combat round / transaction results AND the
// one-shot low-priority lines (relevant resource values, character stats,
// notes). stashHigh keeps both; replayHigh re-queues them.
// NOTE: stashHigh runs in handlePreTurn's finally — BEFORE prompt assembly —
// so _pendingLow still holds this turn's one-shot lines at stash time (the
// macro drains them only when the prompt is built).
const _stashedHigh = new Map();
const STASH_LIMIT = 10;

export function stashHigh(mesId) {
    const id = Number(mesId);
    if (!Number.isFinite(id)) return;
    const high = _pendingHigh.join("\n");
    const low = _pendingLow.join("\n");
    if (!high && !low) return;
    _stashedHigh.set(id, { high, low });
    for (const k of _stashedHigh.keys()) {
        if (k < id - STASH_LIMIT) _stashedHigh.delete(k);
    }
    console.info(`[GM DIAG] stashHigh: key=${id} highChars=${high.length} lowChars=${low.length} keys=[${[..._stashedHigh.keys()]}]`);
}

export function replayHigh(mesId) {
    const stored = _stashedHigh.get(Number(mesId));
    if (!stored) {
        console.info(`[GM DIAG] replayHigh: MISS for message ${mesId} (stashed keys=[${[..._stashedHigh.keys()]}])`);
        return false; // caller decides the fallback (swipe recovery)
    }
    logDebug(`injection: replaying stashed results for message ${mesId} (swipe/regenerate)`);
    console.info(`[GM DIAG] replayHigh: HIT for message ${mesId} (high=${stored.high.length} chars, low=${stored.low.length} chars re-queued)`);
    if (stored.high) _pendingHigh.push(stored.high);
    if (stored.low) {
        // One-shot low-priority lines were drained by the previous
        // generation's macro — re-queue them verbatim for this one.
        _pendingLow.push(...stored.low.split("\n").filter(Boolean));
    }
    return true;
}

// Queues a ONE-SHOT high-priority action rewrite produced by the pre-pass.
// XML-escaped on queue.
export function queueRewrite(text) {
    const t = txt(String(text ?? "").trim());
    if (!t) return;
    queueHigh(block("action_rewrite", "The player's action, clarified (vague, meta or contradictory parts resolved). Their original dialogue still stands.", [t]));
}

// Queues a ONE-SHOT high-priority skill suggestion produced by the pre-pass:
// the story engine should narrate the character using the skill this turn.
// The cooldown itself is NOT applied here — the post-pass <use_skills> report
// stays the only cooldown writer. XML-escaped on queue.
export function queueSkillUse(character, skill, cost = "") {
    const c = txt(oneLine(character));
    const sk = txt(oneLine(skill));
    const co = txt(oneLine(cost));
    if (!c || !sk) return;
    const costNote = co ? ` Narrate its cost (${co}) as paid, exactly as the skill describes.` : "";
    queueHigh(`<skill_use>${c} uses ${sk} in this action.${costNote}</skill_use>`);
}

// Queues a ONE-SHOT high-priority clash override — ONLY when a clash
// resolution actually ran this turn (called from combatEngine). Tells the
// story engine that clash outcomes supersede the skill-use suggestions
// whose actions got interrupted, cancelled or negated by a clash.
export function queueClashOverride() {
    queueHigh(`<clash_override>A clash outcome that interrupts, cancels or negates an action overrides any skill_use for it: that action fails before it happens. Narrate only the interruption; no cost, no effect.</clash_override>`);
}

// Queues a ONE-SHOT low-priority line (e.g. a shared resource value the
// pre-pass flagged as relevant this turn). Rendered by the next low-priority
// build, then dropped — unlike always-inject values, it does not persist.
export function queueLowOnce(line) {
    if (!line || !enabled()) return;
    _pendingLow.push(line);
}

// Queues a ONE-SHOT low-priority note: a free-form contextual remark the
// pre-pass judged relevant this turn (relevance-gated world info). Rendered
// inside the low-priority block, then dropped. XML-escaped on queue.
export function queueLowNote(text) {
    const t = txt(oneLine(text));
    if (!t) return;
    // Plain sentence, not a <note> element: it reads as context, not data.
    queueLowOnce(`Note: ${t}`);
}

export function clearLow() {
    _pendingLow = [];
}

// Cache-first: the low-priority block only carries what persists between
// turns, so a prompt prefix that contains it stays byte-identical (and
// cached) until that state actually changes. Everything that changes per turn
// (one-shot readouts, live enemy state) rides in the high-priority macro,
// which sits near the end of the prompt anyway.
function cacheFirst() {
    return extension_settings[extensionName]?.cache_first !== false;
}

// Bonds of the characters in the scene: the party, plus benched sheets named
// in the last few messages. Per-turn on purpose: in the cached low block a
// change surfaced late (only on a band crossing) and every change broke the
// prefix anyway.
function bondLines(d, s) {
    const cfg = s.feature_bonds ? bondConfig(d) : null;
    if (!cfg?.inject || !cfg.defs.length) return [];
    const chat = getContext()?.chat || [];
    const recent = chat.slice(-3).map(m => `${m?.name ?? ""}\n${m?.mes ?? ""}`).join("\n");
    const players = playerNames();
    const benched = (d.roster || []).map(r => r.sheet).filter(c => c && isMentioned(recent, c.name, c.aliases));
    const holders = [...(d.characters || []), ...benched]
        .filter(c => c.bond && c.state?.mode !== "dead" && !isPlayerSheet(c, players))
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    const lines = holders.map(c => bondInjectionLine(d, c, txt, nameTag(c.name))).filter(Boolean);
    if (!lines.length) return [];
    return [block("bonds", `How each character feels toward ${txt(personaName())} right now${bondGuideOn(d, s) ? " (read with <bond_rules>)" : ""}. Let it color their behavior; never state it outright.`, lines)];
}

// The bonds guidance is static text, so it sits in the cached low block
// (like the chronogram guidance) instead of riding in every turn context.
// Shown while some living party NPC carries a bond, so it does not flicker
// with benched characters walking in and out of the last messages.
function bondGuideOn(d, s) {
    const cfg = s.feature_bonds ? bondConfig(d) : null;
    if (!cfg?.inject || !cfg.defs.length) return false;
    const players = playerNames();
    return (d.characters || []).some(c => c.bond && c.state?.mode !== "dead" && !isPlayerSheet(c, players));
}

// Per-turn context: world clock, live enemy state, bonds + the pre-pass's
// one-shot readouts. Drains the one-shot queue (recorded for the post-pass as _lastLow).
function buildTurnContext() {
    const d = stateManager.getData();
    const s = gmSettings();
    const parts = [];
    // Time moves every turn, so the clock (and now/next) is per-turn context.
    if (s.feature_chrono) {
        const clock = clockInjectionText(d, txt);
        if (clock) parts.push(clock);
    }
    // Context-based enemies: compact state summary, only when the feature is
    // on AND enemies exist — zero tokens otherwise.
    if (s.feature_enemies && (d.enemies || []).length) {
        const lines = d.enemies.map(e => {
            const res = (e.resources || []).map(r => `${r.name} ${r.value}/${resolveResourceMax(e, r)}`).join(", ");
            const st = (e.statuses || []).map(x => x.name).join(", ");
            const tag = nameTag(e.name, "enemy");
            return `<${tag}>${txt([res, st].filter(Boolean).join("; ") || "present")}</${tag}>`;
        });
        parts.push(block("enemies", "Active enemies in the scene.", lines));
    }
    parts.push(...bondLines(d, s));
    // One-shot lines queued by the pre-pass for THIS turn only.
    if (_pendingLow.length) {
        const oneShot = _pendingLow.splice(0, _pendingLow.length);
        _lastLow = oneShot.join("\n");
        parts.push(...oneShot);
    }
    return parts;
}

// Returns everything queued so far and drains the queue. In cache-first mode
// the per-turn context (enemy state, one-shot readouts) is appended here
// instead of in the low-priority block.
export function consumeHigh() {
    if (!enabled()) return "";
    const turn = cacheFirst() ? buildTurnContext() : [];
    if (_pendingHigh.length === 0 && !turn.length) return "";
    const out = _pendingHigh.join("\n");
    _pendingHigh = [];
    if (out) _lastHigh = out;
    const blocks = [];
    if (out) {
        blocks.push(block("gamemaster_result", "Outcomes the game system just resolved. Narrate them as they are, in prose: never quote numbers or tags, never add actions or results not shown here.", [out]));
    }
    if (turn.length) {
        blocks.push(block("gamemaster_turn_context", "Background facts for this turn. Use them for consistency; don't recite them.", turn));
    }
    return blocks.join("\n");
}

export function clearHigh() {
    _pendingHigh = [];
    _stashedHigh.clear();
}

// Drops whatever the previous generation left unconsumed (macro not placed in
// the preset, generation aborted before prompt assembly). Called at the start
// of every pre-turn: without it, stale rolls/transactions piled up turn after
// turn and flooded the first prompt that finally contained the macro. The
// stash is kept — swipes still replay their own turn's payload.
export function discardPending() {
    if (_pendingHigh.length || _pendingLow.length) {
        logDebug(`injection: discarding ${_pendingHigh.length} stale high / ${_pendingLow.length} stale low entries`);
    }
    _pendingHigh = [];
    _pendingLow = [];
}

// ---------- low priority (persistent context) ----------

// Builds the persistent context block: warnings, always-inject entries,
// character states and objectives (bonds ride in the turn context). Ordered deterministically (no insertion-order churn), so
// the block only changes when the underlying state does.
export function buildLowPriority() {
    if (!enabled()) return "";
    const d = stateManager.getData();
    const parts = [];
    const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));

    const brief = scenarioBriefInjection();
    if (brief) parts.push(brief);

    const s = gmSettings();
    for (const w of s.feature_warnings ? [...(d.warnings || [])].sort(byName) : []) {
        const text = oneLine(w.text);
        parts.push(`<warning>${txt(oneLine(w.name))}${text ? `: ${txt(text)}` : ""}</warning>`);
    }

    const shared = containerEnabled("sharedResources") ? d.sharedResources || [] : [];
    for (const r of shared.filter(x => x.always_inject).sort(byName)) {
        const tag = nameTag(r.name, "resource");
        parts.push(`<${tag}>${txt(oneLine(r.qty))}</${tag}>`);
    }
    const custom = containerEnabled("custom") ? d.custom || [] : [];
    for (const c of custom.filter(x => x.always_inject).sort(byName)) {
        const tag = nameTag(c.name, "detail");
        parts.push(`<${tag}>${txt(oneLine(c.value))}</${tag}>`);
    }

    // Characters in a special state (dead = never use again; knocked out =
    // down until recovery) plus their "always inject" entries (outfit, a
    // signature stat...), one name-keyed block each.
    for (const c of d.characters || []) {
        const mode = c.state ? CHARACTER_STATES[c.state.mode] : null;
        const blockText = characterBlock(c, mode);
        if (blockText) parts.push(blockText);
    }

    // Time: the day's schedules (change once a day) and active objectives —
    // the clock itself is volatile and rides in the turn context so this
    // block keeps its cached prefix.
    // The pacing guidance is static text, so it sits here (cached) rather than
    // next to the per-turn clock; it only appears with something to apply to.
    if (s.feature_chrono) {
        const scheds = scheduleInjectionLines(d, stateManager.chronoOwners(playerNames()), txt);
        const objs = objectiveInjectionLines(d, txt, o => stateManager.objectiveOwnerName(o));
        if (scheds.length || objs.length) {
            // Editable per chat (Time tab); the built-in text otherwise.
            const guide = chronoGuideText(d, { clock: !!d.chrono?.inject_clock, schedules: scheds.length > 0, objectives: objs.length > 0 }, txt(personaName()));
            parts.push(block("chronogram", guide, [...scheds, ...objs]));
        }
    }

    if (bondGuideOn(d, s)) parts.push(block("bond_rules", bondGuideText(d, txt(personaName()), txt), []));

    // Legacy layout: per-turn context shares this block (cache-first off).
    if (!cacheFirst()) parts.push(...buildTurnContext());

    if (!parts.length) return "";
    return block("gamemaster_context", "Tracked facts about the story. Keep the narration consistent with them without reciting them; warnings are imminent needs.", parts);
}

// ---------- post-pass visibility ----------

// Clears the per-turn injection record. Called at the start of every
// generation (handlePreTurn), before prompt assembly — so the record always
// describes exactly what THIS generation's macros injected, even when the
// macro is missing from the prompt or nothing was queued.
export function resetInjectionRecord() {
    // What was injected last generation becomes the "previous GM notes"
    // before the per-turn record is cleared.
    _prevHigh = _lastHigh;
    _prevLow = _lastLow;
    _lastHigh = "";
    _lastLow = "";
}

// What the macros injected into the PREVIOUS turn's story prompt (one-shot
// notes, roll results, transactions). Empty when nothing was injected.
export function getPreviousInjections() {
    if (!_prevHigh && !_prevLow) return "";
    const parts = [];
    if (_prevHigh) parts.push(_prevHigh);
    if (_prevLow) parts.push(_prevLow);
    return parts.join("\n");
}

// What the macros injected into this turn's story prompt, as one XML block.
// Empty when nothing was injected this turn. Consumed by the post-pass
// tracker (core/agentRunner.js) so it judges the exchange with the same
// ground-truth results (dice, transactions, rewrites, one-shot notes) the
// story engine saw.
export function getLastInjections() {
    if (!_lastHigh && !_lastLow) return "";
    const parts = [];
    if (_lastHigh) parts.push(_lastHigh);
    if (_lastLow) parts.push(_lastLow);
    return block("gamemaster_injections", "Results and context the game system injected into this turn's story prompt (dice rolls, transactions, action rewrites, notes). Treat as ground truth when reading the exchange.", parts);
}

// Whether THIS turn's story prompt contained a resolved combat round
// (<combat_round> queued by combatEngine). The post-pass tracker
// (core/agentRunner.js) uses it to tighten its damage instructions —
// combat turns need sheet-derived, ground-truth accounting.
export function hadCombatThisTurn() {
    return _lastHigh.includes("<combat_round");
}