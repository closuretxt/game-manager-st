// Plain-language descriptions for the combat rules dialog (ui/chatModeDialog.js):
// written for someone who has never played a tabletop game. The modules' own
// `hint`s stay short and technical (tooltips, the HUD); these say what the
// pick FEELS like at the table. Pure data.

export const PRESET_DESCRIPTIONS = {
    clash: {
        universal: "The simplest setup. Everyone acts at once, the AI judges how likely each move is to work from the character sheets, and a hidden roll picks what happens. No numbers to learn.",
        heroic: "Classic fantasy-adventure feel. Everyone rolls for a fixed turn order at the start, attacks are a 20-sided die against a difficulty number, and the party gets stronger the longer a fight lasts. Hits build momentum you can spend to retry a miss.",
        gritty: "Dangerous and grounded. Your stats are handfuls of dice (more dice = better odds), wounds are words (Hurt, Wounded, Broken) instead of numbers, being dazed or outnumbered makes rolls worse, and enemies can lose their nerve and run.",
        story: "Built around your characters. Only the party rolls (the enemies' moves are decided by how well yours went). 10+ works, 7-9 works with a catch. Countdowns can tick toward story events.",
        tactical: "For people who like planning. Heavy moves make you act later next round, distance matters (melee needs you up close), hitting the same enemy builds combos, and hitting a weakness can break its guard.",
        duelist: "One-on-one sword-fight feel. Pick Strike, Feint or Guard each round (rock-paper-scissors), dice can explode for big hits, and wounds are words, not numbers.",
        legacy: "The old combat system from before the rework. No options here.",
    },
    race: {
        universal: "A simple race: the course is split into segments, the AI judges each move, and the start, middle and final stretch play differently.",
        classic: "A full race: stamina matters, you can sprint in the final stretch, and running right behind someone saves energy.",
        percentile: "A full race rolled as percentages (\"40% chance\"). Falling behind fills a gauge that unlocks one big Ultimate move.",
    },
    scores: {
        universal: "A performance or competition scored by a panel of judges, round by round. Highest total wins.",
    },
    challenge: {
        universal: "The party against a situation (a collapsing cave, a storm). Two countdowns race: reach the goal before the danger one fills.",
    },
};

// Shown under the Turn order, Dice and Consequences dropdowns, and as the
// tooltip of each Extra.
export const MODULE_DESCRIPTIONS = {
    "turn.simultaneous": "Everyone says what they do, then moves happen fastest first. If someone is taken out before their turn, their move doesn't happen.",
    "turn.initiative": "Everyone rolls once at the start of the fight for a turn order and keeps it until the fight ends. High roll goes first, every round.",
    "turn.phases": "The whole party acts first, then all the enemies.",
    "turn.timeline": "Light moves (a quick jab) let you act sooner next round, heavy ones (a big spell) make you act later.",
    "turn.ap": "Each character gets a few action points per round. Big moves cost more. Points you don't spend become a defense against the next hit.",
    "turn.duel": "Each side secretly picks Strike, Feint or Guard. Strike beats Feint, Feint beats Guard, Guard beats Strike. The winner rolls with an edge.",
    "turn.player_facing": "Only your party rolls dice: to attack and to avoid getting hit. A bad roll means the enemy's move lands. Saves one AI call per round.",
    "dice.oracle": "No dice rules to learn. The AI reads the character sheets and sets how likely each outcome is (\"60% it works\"), then a hidden roll picks one.",
    "dice.d20": "A 20-sided die plus a bonus from your stats, against a difficulty number the AI sets. Meet it and you succeed; a natural 20 is a critical hit, a natural 1 a disaster.",
    "dice.bands_2d6": "Two 6-sided dice plus a bonus. 10 or more: it works. 7 to 9: it works, but with a catch. 6 or less: it fails and the other side gets to act.",
    "dice.pool": "Your stat is how many 6-sided dice you throw. Every 5 or 6 counts as a success, and you compare your successes against theirs.",
    "dice.percentile": "The AI gives each move a percent chance. Roll 1-100: under the chance works, way under is a critical.",
    "dice.step": "Better stats mean bigger dice (a 4-sided die up to a 12-sided one). Both sides roll and the higher wins; rolling the max face lets you roll again and add it.",
    "dice.deck": "Instead of dice, draw playing cards from a shuffled deck that carries over between rounds. Your party holds a hand and can pick which card to play. Jokers are wild.",
    "dice.homebrew": "Write your own dice formula (like 3d6+mod) and choose how far past the difficulty counts as a critical.",
    "cons.oracle": "Damage, healing and statuses happen exactly as the AI described for the result that came up.",
    "cons.track": "Results move the contest's own bars (race progress, score, countdowns) instead of hurting anyone.",
    "cons.ladder": "No hit points. Each hit pushes the target one step down: Scratched, Hurt, Wounded, Broken, then Out.",
    "mut.escalation": "The party gets +1 to its rolls for every round the fight goes on, so long fights tip in your favor.",
    "mut.crit_effects": "A critical hit leaves the target staggered for a turn; a disastrous roll leaves the attacker off-balance.",
    "mut.momentum": "Your party's hits fill a meter. When it's full enough, a miss can be rerolled (the game asks you first).",
    "mut.phases": "Races have a start, middle and final stretch, and each one cares about different stats.",
    "mut.spurt": "In the final stretch a runner can burn all their stamina for a big burst of speed, and ends exhausted.",
    "mut.drafting": "Running right behind someone uses half the stamina, but passing them is a contest.",
    "mut.judges": "A panel of judges each gives a visible mark; the round's score is their average.",
    "mut.advantage": "Being dazed, hurt or outnumbered makes you roll twice and keep the worse; attacking someone in that state lets you keep the better.",
    "mut.exploding": "Rolling the highest face lets you roll that die again and add it, so big hits can get really big.",
    "mut.range": "Fighters are in melee range, close by or far away. A melee attack from too far spends the turn closing in.",
    "mut.chain": "Hitting the same enemy again and again gives +1 per hit in a row.",
    "mut.break": "Enemies have a guard. Hitting their weakness wears it down; when it breaks they lose their next turn and are easier to hit.",
    "mut.limit": "Getting hurt or falling behind fills a gauge. When it's full, the character can unleash an Ultimate move.",
    "mut.clocks": "Side countdowns (\"reinforcements arrive: 4\") tick each round; when one fills, it happens in the story.",
    "mut.morale": "Badly hurt enemies, or ones who just saw an ally fall, may lose their nerve and flee or give up.",
    "mut.deaths_door": "The first time a party member would be knocked out, they get one roll to stay on their feet.",
};
