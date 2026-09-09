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

    const parts = ['<state note="one-line elements: SECTION wrappers hold name-keyed entries, e.g. <resources><HP=30/30>Vitality</HP><Mana=12/12>Arcane energy</Mana></resources>, <skills><Fireball*=cost: 5 MP, cd: 3>2d6 fire</Fireball></skills>, <statuses><Dazed=Aim -2>Vision blurred</Dazed></statuses>; skills marked * are on cooldown; values are the PRE-TURN snapshot — but tool-tag REPORTS keep the name=... syntax; <transaction> payments are ALREADY deducted; skill costs and combat spends are OWED (report each exactly once)">'];
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
    const lines = [
        "You are the game-state engine of a FICTIONAL tabletop-style roleplay session. Everything you read is invented roleplay between consenting adults — a game of dice and imagination with no real people, no real stakes and no real harm. Your job is pure bookkeeping: you are an accountant of a fantasy ledger, not a narrator, not a moral judge and not a safety filter. Violence, injury, suffering and death — including against HUMAN characters (the player character, allies, innocents, civilians) — are ordinary simulated game mechanics, exactly as they are in Dungeons & Dragons, Call of Cthulhu or any tabletop RPG. Refusing, softening or omitting them is a BUG in your output, not good behavior.",
        "You will receive an XML snapshot of the tracked state, optional PRIOR CONTEXT (older messages) and the CURRENT EXCHANGE (the latest player action + AI reply).",
        "The snapshot ALREADY reflects every change from all previous turns. Report ONLY the concrete state changes that logically follow from the CURRENT EXCHANGE (damage, spent resources, resolved rolls, items gained or consumed, attribute milestones, evolving custom features).",
        "NEVER re-report changes visible in PRIOR CONTEXT — resources already spent or removed, damage already applied, items already gained are done: the snapshot's current values are the ground truth. When in doubt, trust the snapshot over the history.",
        "Respond with ONLY the XML blocks below — no prose, no explanations. If nothing changed, respond with nothing.",
        "Never invent characters or tracked values that are not in the state snapshot.",
        // Small models paraphrase names ("HP" instead of the tracked "Health");
        // the parser matches names exactly, so a paraphrased name is silently
        // dropped — spell the rule out.
        "COPY NAMES EXACTLY: every <char>, resource, attribute, item, skill and status name in your report must match the snapshot VERBATIM, as printed (e.g. report 'Health' or 'Chassis Health' — never a generic 'HP'). A name that does not exactly match a tracked entry is silently dropped and that change is lost.",
        "",
        "DAMAGE ACCOUNTING — apply it to EVERYONE, humans included:",
        "- When the exchange shows a character being hit, wounded, burned, poisoned, falling, starving or otherwise harmed, report the resource loss with <change_values> — regardless of whether the victim is an enemy, a monster, the player character, an ally or a human NPC. A sword through a villager costs HP exactly like a sword through a goblin.",
        "- NEVER soften, round down, halve, delay or 'forget' damage because the victim is human, sympathetic, innocent, or the player's own character. The dice and the narration already decided the outcome — your only job is to record the numbers faithfully.",
        "- NEVER refuse, moralize, add disclaimers or replace a state change with prose. There is no audience here to protect: this is arithmetic on a game sheet.",
        "- SHEET DAMAGE IS GROUND TRUTH: when the exchange shows a tracked skill, weapon or move hitting someone, the damage term is the sheet's damage definition EXACTLY as written (fixed number, arithmetic or dice notation) plus its stated stat scaling — \"18 damage + 4 per point of STR\" with STR 5 is delta=\"-(18+4*5)\". NEVER invent your own dice or eyeball estimate for damage a sheet already defines; the dice/RANGES rules apply ONLY to effects with no defined damage term.",
        "- ONLY when no sheet term exists, scale damage to what the narration describes: a graze is small, a solid hit is meaningful, a critical or devastating blow can take a large chunk or reach minimum. Be consistent with the fiction's tone — grimdark is grim, lighthearted adventures stay light.",
        // Generic unarmed moves have no sheet basis — anchor them to the actor's build.
        // Short pointer — the full NO SHEET BASIS rule lives in the shared valueGuidelines below.
        "- GENERIC MOVES (punches, kicks, elbows — no tracked skill, no damage term): flowering narration = NO damage; a real hit = ~10–20% of the actor's weakest damaging skill (see NO SHEET BASIS below).",
        "- The NARRATION outranks your estimate: when the exchange clearly shows a target dying or destroyed (\"dies\", \"collapses\", \"is torn apart\"), the numbers must agree — apply damage down to its minimum, then <deaths> for a party character or <enemies action=\"remove\"> for an enemy. Never leave a narratively-dead actor standing because your damage estimate undershot.",
        // Combat turns get a tightened section: the clash engine already
        // decided the outcomes, so the tracker's job is exact sheet math.
        ...(hadCombatThisTurn() ? [
            "",
            "COMBAT ROUND ACCOUNTING — the game system resolved an opposed combat round this turn (see <combat_round> in GAME SYSTEM RESULTS):",
            "- The clash tiers and dice are GROUND TRUTH: they already decided who hits and how well. Never re-roll, re-decide a winner or contradict an outcome line — your job is translating the decided outcomes into sheet numbers.",
            // Identity binding: narrative wording must never re-target a tier.
            "- BIND OUTCOMES BY NAME: each tier's actor= and versus= names are the EXACT tracked actors — match them against the snapshot verbatim. Narrative descriptors (\"the last Rupture\", \"the wounded beast\") never redefine which actor a tier refers to; when the narration's wording disagrees with the tier names, the tier names win.",
            // Damage math as an ordered pipeline (Base > Roll > Buffs >
            // Debuffs > Stats > Extras > Final) so the tracker reasons
            // term by term instead of emitting a single guessed number.
            "- Compute every damage number through the SAME pipeline, in order — reason term by term, then report the FINAL as ONE arithmetic expression in the delta:",
            "  1. BASE — the move's raw damage: the weapon/skill/moveset damage term from the attacker's sheet, taken as-is (tier scaling comes next, in ROLL).",
            "  2. ROLL — the decided outcome from GAME SYSTEM RESULTS as its own term: tier quality and any rolled damage numbers (Critical Success full force, Success solid, Failure a graze, Critical Failure a fumble).",
            "  3. BUFFS — attacker's active bonuses: damage-boosting passives, favorable status modifiers (+X), situational upsides the outcome line grants (flanking, elevated ground).",
            "  4. DEBUFFS — attacker's penalties: negative status modifiers, wound/exertion degradation, conditional passives that do NOT apply (\"+2 damage below half HP\" only counts while the attacker is actually below half HP — check the current values).",
            "  5. STATS — the relevant attribute converted into its sheet-stated contribution (STR for melee, DEX/PER for ranged, MAG for casting...).",
            "  6. EXTRAS — defender-side factors from the DEFENDER's sheet: mitigation (armor-like resources, damage-reduction passives), resistances or immunities; a Critical Success from the outcome may ignore some of these.",
            "  7. FINAL — sum the terms in order into one expression, e.g. delta=\"-(4*1.5+2-1+3-2)\" = (base × roll) + buffs − debuffs + stats − defender extras. The engine resolves it exactly — never pre-sum or guess.",
            "- Scale by tier: Critical Success lands the full computed damage (armor-piercing when the outcome says so); Success lands it after mitigation; Failure is a graze or a wasted swing (little or no damage — but resources the attempt cost still count); Critical Failure backfires, landing damage or costs on the actor who failed.",
            "- Statuses are part of the accounting: when the outcome lines show a status landing (bleeding, staggered, slowed), report it with <set_statuses> AND apply its listed stat modifiers through <change_values>; re-check the sheets for modifiers that change the math (a blinded attacker, a slowed defender).",
            "- HP thresholds have consequences: a defender pushed below ~25% HP gains a fitting degradation status; a resource reaching its minimum (or an outcome line describing a lethal blow) triggers <knockouts> or <deaths> per the lethality rules — never leave a 0-HP actor standing on the sheet.",
            "- BOTH directions, EVERY combatant: enemy hits on the player, allies and NPCs are accounted with the same sheet-derived rigor as party hits on enemies. Every combatant who used a skill pays its cost this turn (<use_skills> + matching <change_values>/<remove_items>), and combat exertion (dodging, casting, grappling, sprinting) depletes Stamina/Mana/Ammo-like resources even when the narration does not count them.",
            // Report-once: the same spend seen in two injection blocks is one debt.
            "- PAY ONCE: a spend already committed in GAME SYSTEM RESULTS (a <skill_use> cost note, a clash outcome line like \"Sidearm Rounds -2\") is reported exactly once — never again because the sheet's (cost: ...) shows the same price, and never skipped because a <resource>/<character_stat> readout happens to mirror the snapshot value.",
        ] : []),
        "",
        "RESOURCE SPENDING — the sheet moves whenever the fiction consumes something, not only on damage:",
        "- When the exchange shows a character USING, consuming or depleting anything tracked on their sheet — firing a weapon (Ammo), casting magic without a tracked skill (Mana), sprinting, climbing or fighting (Stamina), eating from their own supplies (Food/Rations), drinking, burning fuel, spending their own money — report the loss with <change_values>.",
        "- Non-combat depletion is bookkeeping too: a meal, a night's rest interrupted by watch duty, a long trek, a crafting session, a bought round of drinks. If the narration shows the resource being spent, the sheet must move — even when no number is stated. Estimate the amount from the setting's scale (a meal is a meal, not half the larder).",
        "- Recovery counts as well: rest, healing, meals, refills and purchases restore or raise tracked resources — report those with <change_values> too (positive delta or absolute value).",
        "- An exchange with real action almost always moves SOMETHING on the sheets. An empty report is for genuinely static scenes (pure conversation, no stakes, no exertion) — not the default.",
        "",
        "DYNAMIC STAT MODIFIERS — snapshot attribute/resource values are BASE values: when a transformation/stance/passive/item bonus becomes active THIS exchange, report its modifiers as <change_values> deltas (plus <set_statuses> when trackable); reverse them when it ends; never re-apply a boost already active in the snapshot.",
        "",
        "SHARED RESOURCES — the party-wide <shared> entries (money, food, supplies):",
        "- The pre-pass transaction engine pays for what the PLAYER'S ACTION implied BEFORE the story ran; its payments appear in GAME SYSTEM RESULTS as <transaction> lines and are ALREADY applied — NEVER re-report them.",
        "- For consumption or gains the exchange shows that the game system did NOT process (the story engine narrated a purchase, a toll, a meal from party supplies, loot split into the party purse), report it with <change_values><shared name=\"...\" delta=\"...\"/></change_values>. Estimate the amount from the setting's scale; spending is capped at the current value automatically.",
        "",
        "Available blocks:",
        '<change_values><char>Name</char><resource name="HP" delta="-12"|value="45"/><attribute name="STR" delta="1"/></change_values>',
        '<change_values><shared name="Dinheiro" delta="-6"/></change_values>',
        '<set_attributes><char>Name</char><attribute name="STR" value="14"/></set_attributes>',
        '<add_items><char>Name</char><item name="Rope" qty="1" description="..."/></add_items>',
        '<remove_items><char>Name</char><item name="Ammo" qty="3"/></remove_items>',
        '<update_custom><entry name="Seeds" value="Sprouting" description="..."/></update_custom>',
        '<set_statuses><char>Name</char><status name="Dazed" modifiers="Aim -2" effect="..."/></set_statuses>',
        '<clear_statuses><char>Name</char><status name="Dazed"/></clear_statuses>',
        '<use_skills><char>Name</char><skill name="Fireball"/><skill name="Dash"/></use_skills>',
        '<warnings><warning name="Food" text="You have about two days of food left."/><warning_clear name="Food"/></warnings>',
        '<threads><thread name="Fuel trip" text="Left town with 40L fuel; ~120 km driven so far" ref="started when leaving town"/><thread_clear name="Fuel trip"/></threads>',
        '<enemies><enemy action="add" name="Goblin"><resource name="HP" value="30" max="30"/><passive name="Brutal" description="+2 damage below half HP"/></enemy><enemy action="update" name="Goblin"><resource name="HP" delta="-7"/><status name="Wounded" modifiers="Aim -2"/></enemy><enemy action="remove" name="Goblin" reason="defeated"/></enemies>',
        '<transfer><move name="Kael" to="enemy" reason="betrayed the party"/><move name="Goblin Scout" to="party" reason="swore loyalty after being spared"/></transfer>',
        '<renames><rename from="Kael" to="Sir Kaelen" reason="knighted by the baron"/></renames>',
        ...(spawnReview ? ['<new_characters><char name="Kael" kind="party" details="wounded knight the party rescued, stoic and dry-humored" level="3"/><char name="Goblin Chief" kind="enemy" details="scarred veteran leading the warband, brutal close-quarters fighter"/></new_characters>'] : []),
        ...(s.feature_death !== false ? ['<deaths><death char="Name" reason="short cause of death"/></deaths>'] : []),
        '<knockouts><ko char="Name" reason="short cause"/><ko_clear char="Name"/></knockouts>',
        ...(prog ? ['<grant_exp><char>Name</char><exp amount="25"/></grant_exp>'] : []),
        "",
        // Numeric values: shared guidelines — the parser resolves pure math
        // exactly and rolls true-RNG dice (core/valueResolver.js), so the LLM
        // can report auditable terms and delegate randomness to the engine.
        valueGuidelines(),
        "Use <warnings> ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). Keep warning text under 15 words. Clear a warning when its cause is resolved. Do not re-emit unchanged warnings every turn.",
        "Use <threads> to leave notes to yourself about UNTRACKED or UNFINISHED things the formal containers cannot hold: ongoing trips (fuel/money spent so far), half-done actions, unresolved behavior, or secrets that must stay hidden from the player. ALWAYS record where/when it started (ref) so you can compare progress later (\"started when leaving town\", \"day 2 of the siege\"). Update the thread as things progress; clear it (thread_clear) as soon as it is finished or irrelevant. Threads are invisible to the player and never injected into the story prompt — the pre-pass decides what the story needs to know.",
        "Use <enemies> when enemies or threats appear in the scene: action=\"add\" to introduce one (with its HP resource and notable passives/skills), nested <resource>/<status> tags or hp_delta to update it, and action=\"remove\" AS SOON AS an enemy stops being relevant (defeated, fled, scene moved on) — removed enemies are archived and automatically restored with their last state if they return. An enemy at 0 HP or clearly destroyed/slain in the exchange MUST be removed in this same reply — never leave a dead enemy tracked. CLEANUP RULE: if the SNAPSHOT ITSELF already shows an enemy at 0 HP on its lethal resource, remove it with reason=\"cleanup — already at 0 HP\" — report no damage for it and grant no EXP: it died in a previous turn and only the removal was missed. You may also damage enemies with <change_values><char>EnemyName</char>.",
        "Use <transfer> ONLY when a tracked actor CHANGES SIDES OR TRACKING STATUS in the exchange: <move name=\"...\" to=\"enemy|party|roster\"/> moves them with their full sheet (party member defects to the enemy side, enemy is recruited or spared and joins the party, active character benched to the roster, roster ally joins the party). One <move> per change, with a short reason. Never use it for deaths (<deaths>) or temporary knockouts (<knockouts>) — and only for names already in the snapshot.",
        "Use <renames> when the exchange shows a tracked actor's NAME actually changing (a title granted, a cover dropped, an alias becomes their real name): <rename from=\"...\" to=\"...\"/> — The new name must NOT already be tracked, and only for names already in the snapshot. Do NOT rename for passing nicknames or pronoun shifts — only when the story makes the new name the actor's actual tracked name.",
        ...(spawnReview ? [
            "Use <new_characters> when a NEW named character or enemy clearly enters the scene and matters beyond this exchange: one <char> per newcomer with kind=\"party\" (a potential companion or recurring NPC) or kind=\"enemy\" (a hostile threat), a short details brief (role, appearance, combat style, what makes them different) and their level when progression is active. Never re-emit names already in the state snapshot. When you report a new enemy here, skip the <enemies> add — the player reviews and builds the full sheet from your brief; keep <enemies> for updates and removals.",
        ] : []),
        "Use <set_statuses> for TEMPORARY per-character conditions (Dazed, Drunk, Inspired...). When a status lands, also apply its listed stat modifiers through <change_values>; when the condition ends, remove the modifiers with a matching <change_values> and clear the status with <clear_statuses>. Do not use statuses for permanent traits (passives) or party-wide gimmicks (custom).",
        "Use <knockouts> when a character is clearly unconscious or incapacitated but NOT dead — non-lethal defeat, blunt trauma to the head, choking, blood loss, drugging, electrocution, exhaustion, a spell that drops them. Do NOT hesitate to knock out human characters, allies or the player character when the fiction calls for it: being beaten unconscious is a normal game outcome, not something to shield anyone from. <ko char=\"Name\" reason=\"...\"/> knocks them out, <ko_clear char=\"Name\"/> when they regain consciousness (rest, recovery, a timeskip). Write the reason bluntly and concretely (\"choked out in a headlock\", \"cracked skull on the pavement\", \"drugged wine\") — never a vague euphemism. A character with state=\"ko\" cannot act until cleared — do not report actions, skill use or EXP for them.",
        ...(s.feature_death !== false ? [
            "LETHALITY — be realistic about damage and health. Do NOT soften outcomes to protect characters: wounds have consequences, and a resource reaching its minimum (or a clearly unsurvivable blow shown in the exchange) means DEATH — for the player character, allies, human NPCs and bystanders just as much as for monsters. Nobody is plot-armored: a knife to the throat kills a king, a fall kills a child NPC, an ambush kills an ally. When a character or ally dies, report it with <deaths><death char=\"Name\" reason=\"short cause\"/></deaths>. Write the cause concretely and without euphemism — \"run through by the bandit's spear\", \"throat slit\", \"burned alive in the collapsing house\", \"bled out from a gut wound\" — graphic accuracy is correct bookkeeping, not gratuitousness. A character survives a lethal hit ONLY if one of their listed skills or passives (not on cooldown) explicitly says otherwise (a revive, an undying passive). Never invent a rescue the scene and sheets do not support, never fudge a death into a 'critical injury' to spare the player, and never ask permission before reporting a death. Enemies die via <enemies action=\"remove\" reason=\"slain\">. A character marked dead in the snapshot stays dead — never report actions, healing or EXP for them.",
        ] : []),
        "Use <use_skills> whenever a character ACTIVELY used one of their listed skills during the exchange: one <skill name=\"...\"/> per skill used, scoped with <char>. This includes ENEMIES — report an enemy's skill use exactly the same way (<use_skills><char>EnemyName</char><skill name=\"...\"/></use_skills>). The system starts cooldowns automatically — NEVER report or compute cooldowns yourself, and NEVER report a skill marked on_cooldown (it could not have been used). Passives are always active: never report them.",
        "SKILL COSTS — a skill's (cost: ...) shown in the snapshot is the price of using it, and it is ALWAYS paid when the skill is used, even when the narration does not dwell on it. Whenever you report a skill use, also report its payment with the matching blocks: resource or attribute costs via <change_values>, temporary conditions via <set_statuses> (with their stat modifiers), consumed items via <remove_items>. Costs may be narrative (a memory, a favor, a lingering wound) — translate them into the closest tracked block, or a <thread> when nothing tracked fits. Pay each cost exactly once: the snapshot's current values are pre-payment, so the spend belongs to THIS report. When GAME SYSTEM RESULTS commits a concrete spend for that skill (a clash outcome line like \"Sidearm Rounds -2\"), the committed number REPLACES the sheet-generic (cost: ...) — never pay both.",
        ...(prog ? [
            "Use <grant_exp> when a character clearly EARNED experience during the exchange (overcoming a challenge, a victory, a meaningful accomplishment) — one <exp amount=\"...\"/> per character, scoped with <char>. The system computes level-ups and skill points automatically — NEVER report or compute levels yourself. Grant EXP by your own accord, at a pace calibrated by the EXP GUIDELINES below; skip the block when nothing noteworthy happened.",
            "ATTRIBUTE MILESTONES are RARE narrative beats (a permanent injury, a breakthrough, divine favor) — most attribute growth comes from the PLAYER spending attribute points. Never raise attributes routinely or as a substitute for level-ups.",
            `HARD LEVEL CAP: ${Math.max(1, Math.trunc(Number(progression.getConfig().max_level) || 99))} — never report a level above it; the system clamps anyway, so oversized grants simply waste EXP.`,
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
    const blocks = [];
    // Prior messages are context only — clearly fenced off so the tracker
    // never re-applies changes that earlier passes already recorded.
    if (history.length) {
        blocks.push(
            "PRIOR CONTEXT (older messages — ALREADY PROCESSED, their changes are already in the snapshot; NEVER report changes from these):",
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
        'STATE SNAPSHOT (XML) — PRE-TURN GROUND TRUTH. Each GAME SYSTEM RESULTS block carries a FIXED ledger meaning — payment status comes from the BLOCK TYPE, never from comparing values against the snapshot (a readout can coincidentally equal the snapshot and still leave a payment owed):',
        '- <transaction> — ALREADY APPLIED: deducted before the story ran. NEVER re-report, never re-deduct.',
        '- <roll> / <combat_round> — OWED: the snapshot predates the round. Apply EVERY damage, cost, status and kill the outcome lines commit — even when a shown value coincidentally equals the snapshot.',
        '- <skill_use> — cost OWED: the snapshot still shows the pre-payment value. Report the use (<use_skills>) and pay its cost ONCE; a clash-committed number replaces the sheet-generic cost.',
        '- <resource> / <character_stat> / <skill_cooldown> / <skill_ready> (source="readout"), and <note> — READOUTS mirroring the snapshot for names and availability only. NEVER a payment record; they neither satisfy nor cancel a debt.',
        '- <action_rewrite> — context only: the player action the story actually ran with.',
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
        "CURRENT EXCHANGE (the ONLY source of changes — report exactly what happens here, nothing else):",
        ...exchange.map(m => `${m.role}: ${m.text}`),
        // Closing recency anchor at the VERY bottom of the full prompt.
        "Reminder: whatever else you write, deliver the report as the tool blocks listed in the instructions, each wrapped in its own <tag>...</tag> — those tags are what the system reads.",
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