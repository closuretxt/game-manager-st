// dice.deck — an encounter deck instead of dice (plans/combat-modules.md
// 4.3): 52 cards + 2 jokers, shuffled with the round's seed and kept in
// contest.meters.deck, so cards already drawn stay out until the deck runs
// dry and reshuffles. Card value (Ace 1 ... King 13) + mod vs the target the
// oracle sets: a joker, or a King that beats the target = critical; an Ace
// that misses = fumble; missing by up to 2 = partial. Advantage draws two
// and keeps the better. The plan's interactive "hand of 3" waits for the Ask
// me prompt.

import { rollDie } from "../../rng.js";
import { oracleResolve } from "./oracle.js";
import { diceSigned, diceOutcome, sampledOdds, diceRollRules, diceFiveTierRule, diceExample } from "./common.js";

const DECK_SIZE = 54;
const DECK_SUITS = ["♠", "♥", "♦", "♣"];
const DECK_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

// Card code 0..51 = suit * 13 + rank index; 52, 53 = jokers.
export function deckCard(code) {
    if (code >= 52) return { value: 0, joker: true, label: "Joker" };
    const rank = code % 13;
    return { value: rank + 1, joker: false, label: `${DECK_RANKS[rank]}${DECK_SUITS[Math.floor(code / 13)]}` };
}

export function deckKey(card, total, target, impossible) {
    if (impossible) return card.value === 1 ? "fumble" : "miss";
    if (card.joker) return "crit";
    if (total >= target) return card.value === 13 ? "crit" : "hit";
    if (card.value === 1) return "fumble";
    if (total >= target - 2) return "graze";
    return "miss";
}

function deckShuffled(rng) {
    const cards = Array.from({ length: DECK_SIZE }, (_, i) => i);
    for (let i = cards.length - 1; i > 0; i--) {
        const j = rollDie(rng, i + 1) - 1;
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
}

// Draws from the contest's deck (reshuffling a dry one). Returns the card
// and whether this draw reshuffled.
function deckDraw(ctx) {
    const meters = ctx.contest.meters = ctx.contest.meters && typeof ctx.contest.meters === "object" ? ctx.contest.meters : {};
    let reshuffled = false;
    if (!Array.isArray(meters.deck) || !meters.deck.length) {
        meters.deck = deckShuffled(ctx.rng);
        reshuffled = true;
    }
    return { card: deckCard(meters.deck.pop()), reshuffled };
}

function deckUsable(r) {
    return !!r && (r.impossible || Number.isFinite(r.dc));
}

// The better (or, with disadvantage, worse) card: a joker beats everything.
function deckBetter(a, b, adv) {
    const score = c => (c.joker ? 99 : c.value);
    return adv > 0 ? (score(b) > score(a) ? b : a) : (score(b) < score(a) ? b : a);
}

export function deckResolve(ctx, group, roll = {}) {
    const r = group?.roll;
    if (!deckUsable(r)) return oracleResolve(ctx, group);
    const adv = Math.max(-1, Math.min(1, (Number(r.adv) || 0) + (Number(roll.adv) || 0)));
    const first = deckDraw(ctx);
    const drawn = [first.card];
    let reshuffled = first.reshuffled;
    let card = first.card;
    if (adv) {
        const second = deckDraw(ctx);
        drawn.push(second.card);
        reshuffled = reshuffled || second.reshuffled;
        card = deckBetter(first.card, second.card, adv);
    }
    // Exploding (mut.exploding): a King draws again and adds.
    let extra = 0;
    if (roll.explode && card.value === 13) {
        const more = deckDraw(ctx);
        drawn.push(more.card);
        extra = more.card.value;
    }
    const mod = Math.trunc(Number(r.mod) || 0);
    const bonus = Math.trunc(Number(roll.bonus) || 0);
    const total = card.value + extra + mod + bonus;
    const key = deckKey(card, total, r.dc, r.impossible);
    if (reshuffled && roll.notes) roll.notes.push("Deck reshuffled");
    const shown = `drew ${drawn.map(c => c.label).join(" / ")}`;
    const detail = r.impossible || card.joker ? `${shown}${r.impossible ? ", impossible" : ""}` : `${shown} ${diceSigned(mod)}${bonus ? ` ${diceSigned(bonus)}` : ""} = ${total} vs ${r.dc}`;
    return diceOutcome(group, key, { roll: total, faces: drawn.map(c => c.value), face: card.value, mod, bonus, dc: r.dc, adv, detail });
}

// Odds from a full deck (the bubble does not know which cards are gone).
export function deckAnnotate(group) {
    const r = group?.roll;
    if (!deckUsable(r)) return;
    const mod = Math.trunc(Number(r.mod) || 0);
    const adv = Math.max(-1, Math.min(1, Number(r.adv) || 0));
    const odds = sampledOdds(group, rng => {
        let card = deckCard(rollDie(rng, DECK_SIZE) - 1);
        if (adv) card = deckBetter(card, deckCard(rollDie(rng, DECK_SIZE) - 1), adv);
        return deckKey(card, card.value + mod, r.dc, r.impossible);
    }, "deck");
    if (odds) group.tiers.forEach((t, i) => { t.chance = odds[i]; });
}

const DECK_ORACLE_RULES = diceRollRules(
    "HARD ROLL RULES — the engine draws a card for the FIRST side of each group (Ace 1 ... King 13, jokers wild) and adds mod against your target; you set the numbers:",
    '- Every group carries ONE <roll actor="First side\'s actor" mod="+N" dc="N" adv="false">reason</roll>. mod = the actor\'s relevant attribute/skill bonus plus passives and statuses (0 to +5 for most actors). dc = what the opposition makes it: 6 easy, 9 solid, 12 hard, 15 heroic. adv="true" when circumstances clearly favor the draw, "dis" when they hinder it. The reason cites the sheet entries, in a few words.',
    "the engine then always fails it",
);

const DECK_ORACLE_TIER_RULE = diceFiveTierRule(
    "an Ace that misses",
    "under the target",
    "1-2 under: it half-works, at a cost",
    "meets the target",
    "a joker, or a King that meets the target",
);

function deckOracleExample(stakes) {
    return diceExample(stakes, '<roll actor="Kael" mod="+3" dc="9" adv="false">Strength +2, Cleave +1; Goblin A\'s Nimble hide armor sets 9</roll>');
}

export const diceDeck = {
    id: "dice.deck",
    label: "Card deck",
    hint: "Draw from a shuffled deck (kept between rounds) + mod vs a target; jokers are wild.",
    icon: "fa-clone",
    sides: 13,
    resolve: deckResolve,
    annotate: deckAnnotate,
    oracle: { rules: DECK_ORACLE_RULES, tierRule: DECK_ORACLE_TIER_RULE, example: deckOracleExample },
};
