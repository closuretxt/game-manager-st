# Game Manager | SillyTavern Extension

A fully customizable manager for RPG-style information in SillyTavern: track **resources** (HP, Mana, Ammo, Sanity — any custom range), **attributes**, **inventory**, **skills**, **passives** and **AI-managed custom features** for every member of your party, plus party-wide shared resources (money, expendables).

## Installation

1. Open SillyTavern, go to the Extensions menu (boxes icon).
2. Click "Install Extension" at the top right.
3. Paste this repository URL and click 'Install for me'.

Or clone/copy this folder into `data/<user>/extensions/game-manager-st`.

## Usage

- A **floating window** (draggable by its header, resizable from the bottom-right corner — size and position are saved) opens on startup. It can be minimized or closed and reopened from the Extensions panel.
- Three tabs:
  - **Party** — the home tab: a list of every tracked character (with at-a-glance resource chips) and an add option. Selecting a character opens their full sheet: Basic Stats (resource bars with custom min/max ranges + attributes), Inventory, Skills and Passives in one scrollable view.
  - **Resource Manager** — party-wide shared resources (Dinheiro, Expendable) managed **only by you**.
  - **Custom** — party-wide AI-managed gimmicks (e.g. planted seeds).
- **Edit mode** (the lock icon in the window header) hides or reveals every mutation control — adding characters, adding/editing/deleting entries, +/- buttons. View-only by default for a hardcore feel; the state persists across reloads.
- **Presets** (in the extension settings drawer) store a character template + shared resources; save/load/delete them freely. New characters are created from the active preset's template (unlock edit mode and use the wand button on a character sheet to apply it).
- **Connection Profile** (in the settings drawer) picks a SillyTavern connection profile to use for the extension's own AI calls — "None" keeps your current connection. The switch icon swaps to the selected profile immediately.

## AI updates (pre-pass / post-pass)

Tool usage does **not** scan the main SillyTavern model's output and does **not** rely on trigger words. Every fresh action first goes through a **pre-pass router LLM** (one cheap call) that decides what the turn needs — a roll, transactions, warnings, relevant context — and specialists execute only that plan. When nothing applies (casual chat), it costs one cheap call and zero injected tokens. After the AI reply, the **post-pass** (agentic call, off by default) analyses the exchange and reports concrete changes as XML tool tags (`docs/TOOL_TAGS.md`) which are then applied.

Every feature has its **own toggle** in the settings drawer (Pre-pass router / Setup Wizard / Warnings / Dice rolls / Transactions / Context injection) — all independently disableable, per the spec's "everything can be disabled".

## Scenario Setup Wizard

Bring any scenario or character and set everything up with **one button** (Party tab, edit mode): paste the scenario (or let it infer from the recent chat) and a single setup LLM call proposes full party sheets, shared resources, custom features and warnings. Gacha-scale casts are handled gracefully — only a small **party** gets full sheets (capped in settings); every other ally lands in a lightweight **roster** (collapsed chips, never injected into prompts) that you can promote to the party at any time. Nothing is applied until you review and hit Apply (replace or merge).

## Agentic features

- **Warnings** — the pre-pass/post-pass can set/clear short remarks ("You have about two days of food left"). They appear as a dismissible note strip in the panel (for you) and are injected via the low-priority macro (for the story LLM) — so resource scarcity becomes a real issue at near-zero prompt cost.
- **Dice rolls** — when the pre-pass judges your action's outcome genuinely uncertain (naming a skill is a hint, not a requirement), the dice LLM provides a title + four ordered chance tiers (Critical Failure / Failure / Success / Critical Success) with outcome lines. A dice bubble animates **above the input bar** while the tiers stream in one by one with animated chance bars; the weighted result pops in, is rendered as a compact bubble on your message (DOM-only — **your message text is never edited**) and queued for high-priority injection. Swiping/deleting the message rolls the state back.
- **Transactions (fair use)** — when the pre-pass detects an implied spend/gain of a shared resource (no verbatim name needed), the transaction flow computes the current value, transaction value, value after, and a plain-language comparison ("Could buy a week's worth of food"). The result is injected as high-priority context and applied to the shared resource (snapshotted for rollback).
- **Context injection** — two macros, minimal XML, empty when nothing is relevant:
  - `{{gamemaster-low-priority}}` — persistent context: active warnings + shared resources flagged "Always inject" (the star feature, e.g. money that is always relevant).
  - `{{gamemaster-high-priority}}` — one-shot immediate reports: pending roll results and transaction checks (consumed once per generation).
  Place them anywhere in your preset; see `docs/AGENTIC.md`.

Both the pre-pass/post-pass and the pre-master LLM calls (router, dice, transactions, setup wizard) run through SillyTavern connection profiles — **separate profile options** in the Advanced settings drawer, so you can put them on a fast/cheap model.

## Development

Run a whole-project syntax check (parses every `.js` file as an ES module, no execution):

```
syntax-check.cmd          (Windows, whole project)
syntax-check.cmd core ui  (specific paths only)
node scripts/syntax-check.js
```

## Current status

- The pre-pass router judges every fresh action (no keyword guessing) and the XML tool-tag parser (`<change_values>`, `<warnings>`, etc. — see `docs/TOOL_TAGS.md`) is gated behind the "Agentic resource updates" setting (off by default).
- Future plans (kept modular via `core/schemas.js`): skill trees, robust combat system, maps.