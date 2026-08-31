// Combat Mode (Text) orchestrator.
// Consumes the pre-pass plan's <combat/> judgment and runs the full opposed
// resolution inside the awaited GENERATION_AFTER_COMMANDS handler:
//
//   plan.combat -> ALLY AI (uncommanded party members, friendly)
//               -> ENEMY AI (hostile side, blind to the player's action)
//               -> CLASH RESOLVER (both sides + speeds + full sheets -> groups)
//               -> weighted roll per group (core/diceRoller.js weightedRoll)
//                    ├─ ui/combatBubble.js (side-by-side, tiers stream in)
//                    ├─ attachCombatToMessage (DOM-only permanent record)
//                    └─ queueHigh(<combat_round> XML) for the story LLM
//
// Combat NEVER mutates state itself: the story LLM narrates the resolved
// round and the post-pass tracks HP/statuses through its tool tags. Every
// failure degrades (generic enemy attacks / single-sided rolls) instead of
// dying — mirroring the pre-pass fallback philosophy.

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { weightedRoll } from "./diceRoller.js";
import { captureSnapshot } from "./snapshots.js";
import { queueHigh } from "./injection.js";
import { runAllyAI } from "./allyAI.js";
import { runEnemyAI } from "./enemyAI.js";
import { resolveClashes } from "./clashResolver.js";
import { combatBubble, attachCombatToMessage } from "../ui/combatBubble.js";
import { playRoll, playTierResult } from "./soundFx.js";

function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "&" + "amp;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/"/g, "&" + "quot;");
}

// Generic 4-tier set for the degraded path (clash resolver failed): every
// action is resolved single-sided with neutral chances.
// Code-owned initiative hint: when an AI pass leaves speed at 0, derive it
// from a Dexterity-like attribute so attribute points visibly win initiative
// instead of relying purely on LLM judgment.
const SPEED_ATTR_RE = /dex|agi|reflex|quickness|initiative|haste|speed/i;
function speedHintOf(name) {
    const sheet = stateManager.getSheet(name);
    if (!sheet) return 0;
    const attr = (sheet.attributes || []).find(a => SPEED_ATTR_RE.test(String(a.name)));
    return attr ? Math.max(0, Math.trunc(Number(attr.value) || 0)) : 0;
}

function genericTiers(actor, action) {
    return [
        { name: "Critical Failure", chance: 10, outcome: `${actor}'s ${action} goes horribly wrong` },
        { name: "Failure", chance: 25, outcome: `${actor}'s ${action} does not work out` },
        { name: "Success", chance: 50, outcome: `${actor}'s ${action} goes as intended` },
        { name: "Critical Success", chance: 15, outcome: `${actor}'s ${action} exceeds all expectations` },
    ];
}

// Fallback grouping when the clash resolver fails: every action becomes a
// single-sided group with generic tiers — both sides still roll and inject.
function fallbackGroups(partyActions, enemyActions) {
    const mk = a => ({
        title: a.action,
        sides: [{ who: a.who, actor: a.actor, speed: a.speed, action: a.action }],
        tiers: genericTiers(a.actor, a.action),
    });
    return [...partyActions.map(mk), ...enemyActions.map(mk)];
}

// Builds the party-side action list: the player's own action first, then the
// ALLY AI's actions for the uncommanded members.
function buildPartyActions(action, plan, allyActions) {
    const st = getContext();
    const player = {
        who: "party",
        actor: String(st.name1 || "Player"),
        speed: Number(plan?.combat?.speed) || 0,
        action: String(action || "").replace(/\s+/g, " ").trim().slice(0, 120) || "Hold position",
    };
    const allies = (allyActions || [])
        // Safety net: the ALLY AI already skips characters in a special
        // state, but never trust it.
        .filter(a => !stateManager.getStateOf(a.char))
        .map(a => ({
            who: "party",
            actor: a.char,
            speed: a.speed || speedHintOf(a.char),
            action: [a.title, a.text].filter(Boolean).join(" — ").slice(0, 120),
        }));
    return [player, ...allies];
}

// Enemy-side actions, degrading to generic attacks when the ENEMY AI pass
// failed (combat must not die because one call did).
function buildEnemyActions(enemyActions) {
    const d = stateManager.getData();
    if (enemyActions && enemyActions.length) {
        return enemyActions.map(a => ({
            who: "enemy",
            actor: a.enemy,
            speed: a.speed || speedHintOf(a.enemy),
            action: [a.title, a.text].filter(Boolean).join(" — ").slice(0, 120),
        }));
    }
    logDebug("combatEngine: enemy AI unavailable — generic attacks");
    return (d.enemies || []).map(e => ({
        who: "enemy",
        actor: e.name,
        speed: speedHintOf(e.name),
        action: "Attack",
    }));
}

// Queues the resolved round for the story LLM (high-priority, one-shot).
// Deliberately minimal: the story engine only needs WHO did WHAT and HOW IT
// ENDED — engine internals (speeds, chances) are noise it would trip over.
function queueCombatRound(groups, winners) {
    const lines = groups.map((g, i) => {
        const w = winners[i];
        const a = g.sides[0] || { actor: "", action: "" };
        const b = g.sides[1] || null;
        const vs = b ? ` versus="${esc(b.actor)}"` : "";
        return `  <clash actor="${esc(a.actor)}" action="${esc(a.action)}"${vs} result="${esc(w.name)}">${esc(w.outcome)}</clash>`;
    });
    queueHigh(`  <combat_round note="This turn's actions were already resolved by dice; narrate these outcomes as ground truth, never re-roll or re-resolve them.">\n${lines.join("\n")}\n  </combat_round>`);
}

// Full combat flow for a player action on message `mesId`. `plan.combat` comes
// from the pre-pass: { engaged: true, speed }. Returns true if a round was
// resolved.
export async function runCombatTurn(action, plan, mesId) {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.feature_combat) return false;

    const d = stateManager.getData();
    if (!(d.enemies || []).length) {
        logDebug("combatEngine: no tracked enemies — skipping combat flow");
        return false;
    }

    const bubble = combatBubble.show("Resolving combat...");
    try {
        // Side A — the player plus any AI-commanded allies. Ally failure means
        // allies hold position (a feature, not a crash).
        const allyActions = await runAllyAI({ playerAction: action });
        const partyActions = buildPartyActions(action, plan, allyActions);

        // Side B — the enemy AI, blind to everything above.
        const enemyRaw = await runEnemyAI({ maxActions: Math.max(1, Number(s.combat_max_enemy_actions) || 6) });
        const enemyActions = buildEnemyActions(enemyRaw);

        bubble.update("Resolving clashes...");

        // Third pass — the only one that sees both sides. Falls back to
        // independent single-sided rolls when it fails.
        let groups = await resolveClashes({
            playerAction: action,
            partyActions,
            enemyActions,
            onStream: (partial) => bubble.syncGroups(partial),
        });
        if (!groups) groups = fallbackGroups(partyActions, enemyActions);
        bubble.syncGroups(groups);

        // Roll each group with the shared weighted roller: the slot-machine
        // sweep runs while the roll "happens", then the winner pops.
        const winners = [];
        for (let i = 0; i < groups.length; i++) {
            bubble.startGroupRoll(i);
            playRoll(900); // tumbling dice while the slot-machine sweeps
            await new Promise(r => setTimeout(r, 900)); // let the animation breathe
            const winner = weightedRoll(groups[i].tiers);
            winners.push(winner);
            bubble.resolveGroup(i, winner);
            playTierResult(winner.name);
        }
        await new Promise(r => setTimeout(r, 1600));

        // Permanent record: DOM-only tag on the message + high-priority
        // injection. The message text itself is NEVER edited.
        captureSnapshot(mesId);
        attachCombatToMessage(mesId, groups, winners);
        queueCombatRound(groups, winners);
        bubble.done("Combat resolved.");
        logDebug(`combatEngine: ${groups.length} group(s) resolved — ${winners.map(w => w.name).join(", ")}`);
        return true;
    } catch (e) {
        console.error("[Game Manager] combat turn failed:", e);
        bubble.close(true);
        return false;
    }
}
