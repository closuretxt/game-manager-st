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

## AI updates (agentic)

Tool usage does **not** scan the main SillyTavern model's output. When "Agentic resource updates" is enabled (off by default), a dedicated agentic call analyses the final exchange (AI reply + player response) and reports concrete changes — rolled dice, spent resources, consumed items, evolving custom features, warnings — as XML tool tags (`docs/TOOL_TAGS.md`) which are then applied. Tags are optional every turn: no changes, no tags.

Every agentic feature has its **own toggle** in the settings drawer (Warnings / Dice rolls / Transactions / Context injection) — all independently disableable, per the spec's "everything can be disabled".

## Agentic features

- **Warnings** — the agentic pass can set/clear short remarks ("You have about two days of food left"). They appear as a dismissible note strip in the panel (for you) and are injected via the low-priority macro (for the story LLM) — so resource scarcity becomes a real issue at near-zero prompt cost.
- **Dice rolls** — when your action explicitly names a tracked skill, a pre-master LLM judges whether the action needs a roll and provides a title + four ordered chance tiers (Critical Failure / Failure / Success / Critical Success) with outcome lines. A dice bubble animates over the chat while the tiers stream in one by one; the weighted result is appended permanently to your message ("I cast fireball. *(🎲 Use Fireball on Goblin — Critical Failure (10%): ...)*") and queued for high-priority injection. Swiping/deleting the message rolls the text and state back.
- **Transactions (fair use)** — when your action mentions a shared resource, a pre-master LLM computes the current value, transaction value, value after, and a plain-language comparison ("Could buy a week's worth of food"). The result is injected as high-priority context and applied to the shared resource (snapshotted for rollback).
- **Context injection** — two macros, minimal XML, empty when nothing is relevant:
  - `{{gamemaster-low-priority}}` — persistent context: active warnings + shared resources flagged "Always inject" (the star feature, e.g. money that is always relevant).
  - `{{gamemaster-high-priority}}` — one-shot immediate reports: pending roll results and transaction checks (consumed once per generation).
  Place them anywhere in your preset; see `docs/AGENTIC.md`.

Both the agentic pass and the pre-master LLM calls (dice/transactions) run through SillyTavern connection profiles — **separate profile options** in the Advanced settings drawer, so you can put dice/transaction judgment on a fast/cheap model.

## Current status

- The pre-turn hook is implemented as a seam for future logic; the XML tool-tag parser (`<change_values>`, `<warnings>`, etc. — see `docs/TOOL_TAGS.md`) is gated behind the "Agentic resource updates" setting (off by default).
- Future plans (kept modular via `core/schemas.js`): skill trees, robust combat system, maps.