# Agentic Features

Every feature below has an independent toggle in the settings drawer. The agentic state pass additionally requires "Agentic resource updates" (off by default).

## Architecture

```
player sends action / swipes
  └─ GENERATION_AFTER_COMMANDS (awaited — prompt assembly waits for this)
       ├─ PRE-PASS router LLM (core/prePass.js) — judges EVERY fresh action,
       │    no keyword guessing. Returns a plan:
       │      roll? / transactions[]? / warnings[]? / relevant[]? / nothing
       ├─ specialists execute only the plan's entries
       │    ├─ plan.roll         → diceRoller   → dice bubble + roll
       │    ├─ plan.transactions → transactions → fair-use check + apply
       │    ├─ plan.warnings     → stateManager warnings
       │    └─ plan.relevant     → one-shot low-priority value injection
       └─ agentic pass (if "Agentic resource updates" is on)
            └─ analyses the exchange → tool tags → state changes + warnings
  └─ prompt assembly — {{gamemaster-low-priority}} / {{gamemaster-high-priority}}
       substitute the buffers, which already contain this turn's results
  └─ story generation — sees fresh, relevant state only
```

The pre-pass decides IF something is needed; the specialists decide HOW (the dice LLM still generates the streaming tiers, the transaction LLM still validates amounts when the router didn't provide a delta). Swipes/regenerates never re-run the pre-pass. If the pre-pass is disabled (setting) or fails/malforms, the legacy keyword detection (`detectTriggers`) builds a synthetic plan instead — the system degrades, it doesn't die. A `nothing` plan skips every specialist.

Because everything runs inside the awaited `GENERATION_AFTER_COMMANDS` handler, SillyTavern's prompt assembly only starts after the pre-turn work finishes — the same turn's generation receives the roll results, transaction reports, warnings and state changes. Empty buffers cost zero tokens; the XML envelopes carry a short self-describing note so the story LLM understands the tags without any permanent instruction text.

All LLM calls route through SillyTavern **connection profiles** (per-request, your active connection is untouched): the agentic pass uses "Connection Profile (agentic pass)", the pre-master calls use "Connection Profile (pre-master)" — pick a fast/cheap model for the latter. The legacy swap mode (`legacy_api`) applies to both.

## Injection macros

Place anywhere in your prompt/preset:

- `{{gamemaster-low-priority}}` — persistent context, non-immediate:
  ```xml
  <gamemaster_context>
    <warning name="Food">You have about two days of food left.</warning>
    <resource name="Dinheiro" value="150"/>
  </gamemaster_context>
  ```
  Only warnings and shared resources with the **"Always inject"** flag appear. Empty when nothing is relevant — zero tokens.

- `{{gamemaster-high-priority}}` — immediate reports, **consumed once** per generation:
  ```xml
  <gamemaster_result>
    <roll title="Use Fireball on Goblin" tier="Critical Failure" chance="10">Fireball explodes in your face</roll>
    <transaction resource="Dinheiro" current="150" transaction="-100" remaining="50">Could buy a week's worth of food</transaction>
  </gamemaster_result>
  ```

## Dice rolls

1. Trigger: the **pre-pass** judges the action's outcome genuinely uncertain and consequential — naming a skill is a strong hint but no longer required, and naming one in a trivial context does not roll.
2. The dice LLM receives the recent scene + party skill list and returns JSON: `needsRoll`, `title`, and 4 ordered `tiers` (Critical Failure / Failure / Success / Critical Success), each with a `chance` percentage and a short `outcome` line. When the pre-pass already decided a roll is needed, a `needsRoll: false` reply is overridden (the tiers are still required).
3. A dice bubble appears **centered above the chat input bar**; the dice cycles its faces while shaking, tiers stream in one by one with animated chance bars; the weighted result locks in with a pop.
4. The winning outcome is rendered as a compact bubble attached to your message (DOM-only — the message text is never modified) and queued for high-priority injection.
5. Swipe or delete the message → snapshot rollback restores the state.

## Transactions (fair use)

1. Trigger: the **pre-pass** detects an implied spend/gain of a shared resource — no verbatim name needed ("I hand him the coins" works). The plan entry may already carry a judged `delta` + `comparison`, in which case the specialist LLM call is skipped.
2. Otherwise the transaction LLM returns JSON: `applies`, `transaction` (negative = spending), and a `comparison` note (plain language, ≤12 words).
3. Spending is capped at what you own; the result is applied to the shared resource, injected as high-priority context, and shown as a toast.

Resources the pre-pass flags as `relevant` (value matters this turn, no transaction) are injected once via the low-priority macro — on top of any shared resource with the permanent **"Always inject"** flag.

## Scenario Setup Wizard

One-button bootstrap (`core/setupWizard.js` + `ui/setupWizard.js`, button in the Party tab while edit mode is on, gated by its own setting):

1. Paste a scenario/character description (or leave empty to infer from the recent chat) → **Generate Setup**.
2. ONE setup LLM call proposes: full **party** sheets (capped by the "Wizard party cap" setting), a lightweight **roster** for the dozens of allies gacha-style scenarios have (name + one-liner, never injected, never rolled), **shared resources**, **custom features** and initial **warnings**. The prompt is derived from the `GM_SCHEMA` type registry, so future trackable types are automatically wizard-settable.
3. Review modal: trim the party, promote/remove roster allies, edit names, then **Apply** (replace the current setup or merge into it). Nothing touches state before Apply.

## Deep context (optional)

With the **"Deep context"** setting enabled (`util/loreContext.js`), the wizard AND the pre-pass router additionally receive the active **character card** (description/personality/scenario), the **user persona**, the **author's note** and **activated World Info** entries — WI is activated against the recent chat + scenario text, so only lore relevant to the current scene is pulled, never a whole-book dump. Off by default: it raises the token cost of every pre-pass call. All lookups are best-effort — a missing/changed SillyTavern API degrades to an empty block.

## Snapshots & rollback

Before any change (agentic pass, roll, transaction) the pre-change state is snapshotted per message (last 5 kept). Deleting a message, swiping it, or re-running the pass manually rolls state (and rolled message text) back to the baseline.

## Roster

Roster allies (`core/stateManager.js`, party-level) are intentionally lightweight: name + note, rendered as collapsed chips under the Party list. They are never injected into prompts and never rolled for — promote one to the Party (edit mode) to give it a full tracked sheet. This keeps gacha-scale casts (dozens of `{{user}}` allies) from flooding context or UI.
