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
import { generateRaw, substituteParams } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { progression } from "./progression.js";
import { parseToolBlocks, applyToolBlocks } from "./toolParser.js";
import { captureSnapshot } from "./snapshots.js";
import { sendRequestViaProfile, resolveConnectionProfile, getProfileNameById } from "../util/connectionService.js";
import { swapProfile } from "../util/profileSwapper.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 6;
let _running = false;

function buildStateSummary() {
    const d = stateManager.getData();
    const s = extension_settings[extensionName];
    // Progression tracks are only exposed when the feature is on — otherwise
    // the agent never sees (and never grants) EXP.
    const prog = progression.isEnabled();
    const charSummary = c => {
        const out = {
            name: c.name,
            resources: c.resources.map(r => ({ name: r.name, value: r.value, min: r.min, max: r.max })),
        attributes: c.attributes.map(a => ({ name: a.name, value: a.value })),
        inventory: c.inventory.map(i => ({ name: i.name, qty: i.qty })),
        // on_cooldown is a code-computed boolean — the agent never sees (and
        // never computes) remaining cooldown counts.
        skills: (c.skills || []).map(s => {
            const skill = { name: s.name };
            if ((Number(s.cooldown_left) || 0) > 0) skill.on_cooldown = true;
            return skill;
        }),
        statuses: (c.statuses || []).map(s => ({ name: s.name, modifiers: s.modifiers || "" })),
        };
        // The agent must see deaths so it never "heals" a corpse or keeps
        // treating the dead as actors.
        if (c.dead === true) {
            out.dead = true;
            if (c.death_reason) out.death_reason = c.death_reason;
        }
        if (prog) {
            const track = progression.trackOf(c);
            out.level = track.level;
            out.exp = track.exp;
            out.exp_to_next = progression.expToNext(track.level);
            out.skill_points = track.skill_points;
        }
        return out;
    };
    return {
        characters: d.characters.map(charSummary),
        // Enemies only when the feature is on AND some exist — otherwise the
        // agent never sees (and never invents) enemy state.
        enemies: (s.feature_enemies ? d.enemies : []).map(charSummary),
        customFeatures: d.custom.map(c => ({ name: c.name, value: c.value })),
        // Open threads: untracked/unfinished things + secrets the agent left
        // for itself (also visible to the pre-pass, never to the story prompt).
        openThreads: (d.threads || []).map(t => ({ name: t.name, text: t.text, ref: t.ref || "" })),
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

// The system message: agent instructions plus, when the deep context setting
// is on, the card / persona / author's note / activated World Info — so the
// agent knows who and where the scene is before reading state or history.
// The latest exchange text participates in WI activation, like the player
// action does in the pre-pass.
async function buildSystemPrompt(exchange = []) {
    const s = extension_settings[extensionName];
    const prog = progression.isEnabled();
    let deep = "";
    if (s.deep_context) {
        const extraText = exchange.length ? exchange[exchange.length - 1].text : "";
        deep = await buildDeepContext(extraText);
    }
    const lines = [
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
        '  <set_statuses><char>Name</char><status name="Dazed" modifiers="Aim -2" effect="..."/></set_statuses>',
        '  <clear_statuses><char>Name</char><status name="Dazed"/></clear_statuses>',
        '  <use_skills><char>Name</char><skill name="Fireball"/><skill name="Dash"/></use_skills>',
        '  <warnings><warning name="Food" text="You have about two days of food left."/><warning_clear name="Food"/></warnings>',
        '  <threads><thread name="Fuel trip" text="Left town with 40L fuel; ~120 km driven so far" ref="started when leaving town"/><thread_clear name="Fuel trip"/></threads>',
        '  <enemies><enemy action="add" name="Goblin"><resource name="HP" value="30" max="30"/><passive name="Brutal" description="+2 damage below half HP"/></enemy><enemy action="update" name="Goblin"><resource name="HP" delta="-7"/><status name="Wounded" modifiers="Aim -2"/></enemy><enemy action="remove" name="Goblin" reason="defeated"/></enemies>',
        ...(s.feature_death !== false ? ['  <deaths><death char="Name" reason="short cause of death"/></deaths>'] : []),
        ...(prog ? ['  <grant_exp><char>Name</char><exp amount="25"/></grant_exp>'] : []),
        "",
        "Use <warnings> ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). Keep warning text under 15 words. Clear a warning when its cause is resolved. Do not re-emit unchanged warnings every turn.",
        "Use <threads> to leave notes to yourself about UNTRACKED or UNFINISHED things the formal containers cannot hold: ongoing trips (fuel/money spent so far), half-done actions, unresolved behavior, or secrets that must stay hidden from the player. ALWAYS record where/when it started (ref) so you can compare progress later (\"started when leaving town\", \"day 2 of the siege\"). Update the thread as things progress; clear it (thread_clear) as soon as it is finished or irrelevant. Threads are invisible to the player and never injected into the story prompt — the pre-pass decides what the story needs to know.",
        "Use <enemies> when enemies or threats appear in the scene: action=\"add\" to introduce one (with its HP resource and notable passives/skills), nested <resource>/<status> tags or hp_delta to update it, and action=\"remove\" AS SOON AS an enemy stops being relevant (defeated, fled, scene moved on) — removed enemies are archived and automatically restored with their last state if they return. You may also damage enemies with <change_values><char>EnemyName</char>.",
        "Use <set_statuses> for TEMPORARY per-character conditions (Dazed, Drunk, Inspired...). When a status lands, also apply its listed stat modifiers through <change_values>; when the condition ends, remove the modifiers with a matching <change_values> and clear the status with <clear_statuses>. Do not use statuses for permanent traits (passives) or party-wide gimmicks (custom).",
        ...(s.feature_death !== false ? [
            "LETHALITY — be realistic about damage and health. Do NOT soften outcomes to protect characters: wounds have consequences, and a resource reaching its minimum (or a clearly unsurvivable blow shown in the exchange) means DEATH. When a character or ally dies, report it with <deaths><death char=\"Name\" reason=\"short cause\"/></deaths>. A character survives a lethal hit ONLY if one of their listed skills or passives (not on cooldown) explicitly says otherwise (a revive, an undying passive). Never invent a rescue the scene and sheets do not support. Enemies die via <enemies action=\"remove\" reason=\"slain\">. A character marked dead in the snapshot stays dead — never report actions, healing or EXP for them.",
        ] : []),
        "Use <use_skills> whenever a character ACTIVELY used one of their listed skills during the exchange: one <skill name=\"...\"/> per skill used, scoped with <char>. The system starts cooldowns automatically — NEVER report or compute cooldowns yourself, and NEVER report a skill marked on_cooldown (it could not have been used). Passives are always active: never report them.",
        ...(prog ? [
            "Use <grant_exp> when a character clearly EARNED experience during the exchange (overcoming a challenge, a victory, a meaningful accomplishment) — one <exp amount=\"...\"/> per character, scoped with <char>. The system computes level-ups and skill points automatically — NEVER report or compute levels yourself. Grant EXP by your own accord, at a pace calibrated by the EXP GUIDELINES below; skip the block when nothing noteworthy happened.",
            ...(String(progression.getConfig().exp_guidelines || "").trim()
                ? [`EXP GUIDELINES (calibration for <grant_exp> amounts): ${progression.getConfig().exp_guidelines.trim()}`]
                : []),
        ] : []),
    ];
    if (deep) {
        lines.push("", "DEEP CONTEXT (card / persona / lore):", deep);
    }
    return lines.join("\n");
}

function buildUserPrompt(exchange) {
    const s = extension_settings[extensionName];
    let custom = String(s.custom_instructions?.post || "").trim();
    const blocks = [
        "STATE SNAPSHOT (JSON):",
        JSON.stringify(buildStateSummary()),
        "",
        "RECENT EXCHANGE:",
        ...exchange.map(m => `${m.role}: ${m.text}`),
    ];
    // User's standing instructions for the post-pass. Full ST macro parsing
    // ({{char}}, {{user}}, {{time}}...) via substituteParams, like a normal
    // generation would do.
    if (custom) {
        try {
            const st = getContext();
            const charName = st.characters?.[st.characterId]?.name;
            custom = substituteParams(custom, { name2Override: charName });
        } catch (e) {
            console.warn("[Game Manager] custom instruction macro substitution failed:", e);
        }
        blocks.push("", `<custom>\n${custom}\n</custom>`);
    }
    return blocks.join("\n");
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
        const exchange = collectRecentMessages();
        const messages = [
            { role: "system", content: await buildSystemPrompt(exchange) },
            { role: "user", content: buildUserPrompt(exchange) },
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
        const snapId = mesId ?? Math.max(0, st2.chat.length - 1);
        console.info(`[GM DIAG] agent pass: capturing baseline snapshot for message ${snapId} (chat.length=${st2.chat.length})`);
        captureSnapshot(snapId);
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