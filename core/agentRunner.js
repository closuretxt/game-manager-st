// Agentic update pass.
// Instead of scanning the main SillyTavern model's output, a dedicated
// agentic call analyses the final exchange (AI reply + player response) and
// reports concrete state changes as tool tags — rolling dice, spending
// resources, updating custom features, etc.
//
// Request routing:
// - Default: per-request profiles via ConnectionManagerRequestService
//   (util/connectionService.js) — the user's active connection is untouched.
// - Legacy (advanced option): swaps the active connection profile, runs a raw
//   generation, and swaps back (util/profileSwapper.js).
//
// Gated behind the "Agentic resource updates" setting — OFF by default.

import { extension_settings, getContext } from "../../../../extensions.js";
import { generateRaw } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { parseToolBlocks, applyToolBlocks } from "./toolParser.js";
import { captureSnapshot } from "./snapshots.js";
import { sendRequestViaProfile, resolveConnectionProfile, getProfileNameById } from "../util/connectionService.js";
import { swapProfile } from "../util/profileSwapper.js";

const MAX_CONTEXT_MESSAGES = 6;
let _running = false;

function buildStateSummary() {
    const d = stateManager.getData();
    return {
        characters: d.characters.map(c => ({
            name: c.name,
            resources: c.resources.map(r => ({ name: r.name, value: r.value, min: r.min, max: r.max })),
            attributes: c.attributes.map(a => ({ name: a.name, value: a.value })),
            inventory: c.inventory.map(i => ({ name: i.name, qty: i.qty })),
        })),
        customFeatures: d.custom.map(c => ({ name: c.name, value: c.value })),
        // Shared party resources are intentionally excluded: AI never touches them.
    };
}

function collectRecentMessages() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return [];
    return chat.slice(-MAX_CONTEXT_MESSAGES).map(m => ({
        role: m.is_user ? "player" : (m.name || "narrator"),
        text: String(m.mes ?? "").slice(0, 4000),
    }));
}

function buildSystemPrompt() {
    return [
        "You are the game-state engine of a tabletop-style roleplay session.",
        "You will receive the recent exchange and a JSON snapshot of the tracked state.",
        "Report ONLY the concrete state changes that logically follow from the exchange (damage, spent resources, resolved rolls, items gained or consumed, attribute milestones, evolving custom features).",
        "Respond with ONLY the XML blocks below — no prose, no explanations. If nothing changed, respond with nothing.",
        "Never invent characters or tracked values that are not in the state snapshot. Never modify shared party resources.",
        "",
        "Available blocks:",
        '  <change_values><char>Name</char><resource name="HP" delta="-12"|value="45"/><attribute name="STR" delta="1"/></change_values>',
        '  <set_attributes><char>Name</char><attribute name="STR" value="14"/></set_attributes>',
        '  <add_items><char>Name</char><item name="Rope" qty="1" description="..."/></add_items>',
        '  <remove_items><char>Name</char><item name="Ammo" qty="3"/></remove_items>',
        '  <update_custom><entry name="Seeds" value="Sprouting" description="..."/></update_custom>',
        '  <warnings><warning name="Food" text="You have about two days of food left."/><warning_clear name="Food"/></warnings>',
        "",
        "Use <warnings> ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). Keep warning text under 15 words. Clear a warning when its cause is resolved. Do not re-emit unchanged warnings every turn.",
    ].join("\n");
}

function buildUserPrompt(exchange) {
    return [
        "STATE SNAPSHOT (JSON):",
        JSON.stringify(buildStateSummary()),
        "",
        "RECENT EXCHANGE:",
        ...exchange.map(m => `${m.role}: ${m.text}`),
    ].join("\n");
}

// Runs one agentic analysis pass for the message `mesId`. Returns the number
// of applied changes.
export async function runAgentPass(reason = "manual", mesId = null) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.auto_update) return 0;
    if (_running) {
        logDebug("agent pass skipped — already running");
        return 0;
    }
    _running = true;
    try {
        const st = getContext();
        const messages = [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserPrompt(collectRecentMessages()) },
        ];

        let reply = "";
        if (s.legacy_api) {
            // LEGACY: swap the active connection profile, raw-generate, swap back.
            const profileId = resolveConnectionProfile(st, s.connection_profile);
            const targetName = getProfileNameById(st, profileId);
            const originalName = st.extensionSettings?.connectionManager?.selectedProfileName
                || getProfileNameById(st, resolveConnectionProfile(st, ""));
            try {
                if (targetName && targetName !== originalName) {
                    const ok = await swapProfile(targetName, originalName);
                    if (!ok) logDebug("agent pass: profile swap failed, using current connection");
                }
                reply = await generateRaw({ prompt: `${messages[0].content}\n\n${messages[1].content}` });
            } finally {
                if (targetName && originalName && targetName !== originalName) {
                    await swapProfile(originalName, targetName);
                }
            }
        } else {
            reply = await sendRequestViaProfile(resolveConnectionProfile(st, s.connection_profile), messages);
        }

        const blocks = parseToolBlocks(reply || "");
        if (!blocks.length) {
            logDebug(`agent pass (${reason}): no changes reported`);
            return 0;
        }
        // Baseline for rollback: the state before this message's first changes.
        const st2 = getContext();
        captureSnapshot(mesId ?? Math.max(0, st2.chat.length - 1));
        const applied = applyToolBlocks(blocks);
        logDebug(`agent pass (${reason}): applied ${applied} change(s)`);
        return applied;
    } catch (e) {
        console.error("[Game Manager] agent pass failed:", e);
        return 0;
    } finally {
        _running = false;
    }
}