// Router heat — lets the pre-pass router sleep through calm stretches. Hot
// (default) = every fresh action is judged by the router LLM as usual. Cold =
// the call is skipped and the turn runs on what needs no router: hotbar quick
// actions, a running contest's next round, quick battle's forced round.
//
// - Who switches it: the input-bar button (either way) and the post-pass
//   tracker (<router state="cold|hot"/>, any time — it reads every reply).
//   Opt-in: the "Router heat" setting (off = always hot, no button, no
//   tracker rule). The Interface drawer can hide just the button.
// - Wakes on its own (the router judges THAT action and stays hot): a live
//   enemy that was not there at the previous cold turn, a tracked skill or
//   shared resource named in the action, or an obvious fight/trade verb.
//   Enemies already present never wake it, and quick battle doesn't either.
// - State lives in the chat's features bucket (core/features.js), so a
//   swipe rollback never flips it.

import { getContext } from "../../../../extensions.js";
import { gmSettings, getRouterCold, setRouterCold, hasChat } from "../core/features.js";
import { stateManager } from "../core/stateManager.js";
import { logDebug, gmNotify } from "../core/debug.js";

// Plain fight/trade verbs: an action like this needs a roll or a payment
// judged, so the router wakes for it. Kept short on purpose — a missed wake
// costs one unjudged turn, a false one costs a router call.
const WAKE_RE = /\b(attack|attacks|attacking|strike|stab|slash|shoot|shoots|punch|kick|ambush|charge at|swing at|fire at|cast|draw (?:my|his|her|their) (?:sword|blade|gun|weapon|bow)|buy|buys|purchase|pay|pays|sell|sells|steal|steals|haggle|bribe)\b/i;

function liveEnemyIds() {
    return (stateManager.getData().enemies || []).filter(e => !e.state).map(e => String(e.id));
}

// Router heat is opt-in (settings: router_heat). Off = always hot, no button,
// no tracker rule — a chat left cold keeps its flag but it's ignored.
export function routerHeatOn() {
    const s = gmSettings();
    return !!(s.enabled && s.pre_pass && s.router_heat);
}

export function routerCold() {
    return routerHeatOn() && !!getRouterCold();
}

// Why a cold router should judge this action, or "" (stays cold).
// `hits` = detectTriggers(action) (tracked skill / shared resource names).
export function routerWakeReason(action, hits = []) {
    const seen = new Set(getRouterCold()?.seen || []);
    const fresh = (stateManager.getData().enemies || []).find(e => !e.state && !seen.has(String(e.id)));
    if (fresh) return `${fresh.name} appeared`;
    if (hits.length) return `"${hits[0].name}" named`;
    const m = String(action || "").match(WAKE_RE);
    return m ? `"${m[0]}"` : "";
}

// A cold turn went by: enemies present now are no longer "new".
export function noteColdTurn() {
    if (getRouterCold()) setRouterCold(true, liveEnemyIds());
}

// Switches the router; returns true when the state changed.
export function setRouterHeat(hot) {
    const cold = !!getRouterCold();
    if (cold === !hot) return false;
    if (!setRouterCold(!hot, liveEnemyIds())) return false;
    renderButton();
    logDebug(`routerHeat: router ${hot ? "hot" : "cold"}`);
    return true;
}

// The tracker's call (core/agentRunner.js): <router state="cold|hot"/>.
// Returns "hot" / "cold" when it switched the router, else "".
export function applyRouterTag(reply) {
    if (!routerHeatOn()) return "";
    const m = String(reply || "").match(/<router\b[^>]*\bstate\s*=\s*["']?(hot|cold)\b/i);
    if (!m) return "";
    const state = m[1].toLowerCase();
    return setRouterHeat(state === "hot") ? state : "";
}

// ---------- input bar ----------

function renderButton() {
    let btn = document.getElementById("gm_router_heat");
    const show = routerHeatOn() && gmSettings().ui_router_button !== false && hasChat();
    if (!btn) {
        const send = document.getElementById("send_but");
        if (!send) return;
        btn = document.createElement("div");
        btn.id = "gm_router_heat";
        btn.className = "interactable";
        btn.tabIndex = 0;
        btn.addEventListener("click", () => {
            try {
                const hot = !!getRouterCold();
                if (!setRouterHeat(hot)) return;
                gmNotify(hot ? "Router hot: every action is judged again." : "Router cold: actions skip the pre-pass until it wakes.", "info");
            } catch (e) {
                console.error("[Game Manager] router heat toggle failed:", e);
            }
        });
        // Left of quick battle when it's there, else of the send button.
        (document.getElementById("gm_quick_battle") || send).before(btn);
    }
    const cold = show && !!getRouterCold();
    btn.style.display = show ? "" : "none";
    btn.className = `interactable fa-solid ${cold ? "fa-snowflake gm_router_cold" : "fa-fire"}`;
    btn.title = cold
        ? "Router COLD: actions skip the pre-pass (no roll/transaction judging). It wakes on new enemies, named skills or fight/trade actions, or when the GM says so. Click to make it hot."
        : "Router HOT: every action is judged by the pre-pass. Click to let it sleep until something happens.";
}

export function initRouterHeat() {
    const st = getContext();
    st.eventSource.on(st.event_types.CHAT_CHANGED, () => renderButton());
    stateManager.onChange(() => renderButton());
    renderButton();
}
