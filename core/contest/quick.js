// Quick actions (plans/combat-modules.md 3.6): the hotbar's basic contest
// actions. A click stores the intent as PENDING (one per actor, so allies can
// be commanded too) and drops an editable phrase into the input bar only when
// it is empty. The next fresh player message consumes every pending intent:
// it forces a contest round even when the pre-pass judged none, and the
// intents replace the pre-pass's guesses for those actors.
// In memory only: a reload or chat switch forgets them (nothing was sent).

import { contestKey } from "./effects.js";

let _quickPending = [];

// "Strike Goblin A" / "Seraphina: Defend Kael". Targets are optional.
export function quickPhrase(intent) {
    const what = [intent?.action, intent?.target].filter(Boolean).join(" ");
    return intent?.isPlayer ? what : `${intent?.actor}: ${what}`;
}

export function setQuickAction(intent) {
    if (!intent?.actor || !intent?.action) return;
    const key = contestKey(intent.actor);
    _quickPending = _quickPending.filter(i => contestKey(i.actor) !== key);
    _quickPending.push({ actor: intent.actor, action: intent.action, target: intent.target || "", isPlayer: !!intent.isPlayer });
}

export function clearQuickActions() {
    _quickPending = [];
}

export function quickActions() {
    return _quickPending.slice();
}

export function takeQuickActions() {
    const out = _quickPending;
    _quickPending = [];
    return out;
}

// Folds the intents into the pre-pass plan (pure): the round runs, the
// player's intent leads their declared action, allies' intents become acts.
// `kind` = the running contest's kind: fights force <combat>, the other
// kinds force a round of that contest.
export function applyQuickActions(plan, intents, kind = "clash") {
    if (!Array.isArray(intents) || !intents.length) return plan;
    const p = plan && typeof plan === "object" ? plan : {};
    p.nothing = false;
    if (kind === "clash") p.combat = { ...(p.combat || {}), engaged: true };
    else p.contest = { ...(p.contest || {}), kind, rivals: p.contest?.rivals || [], round: true };
    const acts = Array.isArray(p.acts) ? p.acts.slice() : [];
    for (const it of intents) {
        const what = [it.action, it.target].filter(Boolean).join(" ");
        if (it.isPlayer) {
            p.quickAction = what;
            continue;
        }
        const key = contestKey(it.actor);
        const act = { actor: it.actor, speed: 0, title: it.action, text: what, target: it.target || "" };
        const i = acts.findIndex(a => contestKey(a.actor) === key);
        if (i >= 0) acts[i] = { ...act, speed: acts[i].speed || 0 };
        else acts.push(act);
    }
    p.acts = acts;
    return p;
}

// A running race / scored contest / challenge continues on every player
// message unless the router said otherwise (<contest round="false"/>,
// <contest_end/>, or a fight that takes over). Fights keep their own gate:
// they run only when the router judges the action engages the enemies.
export function continueContestPlan(plan, activeKind) {
    if (!activeKind || activeKind === "clash") return plan;
    const p = plan && typeof plan === "object" ? plan : {};
    if (p.contestEnd || p.combat?.engaged || p.contest?.kind || p.contest?.round === false) return p;
    p.nothing = false;
    p.contest = { kind: activeKind, rivals: [], round: true };
    return p;
}

// The contest kind this plan runs a round of (fights excluded), or null.
export function plannedContestKind(plan) {
    const c = plan?.contest;
    if (!c?.kind || c.kind === "clash" || c.round === false) return null;
    return String(c.kind);
}
