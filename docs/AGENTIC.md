# Agentic Features

Every feature below has an independent toggle in the settings drawer. The agentic state pass additionally requires "Agentic resource updates" (off by default).

## Architecture

```
player action ──► triggerWatcher (MESSAGE_SENT)
                    ├─ skill name match  ──► diceRoller  ──► dice bubble + roll
                    └─ resource mention  ──► transactions ──► fair-use check
exchange settles ──► agentRunner (MESSAGE_RECEIVED +1.5s) ──► tool tags ──► state
                     │
                     └─ <warnings> block ──► stateManager warnings
warnings / always-inject values ──► {{gamemaster-low-priority}}
roll results / transactions     ──► {{gamemaster-high-priority}} (one-shot)
```

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

1. Trigger: your message explicitly contains a tracked **skill** name (word-boundary, case-insensitive).
2. The pre-master LLM receives the recent scene + party skill list and returns JSON: `needsRoll`, `title`, and 4 ordered `tiers` (Critical Failure / Failure / Success / Critical Success), each with a `chance` percentage and a short `outcome` line.
3. A dice bubble appears over the chat immediately; tiers stream in one by one; the weighted result is revealed after a short spin.
4. The winning outcome is appended permanently to your message and queued for high-priority injection.
5. Swipe or delete the message → snapshot rollback restores both state and pre-roll message text.

## Transactions (fair use)

1. Trigger: your message mentions a **shared resource** by name.
2. The pre-master LLM returns JSON: `applies`, `transaction` (negative = spending), and a `comparison` note (plain language, ≤12 words).
3. Spending is capped at what you own; the result is applied to the shared resource, injected as high-priority context, and shown as a toast.

## Snapshots & rollback

Before any change (agentic pass, roll, transaction) the pre-change state is snapshotted per message (last 5 kept). Deleting a message, swiping it, or re-running the pass manually rolls state (and rolled message text) back to the baseline.
