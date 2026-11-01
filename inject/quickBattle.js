// Quick battle — fights without the story model. A toggle on the input bar
// (per chat). With it on, a sent message runs the normal pre-turn: router,
// contest round, Ask me, effects committed on the user message. Then the
// generate interceptor cancels the story call and a reply holding the round
// cards takes its place, written as the character's message so the chat keeps
// its user/character rhythm (swipes, rollbacks and the next story turn all see
// a normal exchange).
//
// - Forced round: with quick battle on and live enemies, a message the router
//   judged as no fight still runs a round (the player asked for battle mode).
//   No live enemy = quick battle stands aside and the story generates.
// - The reply's text is the plain-language round (quickReplyText): later
//   story turns read it as what happened. The DOM shows the cards instead.
// - No tracker pass: the round already applied every effect, and there's no
//   story for it to read (postTurn skips gm_quick replies).
// - Swiping the reply generates a real narration of the same round (the
//   round replays, never re-rolls); swiping back shows the cards again.

import { getContext } from "../../../../extensions.js";
import { saveChatConditional } from "../../../../../script.js";
import { getMessageTimeStamp } from "../../../../RossAscends-mods.js";
import { gmSettings, getQuickBattle, setQuickBattle, hasChat } from "../core/features.js";
import { stateManager } from "../core/stateManager.js";
import { logDebug, gmNotify } from "../core/debug.js";
import { quickReplyText } from "../core/contest/ledger.js";
import { captureSnapshot, captureSwipeState } from "../core/snapshots.js";
import { roundCardsEl } from "../ui/roundCard.js";
import { registerAttachmentRestorer } from "../util/messageDom.js";

// The user message whose round ran this turn in quick mode; the interceptor
// consumes it. Never survives a turn (handlePreTurn sets it, the next
// interceptor call takes it).
let _pending = null;

export function quickBattleOn() {
    const s = gmSettings();
    return !!(s.enabled && s.feature_combat && getQuickBattle());
}

function liveEnemies() {
    return (stateManager.getData().enemies || []).filter(e => !e.state).length > 0;
}

// Pre-turn hook (core/triggerWatcher.js), after quick actions and contest
// continuation: no fight planned but quick battle on = a forced fight round.
// Races and other contests already planned are left alone.
export function forceQuickPlan(plan, contestPlanned) {
    if (!quickBattleOn() || contestPlanned || plan?.combat?.engaged) return plan;
    if (!liveEnemies()) {
        logDebug("quickBattle: no live enemies — the story generates normally");
        return plan;
    }
    logDebug("quickBattle: forcing a fight round");
    return {
        transactions: [], warnings: [], relevant: [], notes: [], skills: [], acts: [], rewrite: null,
        ...(plan || {}),
        nothing: false,
        combat: { ...(plan?.combat || {}), engaged: true },
    };
}

export function markQuickRound(userMsgId) {
    _pending = quickBattleOn() ? { userMsgId: Number(userMsgId) } : null;
}

// Part of the shared generate interceptor (inject/interceptor.js). Only a
// fresh send is replaced; swipes, regenerates and continues narrate.
export async function quickInterceptor(_chat, _contextSize, abort, type) {
    const pending = _pending;
    _pending = null;
    if (!pending || (type && type !== "normal")) return false;
    // Only the round of the message being answered now (a stopped send can
    // leave an older one behind).
    const chat = getContext()?.chat || [];
    const msg = chat[pending.userMsgId];
    if (pending.userMsgId !== chat.length - 1 || !msg?.is_user || !msg.gm_contest?.cards) return false;
    abort(true);
    // After ST unblocks the send (the interceptor runs inside Generate).
    setTimeout(() => postQuickReply(pending.userMsgId).catch(e => console.error("[Game Manager] quick battle reply failed:", e)), 0);
    return true;
}

async function postQuickReply(userMsgId) {
    const st = getContext();
    const chat = st.chat;
    const record = chat?.[userMsgId]?.gm_contest;
    if (!record?.cards || userMsgId !== chat.length - 1) return;
    const text = quickReplyText(record.cards, record.round, !!record.over);
    const extra = { api: "manual", model: "quick battle", gen_id: Date.now() };
    const message = {
        name: st.name2 || "Game Master",
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: text,
        extra: { ...extra },
        swipe_id: 0,
        swipes: [text],
        swipe_info: [{ send_date: getMessageTimeStamp(), gen_started: null, gen_finished: null, extra: { ...extra } }],
        // Which swipe holds the cards; a narrated swipe shows its own text.
        gm_quick: { swipe: 0, round: record.round },
    };
    chat.push(message);
    const id = chat.length - 1;
    // Baselines for this reply: the round is already in the state, so a
    // narrated swipe starts from here and swiping back restores it.
    captureSnapshot(id);
    captureSwipeState(id, 0);
    await st.eventSource.emit(st.event_types.MESSAGE_RECEIVED, id, "extension");
    st.addOneMessage(message);
    await st.eventSource.emit(st.event_types.CHARACTER_MESSAGE_RENDERED, id, "extension");
    await saveChatConditional();
    logDebug(`quickBattle: round ${record.round} posted as message ${id}`);
}

// True when message `id` is a quick reply currently showing its cards.
export function isQuickReplyShowing(msg) {
    return !!msg?.gm_quick && Number(msg.swipe_id ?? 0) === Number(msg.gm_quick.swipe ?? 0);
}

// ---------- message view ----------

function renderQuickReply(mesEl, msg) {
    const showing = isQuickReplyShowing(msg);
    const existing = mesEl.querySelector(".gm_quick_reply");
    mesEl.classList.toggle("gm_quick_mes", showing);
    if (!showing) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const id = Number(mesEl.getAttribute("mesid"));
    const record = getContext()?.chat?.[id - 1]?.gm_contest;
    if (!record?.cards) return;
    const box = $("<div>").addClass("gm_quick_reply").append(roundCardsEl(record.cards, { icon: record.icon || "" }));
    if (record.over) box.append($("<div>").addClass("gm_quick_over").text("The fight is over."));
    $(mesEl.querySelector(".mes_text")).after(box);
}

// ---------- input bar ----------

function renderButton() {
    let btn = document.getElementById("gm_quick_battle");
    const s = gmSettings();
    const show = !!(s.enabled && s.feature_combat && hasChat());
    if (!btn) {
        const send = document.getElementById("send_but");
        if (!send) return;
        btn = document.createElement("div");
        btn.id = "gm_quick_battle";
        btn.className = "fa-solid fa-bolt interactable";
        btn.tabIndex = 0;
        btn.addEventListener("click", () => {
            try {
                const on = !getQuickBattle();
                if (!setQuickBattle(on)) return;
                renderButton();
                gmNotify(on ? "Quick battle on: fight rounds skip the story reply." : "Quick battle off.", "info");
            } catch (e) {
                console.error("[Game Manager] quick battle toggle failed:", e);
            }
        });
        send.before(btn);
    }
    const on = show && getQuickBattle();
    btn.style.display = show ? "" : "none";
    btn.classList.toggle("gm_quick_on", on);
    btn.title = on
        ? "Quick battle ON: fight rounds show their result cards without a story reply. Click to turn off."
        : "Quick battle: fight rounds skip the story reply (results only). Click to turn on.";
}

export function initQuickBattle() {
    const st = getContext();
    registerAttachmentRestorer((mesEl, msg) => {
        if (!msg?.gm_quick && !mesEl.querySelector(".gm_quick_reply")) return;
        renderQuickReply(mesEl, msg);
    });
    st.eventSource.on(st.event_types.CHAT_CHANGED, () => {
        _pending = null;
        renderButton();
    });
    stateManager.onChange(() => renderButton());
    renderButton();
}
