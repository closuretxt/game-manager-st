# Game Manager | SillyTavern Extension

A customizable manager for scenarios for SillyTavern focused in minimal injection and auto-setup. Setup a scenario and characters by giving brief information and the Wizard will use all your world books and cards to make it happen, deciding if the scenario has progression and how it works. Fully compatible with other macro-exposed extensions with custom fields.
This extension has a focus and limits, it doesn't try to go overboard with features. Aiming to ground the story logic like a game, using factual examples.

## 🚀 Installation

1. Open SillyTavern, go to the Extensions menu (boxes icon).
2. Click "Install Extension" at the top right.
3. Paste this URL and click 'Install for me':
```plaintext
https://github.com/closuretxt/game-manager-st
```

⚠️ *This system makes use of extra API calls and context injection, proceed at your own responsability and beware of usage costs.* ⚠️

## IMPORTANT:
This extension DOES NOT inject content by itself. It just exposes macros and expects you to do it, if there's no values they will be empty.
**Context injection** - two macros, minimal XML:
- `{{gamemaster-low-priority}}` - persistent context: active warnings + shared resources flagged "Always inject" (the star feature, e.g.money that is always relevant). Place in the middle as possible or before summary/chat history. Makes cache miss if changed.
- `{{gamemaster-high-priority}}` - one-shot immediate reports: pending roll results and transaction checks. Place together with your top chat instructions. If you have writing guidances or other injections put them there.

Place them anywhere in your preset; Whatever you feel the best.

## What it does.
It does exactly what any other tracker would but provides one-click setups, progression system with skill trees and a pre-LLM gamemaster for skill and dice rolling. It can even keep track of large rosters of characters by moving them across Party and Roster states.

When using the pre-pass, an LLM will also judge your action before it goes to the LLM, if it judges that it may have a chance to fail or its a combat sequence, extra passes will run to address the actions of your party and the enemies and a clash will happen. Each individual action will clash against each other and the gamemaster will decide the odds before the dice rolls. The pre-pass also judges things like how viable is said action and if there's any transactions it lets the story engine knows the value and that it's valid.

You get it right? Progression, Resource Management and dice rolls. You can disable all them separatedly.

Skill trees are generated similar to the scenario and character creator. It uses user input or scenario/lorebook info and finds a way to do it well. The skill trees are biased towards making upgrades instead of flooding you with skills, forcing you to make different builds. The difficulty is decided by your prompt but you can also manually shift the values if you want a more difficult experience.

Nothing is editable without edit mode. Want to cheat? Use the toggle.
Knocked and death states, the pos-turn gamemaster is urged to provide knockouts or death states, if your character gets knocked out and the gamemaster decides that it wants a timeskip, you will wake up in a bed or not wake up at all.

## Minimal injections
As said before, your actual LLM just receives relevant information and they are split into high and low priorities. High priorities are intended to go with your author's note and low nested inside lorebooks.
"How does a LLM know what matters?" - The specialists will provide warnings and inject information if relevant. "You have about two days of food left.", "Encounter chance increased.", etc. The details do not matter, your story engine is for creative writing.
Everything is made through agentic stuff and different API's, setup cheap flash versions with thinking and let them take the bullet.

## Why this over X Tracker/Suite/RPG extension?
If you are a power user, most extensions are **highly** disruptive, eat context and have no actual use if you already have ready to go scenarios and characters. This was made for a friend of mine and for myself, but if it finds use out there to someone like me that cares about this thing, then I am glad.

Extra points that this extension has no features that are outside of the scope of it and you can easily inject other information since everything is macro-parsed. (If you don't know what this means then that's alright)

There's no prompt editing available outside of custom fields. I may do something in the future but I wanted to keep this straightforward and easy to get into. It may sound contradictory since its made for a power user but honestly I tried to strike in the middle since I hate extensions that are filled with prompt fields.

It is intended to survive every kind of shift in priority or scenario, it supports infinite custom fields and complex systems.

## Cache
Cache hit %'s depends on how the specialists go about your scenario and where you put the GM macros.

## AI updates (pre-pass / post-pass)

Every fresh action first goes through a **pre-pass router LLM** (one cheap call) that decides what the turn needs a roll, transactions, warnings, relevant context and specialists execute only that plan. When nothing applies (casual chat), it costs one cheap call and zero injected tokens. After the AI reply, the **post-pass** (agentic call) analyses the exchange and reports concrete changes as XML tool tags which are then applied.

Every feature has its **own toggle** in the settings drawer (Pre-pass router / Setup Wizard / Warnings / Dice rolls / Transactions / Context injection) all independently disableable.

## Scenario Setup Wizard

Bring any scenario or character and set everything up with **one button** (Party tab, edit mode): paste the scenario (or let it infer from the recent chat) and a single setup LLM call proposes full party sheets, shared resources, custom features and warnings. Gacha-scale casts are handled gracefully only a small **party** gets full sheets (capped in settings); every other ally lands in a lightweight **roster** (collapsed chips, never injected into prompts) that you can promote to the party at any time. Nothing is applied until you review and hit Apply (replace or merge). Refine it with more instructions afterwards as many times as you want.

## Agentic features

- **Warnings** - the pre-pass/post-pass can set/clear short remarks ("You have about two days of food left"). They appear as a dismissible note strip in the panel (for you) and are injected via the low-priority macro (for the story LLM) so resource scarcity becomes a real issue.
- **Dice rolls** - when the pre-pass judges your action's outcome genuinely uncertain (naming a skill is a hint, not a requirement), the dice LLM provides a title + four ordered chance tiers (Critical Failure / Failure / Success / Critical Success) with outcome lines. A dice bubble animates **above the input bar** while the tiers stream in one by one with animated chance bars; the weighted result pops in, is rendered as a compact bubble on your message (DOM-only - **your message text is never edited**) and queued for high-priority injection. Swiping/deleting the message rolls the state back.
- **Transactions (fair use)** - when the pre-pass detects an implied spend/gain of a shared resource (no verbatim name needed), the transaction flow computes the current value, transaction value, value after, and a plain-language comparison ("Could buy a week's worth of food"). The result is injected as high-priority context and applied to the shared resource.

Both the pre-pass/post-pass and the pre-master LLM calls (router, dice, transactions, setup wizard) run through SillyTavern connection profiles **separate profile options** in the Advanced settings drawer, so you can put them on a fast/cheap model.

## Current status

- The pre-pass router judges every fresh action (no keyword guessing) and the XML tool-tag parser (`<change_values>`, `<warnings>`, etc.
- Future plans (kept modular via `core/schemas.js`): skill trees, robust combat system, maps.

## 📄 License

AGPL-3.0 LICENSE || Copyright (C) 2026 closuretxt || Please read LICENSE for more information.