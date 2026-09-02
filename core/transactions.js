// Fair-use transaction pre-master.
// When the player's action mentions a shared party resource (money, food,
// expendables...), this LLM judges the transaction before it happens and
// produces the four pieces of info the spec requires: current value,
// transaction value, value after, and a plain-language comparison
// ("Could buy a week's worth of food").
//
// The result is queued for high-priority injection AND applied to the shared
// resource (snapshotted for rollback). The post-pass tracker only accounts
// shared resources the pre-pass did not already handle (see agentRunner.js).

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager, playerLabel } from "./stateManager.js";
import { captureSnapshot } from "./snapshots.js";
import { queueHigh } from "./injection.js";
import { parseAttrs } from "./toolParser.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { statusBubble } from "../ui/statusBubble.js";

const SYSTEM_PROMPT = [
    "You are the game master's accountant for a tabletop-style roleplay session.",
    "You receive a party-wide resource (name, current amount) and the player's action that mentions it.",
    "Decide the concrete transaction that follows from the action and respond with ONLY XML (no markdown fences, no prose):",
    '<transaction applies="true" amount="<number spent or gained, negative for spending>" comparison="<short plain-language note, e.g. Could buy a week\'s worth of food>"/>',
    'If the action does not imply any transaction, respond with ONLY: <transaction applies="false"/>',
    "Rules: keep amounts plausible for the setting; if the action implies spending more than owned, cap the transaction at the full amount. Comparison must be under 12 words.",
].join("\n");

function collectContext(resource, playerAction) {
    const chat = getContext()?.chat || [];
    const history = chat.slice(-5, -1)
        .map(m => `${m.is_user ? playerLabel() : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 800)}`);
    return [
        "RECENT SCENE:",
        ...history,
        "",
        `RESOURCE: ${resource.name} — current amount: ${resource.qty}`,
        `PLAYER ACTION: ${playerAction}`,
    ].join("\n");
}

function parseReply(text) {
    const m = String(text || "").match(/<transaction\b([^>]*?)(?:\/>|>)/i);
    if (!m) return null;
    const a = parseAttrs(m[1]);
    return {
        applies: String(a.applies ?? "").toLowerCase() === "true",
        transaction: Math.trunc(Number(a.amount) || 0),
        comparison: String(a.comparison || ""),
    };
}

// Transaction flow for a player action mentioning `resource` on message
// `mesId`. `plan` is an optional pre-pass entry ({ delta, comparison }) — when
// it carries a non-zero delta the router already judged the transaction and
// the specialist LLM call is skipped. Returns true if a transaction was applied.
export async function runTransaction(resource, playerAction, mesId = null, plan = null) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_transactions) return false;
    if (!resource) return false;

    try {
        let tx = 0;
        let comparison = "";
        if (plan && Number(plan.delta) !== 0) {
            // Pre-pass already judged this transaction — no specialist call.
            tx = Math.trunc(Number(plan.delta) || 0);
            comparison = String(plan.comparison || "").slice(0, 120);
        } else {
            const st = getContext();
            const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
            // Deep context (own "Deep Context for Engines" setting) goes into
            // the system message, after the accountant instructions —
            // plausible amounts depend on the setting's prices and economy.
            let systemContent = SYSTEM_PROMPT;
            if (s.deep_context_engines) {
                const deep = await buildDeepContext(String(playerAction || ""));
                if (deep) systemContent += `\n\n<deep_context>\n${deep}\n</deep_context>`;
            }
            const messages = [
                { role: "system", content: systemContent },
                { role: "user", content: collectContext(resource, playerAction) },
            ];
            const reply = await sendRequestViaProfile(profileId, messages);
            const parsed = parseReply(reply || "");
            if (!parsed || parsed.applies !== true) {
                logDebug("transactions: no transaction implied");
                return false;
            }
            tx = Math.trunc(Number(parsed.transaction) || 0);
            comparison = String(parsed.comparison || "").slice(0, 120);
        }

        const current = Math.trunc(Number(resource.qty) || 0);
        // Signed delta: negative = spending (capped at owned), positive = gain.
        const remaining = Math.max(0, current + tx);
        const net = current - remaining;

        // Baseline snapshot so delete/swipe rolls the resource back too.
        captureSnapshot(mesId);
        resource.qty = remaining;
        stateManager.emitChange("transaction");

        queueHigh(`  <transaction resource="${resource.name}" current="${current}" transaction="${net}" remaining="${remaining}">${comparison}</transaction>`);
        statusBubble.result(`${resource.name}: ${net >= 0 ? "-" : "+"}${Math.abs(net)} → ${remaining}${comparison ? ` · ${comparison}` : ""}`);
        logDebug(`transactions: ${resource.name} ${current} -> ${remaining} (${comparison})`);
        return true;
    } catch (e) {
        console.error("[Game Manager] transaction check failed:", e);
        return false;
    }
}