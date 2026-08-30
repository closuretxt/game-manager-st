// Deep context builder (optional — gated by the "Deep context" setting).
// When enabled, the extension's LLM calls (setup wizard, pre-pass router)
// receive the character card, user persona, author's note and ACTIVATED World
// Info entries. WI is activated against the recent chat + scenario text, so
// only lore relevant to the current scene is pulled — never a whole-book dump.
//
// Everything here is best-effort: a missing/changed SillyTavern API degrades
// to an empty block instead of breaking the call.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

const MAX_CARD_FIELD = 1200;
const MAX_NOTE = 600;
const MAX_WI_CHARS = 4000;

// Activates World Info against `text`. Dynamic import + guards so a changed
// world-info.js API never breaks the extension.
async function activateWorldInfo(text) {
    try {
        const wi = await import("../../../../world-info.js");
        const st = getContext();
        const settings = st?.worldInfoSettings;
        if (!wi?.checkWorldInfo || !settings) return "";

        const budget = typeof wi.getWorldInfoBudget === "function"
            ? wi.getWorldInfoBudget(settings)
            : { worldInfoBudget: MAX_WI_CHARS, worldInfoBudgetPadding: 0 };
        const result = await wi.checkWorldInfo(text, settings, budget);
        const parts = [...(result?.worldInfoBefore || []), ...(result?.worldInfoAfter || [])];
        return parts.join("\n").slice(0, MAX_WI_CHARS);
    } catch (e) {
        logDebug("loreContext: world info activation unavailable:", e?.message || e);
        return "";
    }
}

// Builds the deep context block. `extraText` (e.g. the wizard's scenario
// description) participates in WI activation. Returns "" when nothing is
// found — callers just skip the block.
export async function buildDeepContext(extraText = "") {
    const st = getContext();
    const parts = [];

    // Character card — the character the chat is playing with.
    const char = st?.characters?.[st?.characterId];
    if (char) {
        const card = [
            char.description && `Description: ${String(char.description).slice(0, MAX_CARD_FIELD)}`,
            char.personality && `Personality: ${String(char.personality).slice(0, MAX_NOTE)}`,
            char.scenario && `Scenario: ${String(char.scenario).slice(0, MAX_NOTE)}`,
        ].filter(Boolean);
        if (card.length) parts.push(`CHARACTER CARD (${char.name || "unknown"}):\n${card.join("\n")}`);
    }

    // User persona.
    if (st?.name1) parts.push(`USER PERSONA: ${st.name1}`);

    // Author's note.
    const note = st?.chatMetadata?.note_prompt;
    if (note) parts.push(`AUTHOR'S NOTE: ${String(note).slice(0, MAX_NOTE)}`);

    // World Info — activated against recent chat + the extra text.
    const chat = Array.isArray(st?.chat) ? st.chat : [];
    const activationText = [
        ...chat.slice(-6).map(m => String(m.mes ?? "").slice(0, 500)),
        String(extraText || "").slice(0, 2000),
    ].join("\n");
    const wi = await activateWorldInfo(activationText);
    if (wi) parts.push(`WORLD INFO (activated):\n${wi}`);

    return parts.join("\n\n");
}
