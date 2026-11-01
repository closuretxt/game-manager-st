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
import { gmSettings, getContestRulesets } from "../features.js";
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
import { contestKey, trackValue } from "./effects.js";
import { runRoundAsync } from "./engine.js";
import { resolveRuleset, rulesetIsCustom } from "./registry.js";
import { storyBlock, postPassBlock, chipRows, roundCards } from "./ledger.js";
import { adjudicateRound } from "./oracle.js";
import { brainActions, rivalBrainActions } from "./brains.js";
import { hudFighters, hudTurnOrder, hudMeters, hudPushLog } from "./hud.js";
import { runOpposition } from "./opposition.js";
import { racePhase } from "./modules/shape/race.js";

// ---------- configuration ----------

// The chat's rulesets (chat configuration, outside `data`); a chat without
// one follows the drawer's global preset. The global Legacy toggle forces the
// pre-rework pipeline for fights during the transition (the other kinds have
// no legacy pipeline).
export function contestRuleset(kind = "clash") {
    const s = gmSettings();
    const rs = resolveRuleset(getContestRulesets(), kind, s.contest_preset);
    if (s.combat_legacy && kind === "clash") return { ...rs, legacy: true, preset: "legacy" };
    return rs;
}

// The stakes resource name: the chat's, else the shape's own default
// (Health for fights, Stamina for races, none for scored contests).
function stakesNameOf(ruleset) {
    const own = String(ruleset?.opts?.stakes || "").trim();
    if (own) return own;
    const def = ruleset?.shape?.stakesDefault;
    return def === undefined ? "Health" : String(def);
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
        // turn.initiative: name key -> initiative total, rolled once.
        initiative: c.initiative && typeof c.initiative === "object" ? c.initiative : {},
        // Mutator meters (momentum...).
        meters: c.meters && typeof c.meters === "object" ? c.meters : {},
        // HUD round log (core/contest/hud.js): the last rounds' result rows.
        log: Array.isArray(c.log) ? c.log : [],
        // Races / scored contests: the rivals' names (tracked enemies or
        // untracked runners the pre-pass named).
        rivals: Array.isArray(c.rivals) ? c.rivals.map(String) : [],
        // Fights: enemies taken out in earlier rounds (archived), for the
        // story's standing: [{ name, mode }].
        fallen: Array.isArray(c.fallen) ? c.fallen.filter(f => f && f.name) : [],
    };
    return d.contest;
}

function emptyContest(kind, active, round = 0) {
    return { active, kind, round, party: [], out: {}, tracks: {}, initiative: {}, meters: {}, log: [], rivals: [], fallen: [] };
}

function startContest(kind) {
    const d = stateManager.getData();
    d.contest = emptyContest(kind, true);
    return d.contest;
}

// ---------- state adapter for the pure engine ----------

function findSheet(name) {
    const d = stateManager.getData();
    const char = stateManager.getCharacter(name) || matchName(d.characters || [], name);
    if (char) return { sheet: char, side: "party" };
    const enemy = stateManager.getEnemy(name) || matchName(d.enemies || [], name);
    if (enemy) return { sheet: enemy, side: "enemy" };
    // An untracked rival (race / scored contest): a sheet-less stand-in, so
    // its tracks move while resource/status effects on it are skipped.
    const key = contestKey(name);
    const rival = (d.contest?.active ? d.contest.rivals || [] : []).find(n => contestKey(n) === key);
    if (rival) return { sheet: { id: null, name: rival, pseudo: true, resources: [], attributes: [], skills: [], statuses: [], inventory: [] }, side: "enemy" };
    return null;
}

function buildOps() {
    const real = fn => (sheet, ...args) => (sheet?.pseudo ? false : fn(sheet, ...args));
    return {
        sheet: findSheet,
        match: matchName,
        max: (sheet, entry) => resolveResourceMax(sheet, entry),
        useSkill: real((sheet, name) => stateManager.useSkill(sheet.id, name)),
        addItem: real((sheet, name, qty) => stateManager.addItem(sheet.id, { name, qty })),
        removeItem: real((sheet, name, qty) => stateManager.removeItem(sheet.id, name, qty)),
        setStatus: real((sheet, fields) => stateManager.updateStatus(sheet.id, fields)),
        clearStatus: real((sheet, name) => stateManager.removeStatusByName(sheet.id, name)),
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
// act (no special state, still in the contest, not the player). A hotbar
// quick action (core/contest/quick.js) leads the player's declared action;
// the message text follows it unless it is just the quick phrase.
export function buildPartyActions(action, plan, contest) {
    const player = playerActorName();
    const said = cleanText(action);
    const quick = cleanText(plan?.quickAction);
    const declared = quick && said.toLowerCase() !== quick.toLowerCase() ? [quick, said].filter(Boolean).join(" — ") : (said || quick);
    const out = [{
        who: "party",
        actor: player,
        speed: Number(plan?.combat?.speed) || speedHintOf(player),
        action: declared.slice(0, 140) || "Hold position",
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
    // Follow-ups: resolved after the move they follow (engine followOrder).
    const names = out.map(p => p.actor);
    for (const p of out) {
        const a = (plan?.acts || []).find(x => contestKey(x.actor) === contestKey(p.actor));
        const after = a ? followTargetOf(a, p.actor, names) : "";
        if (after) p.after = after;
    }
    return out;
}

// Whose move an ally's act follows up: the router's after="..." first, else
// the wording ("Follow Aaru's shots", "after Kael's strike"). Only another
// party actor of this round counts. "Cover"/"protect" don't: those come first.
const FOLLOW_RE = /\b(?:follow(?:s|ing)?(?:\s+up)?(?:\s+on)?|after|finish(?:es|ing)?\s+off)\s+(.+)/i;
function followTargetOf(act, self, names) {
    const others = names.filter(n => contestKey(n) !== contestKey(self));
    if (act.after) return matchName(others.map(n => ({ name: n })), act.after)?.name || "";
    const m = FOLLOW_RE.exec(`${act.title || ""} ${act.text || ""}`);
    if (!m) return "";
    const rest = m[1].toLowerCase();
    return others.find(n => rest.startsWith(n.toLowerCase())) || "";
}

// Stakes left, 0..1, for the scripted brains; null when the sheet has none.
function stakesRatio(stakesName) {
    return (sheet) => {
        const entry = matchName(sheet?.resources || [], stakesName);
        if (!entry) return null;
        const max = resolveResourceMax(sheet, entry);
        const min = Number.isFinite(+entry.min) ? +entry.min : 0;
        if (!Number.isFinite(max) || max <= min) return null;
        return Math.max(0, Math.min(1, ((Number(entry.value) || 0) - min) / (max - min)));
    };
}

// Scripted enemy actions (core/contest/brains.js): 0 calls.
function brainEnemyRaw(contest, stakes, max) {
    const d = stateManager.getData();
    const enemies = (d.enemies || []).filter(e => !e.state);
    const party = (d.characters || []).filter(c => !c.state && !contest.out[contestKey(c.name)]);
    return brainActions(enemies, party, stakesRatio(stakes), max);
}

// ---------- rivals (race / scored contest) ----------

// Adds the pre-pass's rival names to the contest (once each). Party members
// never become rivals: a race between party members runs them all on the
// party side.
function mergeRivals(contest, names) {
    const d = stateManager.getData();
    const have = new Set(contest.rivals.map(contestKey));
    for (const raw of names || []) {
        const name = cleanText(raw).slice(0, 60);
        if (!name || have.has(contestKey(name))) continue;
        if (stateManager.getCharacter(name) || matchName(d.characters || [], name)) continue;
        const enemy = stateManager.getEnemy(name) || matchName(d.enemies || [], name);
        contest.rivals.push(enemy ? enemy.name : name);
        have.add(contestKey(name));
    }
}

// Rivals still in the contest: [{ name, sheet }] (sheet = tracked enemy or
// the sheet-less stand-in).
function activeRivals(contest) {
    return (contest.rivals || [])
        .filter(n => !contest.out[contestKey(n)])
        .map(n => findSheet(n))
        .filter(f => f && f.side === "enemy" && !f.sheet.state)
        .map(f => ({ name: f.sheet.name, sheet: f.sheet }));
}

// Everyone in the contest this round: [{ name, side }]. Fights take every
// tracked enemy; races and scored contests their rivals; challenges only
// the party.
function contestParticipants(contest, shape, partyActions = []) {
    const d = stateManager.getData();
    const opponents = shape?.rivals
        ? (contest.rivals || []).map(name => ({ name, side: "enemy" }))
        : shape?.id === "shape.clash" ? (d.enemies || []).map(e => ({ name: e.name, side: "enemy" })) : [];
    return [
        ...partyActions.map(a => ({ name: a.actor, side: "party" })),
        ...contest.party.map(name => ({ name, side: "party" })),
        ...opponents,
    ].filter(p => findSheet(p.name));
}

// The shape's, the turn module's and the mutators' view of the contest for
// the oracle and the rivals' call (numbers allowed: neither is the story).
// A plain fight has none, so its oracle prompt stays as it was.
function contestStateLines(ctx) {
    const lines = [];
    for (const src of [ctx.shape, ctx.turn, ...(ctx.mutators || [])]) {
        if (typeof src?.oracleState !== "function") continue;
        try {
            lines.push(...(src.oracleState(ctx) || []));
        } catch (e) {
            logDebug(`contest: ${src.id} oracleState failed — ${e?.message || e}`);
        }
    }
    return lines;
}

// Scripted rival tactics (0 calls): race styles read the phase and who runs
// ahead; scored styles alternate safe / showy.
function rivalBrainRaw(kind, rivals, ctx, max) {
    const ahead = (name) => {
        const own = trackValue(ctx.contest, name, "progress");
        let best = null, gap = Infinity;
        for (const p of ctx.participants || []) {
            const g = trackValue(ctx.contest, p.name, "progress") - own;
            if (g > 0 && g < gap) { gap = g; best = p.name; }
        }
        return best;
    };
    return rivalBrainActions(kind, rivals, { phase: kind === "race" ? racePhase(ctx) : "", ahead, round: ctx.contest.round }, max);
}

// Enemy side. An EMPTY array is a deliberate no-op round; only null (the
// call failed) degrades to the scripted brains.
function buildEnemyActions(raw, fallback) {
    let list = raw;
    if (!Array.isArray(list)) {
        logDebug("contest: opposition unavailable — scripted brains");
        list = fallback();
    }
    return list.map(a => {
        const title = cleanText(a.title);
        const text = cleanText(a.text);
        return { who: "enemy", actor: a.enemy, speed: a.speed || speedHintOf(a.enemy), action: [title, text !== title ? text : ""].filter(Boolean).join(" — ").slice(0, 140) || "Attack" };
    });
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
// out of the contest until it ends. Outside fights a rival who drops out of a
// race only leaves the contest; a tracked one leaves the scene only if dead.
function commitOutStates(round, contest, shape) {
    const s = gmSettings();
    const fight = shape?.id === "shape.clash";
    for (const o of Object.values(round.out || {})) {
        const found = findSheet(o.name);
        if (!found) continue;
        if (found.side === "enemy") {
            if (!found.sheet.pseudo && (fight || o.mode === "dead")) {
                stateManager.removeEnemy(found.sheet.id);
                // Archived enemies leave the participants; the standing
                // still names them so the story does not bring them back.
                contest.fallen = (contest.fallen || []).filter(f => contestKey(f.name) !== contestKey(found.sheet.name));
                contest.fallen.push({ name: found.sheet.name, mode: o.mode });
            } else contest.out[contestKey(found.sheet.name)] = o.mode;
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
    if (Array.isArray(stored.chips) || stored.cards) attachContestToMessage(userMsgId, stored.chips, stored.cards || null, stored.icon || "");
    _lastLedger = { userMsgId: Number(userMsgId), post: stored.degraded ? "" : String(stored.post || "") };
    return true;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
// "Ask me": how long a mid-roll question waits before it auto-picks. The
// story generation is on hold meanwhile (we are inside the awaited GAC).
const CONTEST_ASK_MS = 20000;

// ---------- HUD (ui/mainPanel.js, Enemies tab) ----------

export function contestActive() {
    const c = stateManager.getData().contest;
    return !!c?.active;
}

// The running contest's kind, or null.
export function activeContestKind() {
    const c = stateManager.getData().contest;
    return c?.active ? String(c.kind || "clash") : null;
}

// Names the hotbar's targeted quick actions can pick on the opposing side.
export function contestOpponents() {
    const d = stateManager.getData();
    const c = d.contest;
    if (!c?.active) return [];
    if (String(c.kind || "clash") === "clash") return (d.enemies || []).filter(e => !e.state).map(e => e.name);
    return activeRivals(contestState()).map(r => r.name);
}

// Ends the contest by hand (HUD End button). The enemies stay in the scene:
// archiving them is the player's call. A plain state edit like any other
// manual change; the next message's snapshot covers it.
export function endContest() {
    const c = contestState();
    if (!c.active) return false;
    stateManager.getData().contest = emptyContest(c.kind, false, c.round);
    stateManager.emitChange("contest_end");
    return true;
}

// Everything the HUD draws, from the live state and the chat's ruleset.
export function contestHud() {
    const d = stateManager.getData();
    const contest = d.contest;
    if (!contest?.active) return null;
    const ruleset = contestRuleset(contest.kind || "clash");
    const stakesName = stakesNameOf(ruleset);
    const stakesOf = (sheet) => {
        if (!stakesName) return null;
        const entry = matchName(sheet?.resources || [], stakesName);
        if (!entry) return null;
        const max = resolveResourceMax(sheet, entry);
        return { value: Number(entry.value) || 0, min: Number.isFinite(+entry.min) ? +entry.min : 0, max: Number(max) };
    };
    const names = {};
    for (const sh of [...(d.characters || []), ...(d.enemies || [])]) names[contestKey(sh.name)] = sh.name;
    for (const n of contest.party || []) names[contestKey(n)] = names[contestKey(n)] || n;
    // Races, scored contests and challenges draw their own rows (progress,
    // scores, clocks); fights draw the stakes bars.
    let fighters;
    if (typeof ruleset.shape?.hudRows === "function") {
        const view = { contest: contestState(), opts: { ...ruleset.opts, stakes: stakesName }, ops: buildOps(), shape: ruleset.shape, mutators: ruleset.mutators, out: {} };
        view.participants = contestParticipants(view.contest, ruleset.shape);
        if (!view.participants.some(p => p.side === "party")) {
            view.participants.unshift(...(d.characters || []).filter(c => !c.state).map(c => ({ name: c.name, side: "party" })));
        }
        view.stakes = sheet => ruleset.shape.stakes(view, sheet);
        fighters = ruleset.shape.hudRows(view);
    } else {
        fighters = hudFighters(contest, d.characters || [], d.enemies || [], stakesOf);
    }
    return {
        kind: ruleset.kind,
        round: Math.max(0, Math.trunc(Number(contest.round) || 0)),
        preset: ruleset.preset,
        custom: rulesetIsCustom(ruleset),
        legacy: ruleset.legacy,
        shape: ruleset.shape,
        fighters,
        order: hudTurnOrder(contest, names),
        // Participants for meters kept per party member (limit gauges).
        meters: hudMeters({ contest, opts: ruleset.opts || {}, participants: (contest.party || []).map(name => ({ name, side: "party" })) }, ruleset.mutators),
        log: Array.isArray(contest.log) ? contest.log : [],
    };
}

// One contest round for the player action on user message `userMsgId`.
// Returns true when a round was committed.
// `kind`: clash (needs tracked enemies) | race | scores | challenge.
export async function runContestTurn(action, plan, userMsgId, kind = "clash") {
    const s = gmSettings();
    const d = stateManager.getData();
    const fight = kind === "clash";
    if (fight && !(d.enemies || []).length) {
        logDebug("contest: no tracked enemies — no round");
        return false;
    }
    const ruleset = contestRuleset(kind);
    const shape = ruleset.shape;
    if (!shape) return false;
    let contest = contestState();
    if (!contest.active || contest.kind !== ruleset.kind) contest = startContest(ruleset.kind);
    if (shape.rivals) mergeRivals(contest, plan?.contest?.rivals);

    const bubble = combatBubble.show("Resolving the round...");
    try {
        const partyActions = buildPartyActions(action, plan, contest);
        bubble.showActions(partyActions);

        // One ctx for the whole round: the rivals' call and the oracle read
        // the shape's view of it; the engine resolves with it.
        const stakes = stakesNameOf(ruleset);
        const seed = newSeed();
        const ctx = {
            rng: makeRng(seed),
            ops: buildOps(),
            shape,
            turn: ruleset.turn,
            dice: ruleset.dice,
            consequence: ruleset.consequence,
            mutators: ruleset.mutators,
            opts: { ...ruleset.opts, stakes },
            contest,
            participants: contestParticipants(contest, shape, partyActions),
            // Actor -> the party member whose move they follow up this round.
            follows: Object.fromEntries(partyActions.filter(p => p.after).map(p => [p.actor, p.after])),
            roundNo: contest.round + 1,
            out: {},
            log: msg => logDebug(`contest: ${msg}`),
        };
        ctx.stakes = sheet => shape.stakes(ctx, sheet);
        const stateLines = contestStateLines(ctx);
        // Rules the turn module and the mutators add to the oracle prompt
        // (duel stances, range bands, limit gauges...).
        const rules = [ruleset.turn, ...(ruleset.mutators || [])].flatMap(m => (Array.isArray(m?.oracleRules) ? m.oracleRules : []));

        // Blind by default; a reactive pre-pass judgment hands the enemies the
        // player's move so they answer it. opts.opposition = "brains" skips
        // the call for scripted behaviors (3.7). Races and scored contests
        // ask their rivals instead; a challenge has no opposing side.
        const maxActions = Math.max(1, Number(s.combat_max_enemy_actions) || 6);
        const brains = ruleset.opts?.opposition === "brains";
        // Player-facing turns: no opposition call; the oracle plays the
        // opponents from their sheets (bystanders) inside the party's groups.
        const noOpposition = ruleset.turn?.opposition === false;
        const bystanders = !noOpposition ? []
            : fight ? (d.enemies || []).filter(e => !e.state).map(e => e.name)
                : shape.opposition ? activeRivals(contest).map(r => r.name) : [];
        let enemyRaw, fallback;
        if (noOpposition) {
            fallback = () => [];
            enemyRaw = [];
        } else if (fight) {
            const reactive = plan?.combat?.reactive === true;
            fallback = () => brainEnemyRaw(contest, stakes, maxActions);
            enemyRaw = brains ? fallback() : await runEnemyAI({
                maxActions,
                ...(reactive ? { playerAction: action } : {}),
            });
        } else {
            const rivals = shape.opposition ? activeRivals(contest) : [];
            fallback = () => rivalBrainRaw(kind, rivals, ctx, maxActions);
            enemyRaw = !rivals.length ? [] : brains ? fallback() : await runOpposition({ shape, rivals, stateLines, maxActions });
        }
        const enemyActions = buildEnemyActions(enemyRaw, fallback);
        bubble.addEnemyActions(enemyActions);
        bubble.update("Adjudicating...");

        // Dice modules that roll from oracle inputs (d20...) turn them into
        // display odds, so the bubble's bars mean something.
        const annotate = (gs) => {
            if (typeof ruleset.dice?.annotate === "function") for (const g of gs || []) ruleset.dice.annotate(g, ruleset.opts, resolveNumericExpr);
            return gs;
        };
        let groups = await adjudicateRound({
            playerAction: action,
            partyActions,
            enemyActions,
            stakes,
            dice: ruleset.dice,
            shape: fight ? null : shape,
            stateLines,
            rules,
            opts: ruleset.opts,
            bystanders,
            untracked: (contest.rivals || []).filter(n => findSheet(n)?.sheet?.pseudo),
            onStream: (partial) => bubble.syncGroups(annotate(partial)),
        });
        const degraded = !groups;
        if (!groups) groups = fallbackGroups(partyActions, enemyActions);
        bubble.syncGroups(annotate(groups));

        // COMMIT — baseline first, on the USER message (see header).
        captureSnapshot(userMsgId);
        const participants = ctx.participants;
        // The bubble plays each group back as it resolves (in resolution
        // order, with the dice module's numbers in words), so an "Ask me"
        // question for a later group comes after the earlier ones are shown.
        const die = { icon: ruleset.dice?.icon || "fa-dice", sides: ruleset.dice?.sides || 0 };
        let notesShown = false;
        const onGroup = async (g) => {
            if (!notesShown) {
                notesShown = true;
                bubble.setNotes(ctx.notes);
            }
            const card = roundCards({ groups: [g] }).groups[0];
            if (g.status === "interrupted") {
                bubble.resolveGroup(g.index, { name: "Interrupted", card });
                return;
            }
            bubble.startGroupRoll(g.index, die);
            playRoll(900);
            await wait(900);
            bubble.resolveGroup(g.index, { name: g.outcome.name, face: g.outcome.face, icon: die.icon, card });
            playTierResult(g.outcome.name);
        };
        const askMe = ruleset.opts?.choices !== "auto";
        const round = await runRoundAsync(ctx, groups, { onGroup, ...(askMe ? { ask: q => bubble.ask(q, CONTEST_ASK_MS) } : {}) });
        for (const g of round.groups) {
            for (const r of g.records) if (r.status === "skipped") logDebug(`contest: effect skipped (${r.reason}) — ${r.kind} "${r.name}" on "${r.target}"`);
        }

        commitOutStates(round, contest, shape);
        contest.round += 1;
        const roundNo = contest.round;
        for (const p of participants) {
            if (p.side === "party" && !contest.party.some(n => contestKey(n) === contestKey(p.name))) contest.party.push(p.name);
        }
        const story = storyBlock(ruleset.shape, round);
        const post = postPassBlock(round, { degraded, roundNo });
        const chips = chipRows(round, ruleset.dice?.icon || "");
        const cards = roundCards(round);
        contest.log = hudPushLog(contest.log, roundNo, chips, cards);
        if (round.over) {
            stateManager.getData().contest = emptyContest(contest.kind, false, roundNo);
        }
        stateManager.emitChange("contest_round");

        storeMessageData(userMsgId, "gm_contest", {
            v: 1,
            kind: ruleset.kind,
            preset: ruleset.preset,
            seed,
            round: roundNo,
            degraded,
            over: round.over,
            groups: groups.map(g => ({ title: g.title, sides: g.sides, roll: g.roll || null, tiers: g.tiers.map(t => ({ name: t.name, chance: t.chance, outcome: t.outcome, effects: t.effects })) })),
            results: round.groups.map(g => ({ index: g.index, status: g.status, outcome: g.outcome, records: g.records, fell: g.fell, lines: g.lines, notes: g.notes })),
            notes: round.notes,
            standing: round.standing,
            story,
            post,
            chips,
            cards,
            icon: die.icon,
        });
        _lastLedger = { userMsgId: Number(userMsgId), post: degraded ? "" : post };
        if (story) queueHigh(story);

        // Round notes that came after the first group (clocks, phases).
        bubble.setNotes(round.notes);
        await wait(1200);
        attachContestToMessage(userMsgId, chips, cards, die.icon);
        bubble.done(round.over ? "Contest over." : "Round resolved.");
        logDebug(`contest: round ${roundNo} committed — ${round.groups.length} group(s)${degraded ? " (degraded)" : ""}${round.over ? ", contest over" : ""}`);
        return true;
    } catch (e) {
        console.error("[Game Manager] contest round failed:", e);
        bubble.close(true);
        return false;
    }
}
