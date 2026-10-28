// Message log — the post-pass notifications, also kept under the AI message
// that caused them: a collapsible "Game Master · N changes" line after the
// message text, per swipe, saved with the chat (msg.gm_log = {swipeId: lines}).
//
// runAgentPass opens a log (beginMessageLog), ui/notifications.js copies every
// line it pops up into it (logNotification), and the pass commits it when it
// ends. Lines are stored as plain tokens ({c: class, t: text}), never HTML —
// a chat file is user data and is rebuilt with .text() only.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "../core/constants.js";
import { storeMessageData } from "../util/chatStore.js";
import { onMessageRendered, registerAttachmentRestorer } from "../util/messageDom.js";

const HL_CLASSES = new Set(["gm_n_name", "gm_n_pos", "gm_n_neg", "gm_n_val", "gm_n_dim"]);
let _target = null;
let _lines = [];

const attachOn = () => !!extension_settings[extensionName]?.notify_attach;

export function beginMessageLog(mesId) {
    _target = Number.isFinite(Number(mesId)) ? Number(mesId) : null;
    _lines = [];
}

// Notification HTML (built from escaped values + highlight spans) -> tokens.
export function tokenize(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const tokens = [];
    for (const node of doc.body.firstChild?.childNodes || []) {
        if (node.nodeType === 3) tokens.push({ t: node.textContent });
        else if (node.nodeType === 1) {
            const cls = [...node.classList].find(c => HL_CLASSES.has(c));
            tokens.push(cls ? { c: cls, t: node.textContent } : { t: node.textContent });
        }
    }
    return tokens.filter(x => x.t);
}

export function logNotification(html) {
    if (_target === null || !attachOn()) return;
    try {
        const tokens = tokenize(String(html ?? ""));
        if (tokens.length) _lines.push(tokens);
    } catch { /* never break a notification */ }
}

export function commitMessageLog() {
    const id = _target;
    const lines = _lines;
    _target = null;
    _lines = [];
    if (id === null || !attachOn()) return;
    const msg = getContext()?.chat?.[id];
    if (!msg || msg.is_user) return;
    const log = msg.gm_log && typeof msg.gm_log === "object" ? { ...msg.gm_log } : {};
    const swipe = String(msg.swipe_id ?? 0);
    // A rerun that changed nothing clears this swipe's old log.
    if (lines.length) log[swipe] = lines;
    else if (log[swipe]) delete log[swipe];
    else return;
    storeMessageData(id, "gm_log", log);
    onMessageRendered(id, el => renderInto(el, msg));
}

function buildLog(lines) {
    const box = $("<details>").addClass("gm_msg_log");
    box.append($("<summary>").append(
        $("<i>").addClass("fa-solid fa-dice-d20"),
        $("<span>").text(` Game Master · ${lines.length} change${lines.length === 1 ? "" : "s"}`),
    ));
    const body = $("<div>").addClass("gm_msg_log_body");
    for (const tokens of lines) {
        const line = $("<div>").addClass("gm_msg_log_line");
        for (const tok of Array.isArray(tokens) ? tokens : []) {
            const span = $("<span>").text(String(tok?.t ?? ""));
            if (HL_CLASSES.has(tok?.c)) span.addClass(tok.c);
            line.append(span);
        }
        body.append(line);
    }
    return box.append(body);
}

// Idempotent: keeps the element when it already shows this swipe's log,
// rebuilds it after a swipe, removes it when the swipe has none.
export function renderInto(mesEl, msg) {
    const existing = mesEl.querySelector(".gm_msg_log");
    const swipe = String(msg?.swipe_id ?? 0);
    const lines = attachOn() && !msg?.is_user ? msg?.gm_log?.[swipe] : null;
    const key = lines?.length ? `${swipe}:${lines.length}:${JSON.stringify(lines).length}` : "";
    if (existing && existing.dataset.key === key) return;
    const wasOpen = !!existing?.open;
    existing?.remove();
    if (!key) return;
    const target = mesEl.querySelector(".mes_text");
    if (!target) return;
    const box = buildLog(lines).attr("data-key", key).prop("open", wasOpen);
    $(target).after(box);
}

registerAttachmentRestorer((mesEl, msg) => {
    if (!msg?.gm_log && !mesEl.querySelector(".gm_msg_log")) return;
    renderInto(mesEl, msg);
});
