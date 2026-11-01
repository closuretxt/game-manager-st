// Round cards (core/contest/ledger.js#roundCards) as DOM: one card per
// action, readable without knowing any table-game rules. Shared by the
// combat bubble, the chips under the player's message and the HUD round log,
// so the three always read the same. jQuery only; no state.

// One line of effects for one character: "Scout B: [Dazed] [-20 Stamina]".
export function roundEffectsEl(effects) {
    const box = $("<div>").addClass("gm_rc_fx");
    for (const e of effects || []) {
        const row = $("<div>").addClass("gm_rc_fx_row");
        row.append($("<span>").addClass("gm_rc_fx_who").text(e.who));
        for (const it of e.items || []) {
            const chip = $("<span>").addClass(`gm_rc_chip gm_rc_${it.tone || "info"}`).text(it.text);
            if (it.hint) chip.attr("title", it.hint);
            row.append(chip);
        }
        box.append(row);
    }
    return box;
}

// Small grey lines for the rules that touched the roll (advantage, momentum...).
export function roundTagsEl(tags) {
    const box = $("<div>").addClass("gm_rc_tags");
    for (const t of tags || []) box.append($("<span>").addClass("gm_rc_tag").text(t));
    return box;
}

// The roll in words; the dice math is the tooltip.
export function roundRollEl(card, icon) {
    if (!card.roll && !card.math) return $();
    const line = $("<div>").addClass("gm_rc_roll");
    line.append($("<i>").addClass(`fa-solid ${icon || "fa-dice"}`), $("<span>").text(card.roll ? capitalize(card.roll) : card.math));
    if (card.math && card.roll) line.attr("title", `Dice math: ${card.math}`);
    return line;
}

function capitalize(s) {
    const t = String(s || "");
    return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function roundCardEl(card, { icon = "" } = {}) {
    const el = $("<div>").addClass(`gm_rc gm_rc_tone_${card.tone || "none"}`);
    const head = $("<div>").addClass("gm_rc_head");
    const badge = $("<span>").addClass("gm_rc_badge").text(card.result || "—");
    if (card.meaning) badge.attr("title", card.meaning);
    const who = $("<span>").addClass("gm_rc_who").append($("<b>").text(card.who));
    if (card.target) who.append($("<span>").addClass("gm_rc_arrow").text(" → "), $("<b>").text(card.target));
    head.append(badge, who);
    el.append(head);
    if (card.move) {
        const move = $("<div>").addClass("gm_rc_move").text(card.move);
        if (card.against) move.append($("<span>").addClass("gm_rc_against").text(` (${card.target || "they"} used ${card.against})`));
        if (card.moveHint) move.attr("title", card.moveHint);
        el.append(move);
    }
    // "Success"/"Failure" explain themselves; a partial one needs the words.
    if (card.meaning && card.tone === "mixed") el.append($("<div>").addClass("gm_rc_meaning").text(card.meaning));
    if (card.story) el.append($("<div>").addClass("gm_rc_story").text(card.story));
    el.append(roundRollEl(card, icon));
    if ((card.effects || []).length) el.append(roundEffectsEl(card.effects));
    if ((card.tags || []).length) el.append(roundTagsEl(card.tags));
    return el;
}

// The whole round: turn order, the cards, scene events, and how the order
// was decided (folded).
export function roundCardsEl(model, { icon = "", title = "" } = {}) {
    const box = $("<div>").addClass("gm_rc_round");
    if (title) box.append($("<div>").addClass("gm_rc_title").text(title));
    if ((model?.order || []).length > 1) {
        const order = $("<div>").addClass("gm_rc_order").append($("<span>").addClass("gm_rc_order_label").text("Turn order"));
        model.order.forEach((name, i) => {
            if (i) order.append($("<span>").addClass("gm_rc_arrow").text("→"));
            order.append($("<span>").addClass("gm_rc_pill").text(name));
        });
        box.append(order);
    }
    for (const c of model?.groups || []) box.append(roundCardEl(c, { icon }));
    for (const ev of model?.events || []) box.append($("<div>").addClass("gm_rc_event").text(ev));
    if ((model?.notes || []).length) {
        const more = $("<details>").addClass("gm_rc_notes").append($("<summary>").text("Round rules"));
        for (const n of model.notes) more.append($("<div>").text(n));
        box.append(more);
    }
    return box;
}
