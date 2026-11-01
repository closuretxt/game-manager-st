// Bonds, message placement (plans/bonds-v2.md §11). Instead of the low
// block, each character's bond (stage + role note + open threads) rides as a
// visible line attached to the AI message whose post-pass changed it, and
// stays in the prompt until that message scrolls out of context.
//
// - The post-pass stores the text on the message, per swipe
//   (msg.gm_bond = {swipeId: text}), and it is shown under the message.
// - ST's generate interceptor (manifest "generate_interceptor") splices it
//   into the prompt as a narrator entry right after its message. The array
//   ST hands us is a per-generation copy, filtered and regexed, BEFORE
//   context trimming: the saved chat is never touched, and the line leaves
//   the prompt together with its message. Chat Completion sends narrator
//   entries as role "system" (openai.js setOpenAIMessages).
// - A separate entry, never text appended to the AI message: appended text
//   would teach the story model to write these lines itself.
//
// Interceptors are skipped on ST dry runs, so the prompt itemizer / token
// counter don't show the line.

import { getContext } from "../../../../extensions.js";
import { system_message_types } from "../../../../../script.js";
import { gmSettings } from "../core/features.js";
import { logDebug } from "../core/debug.js";
import { stateManager, playerNames } from "../core/stateManager.js";
import { bondConfig, bondNeedsAttach, bondStoryText } from "../core/bonds.js";
import { isMentioned } from "../core/rosterRotation.js";
import { storeMessageData } from "../util/chatStore.js";
import { onMessageRendered, registerAttachmentRestorer } from "../util/messageDom.js";

const INTERCEPTOR = "gmBondsInterceptor"; // must match manifest.json

function personaName() {
    return String(getContext()?.name1 || "").trim() || "the player";
}

function placementOn() {
    const s = gmSettings();
    if (!s.enabled || !s.feature_injection || !s.feature_bonds) return false;
    const cfg = bondConfig(stateManager.getData());
    return cfg.inject && cfg.placement === "message" && cfg.defs.length > 0;
}

// Post-pass (after the tracker's tags and the stage review): builds the line
// for message `now` from every character whose bond changed this pass, or
// who is in the exchange with their last line long gone. A rerun that
// changes nothing clears this swipe's old line.
export function attachBondLines(now, exchangeText) {
    try {
        const msg = getContext()?.chat?.[now];
        if (!msg || msg.is_user) return;
        const parts = [];
        const ids = [];
        if (placementOn()) {
            const d = stateManager.getData();
            const user = personaName();
            const holders = stateManager.bondHolders(playerNames())
                .filter(c => c.bond && c.state?.mode !== "dead")
                .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
            for (const c of holders) {
                if (!bondNeedsAttach(d, c, now, isMentioned(exchangeText, c.name, c.aliases))) continue;
                const text = bondStoryText(d, c, user);
                if (!text) continue;
                parts.push(`[${text}]`);
                ids.push(c.id);
            }
        }
        const swipe = String(msg.swipe_id ?? 0);
        const store = msg.gm_bond && typeof msg.gm_bond === "object" ? { ...msg.gm_bond } : {};
        if (parts.length) store[swipe] = parts.join("\n");
        else if (store[swipe]) delete store[swipe];
        else return;
        storeMessageData(now, "gm_bond", store);
        stateManager.markBondsAttached(ids, now);
        onMessageRendered(now, el => renderInto(el, msg));
    } catch (e) {
        logDebug("bondLine: attach failed:", e?.message || e);
    }
}

// ---------- prompt ----------

async function interceptor(chat, _contextSize, _abort, type) {
    try {
        if (!placementOn() || !Array.isArray(chat)) return;
        // Backwards, so each splice leaves the indexes still to visit alone.
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            const text = m && !m.is_user ? m.gm_bond?.[String(m.swipe_id ?? 0)] : "";
            if (!text) continue;
            // Continue = the last entry is the reply being extended: nothing
            // may come after it.
            if (type === "continue" && i === chat.length - 1) continue;
            chat.splice(i + 1, 0, {
                name: "Note",
                is_user: false,
                is_system: false,
                send_date: m.send_date,
                mes: String(text),
                index: m.index,
                extra: { type: system_message_types.NARRATOR },
            });
        }
    } catch (e) {
        console.error("[Game Manager] bonds interceptor failed:", e);
    }
}

// ---------- message view ----------

function renderInto(mesEl, msg) {
    const existing = mesEl.querySelector(".gm_bond_line");
    const text = !msg?.is_user ? msg?.gm_bond?.[String(msg?.swipe_id ?? 0)] : "";
    if (existing && existing.dataset.text === (text || "")) return;
    existing?.remove();
    if (!text) return;
    const target = mesEl.querySelector(".mes_text");
    if (!target) return;
    const box = $("<details>").addClass("gm_bond_line").attr("data-text", text);
    box.append($("<summary>").append(
        $("<i>").addClass("fa-solid fa-heart-circle-check"),
        $("<span>").text(" Bonds · in the story's context"),
    ));
    const body = $("<div>").addClass("gm_bond_line_body");
    for (const line of String(text).split("\n")) body.append($("<div>").text(line));
    $(target).after(box.append(body));
}

export function initBondLines() {
    globalThis[INTERCEPTOR] = interceptor;
    registerAttachmentRestorer((mesEl, msg) => {
        if (!msg?.gm_bond && !mesEl.querySelector(".gm_bond_line")) return;
        renderInto(mesEl, msg);
    });
}
