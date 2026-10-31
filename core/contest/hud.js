// Contest HUD model (plans/combat-modules.md 5): what the Enemies tab shows
// while a contest is active — turn order, condition bars, mutator meters and
// the round log. The HUD is the player's screen, so numbers are fine here
// (they never reach the story LLM). Pure: the panel passes the sheets and a
// stakes reader in; ui/mainPanel.js renders the result.

import { contestKey } from "./effects.js";

const HUD_LOG_ROUNDS = 6;

// One condition bar per fighter. Party = the contest's party (everyone on
// the sheet list when the first round has not recorded one yet); enemies =
// the ones still in the scene. stakesOf(sheet) -> { value, min, max } | null.
export function hudFighters(contest, characters, enemies, stakesOf) {
    const c = contest || {};
    const partyKeys = new Set((c.party || []).map(contestKey));
    const party = (characters || []).filter(ch => !partyKeys.size || partyKeys.has(contestKey(ch.name)));
    const bar = (sheet, side) => {
        const st = stakesOf ? stakesOf(sheet) : null;
        const out = (c.out || {})[contestKey(sheet.name)] || sheet?.state?.mode || null;
        let ratio = null;
        if (st && Number.isFinite(st.max) && st.max > st.min) ratio = Math.max(0, Math.min(1, (st.value - st.min) / (st.max - st.min)));
        return { name: sheet.name, side, value: st ? st.value : null, max: st ? st.max : null, ratio, out };
    };
    return [...party.map(s => bar(s, "party")), ...(enemies || []).map(s => bar(s, "enemy"))];
}

// Fixed turn order (turn.initiative), highest first. `names` maps the
// contest's name keys back to display names; unknown keys keep the key.
export function hudTurnOrder(contest, names) {
    const init = contest?.initiative && typeof contest.initiative === "object" ? contest.initiative : {};
    return Object.entries(init)
        .filter(([, v]) => Number.isFinite(Number(v)))
        .map(([key, v]) => ({ name: names?.[key] || key, value: Number(v) }))
        .sort((a, b) => b.value - a.value);
}

// Meters the ruleset's mutators expose (momentum, escalation...).
export function hudMeters(ctx, mutators) {
    const out = [];
    for (const m of mutators || []) {
        if (typeof m?.hud !== "function") continue;
        const meter = m.hud(ctx);
        if (meter) out.push(meter);
    }
    return out;
}

// Round log: the last few rounds' result rows (ledger.chipRows), newest last.
export function hudPushLog(log, roundNo, rows) {
    const list = Array.isArray(log) ? log.slice() : [];
    list.push({ round: roundNo, rows: (rows || []).map(r => ({ title: String(r.title || ""), tier: String(r.tier || ""), outcome: String(r.outcome || "") })) });
    return list.slice(-HUD_LOG_ROUNDS);
}
