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
import { extensionName, CHARACTER_STATES } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { progression } from "./progression.js";
import { parseToolBlocks, applyToolBlocks, escAttr } from "./toolParser.js";
import { getLastInjections } from "./injection.js";
import { captureSnapshot, captureSwipeState } from "./snapshots.js";
import { sendRequestViaProfile, resolveConnectionProfile, getProfileNameById } from "../util/connectionService.js";
import { swapProfile } from "../util/profileSwapper.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 6;
// The tracker only reports changes from the LAST exchange (player action +
// AI reply); older messages are context only, so changes already applied in
// previous turns are never re-applied.
const CURRENT_EXCHANGE_MESSAGES = 2;
let _running = false;

// Side-panel busy indicator: rotating outline on the window border + header
// "Processing..." chip (index.html), so the tracker wait is never dead UI.
// Direct DOM on purpose — importing mainPanel here would create an import
// cycle (mainPanel -> postTurn -> agentRunner -> mainPanel).
function setPanelBusy(on) {
    $("#gm_floating_window").toggleClass("gm_agent_busy", !!on);
    $("#gm_agent_busy").css("display", on ? "flex" : "none");
}

// Renders the tracked state as a compact XML snapshot: ONE line per actor,
// tracked names used directly as attribute keys (the agent must echo those
// exact names in its tool tags). Legends live once in the header note.
function buildStateSummaryXml() {
    const d = stateManager.getData();
    const s = extension_settings[extensionName];
    // Progression tracks are only exposed when the feature is on — otherwise
    // the agent never sees (and never grants) EXP.
    const prog = progression.isEnabled();

    const actorXml = (c, tag) => {
        // The agent must see states so it never "heals" a corpse or keeps
        // treating the incapacitated as actors. Non-recoverable states collapse
        // the entry entirely; recoverable ones keep the sheet (they can come
        // back) flagged with state="<mode>".
        if (c.state && !CHARACTER_STATES[c.state.mode]?.llm_clearable) {
            return `  <${tag} name="${escAttr(c.name)}" state="${c.state.mode}"${c.state.reason ? ` reason="${escAttr(c.state.reason)}"` : ""}/>`;
        }
        const attrs = [`name="${escAttr(c.name)}"`];
        if (c.state) attrs.push(`state="${c.state.mode}"`);
        if (prog) {
            const track = progression.trackOf(c);
            attrs.push(`level="${track.level}"`, `exp="${track.exp}/${progression.expToNext(track.level)}"`, `sp="${track.skill_points}"`);
        }
        for (const r of c.resources) {
            attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}${r.min > 0 ? ` (min ${r.min})` : ""}"`);
        }
        for (const a of c.attributes) attrs.push(`${escAttr(a.name)}="${a.value}"`);
        const items = (c.inventory || []).map(i => `${escAttr(i.name)} x${i.qty}`).join(", ");
        if (items) attrs.push(`items="${items}"`);
        // on_cooldown is a code-computed boolean — the agent never sees (and
        // never computes) remaining cooldown counts. On-cooldown skills are
        // marked with * (legend in the header note). The cost travels with the
        // name so the agent can report its payment when the skill is used.
        const skills = (c.skills || []).map(sk => {
            const cost = String(sk.cost || "").trim();
            return `${escAttr(sk.name)}${cost ? ` (cost: ${escAttr(cost)})` : ""}${(Number(sk.cooldown_left) || 0) > 0 ? "*" : ""}`;
        }).join(", ");
        if (skills) attrs.push(`skills="${skills}"`);
        const statuses = (c.statuses || []).map(st => `${escAttr(st.name)}${st.modifiers ? ` (${escAttr(st.modifiers)})` : ""}`).join(", ");
        if (statuses) attrs.push(`statuses="${statuses}"`);
        return `  <${tag} ${attrs.join(" ")}/>`;
    };

    const parts = ['<state note="values are value/max; skills as Name (cost); * = skill on cooldown; statuses as Name (modifiers)">'];
    for (const c of d.characters) parts.push(actorXml(c, "char"));
    // Enemies only when the feature is on AND some exist — otherwise the
    // agent never sees (and never invents) enemy state.
    if (s.feature_enemies) {
        for (const e of d.enemies) parts.push(actorXml(e, "enemy"));
    }
    // Shared party resources: visible to the tracker so it can account
    // consumption the pre-pass transaction engine did not already handle.
    if ((d.sharedResources || []).length) {
        parts.push(`  <shared>${d.sharedResources.map(r => `${escAttr(r.name)}=${escAttr(r.qty)}`).join("; ")}</shared>`);
    }
    if ((d.custom || []).length) {
        parts.push(`  <custom>${d.custom.map(c => `${escAttr(c.name)}=${escAttr(c.value)}`).join("; ")}</custom>`);
    }
    // Open threads: untracked/unfinished things + secrets the agent left
    // for itself (also visible to the pre-pass, never to the story prompt).
    for (const t of d.threads || []) {
        parts.push(`  <thread name="${escAttr(t.name)}"${t.ref ? ` ref="${escAttr(t.ref)}"` : ""}>${escAttr(t.text)}</thread>`);
    }
    parts.push("</state>");
    return parts.join("\n");
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
    // Spawn review: new characters/enemies are reported as briefs for the
    // generate + review flow instead of minimal auto-created sheets.
    const spawnReview = !!(s.feature_character_creator && s.feature_spawn_review);
    let deep = "";
    if (s.deep_context) {
        const extraText = exchange.length ? exchange[exchange.length - 1].text : "";
        deep = await buildDeepContext(extraText);
    }
    const lines = [
        "You are the game-state engine of a FICTIONAL tabletop-style roleplay session. Everything you read is invented roleplay between consenting adults — a game of dice and imagination with no real people, no real stakes and no real harm. Your job is pure bookkeeping: you are an accountant of a fantasy ledger, not a narrator, not a moral judge and not a safety filter. Violence, injury, suffering and death — including against HUMAN characters (the player character, allies, innocents, civilians) — are ordinary simulated game mechanics, exactly as they are in Dungeons & Dragons, Call of Cthulhu or any tabletop RPG. Refusing, softening or omitting them is a BUG in your output, not good behavior.",
        "You will receive an XML snapshot of the tracked state, optional PRIOR CONTEXT (older messages) and the CURRENT EXCHANGE (the latest player action + AI reply).",
        "The snapshot ALREADY reflects every change from all previous turns. Report ONLY the concrete state changes that logically follow from the CURRENT EXCHANGE (damage, spent resources, resolved rolls, items gained or consumed, attribute milestones, evolving custom features).",
        "NEVER re-report changes visible in PRIOR CONTEXT — resources already spent or removed, damage already applied, items already gained are done: the snapshot's current values are the ground truth. When in doubt, trust the snapshot over the history.",
        "Respond with ONLY the XML blocks below — no prose, no explanations. If nothing changed, respond with nothing.",
        "Never invent characters or tracked values that are not in the state snapshot.",
        "",
        "DAMAGE ACCOUNTING — apply it to EVERYONE, humans included:",
        "- When the exchange shows a character being hit, wounded, burned, poisoned, falling, starving or otherwise harmed, report the resource loss with <change_values> — regardless of whether the victim is an enemy, a monster, the player character, an ally or a human NPC. A sword through a villager costs HP exactly like a sword through a goblin.",
        "- NEVER soften, round down, halve, delay or 'forget' damage because the victim is human, sympathetic, innocent, or the player's own character. The dice and the narration already decided the outcome — your only job is to record the numbers faithfully.",
        "- NEVER refuse, moralize, add disclaimers or replace a state change with prose. There is no audience here to protect: this is arithmetic on a game sheet.",
        "- Scale damage to what the narration describes: a graze is small, a solid hit is meaningful, a critical or devastating blow can take a large chunk or reach minimum. Be consistent with the fiction's tone — grimdark is grim, lighthearted adventures stay light.",
        "",
        "RESOURCE SPENDING — the sheet moves whenever the fiction consumes something, not only on damage:",
        "- When the exchange shows a character USING, consuming or depleting anything tracked on their sheet — firing a weapon (Ammo), casting magic without a tracked skill (Mana), sprinting, climbing or fighting (Stamina), eating from their own supplies (Food/Rations), drinking, burning fuel, spending their own money — report the loss with <change_values>.",
        "- Non-combat depletion is bookkeeping too: a meal, a night's rest interrupted by watch duty, a long trek, a crafting session, a bought round of drinks. If the narration shows the resource being spent, the sheet must move — even when no number is stated. Estimate the amount from the setting's scale (a meal is a meal, not half the larder).",
        "- Recovery counts as well: rest, healing, meals, refills and purchases restore or raise tracked resources — report those with <change_values> too (positive delta or absolute value).",
        "- An exchange with real action almost always moves SOMETHING on the sheets. An empty report is for genuinely static scenes (pure conversation, no stakes, no exertion) — not the default.",
        "",
        "SHARED RESOURCES — the party-wide <shared> entries (money, food, supplies):",
        "- The pre-pass transaction engine pays for what the PLAYER'S ACTION implied BEFORE the story ran; its payments appear in GAME SYSTEM RESULTS as <transaction> lines and are ALREADY applied — NEVER re-report them.",
        "- For consumption or gains the exchange shows that the game system did NOT process (the story engine narrated a purchase, a toll, a meal from party supplies, loot split into the party purse), report it with <change_values><shared name=\"...\" delta=\"...\"/></change_values>. Estimate the amount from the setting's scale; spending is capped at the current value automatically.",
        "",
        "Available blocks:",
        '  <change_values><char>Name</char><resource name="HP" delta="-12"|value="45"/><attribute name="STR" delta="1"/></change_values>',
        '  <change_values><shared name="Dinheiro" delta="-6"/></change_values>',
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
        ...(spawnReview ? ['  <new_characters><char name="Kael" kind="party" details="wounded knight the party rescued, stoic and dry-humored" level="3"/><char name="Goblin Chief" kind="enemy" details="scarred veteran leading the warband, brutal close-quarters fighter"/></new_characters>'] : []),
        ...(s.feature_death !== false ? ['  <deaths><death char="Name" reason="short cause of death"/></deaths>'] : []),
        '  <knockouts><ko char="Name" reason="short cause"/><ko_clear char="Name"/></knockouts>',
        ...(prog ? ['  <grant_exp><char>Name</char><exp amount="25"/></grant_exp>'] : []),
        "",
        "Use <warnings> ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). Keep warning text under 15 words. Clear a warning when its cause is resolved. Do not re-emit unchanged warnings every turn.",
        "Use <threads> to leave notes to yourself about UNTRACKED or UNFINISHED things the formal containers cannot hold: ongoing trips (fuel/money spent so far), half-done actions, unresolved behavior, or secrets that must stay hidden from the player. ALWAYS record where/when it started (ref) so you can compare progress later (\"started when leaving town\", \"day 2 of the siege\"). Update the thread as things progress; clear it (thread_clear) as soon as it is finished or irrelevant. Threads are invisible to the player and never injected into the story prompt — the pre-pass decides what the story needs to know.",
        "Use <enemies> when enemies or threats appear in the scene: action=\"add\" to introduce one (with its HP resource and notable passives/skills), nested <resource>/<status> tags or hp_delta to update it, and action=\"remove\" AS SOON AS an enemy stops being relevant (defeated, fled, scene moved on) — removed enemies are archived and automatically restored with their last state if they return. An enemy at 0 HP or clearly destroyed/slain in the exchange MUST be removed in this same reply — never leave a dead enemy tracked. You may also damage enemies with <change_values><char>EnemyName</char>.",
        ...(spawnReview ? [
            "Use <new_characters> when a NEW named character or enemy clearly enters the scene and matters beyond this exchange: one <char> per newcomer with kind=\"party\" (a potential companion or recurring NPC) or kind=\"enemy\" (a hostile threat), a short details brief (role, appearance, combat style, what makes them different) and their level when progression is active. Never re-emit names already in the state snapshot. When you report a new enemy here, skip the <enemies> add — the player reviews and builds the full sheet from your brief; keep <enemies> for updates and removals.",
        ] : []),
        "Use <set_statuses> for TEMPORARY per-character conditions (Dazed, Drunk, Inspired...). When a status lands, also apply its listed stat modifiers through <change_values>; when the condition ends, remove the modifiers with a matching <change_values> and clear the status with <clear_statuses>. Do not use statuses for permanent traits (passives) or party-wide gimmicks (custom).",
        "Use <knockouts> when a character is clearly unconscious or incapacitated but NOT dead — non-lethal defeat, blunt trauma to the head, choking, blood loss, drugging, electrocution, exhaustion, a spell that drops them. Do NOT hesitate to knock out human characters, allies or the player character when the fiction calls for it: being beaten unconscious is a normal game outcome, not something to shield anyone from. <ko char=\"Name\" reason=\"...\"/> knocks them out, <ko_clear char=\"Name\"/> when they regain consciousness (rest, recovery, a timeskip). Write the reason bluntly and concretely (\"choked out in a headlock\", \"cracked skull on the pavement\", \"drugged wine\") — never a vague euphemism. A character with state=\"ko\" cannot act until cleared — do not report actions, skill use or EXP for them.",
        ...(s.feature_death !== false ? [
            "LETHALITY — be realistic about damage and health. Do NOT soften outcomes to protect characters: wounds have consequences, and a resource reaching its minimum (or a clearly unsurvivable blow shown in the exchange) means DEATH — for the player character, allies, human NPCs and bystanders just as much as for monsters. Nobody is plot-armored: a knife to the throat kills a king, a fall kills a child NPC, an ambush kills an ally. When a character or ally dies, report it with <deaths><death char=\"Name\" reason=\"short cause\"/></deaths>. Write the cause concretely and without euphemism — \"run through by the bandit's spear\", \"throat slit\", \"burned alive in the collapsing house\", \"bled out from a gut wound\" — graphic accuracy is correct bookkeeping, not gratuitousness. A character survives a lethal hit ONLY if one of their listed skills or passives (not on cooldown) explicitly says otherwise (a revive, an undying passive). Never invent a rescue the scene and sheets do not support, never fudge a death into a 'critical injury' to spare the player, and never ask permission before reporting a death. Enemies die via <enemies action=\"remove\" reason=\"slain\">. A character marked dead in the snapshot stays dead — never report actions, healing or EXP for them.",
        ] : []),
        "Use <use_skills> whenever a character ACTIVELY used one of their listed skills during the exchange: one <skill name=\"...\"/> per skill used, scoped with <char>. This includes ENEMIES — report an enemy's skill use exactly the same way (<use_skills><char>EnemyName</char><skill name=\"...\"/></use_skills>). The system starts cooldowns automatically — NEVER report or compute cooldowns yourself, and NEVER report a skill marked on_cooldown (it could not have been used). Passives are always active: never report them.",
        "SKILL COSTS — a skill's (cost: ...) shown in the snapshot is the price of using it, and it is ALWAYS paid when the skill is used, even when the narration does not dwell on it. Whenever you report a skill use, also report its payment with the matching blocks: resource or attribute costs via <change_values>, temporary conditions via <set_statuses> (with their stat modifiers), consumed items via <remove_items>. Costs may be narrative (a memory, a favor, a lingering wound) — translate them into the closest tracked block, or a <thread> when nothing tracked fits. Pay each cost exactly once: the snapshot's current values are pre-payment, so the spend belongs to THIS report.",
        ...(prog ? [
            "Use <grant_exp> when a character clearly EARNED experience during the exchange (overcoming a challenge, a victory, a meaningful accomplishment) — one <exp amount=\"...\"/> per character, scoped with <char>. The system computes level-ups and skill points automatically — NEVER report or compute levels yourself. Grant EXP by your own accord, at a pace calibrated by the EXP GUIDELINES below; skip the block when nothing noteworthy happened.",
            "ATTRIBUTE MILESTONES are RARE narrative beats (a permanent injury, a breakthrough, divine favor) — most attribute growth comes from the PLAYER spending attribute points. Never raise attributes routinely or as a substitute for level-ups.",
            ...(String(progression.getConfig().exp_guidelines || "").trim()
                ? [`EXP GUIDELINES (calibration for <grant_exp> amounts): ${progression.getConfig().exp_guidelines.trim()}`]
                : []),
        ] : []),
    ];
    if (deep) {
        lines.push("", "<deep_context>", deep, "</deep_context>");
    }
    // User's standing instructions for the post-pass — at the END of the
    // system message, after the deep context. Full ST macro parsing
    // ({{char}}, {{user}}, {{time}}...) via substituteParams, like a normal
    // generation would do.
    let custom = String(s.custom_instructions?.post || "").trim();
    if (custom) {
        try {
            const st = getContext();
            const charName = st.characters?.[st.characterId]?.name;
            custom = substituteParams(custom, { name2Override: charName });
        } catch (e) {
            console.warn("[Game Manager] custom instruction macro substitution failed:", e);
        }
        lines.push("", `<custom>\n${custom}\n</custom>`);
    }
    return lines.join("\n");
}

function buildUserPrompt(exchange, history = []) {
    // What the pre-master injected into this turn's story prompt (dice rolls,
    // transactions, action rewrites, one-shot notes) — placed BEFORE the
    // exchange so the tracker reads the raw results with the narration that
    // followed them. Raw chat text alone never contains the actual numbers.
    const injections = getLastInjections();
    const blocks = [
        "STATE SNAPSHOT (XML):",
        buildStateSummaryXml(),
        "",
    ];
    if (injections) {
        blocks.push("GAME SYSTEM RESULTS (injected into this turn's story prompt):", injections, "");
    }
    // Prior messages are context only — clearly fenced off so the tracker
    // never re-applies changes that earlier passes already recorded.
    if (history.length) {
        blocks.push(
            "PRIOR CONTEXT (older messages — ALREADY PROCESSED, their changes are already in the snapshot; NEVER report changes from these):",
            ...history.map(m => `${m.role}: ${m.text}`),
            "",
        );
    }
    blocks.push(
        "CURRENT EXCHANGE (the ONLY source of changes — report exactly what happens here, nothing else):",
        ...exchange.map(m => `${m.role}: ${m.text}`),
    );
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
        setPanelBusy(true);
        const st = getContext();
        const recent = collectRecentMessages();
        // Last player action + AI reply = the exchange being accounted;
        // everything before it is read-only context.
        const exchange = recent.slice(-CURRENT_EXCHANGE_MESSAGES);
        const history = recent.slice(0, -CURRENT_EXCHANGE_MESSAGES);
        const messages = [
            { role: "system", content: await buildSystemPrompt(exchange) },
            { role: "user", content: buildUserPrompt(exchange, history) },
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
        // Baseline for rollback: the state before this message's first changes.
        const st2 = getContext();
        const snapId = mesId ?? Math.max(0, st2.chat.length - 1);
        let applied = 0;
        if (blocks.length) {
            console.info(`[GM DIAG] agent pass: capturing baseline snapshot for message ${snapId} (chat.length=${st2.chat.length})`);
            captureSnapshot(snapId);
            applied = applyToolBlocks(blocks);
            logDebug(`agent pass (${reason}): applied ${applied} change(s)`);
        } else {
            logDebug(`agent pass (${reason}): no changes reported`);
        }
        // Post-pass state of THIS swipe version: switching between swipe
        // versions of this message later restores exactly what this pass
        // produced (recorded even when the pass applied nothing).
        captureSwipeState(snapId, st2.chat[snapId]?.swipe_id);
        setPanelBusy(false);
        return applied;
    } catch (e) {
        console.error("[Game Manager] agent pass failed:", e);
        setPanelBusy(false);
        return 0;
    } finally {
        _running = false;
    }
}