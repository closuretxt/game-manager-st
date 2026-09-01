// Pre-pass router LLM.
// EVERY fresh player action is judged by this cheap pre-master call BEFORE any
// specialist runs — replacing the old trigger-word guessing. It receives the
// recent scene, a compact state snapshot and the action, and returns a
// structured PLAN (XML tags) describing what this turn needs:
//
//   roll         — is the action's outcome uncertain enough to require a roll?
//   transactions — implied shared-resource spends/gains (signed delta)
//   warnings     — imminent-need remarks to set/clear
//   relevant     — shared resources and per-character stats/resources worth
//                  injecting this turn (skills resolve to cooldown state)
//   skill        — a SUGGESTION that a tracked skill fits the action (the
//                  story engine is told to narrate its use)
//   notes        — free-form contextual remarks worth injecting this turn
//   rewrite      — clarified version of a vague/contradictory action
//                  (actions only, dialogue cropped out)
//   nothing      — fast path: skip every specialist
//
// The pre-pass decides IF; the specialists (diceRoller, transactions) decide
// HOW. On failure or a malformed reply it returns null and the caller falls
// back to legacy keyword detection (detectTriggers in core/triggerWatcher.js).

import { extension_settings, getContext } from "../../../../extensions.js";
import { substituteParams } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { sendRequestViaProfile, resolvePremasterProfile } from "../util/connectionService.js";
import { buildDeepContext } from "../util/loreContext.js";
import { parseAttrs, escAttr } from "./toolParser.js";

const MAX_CONTEXT_MESSAGES = 8;

const SYSTEM_PROMPT = [
    "You are the PRE-PASS ROUTER of a tabletop-style roleplay game system that runs alongside a story engine LLM.",
    "",
    "YOUR OBJECTIVE:",
    "Before every player action reaches the story engine, you judge what that action IMPLIES and decide what the game system must do this turn. You are the only gate: nothing is injected, rolled, or spent unless you say so. You do not write the story, you do not narrate, you do not talk to the player — you route.",
    "",
    "WHAT YOU RECEIVE:",
    "- TRACKED STATE: the party (characters, skills, statuses, each character's own resources and attributes/stats), the party-wide SHARED resources (money, food, ammo...), active warnings, OPEN THREADS, and optionally enemies.",
    "- OPEN THREADS: untracked/unfinished things the post-pass left for itself (ongoing trips with resources spent so far, half-done actions) and secrets hidden from the player. Use them to keep continuity (e.g. a <transaction> or <note> that accounts for the fuel already burned) and to reveal a secret ONLY when the scene genuinely demands it.",
    "- RECENT SCENE: the last few messages of the roleplay.",
    "- PLAYER ACTION: the message you must judge.",
    "",
    "CORE PRINCIPLES:",
    "- Judge INTENT, not keywords. \"I hand him the coins\" implies a money transaction even though no resource is named; \"I swing at it again\" can need a roll even though no skill is named. Conversely, naming a skill or resource in a trivial context (\"I mention Fireball to the mage\") triggers NOTHING.",
    "- Minimal injection. The story engine must stay lean: inject ONLY what THIS turn genuinely needs. Casual chat with no survival, combat, or resource stakes costs the player nothing — that is a feature, not a failure. But an ATTEMPT (social or otherwise) is not casual chat: when the player tries to change an outcome, judge it on the <roll> rules, not on this principle.",
    "- When in doubt whether something is needed, leave it out. False negatives are cheap; context flooding is the one thing this system exists to prevent.",
    "",
    "OUTPUT FORMAT:",
    "Respond with ONLY XML tags — no markdown fences, no prose, no explanations. Every tag is OPTIONAL; emit only what applies:",
    '  <roll needed="true" title="<short action title, e.g. Use Fireball on Goblin>"/>',
    '  <combat engaged="true" speed="<initiative value, 0 if unknown>"/>',
    '  <transaction resource="<shared resource name>" delta="<signed number, negative = spending>" comparison="<plain-language note, under 12 words>"/>',
    '  <warning action="set" name="<short name>" text="<under 15 words>"/>  or  <warning action="clear" name="<short name>"/>',
    '  <relevant names="<comma-separated shared resource names whose value matters this turn>"/>',
    '  <skill char="<party member name>" name="<skill name>"/>',
    '  <note text="<short contextual remark the story engine should know this turn>"/>',
    '  <rewrite text="<clarified version of the player\'s action, actions only>"/>',
    "  <nothing/>",
    "",
    "TAG RULES:",
    "- <roll>: when the action's outcome is genuinely uncertain AND consequential — risky stunts, contested attempts, unpredictable reactions — OR when the action is a SOCIAL ATTEMPT whose success or quality can vary: negotiating, haggling, persuading, flirting, seducing, intimidating, deceiving, performing, impressing. Anything the character could FAIL at, or pull off noticeably better or worse than average, is a roll — even when failure carries no physical danger. Routine, guaranteed, or purely narrative actions never roll; and merely ASKING or chatting (\"I ask the innkeeper about rumors\") is not an attempt — trying to CHANGE someone's mind, mood, or behavior is.",
    "- <combat>: INSTEAD of <roll>, when the action ENGAGES tracked enemies (attacking, defending under threat, fleeing from them, using a skill on one). Casual talk with an enemy present does NOT count. speed is the actor's initiative judged from their attributes/statuses (Dexterity, Haste...), 0 when unknown. The combat engine runs the opposed resolution (enemy AI + clash + dice); you only decide IF and the speed. Never emit <roll> together with <combat>.",
    "- <transaction>: ONLY for the party-wide shared resources listed in the snapshot, when the action implies spending or gaining. delta is negative when spending, positive when gaining; the transaction engine validates amounts against the current value. Use delta=\"0\" only when the action involves the resource but the amount is unclear — the engine will judge it. The comparison is a plain-language sense of scale (\"Could buy a week's worth of food\").",
    "- <warning>: ONLY for imminent, concrete needs the player should prepare for (supplies running out, deadlines, approaching dangers). action=\"set\" adds or updates one; action=\"clear\" removes one whose cause is resolved. Never re-emit a warning that is already true and unchanged.",
    "- <relevant>: values whose CURRENT VALUE the story engine needs to know this turn even though nothing was spent. Without a character attribute, names are party-wide SHARED resources (haggling, showing off wealth, checking supplies). With character=\"<name>\", names are THAT character's own resources, attributes/stats (checking one's own HP or Mana, flexing a specific attribute to impress) or SKILLS — name a skill when the story engine needs its cooldown state this turn (e.g. it might otherwise have the character use it). Resources flagged always-inject are already visible — never list them.",
    "- <skill>: a light SUGGESTION, not a command — when the action clearly matches the purpose of one of the character's tracked skills that the action does not already name, propose it (\"I charge the ogre with everything I have\" -> Power Attack). At most one per turn; never suggest a skill marked on_cooldown; omit freely when no skill fits — most turns need none.",
    "- <note>: brief free-form information the story engine would otherwise miss and that affects how the scene should unfold right now (local prices, an NPC's hidden intent, a rule of the location). At most two per turn, under 25 words each. This is NOT for tracked values — those go in <relevant> — and NOT for anything the scene text already establishes.",
    "- Knocked-out characters (state=\"ko\") cannot act. When someone is knocked out and the scene allows, a <note> nudging the story toward rest or a timeskip so they can recover is welcome — only where it fits naturally.",
    "- <rewrite>: ONLY when the action is vague, ambiguous, or self-contradictory AND clarifying it changes what should happen next (\"I grab the coins in my pocket and I hand it to the seller\" -> the amount and target become explicit). Rules: rewrite ONLY what the player DOES — CROP OUT all dialogue (quoted speech stays the player's own; the story engine already sees the original message); NEVER invent actions the player did not imply; NEVER answer or extend dialogue; keep it under 40 words, plain declarative description of the action. If the action is already clear, omit the tag entirely.",
    "- <nothing/>: when NONE of the above applies (pure casual chat, simple dialogue, movement with no stakes). Respond with ONLY <nothing/> and nothing else.",
    "- COOLDOWNS are tracked by the system, not by you: a skill marked on_cooldown in the snapshot is UNAVAILABLE this turn. If the player's action tries to use one, emit a <note> saying that skill is still on cooldown so the story engine can narrate the failed/refused attempt — never decide yourself when a cooldown ends.",
    "",
    "EXAMPLES OF JUDGMENT:",
    "- \"I buy three apples\" -> <transaction resource=\"Dinheiro\" delta=\"-6\" comparison=\"A few days of meals\"/>",
    "- \"I cast Fireball at the goblin\" -> <roll needed=\"true\" title=\"Cast Fireball on Goblin\"/>",
    "- \"I ask the innkeeper about rumors\" -> <nothing/>",
    "- \"I try to talk the innkeeper into giving us a free room\" -> <roll needed=\"true\" title=\"Negotiate a Free Room\"/>",
    "- \"I flirt with the barmaid to get her attention\" -> <roll needed=\"true\" title=\"Flirt with the Barmaid\"/>",
    "- \"I tell the guard I have business with the captain\" (a plain lie with no pressure on him) -> <nothing/>",
    "- \"I bluff the guard into believing I have business with the captain, hoping he lets me in\" -> <roll needed=\"true\" title=\"Bluff Past the Guard\"/>",
    "- \"I flaunt my wealth to impress the merchant\" -> <relevant names=\"Dinheiro\"/>",
    "- \"I check our supplies before leaving\" -> <relevant names=\"Food, Water\"/>",
    "- \"I glance at my Mana to see if I can still cast\" -> <relevant character=\"Kira\" names=\"Mana\"/>",
    "- \"I charge the ogre with everything I have\" (Kira has Power Attack) -> <skill char=\"Kira\" name=\"Power Attack\"/>",
    "- \"I grab the coins in my pocket and I hand it to the seller. Here you go, friend.\" -> <transaction resource=\"Dinheiro\" delta=\"0\" comparison=\"\"/> <rewrite text=\"I count out a handful of coins from my pocket and hand them to the seller as payment\"/>",
].join("\n");

//

async function collectContext(playerAction) {
    const st = getContext();
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const history = chat.slice(-MAX_CONTEXT_MESSAGES, -1)
        .map(m => `${m.is_user ? "Player" : (m.name || "Narrator")}: ${String(m.mes ?? "").slice(0, 1500)}`);

    // Compact XML snapshot: only what the router needs to judge intent — one
    // line per actor, tracked names as attribute keys, same dialect as the
    // post-pass snapshot.
    const d = stateManager.getData();
    const s = extension_settings[extensionName];
    const parts = ['<state note="* = skill on cooldown; statuses as Name (modifiers)">'];

    for (const c of d.characters || []) {
        // The dead have nothing left to judge — collapse their entry.
        if (c.state?.mode === "dead") {
            parts.push(`  <char name="${escAttr(c.name)}" state="dead"${c.state.reason ? ` reason="${escAttr(c.state.reason)}"` : ""}/>`);
            continue;
        }
        // on_cooldown is a code-computed boolean — the router never sees
        // (and never computes) remaining cooldown counts.
        const skills = (c.skills || []).map(sk => `${escAttr(sk.name)}${(Number(sk.cooldown_left) || 0) > 0 ? "*" : ""}`).join(", ");
        const statuses = (c.statuses || []).map(st => `${escAttr(st.name)}${st.modifiers ? ` (${escAttr(st.modifiers)})` : ""}`).join(", ");
        // Own resources (HP 12/20) and attributes (STR 3) — the router needs
        // to see them to judge when their value matters this turn.
        const res = (c.resources || []).map(r => `${escAttr(r.name)} ${r.value}${r.max ? `/${r.max}` : ""}`).join(", ");
        const attrs = (c.attributes || []).map(a => `${escAttr(a.name)} ${a.value}`).join(", ");
        parts.push(`  <char name="${escAttr(c.name)}"${c.state ? ` state="${c.state.mode}"` : ""}${skills ? ` skills="${skills}"` : ""}${statuses ? ` statuses="${statuses}"` : ""}${res ? ` resources="${res}"` : ""}${attrs ? ` stats="${attrs}"` : ""}/>`);
    }

    const resources = (d.sharedResources || []).map(r => `${escAttr(r.name)}="${escAttr(r.qty)}"`).join(" ");
    if (resources) parts.push(`  <resources ${resources}/>`);
    if ((d.warnings || []).length) parts.push(`  <warnings>${d.warnings.map(w => escAttr(w.name)).join(", ")}</warnings>`);
    // Open threads: untracked/unfinished things + secrets left by the
    // post-pass. Never injected into the story prompt directly — the
    // router leaks what the scene demands via <note>.
    for (const t of d.threads || []) {
        parts.push(`  <thread name="${escAttr(t.name)}"${t.ref ? ` ref="${escAttr(t.ref)}"` : ""}>${escAttr(t.text)}</thread>`);
    }
    // Enemies only when the feature is on AND some exist — the router never
    // pays tokens for an enemy-free scene.
    if (s.feature_enemies && (d.enemies || []).length) {
        for (const e of d.enemies) {
            const attrs = [`name="${escAttr(e.name)}"`];
            for (const r of e.resources || []) attrs.push(`${escAttr(r.name)}="${r.value}/${r.max}"`);
            const skills = (e.skills || []).map(sk => `${escAttr(sk.name)}${(Number(sk.cooldown_left) || 0) > 0 ? "*" : ""}`).join(", ");
            if (skills) attrs.push(`skills="${skills}"`);
            const statuses = (e.statuses || []).map(st => `${escAttr(st.name)}${st.modifiers ? ` (${escAttr(st.modifiers)})` : ""}`).join(", ");
            if (statuses) attrs.push(`statuses="${statuses}"`);
            parts.push(`  <enemy ${attrs.join(" ")}/>`);
        }
    }

    const blocks = [
        "TRACKED STATE (XML):",
        parts.join("\n"),
        "",
        "RECENT SCENE:",
        ...history,
        "",
        `PLAYER ACTION TO JUDGE: ${playerAction}`,
    ];

    return blocks.join("\n");
}

//

// Tolerant XML parse of the plan. Every tag is optional; <nothing/> is the
// fast path. Returns a raw plan or null when no recognizable tag is present.
function parseReply(text) {
    if (!text) return null;
    const plan = { roll: null, combat: null, transactions: [], warnings: [], relevant: [], notes: [], skills: [], rewrite: null, nothing: /<nothing\b/i.test(text) };
    let m;

    const rollM = text.match(/<roll\b([^>]*?)(?:\/>|>[\s\S]*?<\/roll>)/i);
    if (rollM) {
        const attrs = parseAttrs(rollM[1]);
        if (String(attrs.needed ?? "").toLowerCase() === "true") {
            plan.roll = { needed: true, title: String(attrs.title || "Roll") };
        }
    }

    const combatM = text.match(/<combat\b([^>]*?)(?:\/>|>[\s\S]*?<\/combat>)/i);
    if (combatM) {
        const attrs = parseAttrs(combatM[1]);
        if (String(attrs.engaged ?? "").toLowerCase() === "true") {
            plan.combat = { engaged: true, speed: Math.max(0, Math.trunc(Number(attrs.speed) || 0)) };
        }
    }

    const txRe = /<transaction\b([^>]*?)(?:\/>|>[\s\S]*?<\/transaction>)/gi;
    while ((m = txRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        plan.transactions.push({ resource: a.resource ?? a.name ?? "", delta: a.delta ?? 0, comparison: a.comparison ?? "" });
    }

    const warnRe = /<warning\b([^>]*?)(?:\/>|>[\s\S]*?<\/warning>)/gi;
    while ((m = warnRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        plan.warnings.push({ action: a.action || "set", name: a.name ?? "", text: a.text ?? "" });
    }

    // Multiple <relevant> tags allowed: one per scope (shared vs character).
    const relRe = /<relevant\b([^>]*?)(?:\/>|>[\s\S]*?<\/relevant>)/gi;
    while ((m = relRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        const names = String(a.names || a.name || "").split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        if (names.length) plan.relevant.push({ character: a.character ? String(a.character).trim() : null, names });
    }

    // Skill suggestions — at most one is honored downstream, but parse all.
    const skillRe = /<skill\b([^>]*?)(?:\/>|>[\s\S]*?<\/skill>)/gi;
    while ((m = skillRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        const char = String(a.char || a.character || "").trim();
        const name = String(a.name || a.skill || "").trim();
        if (char && name) plan.skills.push({ char, name });
    }

    const noteRe = /<note\b([^>]*?)(?:\/>|>([\s\S]*?)<\/note>)/gi;
    while ((m = noteRe.exec(text)) !== null) {
        const a = parseAttrs(m[1]);
        const note = String(a.text || a.content || m[2] || "").trim();
        if (note) plan.notes.push(note);
    }

    const rwM = text.match(/<rewrite\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rewrite>)/i);
    if (rwM) {
        const a = parseAttrs(rwM[1]);
        const rewrite = String(a.text || a.action || rwM[2] || "").trim();
        if (rewrite) plan.rewrite = rewrite;
    }

    const empty = !plan.roll && !plan.combat && !plan.transactions.length && !plan.warnings.length && !plan.relevant.length && !plan.notes.length && !plan.skills.length && !plan.rewrite;
    if (empty && !plan.nothing) {
        logDebug("prePass: no recognizable plan tags in reply");
        return null;
    }
    return plan;
}

// Validates the raw plan against the live state: unknown resource names are
// dropped, strings trimmed, the nothing fast path computed.
function sanitizePlan(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.nothing === true) {
        return { roll: null, combat: null, transactions: [], warnings: [], relevant: [], notes: [], skills: [], rewrite: null, nothing: true };
    }

    const d = stateManager.getData();
    const findShared = name => (d.sharedResources || []).find(
        r => r.name && String(r.name).toLowerCase() === String(name ?? "").toLowerCase()
    );

    // Combat and a plain roll are mutually exclusive: combat takes over the
    // opposed resolution entirely.
    const combat = (parsed.combat && parsed.combat.engaged === true)
        ? { engaged: true, speed: Math.max(0, Math.trunc(Number(parsed.combat.speed) || 0)) }
        : null;

    const roll = (!combat && parsed.roll && parsed.roll.needed === true)
        ? { needed: true, title: String(parsed.roll.title || "Roll").slice(0, 80) }
        : null;

    const transactions = (Array.isArray(parsed.transactions) ? parsed.transactions : [])
        .map(t => {
            const entry = findShared(t?.resource);
            if (!entry) return null;
            return {
                entry,
                delta: Math.trunc(Number(t?.delta) || 0), // 0 = specialist judges the amount
                comparison: String(t?.comparison || "").slice(0, 120),
            };
        })
        .filter(Boolean);

    const warnings = (Array.isArray(parsed.warnings) ? parsed.warnings : [])
        .map(w => {
            if (!w?.name) return null;
            const action = String(w.action || "set").toLowerCase() === "clear" ? "clear" : "set";
            return { action, name: String(w.name).slice(0, 40), text: String(w.text || "").slice(0, 120) };
        })
        .filter(Boolean);

    // Shared entries keep { entry }; character-scoped ones resolve against
    // that character's own resources (value/max) and attributes. Unknown
    // names are dropped.
    const findChar = name => (d.characters || []).find(
        c => c.name && String(c.name).toLowerCase() === String(name ?? "").toLowerCase()
    );
    const relevant = [];
    for (const rel of (Array.isArray(parsed.relevant) ? parsed.relevant : [])) {
        if (rel?.character) {
            const char = findChar(rel.character);
            if (!char) continue;
            for (const name of rel.names || []) {
                const needle = String(name).toLowerCase();
                const res = (char.resources || []).find(r => String(r.name || "").toLowerCase() === needle);
                if (res) {
                    relevant.push({ character: char.name, name: res.name, value: res.max ? `${res.value}/${res.max}` : String(res.value ?? "") });
                    continue;
                }
                const attr = (char.attributes || []).find(a => String(a.name || "").toLowerCase() === needle);
                if (attr) {
                    relevant.push({ character: char.name, name: attr.name, value: String(attr.value ?? "") });
                    continue;
                }
                // Skills resolve to their cooldown state (0 = ready) instead of
                // a value — the story engine only needs on/off + turns left.
                const skill = (char.skills || []).find(sk => String(sk.name || "").toLowerCase() === needle);
                if (skill) relevant.push({ character: char.name, name: skill.name, skill: true, cooldown: Math.trunc(Number(skill.cooldown_left) || 0) });
            }
        } else {
            for (const name of rel?.names || []) {
                const entry = findShared(name);
                if (entry) relevant.push({ entry });
            }
        }
    }

    const notes = (Array.isArray(parsed.notes) ? parsed.notes : [])
        .map(n => String(n || "").trim().slice(0, 200))
        .filter(Boolean);

    // Skill suggestions: character must be tracked and able to act, the skill
    // must exist and be off cooldown — anything else is silently dropped.
    const skills = (Array.isArray(parsed.skills) ? parsed.skills : [])
        .map(sk => {
            const char = findChar(sk?.char);
            if (!char || char.state?.mode) return null;
            const skill = (char.skills || []).find(x => String(x.name || "").toLowerCase() === String(sk?.name ?? "").toLowerCase());
            if (!skill || (Number(skill.cooldown_left) || 0) > 0) return null;
            // Cost travels with the suggestion so the story engine can narrate
            // the price being paid (resource, stat or purely narrative).
            return { char: char.name, name: skill.name, cost: String(skill.cost || "").trim() };
        })
        .filter(Boolean)
        .slice(0, 1); // at most one suggestion per turn

    const rewrite = parsed.rewrite ? String(parsed.rewrite).trim().slice(0, 300) : null;

    const nothing = !roll && !combat && !transactions.length && !warnings.length && !relevant.length && !notes.length && !skills.length && !rewrite;
    return { roll, combat, transactions, warnings, relevant, notes, skills, rewrite, nothing };
}

//

// Builds the system message: the router instructions plus, when the deep
// context setting is on, the card / persona / author's note / activated World
// Info — so the router knows who and where the scene is before judging
// anything in the user message.
async function buildSystemContent(playerAction) {
    const s = extension_settings[extensionName];
    let content = SYSTEM_PROMPT;
    if (s.deep_context) {
        const deep = await buildDeepContext(String(playerAction || ""));
        if (deep) content += `\n\n<deep_context>\n${deep}\n</deep_context>`;
    }
    // User's standing instructions for the pre-pass — at the END of the
    // system message, after the deep context (same layout as the post-pass).
    // Full ST macro parsing ({{char}}, {{user}}, {{time}}...) via
    // substituteParams, like a normal generation would do.
    const custom = String(s.custom_instructions?.pre || "").trim();
    if (custom) {
        let rendered = custom;
        try {
            const st = getContext();
            const charName = st.characters?.[st.characterId]?.name;
            rendered = substituteParams(rendered, { name2Override: charName });
        } catch (e) {
            console.warn("[Game Manager] custom instruction macro substitution failed:", e);
        }
        content += `\n\n<custom>\n${rendered}\n</custom>`;
    }
    return content;
}

// Runs the pre-pass router for a player action. Returns a sanitized plan, or
// null when disabled/failed (caller falls back to keyword triggers).
export async function runPrePass(playerAction) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.pre_pass) {
        console.info(`[GM DIAG] runPrePass skipped: enabled=${!!s.enabled} pre_pass=${!!s.pre_pass}`);
        return null;
    }
    if (!playerAction) {
        console.info("[GM DIAG] runPrePass skipped: empty player action");
        return null;
    }

    try {
        const st = getContext();
        const profileId = resolvePremasterProfile(st, s.premaster_profile, s.connection_profile);
        console.info(`[GM DIAG] runPrePass: calling pre-master profile='${profileId || "<same-as-current>"}'`);
        const messages = [
            { role: "system", content: await buildSystemContent(playerAction) },
            { role: "user", content: await collectContext(playerAction) },
        ];
        const reply = await sendRequestViaProfile(profileId, messages);
        console.info(`[GM DIAG] runPrePass raw reply (${String(reply || "").length} chars):`, String(reply || "").slice(0, 400));
        const plan = sanitizePlan(parseReply(reply || ""));
        if (!plan) {
            console.info("[GM DIAG] runPrePass: malformed reply — caller will fall back to keyword triggers");
            logDebug("prePass: malformed reply — caller will fall back to keyword triggers");
            return null;
        }
        logDebug(`prePass: plan — combat=${!!plan.combat} roll=${!!plan.roll} tx=${plan.transactions.length} warn=${plan.warnings.length} relevant=${plan.relevant.length} notes=${plan.notes.length} skills=${plan.skills.length} rewrite=${!!plan.rewrite} nothing=${plan.nothing}`);
        return plan;
    } catch (e) {
        console.error("[GM DIAG] pre-pass failed (exception):", e);
        return null;
    }
}
