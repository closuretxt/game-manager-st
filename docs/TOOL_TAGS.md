# Tool Tags (dormant in v1)

The AI reports game-state changes as small XML blocks that resemble tool calls. The parser (`core/toolParser.js`) is tolerant by design: **tags are optional every turn** (no tags = nothing changed), unknown characters/resources are skipped, and malformed blocks are ignored with a debug log instead of breaking the turn.

> This system is gated behind the **"Agentic resource updates"** setting, which is **off by default**.

## Blocks

Each block is scoped by an optional `<char>` (or `<target>`) tag; when omitted, the **active character** is used.

### `<change_values>` — resources & attribute deltas
```xml
<change_values>
  <char>Kira</char>
  <resource name="HP" delta="-12"/>
  <resource name="Stress" value="35"/>
  <attribute name="Strength" delta="1"/>
</change_values>
```
`delta` adjusts relative to the current value; `value` sets an absolute one (resources are clamped to their min/max).

### `<set_attributes>` — milestone attribute updates
```xml
<set_attributes>
  <char>Kira</char>
  <attribute name="Fortitude" value="8"/>
</set_attributes>
```

### `<add_items>` — add inventory items
```xml
<add_items>
  <char>Kira</char>
  <item name="Health Potion" qty="2" description="Restores 20 HP."/>
</add_items>
```
If the item already exists, quantities stack.

### `<remove_items>` — consume/remove items
```xml
<remove_items>
  <char>Kira</char>
  <item name="Ammo" qty="3"/>
</remove_items>
```
`qty` is optional — omitting it removes the item entirely.

### `<update_custom>` — AI-managed custom features
```xml
<update_custom>
  <char>Kira</char>
  <entry name="Seeds" value="Sprouting" description="Planted near the cabin."/>
</update_custom>
```
Creates the entry if it doesn't exist.

### `<warnings>` — player warnings (party-level)
```xml
<warnings>
  <warning name="Food" text="You have about two days of food left."/>
  <warning_clear name="Food"/>
</warnings>
```
Creates/updates a warning by name; `<warning_clear>` removes it. Warnings are shown to the player in the panel and injected into the story LLM via `{{gamemaster-low-priority}}`. Use them **only for imminent, concrete needs** (supplies running out, deadlines, approaching dangers), keep the text under 15 words, and clear them when the cause is resolved. Do not re-emit unchanged warnings every turn.

## Rules for the AI (for the future injection prompt)

1. Only emit blocks for values that actually changed this turn.
2. Use the party character names exactly as tracked.
3. Never touch shared/party-wide resources — those are user-managed only (the transaction pre-master handles them).