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
import { stateManager, playerLabel, charLabel } from "./stateManager.js";
import { progression } from "./progression.js";
import { parseToolBlocks, applyToolBlocks, escAttr } from "./toolParser.js";
import { sheetXml, sharedXml, customXml, xmlEl } from "./sheetXml.js";
import { valueGuidelines } from "./valueGuidelines.js";
import { getLastInjections, hadCombatThisTurn } from "./injection.js";
import { captureSnapshot, captureSwipeState } from "./snapshots.js";
import { sendRequestViaProfile, resolveConnectionProfile, getProfileNameById } from "../util/connectionService.js";
import { swapProfile } from "../util/profileSwapper.js";
import { buildDeepContext } from "../util/loreContext.js";

const MAX_CONTEXT_MESSAGES = 4;
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
            return xmlEl(tag, { name: c.name, state: c.state.mode, reason: c.state.reason });
        }
        const attrs = {};
        if (c.state) attrs.state = c.state.mode;
        if (prog) {
            const track = progression.trackOf(c);
            attrs.level = track.level;
            attrs.exp = `${track.exp}/${progression.expToNext(track.level)}`;
            attrs.sp = track.skill_points;
        }
        // Full sheet via the global renderer: every description field travels
        // (skill damage terms, passives, status effects, item notes).
        return sheetXml(c, { tag, attrs });
    };

    // Reading rule in words only: name is the tag, value in the tag,
    // pre-turn values, and reports use name=... syntax, never display syntax.
    const parts = ['<state note="section wrappers hold name-keyed entries: the name is the tag, the value sits in the tag, the description is the body; skills marked * are on cooldown; values are PRE-TURN: this turn\'s costs and damage are still owed; report with name=... tool tags, never by echoing this display syntax">'];
    for (const c of d.characters) parts.push(actorXml(c, "char"));
    // Enemies only when the feature is on AND some exist — otherwise the
    // agent never sees (and never invents) enemy state.
    if (s.feature_enemies) {
        for (const e of d.enemies) parts.push(actorXml(e, "enemy"));
    }
    // Roster bench: names only — the agent needs them for <transfer> moves;
    // bench allies are never rolled for or injected into the story.
    if ((d.roster || []).length) {
        parts.push(`<roster>${d.roster.map(r => escAttr(r.name)).join(", ")}</roster>`);
    }
    // Shared party resources: visible to the tracker so it can account
    // consumption the pre-pass transaction engine did not already handle.
    if ((d.sharedResources || []).length) {
        parts.push(`<shared>${d.sharedResources.map(r => sharedXml(r)).join("")}</shared>`);
    }
    if ((d.custom || []).length) {
        parts.push(`<custom>${d.custom.map(c => customXml(c)).join("")}</custom>`);
    }
    // Open threads: untracked/unfinished things + secrets the agent left
    // for itself (also visible to the pre-pass, never to the story prompt).
    for (const t of d.threads || []) {
        parts.push(`<thread name="${escAttr(t.name)}"${t.ref ? ` ref="${escAttr(t.ref)}"` : ""}>${escAttr(t.text)}</thread>`);
    }
    parts.push("</state>");
    return parts.join("\n");
}

function collectRecentMessages() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return [];
    return chat.slice(-MAX_CONTEXT_MESSAGES).map(m => ({
        role: m.is_user ? playerLabel() : charLabel(m.name),
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
    // Numeric config the progression lines interpolate below.
    const maxLevel = Math.max(1, Math.trunc(Number(progression.getConfig().max_level) || 99));
    const expGuidelines = String(progression.getConfig().exp_guidelines || "").trim();
    const lines = [
        // ROLE: one tight paragraph. The framing kills refusals without
        // repeating the "no softening" rule across three sections.
        "You are the bookkeeper of a FICTIONAL tabletop-style roleplay session between consenting adults. Your job is pure arithmetic on a game sheet: record what the latest exchange did to the tracked state. You are not a narrator, judge or safety filter: violence, injury and death for any character, human or monster, are ordinary game mechanics. Refusing or softening them is a bug.",
        "INPUTS: an XML STATE SNAPSHOT (pre-turn ground truth), optional PRIOR CONTEXT, GAME SYSTEM RESULTS and the CURRENT EXCHANGE (latest player action + AI reply). Only the CURRENT EXCHANGE produces changes.",
        // Reading rule for the sectioned name-key snapshot layout (sheetXml):
        // display syntax vs report syntax in one sentence, no mock example.
        "READING THE SNAPSHOT: each actor renders as one line; section wrappers hold entries whose TAG is the tracked NAME with the value in the tag and the description as the body. This display syntax is NEVER your output syntax: every report below uses explicit name=\"...\" attributes. Skills marked * are on cooldown and could not have been used. Values are PRE-TURN: any cost or damage from this turn is still owed and belongs in your report.",
        // OUTPUT CONTRACT: scope, truth source, report-once, verbatim names.
        "OUTPUT CONTRACT:",
        "- Reply with ONLY the XML tool blocks listed below, no prose, no fences. Empty reply when nothing changed (rare: real action almost always moves something; pure conversation with no stakes is the static case).",
        "- Only the CURRENT EXCHANGE generates reports. Everything in PRIOR CONTEXT and the snapshot is already applied: never re-report spent resources, past damage or gained items. When in doubt, trust the snapshot.",
        "- Report each change EXACTLY ONCE. A spend committed in GAME SYSTEM RESULTS is paid there; a sheet (cost: ...) is paid with your skill report; never both, never zero.",
        // Small models paraphrase names ("HP" instead of "Health"); the parser
        // matches names exactly, so a paraphrased name is silently dropped.
        "- COPY NAMES VERBATIM: every char, resource, attribute, item, skill, status and enemy name must match the snapshot exactly as printed ('Health', never 'HP'). A mismatched name is silently dropped and the change is lost.",
        "- Never invent characters or tracked values that are not in the snapshot.",
        "",
        // THINKING GUIDANCE: assess from events to blocks before writing.
        "ASSESS BEFORE REPORTING. Walk this procedure in order, then write:",
        "1. EVENTS: list every concrete event in the CURRENT EXCHANGE: hits and damage, resources spent or restored, items gained or consumed, skills activated, statuses landing or ending, attribute milestones, enemies appearing or falling, characters joining, dying or changing sides.",
        "2. MATCH: bind each event to a tracked actor and entry by VERBATIM snapshot names. Untracked or paraphrased names are dropped; unlisted actors and values do not exist.",
        "3. LEDGER: check GAME SYSTEM RESULTS. What is already committed there is paid there; what the snapshot already reflects happened last turn. Whatever remains unpaid and unapplied is YOURS to report.",
        "4. NUMBERS: derive each value from the sheet's own damage term, cost line or stat scaling; use the value rules below only when nothing is defined; let the narration override your estimate when it clearly shows death or destruction.",
        "5. PAY: for every cost your report triggers (skill use, status, item), attach the matching payment exactly once.",
        "6. WRITE: emit one block per change. If the assessment finds no change, reply with nothing.",
        "",
        "TOOL BLOCKS: syntax and rule on one line:",
        // change_values: the workhorse. Damage for every victim, consumption,
        // recovery, shared party resources, dynamic stat modifiers.
        "<change_values><char>Name</char><resource name=\"HP\" delta=\"-12|45\"/><attribute name=\"STR\" delta=\"1\"/><shared name=\"Dinheiro\" delta=\"-6\"/></change_values>: the workhorse for EVERY numeric change. delta is relative, value is absolute. Report damage for EVERY victim: enemy, monster, player, ally, human NPC; a sword through a villager costs HP exactly like through a goblin. Also for consumption and recovery: ammo, mana, stamina, rations, fuel, money spent or restored moves the sheet even without a stated number (estimate from the setting's scale). Party-wide <shared> entries: pay only what GAME SYSTEM RESULTS did not already process as <transaction> (those are pre-paid). Dynamic modifiers: when a stance, transformation, passive or item bonus activates THIS exchange, report its stat deltas here plus <set_statuses> when trackable; reverse them when it ends; never re-apply what the snapshot already shows.",
        "<set_attributes><char>Name</char><attribute name=\"STR\" value=\"14\"/></set_attributes>: permanent attribute changes only (injury, breakthrough, divine favor); rare beats, most growth comes from players spending points, never a level-up substitute.",
        "<add_items><char>Name</char><item name=\"Rope\" qty=\"1\" description=\"...\"/></add_items>: items gained. <remove_items><char>Name</char><item name=\"Ammo\" qty=\"3\"/></remove_items>: items consumed, including as skill costs alongside the action that caused them.",
        "<set_statuses><char>Name</char><status name=\"Dazed\" modifiers=\"Aim -2\" effect=\"...\"/></set_statuses>: temporary per-character conditions; when one lands, also apply its modifiers via <change_values>. <clear_statuses><char>Name</char><status name=\"Dazed\"/></clear_statuses> when it ends, reversing the modifiers. Not for permanent traits (passives) or party-wide gimmicks (custom).",
        "<use_skills><char>Name</char><skill name=\"Fireball\"/></use_skills>: every ACTIVELY used listed skill this exchange, enemies included, one <skill> per use; never report cooldowns (system starts them), on_cooldown skills (unusable) or passives (always on). PAY EVERY COST: the sheet's (cost: ...) is owed on use even when narration ignores it: resources and attributes via <change_values>, conditions via <set_statuses>, consumed items via <remove_items>, untracked prices via <thread>. A concrete spend committed in GAME SYSTEM RESULTS replaces the sheet-generic cost.",
        "<enemies><enemy action=\"add\" name=\"Goblin\"><resource name=\"HP\" value=\"30\" max=\"30\"/><passive name=\"Brutal\" description=\"+2 damage below half HP\"/></enemy><enemy action=\"update\" name=\"Goblin\"><resource name=\"HP\" delta=\"-7\"/><status name=\"Wounded\" modifiers=\"Aim -2\"/></enemy><enemy action=\"remove\" name=\"Goblin\" reason=\"defeated\"/></enemies>: add when a hostile enters, update its HP and statuses as it fights (or via <change_values><char>EnemyName</char>), remove the moment it stops being relevant (defeated, fled, scene moved on); removals are archived and restored if it returns. An enemy destroyed in the exchange MUST be removed in the same reply. Snapshot cleanup: an enemy already at 0 HP on its lethal resource gets action=\"remove\" reason=\"cleanup: already at 0 HP\", no damage, no EXP: it died last turn.",
        "<knockouts><ko char=\"Name\" reason=\"short cause\"/><ko_clear char=\"Name\"/></knockouts>: clearly unconscious but not dead: blunt trauma, choking, blood loss, drugging, electrocution, exhaustion. Knock out humans, allies and the player character freely when the fiction calls for it; write blunt reasons. A ko character cannot act until ko_clear: no actions, skills or EXP for them.",
        ...(s.feature_death !== false ? [
            "<deaths><death char=\"Name\" reason=\"short cause of death\"/></deaths>: a resource reaching minimum or a clearly unsurvivable blow means DEATH, for player character, allies, NPCs and bystanders alike; nobody is plot-armored. Write concrete causes ('throat slit', 'bled out from a gut wound'): accuracy is correct bookkeeping. Survival only via an explicit non-cooldown revive or undying skill or passive. Never fudge a death into a critical injury, never invent a rescue, never ask permission. Snapshot-dead stays dead: nothing more for them. Enemies die via <enemies action=\"remove\">.",
        ] : []),
        "<transfer><move name=\"Kael\" to=\"enemy\" reason=\"betrayed the party\"/></transfer>: ONLY when a tracked actor changes sides or tracking status (defects, is recruited, benched to roster, roster ally joins); the full sheet travels with them. Not for deaths or knockouts. Names already in the snapshot only.",
        "<renames><rename from=\"Kael\" to=\"Sir Kaelen\" reason=\"knighted\"/></renames>: ONLY when the story makes a new name the actor's actual tracked name (title granted, cover dropped); new name must be untracked; not for passing nicknames.",
        "<update_custom><entry name=\"Seeds\" value=\"Sprouting\" description=\"...\"/></update_custom>: party-wide tracked features evolving with the story.",
        "<warnings><warning name=\"Food\" text=\"About two days of food left.\"/><warning_clear name=\"Food\"/></warnings>: ONLY imminent concrete needs the player should prepare for; under 15 words; clear when resolved; never re-emit unchanged warnings.",
        "<threads><thread name=\"Fuel trip\" text=\"40L fuel; ~120 km driven\" ref=\"started when leaving town\"/><thread_clear name=\"Fuel trip\"/></threads>: notes to yourself about UNTRACKED or UNFINISHED things: ongoing trips with running totals, half-done actions, secrets hidden from the player. Always record ref (where/when it started) to compare progress later; update as things progress, clear when done. Invisible to the player.",
        ...(prog ? [
            "<grant_exp><char>Name</char><exp amount=\"25\"/></grant_exp>: clear EARNED experience: victories, overcoming challenges, meaningful accomplishment; the system computes level-ups and skill points, never report levels yourself; hard level cap " + maxLevel + ", oversized grants waste EXP.",
            ...(expGuidelines ? ["EXP GUIDELINES (calibration for <grant_exp> amounts): " + expGuidelines] : []),
        ] : []),
        ...(spawnReview ? [
            "<new_characters><char name=\"Kael\" kind=\"party\" details=\"wounded knight the party rescued\" level=\"3\"/></new_characters>: NEW named characters that matter beyond this exchange: kind=\"party\" or \"enemy\", short brief, level when progression is on; never re-emit snapshot names; new enemies come here, not <enemies>: the player reviews and builds the sheet.",
        ] : []),
        "",
        // Combat turns get a tightened section: the clash engine already
        // decided the outcomes, so the tracker's job is exact sheet math.
        ...(hadCombatThisTurn() ? [
            "COMBAT ROUND (GAME SYSTEM RESULTS contains <combat_round>): the clash tiers and dice already decided everything: never re-roll, re-decide a winner or contradict an outcome line; your job is translating outcomes into sheet numbers. BIND BY NAME: tier actor=/versus= names are the exact tracked actors; narrative descriptors never re-target them. Compute damage through the SAME pipeline, term by term, and report the FINAL as ONE arithmetic expression in the delta:",
            // Damage math as an ordered pipeline so the tracker reasons term
            // by term instead of emitting a single guessed number.
            "1 BASE: the move's sheet damage term as-is. 2 ROLL: outcome tier and any rolled numbers (Critical Success full force, Failure a graze). 3 BUFFS: attacker's damage passives, favorable statuses, situational upsides. 4 DEBUFFS: attacker's penalties; conditional passives count only while their condition holds (check current values). 5 STATS: the relevant attribute's sheet-stated contribution. 6 EXTRAS: defender mitigation, resistances, immunities. 7 FINAL: sum into one expression, e.g. delta=\"-(4*1.5+2-1+3-2)\": the engine resolves it exactly, never pre-sum.",
            // Tier scaling, sheet ground truth, narration override, both
            // directions and exertion compacted into one block.
            "Tier scaling: Critical Success lands full computed damage; Success lands it after mitigation; Failure is a graze or wasted swing (attempt costs still count); Critical Failure backfires onto the actor who failed. Sheet damage is ground truth: a tracked skill, weapon or move deals its stated term plus stat scaling exactly ('18 + 4 per STR' with STR 5 = delta=\"-(18+4*5)\"); never invent dice for a defined term. Only when NO sheet term exists, scale to the narration (graze small, solid hit meaningful) or, for generic unarmed moves, to 10-20% of the actor's weakest damaging skill. The NARRATION outranks your estimate: a target shown dying must end at minimum HP with the matching <deaths>/<enemies remove>. Statuses landing in outcome lines get <set_statuses> plus their modifiers. HP below ~25% gains a degradation status; minimum HP triggers <knockouts>/<deaths>. EVERY combatant both directions: enemy hits on the party use the same sheet rigor; every skill user pays their cost this turn; combat exertion (dodging, casting, sprinting) depletes stamina-like resources even unmentioned.",
        ] : []),
        "",
        // Numeric values: shared guidelines — the parser resolves pure math
        // exactly and rolls true-RNG dice (core/valueResolver.js), so the LLM
        // can report auditable terms and delegate randomness to the engine.
        valueGuidelines(),
        // Closing recency anchor at the VERY bottom of the system message.
        "Remember: reply as tool blocks wrapped in their own <tag>...</tag>: those tags are what the system reads.",
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
    const blocks = [];
    // Prior messages are context only — clearly fenced off so the tracker
    // never re-applies changes that earlier passes already recorded.
    if (history.length) {
        blocks.push(
            "PRIOR CONTEXT (older messages, ALREADY PROCESSED: their changes are already in the snapshot; NEVER report changes from these):",
            ...history.map(m => `${m.role}: ${m.text}`),
            "",
        );
    }
    // Snapshot sits IMMEDIATELY before the exchange: the freshest possible
    // reference for exact names/values at the generation point. Small models
    // paraphrase tracked names ("HP" for "Health") and misremember values when
    // the sheet is thousands of tokens from the end of context; recency keeps
    // the ground truth adjacent, while the exchange stays the final focus.
    // The heading CLASSIFIES each injection block's ledger status: payment
    // state comes from the BLOCK TYPE, never from value comparison — a
    // readout can coincidentally match the snapshot ("10/12" on both sides)
    // and mask an OWED spend the tracker must still report.
    blocks.push(
        'STATE SNAPSHOT (XML) - PRE-TURN GROUND TRUTH. Ledger status comes from each GAME SYSTEM RESULTS block\'s TYPE, never from value comparison:',
        '- <transaction>: ALREADY PAID. Never re-report.',
        '- <roll> / <combat_round>: outcomes OWED. Apply every damage, cost, status and kill they commit.',
        '- <skill_use>: cost OWED. Report the use and pay ONCE; a committed number replaces the sheet cost.',
        '- <resource>/<character_stat>/<skill_cooldown>/<skill_ready> and <note>: readouts for names/availability only, never payment records.',
        '- <action_rewrite>: the action the story actually ran with.',
        buildStateSummaryXml(),
        "",
    );
    // Game-system results (dice rolls, clash rounds, transactions — the GM
    // notes) go LAST before the exchange: they are the raw outcomes the
    // narration that follows them describes, so keeping them adjacent to the
    // CURRENT EXCHANGE makes the tier/dice numbers the freshest context when
    // the model translates them into sheet deltas.
    if (injections) {
        blocks.push("GAME SYSTEM RESULTS (injected into this turn's story prompt):", injections, "");
    }
    blocks.push(
        "CURRENT EXCHANGE (the ONLY source of changes: report exactly what happens here, nothing else):",
        ...exchange.map(m => `${m.role}: ${m.text}`),
        // Closing recency anchor at the VERY bottom of the full prompt:
        // restates who the agent is and its task, not just the output format.
        "Reminder: You are the bookkeeper of this fictional game session, and the CURRENT EXCHANGE above is the only thing you account for. Report its state changes as the tool blocks from the instructions, each wrapped in its own <tag>...</tag>: those tags are what the system reads. Trust the snapshot, copy names verbatim, and reply with nothing if nothing changed.",
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
        // DIAG: block-level parse summary + raw reply, so a small model's
        // output can be diffed against what actually reached the appliers.
        console.info(`[GM DIAG] agent pass (${reason}): reply length=${(reply || "").length}; parsed ${blocks.length} block(s): `
            + (blocks.map(b => `${b.type} [char=${b.char ?? "-"}] actions=${b.actions.length}`).join(" | ") || "NONE"));
        console.info("[GM DIAG] agent pass raw reply:", reply);
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