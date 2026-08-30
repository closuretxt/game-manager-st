// Fair-use transaction pre-master.
// When the player's action mentions a shared party resource (money, food,
// expendables...), this LLM judges the transaction before it happens and
// produces the four pieces of info the spec requires: current value,
// transaction value, value after, and a plain-language comparison
// ("Could buy a week's worth of food").
//
// The result is queued for high-priority injection AND applied to the shared
// resource (snapshotted for rollback), since the agentic state pass never
// touches shared resources.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug, gmNotify } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { captureSnapshot } from "./snapshots.js";
import { queueHigh } from "./injection.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";

const SYSTEM_PROMPT = [
    "You are the game master's accountant for a tabletop-style roleplay session.",
    "You receive a party-wide resource (name, current amount) and the player's action that mentions it.",
    "Decide the concrete transaction that follows from the action and respond with ONLY a JSON object (no fences, no prose):",
    '{"applies": true, "transaction": <number spent or gained, negative for spending>, "comparison": "<short plain-language note, e.g. Could buy a week\'s worth of food>"}',
    "Rules: keep amounts plausible for the setting; if the action implies spending more than owned, cap the transaction at the full amount; if the action does not imply any transaction, respond with {\"applies\": false}. Comparison must be under 12 words.",
].join("\n");

function collectContext(resource, playerAction) {
    const chat = getContext()?.chat || [];
    const history = chat.slice(-5, -1)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 800)}`);
    return [
        "RECENT SCENE:",
        ...history,
        "",
        `RESOURCE: ${resource.name} — current amount: ${resource.qty}`,
        `PLAYER ACTION: ${playerAction}`,
    ].join("\n");
}

function parseReply(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch (e) {
        logDebug("transactions: JSON parse failed:", e);
        return null;
    }
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
            const messages = [
                { role: "system", content: SYSTEM_PROMPT },
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
        gmNotify(`${resource.name}: ${net >= 0 ? "-" : "+"}${Math.abs(net)} → ${remaining} (${comparison})`, "info");
        logDebug(`transactions: ${resource.name} ${current} -> ${remaining} (${comparison})`);
        return true;
    } catch (e) {
        console.error("[Game Manager] transaction check failed:", e);
        return false;
    }
}