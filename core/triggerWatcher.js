// Trigger watcher — scans the player's outgoing action for pre-master hooks:
//   - an explicitly named tracked SKILL  -> dice roll flow (core/diceRoller.js)
//   - a mentioned SHARED RESOURCE name   -> fair-use transaction flow
//     (core/transactions.js)
// Per the spec, dice do not fire every turn: the skill name must appear
// verbatim (word-boundary match) in the player's message.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { rollDice } from "./diceRoller.js";
import { runTransaction } from "./transactions.js";

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds mentions of tracked names in the action text. Returns the matched
// entries ({ kind, name, entry }).
export function detectTriggers(actionText) {
    const d = stateManager.getData();
    const hits = [];
    if (!actionText) return hits;
    const text = String(actionText);

    for (const char of d.characters || []) {
        for (const skill of char.skills || []) {
            if (!skill.name) continue;
            const re = new RegExp(`\\b${escapeRegex(skill.name)}\\b`, "i");
            if (re.test(text)) hits.push({ kind: "skill", name: skill.name, char });
        }
    }

    for (const res of d.sharedResources || []) {
        if (!res.name) continue;
        const re = new RegExp(`\\b${escapeRegex(res.name)}\\b`, "i");
        if (re.test(text)) hits.push({ kind: "resource", name: res.name, entry: res });
    }

    return hits;
}

let _running = false;

// Handler for the player's outgoing message.
export async function handlePlayerAction(mesId) {
    const s = extension_settings[extensionName];
    if (!s.enabled) return;
    if (_running) return;
    const st = getContext();
    const msg = st.chat?.[mesId];
    if (!msg || !msg.is_user) return;

    const action = String(msg.mes ?? "").trim();
    if (!action) return;

    const hits = detectTriggers(action);
    if (!hits.length) return;

    _running = true;
    try {
        const skills = hits.filter(h => h.kind === "skill");
        const resources = hits.filter(h => h.kind === "resource");

        if (s.feature_dice && skills.length) {
            logDebug(`triggerWatcher: skill trigger "${skills[0].name}" on message ${mesId}`);
            await rollDice(action, mesId);
        }

        if (s.feature_transactions && resources.length) {
            logDebug(`triggerWatcher: resource trigger "${resources[0].name}" on message ${mesId}`);
            await runTransaction(resources[0].entry, action, mesId);
        }
    } catch (e) {
        console.error("[Game Manager] trigger handling failed:", e);
    } finally {
        _running = false;
    }
}

export function initTriggerWatcher() {
    const st = getContext();
    // MESSAGE_SENT fires with the new message index when the player sends.
    st.eventSource.on(st.event_types.MESSAGE_SENT, async (mesId) => {
        try {
            const id = typeof mesId === "number" ? mesId : (st.chat?.length ?? 1) - 1;
            await handlePlayerAction(id);
        } catch (e) {
            console.error("[Game Manager] trigger watcher failed:", e);
        }
    });
    logDebug("trigger watcher armed");
}