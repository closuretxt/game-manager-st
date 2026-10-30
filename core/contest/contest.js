// Contest lifecycle + one round, RESOLVE -> COMMIT -> NARRATE
// (plans/combat-modules.md 2, 3.9, 3.13). Runs inside the awaited
// GENERATION_AFTER_COMMANDS handler, so the committed round reaches the SAME
// turn's story prompt:
//
//   party actions   player + the pre-pass's <act> for uncommanded allies
//   opposition      ENEMY AI, blind unless the pre-pass judged a reactive round
//   oracle          groups + chances + per-tier effects (core/contest/oracle.js)
//   engine          order -> validate -> roll -> apply (seeded, pure)
//   commit          snapshot on the USER message, deltas applied, gm_contest stored
//   narrate         <combat_round> for the story LLM; <contest_ledger> for the tracker
//
// The baseline sits on the USER message id, never the AI reply's: a swipe
// restores the AI baseline (= post-commit state) and replays the stored round,
// so the round's deltas survive; deleting the user message reverts them.

import { getContext } from "../../../../../extensions.js";
import { gmSettings } from "../features.js";
import { logDebug } from "../debug.js";
import { stateManager, playerNames, playerLabel, matchName } from "../stateManager.js";
import { resolveResourceMax } from "../resourceScaler.js";
import { resolveNumericExpr } from "../valueResolver.js";
import { captureSnapshot } from "../snapshots.js";
import { queueHigh } from "../injection.js";
import { storeMessageData } from "../../util/chatStore.js";
import { combatBubble, attachContestToMessage } from "../../ui/combatBubble.js";
import { playRoll, playTierResult } from "../soundFx.js";
import { runEnemyAI } from "../enemyAI.js";
import { makeRng, newSeed } from "./rng.js";
import { contestKey } from "./effects.js";
import { runRound } from "./engine.js";
import { resolveRuleset } from "./registry.js";
import { storyBlock, postPassBlock, chipRows } from "./ledger.js";
import { adjudicateRound } from "./oracle.js";

// ---------- configuration ----------

// The chat's rulesets (chat configuration, outside `data`). The global
// Legacy toggle forces the pre-rework pipeline everywhere during the
// transition.
export function contestRuleset(kind = "clash") {
    const s = gmSettings();
    const rulesets = getContext()?.chatMetadata?.game_manager?.features?.contest || null;
    const rs = resolveRuleset(rulesets, kind);
    if (s.combat_legacy) return { ...rs, legacy: true, preset: "legacy" };
    return rs;
}

// ---------- d.contest (game state: snapshots cover it) ----------

function contestState() {
    const d = stateManager.getData();
    const c = d.contest && typeof d.contest === "object" ? d.contest : {};
    d.contest = {
        active: !!c.active,
        kind: String(c.kind || "clash"),
        round: Math.max(0, Math.trunc(Number(c.round) || 0)),
        party: Array.isArray(c.party) ? c.party.map(String) : [],
        out: c.out && typeof c.out === "object" ? c.out : {},
        tracks: c.tracks && typeof c.tracks === "object" ? c.tracks : {},
    };
    return d.contest;
}

function startContest(kind) {
    const d = stateManager.getData();
    d.contest = { active: true, kind, round: 0, party: [], out: {}, tracks: {} };
    return d.contest;
}

// ---------- state adapter for the pure engine ----------

function findSheet(name) {
    const d = stateManager.getData();
    const char = stateManager.getCharacter(name) || matchName(d.characters || [], name);
    if (char) return { sheet: char, side: "party" };
    const enemy = stateManager.getEnemy(name) || matchName(d.enemies || [], name);
    if (enemy) return { sheet: enemy, side: "enemy" };
    return null;
}

function buildOps() {
    return {
        sheet: findSheet,
        match: matchName,
        max: (sheet, entry) => resolveResourceMax(sheet, entry),
        useSkill: (sheet, name) => stateManager.useSkill(sheet.id, name),
        addItem: (sheet, name, qty) => stateManager.addItem(sheet.id, { name, qty }),
        removeItem: (sheet, name, qty) => stateManager.removeItem(sheet.id, name, qty),
        setStatus: (sheet, fields) => stateManager.updateStatus(sheet.id, fields),
        clearStatus: (sheet, name) => stateManager.removeStatusByName(sheet.id, name),
        priorState: (sheet) => sheet?.state?.mode || null,
        evalMath: resolveNumericExpr,
    };
}

// ---------- actions ----------

function cleanText(v) {
    return String(v ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// The player's own sheet name when they have one (persona or custom label).
function playerActorName() {
    for (const n of playerNames()) {
        const c = stateManager.getCharacter(n);
        if (c) return c.name;
    }
    return playerLabel();
}

const SPEED_ATTR_RE = /dex|agi|reflex|quickness|initiative|haste|speed/i;
function speedHintOf(name) {
    const sheet = findSheet(name)?.sheet;
    const attr = (sheet?.attributes || []).find(a => SPEED_ATTR_RE.test(String(a.name)));
    return attr ? Math.max(0, Math.trunc(Number(attr.value) || 0)) : 0;
}

// Party side: the player first, then the pre-pass's acts for allies who can
// act (no special state, still in the contest, not the player).
export function buildPartyActions(action, plan, contest) {
    const player = playerActorName();
    const out = [{
        who: "party",
        actor: player,
        speed: Number(plan?.combat?.speed) || speedHintOf(player),
        action: cleanText(action).slice(0, 140) || "Hold position",
    }];
    const seen = new Set([contestKey(player)]);
    for (const a of plan?.acts || []) {
        const char = stateManager.getCharacter(a.actor) || matchName(stateManager.getData().characters || [], a.actor);
        if (!char || char.state || contest.out[contestKey(char.name)]) continue;
        const key = contestKey(char.name);
        if (seen.has(key)) continue;
        seen.add(key);
        const title = cleanText(a.title);
        const text = cleanText(a.text);
        out.push({
            who: "party",
            actor: char.name,
            speed: a.speed || speedHintOf(char.name),
            action: [title, text !== title ? text : ""].filter(Boolean).join(" — ").slice(0, 140) || "Act",
        });
    }
    return out;
}

// Enemy side. An EMPTY array is a deliberate no-op round; only null (the
// call failed) degrades to plain attacks.
function buildEnemyActions(raw) {
    const d = stateManager.getData();
    if (Array.isArray(raw)) {
        return raw.map(a => {
            const title = cleanText(a.title);
            const text = cleanText(a.text);
            return { who: "enemy", actor: a.enemy, speed: a.speed || speedHintOf(a.enemy), action: [title, text !== title ? text : ""].filter(Boolean).join(" — ").slice(0, 140) };
        });
    }
    logDebug("contest: opposition unavailable — plain attacks");
    return (d.enemies || []).map(e => ({ who: "enemy", actor: e.name, speed: speedHintOf(e.name), action: "Attack" }));
}

// Degraded path (oracle failed): single-sided generic tiers, NO effects —
// the ledger then tells the tracker to account this round as before.
function fallbackGroups(partyActions, enemyActions) {
    return [...partyActions, ...enemyActions].map(a => ({
        title: `${a.actor}: ${a.action}`.slice(0, 100),
        sides: [{ who: a.who, actor: a.actor, speed: a.speed, action: a.action }],
        tiers: [
            { name: "Critical Failure", chance: 10, outcome: `${a.actor}'s ${a.action} goes badly wrong.`, effects: [] },
            { name: "Failure", chance: 25, outcome: `${a.actor}'s ${a.action} does not work out.`, effects: [] },
            { name: "Success", chance: 50, outcome: `${a.actor}'s ${a.action} works.`, effects: [] },
            { name: "Critical Success", chance: 15, outcome: `${a.actor}'s ${a.action} works better than hoped.`, effects: [] },
        ],
    }));
}

// ---------- commit ----------

// Persists the round's out-states: party members fall through the sheet's
// state slot (dead / ko), enemies leave the scene (archived, restored with
// their last state if they come back). Party members who fled or yielded stay
// out of the contest until it ends.
function commitOutStates(round, contest) {
    const s = gmSettings();
    for (const o of Object.values(round.out || {})) {
        const found = findSheet(o.name);
        if (!found) continue;
        if (found.side === "enemy") {
            stateManager.removeEnemy(found.sheet.id);
            continue;
        }
        if (o.mode === "dead" && s.feature_death !== false) stateManager.setState(found.sheet.id, "dead", o.reason || "fell in combat");
        else if (o.mode === "dead" || o.mode === "ko" || o.mode === "down") stateManager.setState(found.sheet.id, "ko", o.reason || "knocked out in combat");
        else contest.out[contestKey(found.sheet.name)] = o.mode;
    }
}

// Last committed post-pass block, kept in memory in case the gm_contest write
// on the user message is still pending (custom send flows).
let _lastLedger = { userMsgId: -1, post: "" };

// The tracker's <contest_ledger> for the exchange ending at AI message
// `aiMsgId`, or "" when that exchange had no committed contest round. A
// degraded round (the oracle failed, no effects) returns "" too: the tracker
// then accounts it from the <combat_round> lines like the Legacy pipeline.
export function contestLedgerFor(aiMsgId) {
    const chat = getContext()?.chat || [];
    for (let i = Math.min(Number(aiMsgId), chat.length - 1); i >= 0; i--) {
        const m = chat[i];
        if (!m?.is_user) continue;
        if (m.gm_contest) return m.gm_contest.degraded ? "" : String(m.gm_contest.post || "");
        return _lastLedger.userMsgId === i ? _lastLedger.post : "";
    }
    return "";
}

// Swipe/regenerate after a reload: the stored round is re-queued verbatim —
// no re-roll, no re-apply (the AI baseline the swipe restored already holds
// the committed deltas).
export function replayContestRound(stored, userMsgId) {
    if (!stored?.story) return false;
    queueHigh(stored.story);
    if (Array.isArray(stored.chips)) attachContestToMessage(userMsgId, stored.chips);
    _lastLedger = { userMsgId: Number(userMsgId), post: stored.degraded ? "" : String(stored.post || "") };
    return true;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// One contest round for the player action on user message `userMsgId`.
// Returns true when a round was committed.
export async function runContestTurn(action, plan, userMsgId) {
    const s = gmSettings();
    const d = stateManager.getData();
    if (!(d.enemies || []).length) {
        logDebug("contest: no tracked enemies — no round");
        return false;
    }
    const ruleset = contestRuleset("clash");
    let contest = contestState();
    if (!contest.active || contest.kind !== ruleset.kind) contest = startContest(ruleset.kind);

    const bubble = combatBubble.show("Resolving the round...");
    try {
        const partyActions = buildPartyActions(action, plan, contest);
        bubble.showActions(partyActions);

        // Blind by default; a reactive pre-pass judgment hands the enemies the
        // player's move so they answer it.
        const reactive = plan?.combat?.reactive === true;
        const enemyRaw = await runEnemyAI({
            maxActions: Math.max(1, Number(s.combat_max_enemy_actions) || 6),
            ...(reactive ? { playerAction: action } : {}),
        });
        const enemyActions = buildEnemyActions(enemyRaw);
        bubble.addEnemyActions(enemyActions);
        bubble.update("Adjudicating...");

        const stakes = String(ruleset.opts?.stakes || "Health");
        let groups = await adjudicateRound({
            playerAction: action,
            partyActions,
            enemyActions,
            stakes,
            onStream: (partial) => bubble.syncGroups(partial),
        });
        const degraded = !groups;
        if (!groups) groups = fallbackGroups(partyActions, enemyActions);
        bubble.syncGroups(groups);

        // COMMIT — baseline first, on the USER message (see header).
        captureSnapshot(userMsgId);
        const seed = newSeed();
        const participants = [
            ...partyActions.map(a => ({ name: a.actor, side: "party" })),
            ...contest.party.map(name => ({ name, side: "party" })),
            ...(d.enemies || []).map(e => ({ name: e.name, side: "enemy" })),
        ].filter(p => findSheet(p.name));
        const ctx = {
            rng: makeRng(seed),
            ops: buildOps(),
            shape: ruleset.shape,
            turn: ruleset.turn,
            dice: ruleset.dice,
            consequence: ruleset.consequence,
            mutators: ruleset.mutators,
            opts: { ...ruleset.opts, stakes },
            contest,
            participants,
            out: {},
            log: msg => logDebug(`contest: ${msg}`),
        };
        ctx.stakes = sheet => ruleset.shape.stakes(ctx, sheet);
        const round = runRound(ctx, groups);
        for (const g of round.groups) {
            for (const r of g.records) if (r.status === "skipped") logDebug(`contest: effect skipped (${r.reason}) — ${r.kind} "${r.name}" on "${r.target}"`);
        }

        commitOutStates(round, contest);
        contest.round += 1;
        const roundNo = contest.round;
        for (const p of participants) {
            if (p.side === "party" && !contest.party.some(n => contestKey(n) === contestKey(p.name))) contest.party.push(p.name);
        }
        if (round.over) {
            stateManager.getData().contest = { active: false, kind: contest.kind, round: roundNo, party: [], out: {}, tracks: {} };
        }
        stateManager.emitChange("contest_round");

        const story = storyBlock(ruleset.shape, round);
        const post = postPassBlock(round, { degraded, roundNo });
        const chips = chipRows(round);
        storeMessageData(userMsgId, "gm_contest", {
            v: 1,
            kind: ruleset.kind,
            preset: ruleset.preset,
            seed,
            round: roundNo,
            degraded,
            over: round.over,
            groups: groups.map(g => ({ title: g.title, sides: g.sides, tiers: g.tiers.map(t => ({ name: t.name, chance: t.chance, outcome: t.outcome, effects: t.effects })) })),
            results: round.groups.map(g => ({ index: g.index, status: g.status, outcome: g.outcome, records: g.records, fell: g.fell, lines: g.lines })),
            standing: round.standing,
            story,
            post,
            chips,
        });
        _lastLedger = { userMsgId: Number(userMsgId), post: degraded ? "" : post };
        if (story) queueHigh(story);

        // The round is already decided and committed; the bubble only plays
        // it back in resolution order.
        for (const g of round.groups) {
            if (g.status === "interrupted") {
                bubble.resolveGroup(g.index, { name: "Interrupted" });
                continue;
            }
            bubble.startGroupRoll(g.index);
            playRoll(900);
            await wait(900);
            bubble.resolveGroup(g.index, { name: g.outcome.name });
            playTierResult(g.outcome.name);
        }
        await wait(1200);
        attachContestToMessage(userMsgId, chips);
        bubble.done(round.over ? "Contest over." : "Round resolved.");
        logDebug(`contest: round ${roundNo} committed — ${round.groups.length} group(s)${degraded ? " (degraded)" : ""}${round.over ? ", contest over" : ""}`);
        return true;
    } catch (e) {
        console.error("[Game Manager] contest round failed:", e);
        bubble.close(true);
        return false;
    }
}
