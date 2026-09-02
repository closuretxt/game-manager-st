// Deep context builder (optional — gated by the "Deep context" setting).
// When enabled, the extension's LLM calls (setup wizard, pre-pass router,
// post-pass agent) receive the character card, user persona, author's note
// and ACTIVATED World Info entries — appended to the SYSTEM message, before
// any state or history in the user message. WI is activated against the
// recent chat + scenario text, so only lore relevant to the current scene is
// pulled — never a whole-book dump.
//
// Everything here is best-effort: a missing/changed SillyTavern API degrades
// to an empty block instead of breaking the call.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

const MAX_CARD_FIELD = 5000;
const MAX_NOTE = 6000;
const MAX_WI_CHARS = 40000;

// Activates World Info via getWorldInfoPrompt — the same call as the reference
// implementation (setup/AnotherExtensionIndex.js runPass): chat strings
// newest-first + max context + dry run. Dynamic import + guards so a changed
// world-info.js API never breaks the extension.
// Reads the user persona description via power-user.js — dynamic import +
// guard so a changed API just degrades to an empty string.
async function getPersonaDescription() {
    try {
        const pu = await import("../../../../power-user.js");
        return String(pu?.power_user?.persona_description || "").trim();
    } catch (e) {
        logDebug("loreContext: persona description unavailable:", e?.message || e);
        return "";
    }
}

async function activateWorldInfo(chatStrings) {
    try {
        const wi = await import("../../../../world-info.js");
        if (typeof wi?.getWorldInfoPrompt !== "function") return "";

        const result = await wi.getWorldInfoPrompt(chatStrings, 100000, true);
        const toText = v => Array.isArray(v) ? v.join("\n") : String(v || "");
        const parts = [toText(result?.worldInfoBefore), toText(result?.worldInfoAfter)].filter(Boolean);
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

    // Character card — same access pattern as the reference implementation
    // (setup/AnotherExtensionIndex.js runPass): st.characters[st.characterId].
    const char = st.characters?.[st.characterId];
    logDebug(`loreContext: character lookup — characterId=${st.characterId}, found=${!!char}, `
        + `name=${char?.name || "(none)"}, description=${char?.description ? `${String(char.description).length} chars` : "empty"}`);
    if (char) {
        const cardLines = [
            char.name ? `<name>${char.name}</name>` : "",
            char.description ? `<description>${String(char.description).slice(0, MAX_CARD_FIELD)}</description>` : "",
            char.scenario ? `<scenario>${String(char.scenario).slice(0, MAX_NOTE)}</scenario>` : "",
        ].filter(Boolean);
        if (cardLines.length) parts.push(`CHARACTER CARD:\n${cardLines.join("\n")}`);
    }

    // User persona — name plus description (when set).
    if (st?.name1) {
        const personaLines = [`USER PERSONA: ${st.name1}`];
        const personaDesc = await getPersonaDescription();
        if (personaDesc) personaLines.push(personaDesc.slice(0, MAX_NOTE));
        parts.push(personaLines.join("\n"));
    }

    // Author's note.
    const note = st?.chatMetadata?.note_prompt;
    if (note) parts.push(`AUTHOR'S NOTE: ${String(note).slice(0, MAX_NOTE)}`);

    // World Info — activated against the recent chat (newest first, exactly
    // like the reference implementation) plus the scenario/extra text.
    const chatStrings = (Array.isArray(st?.chat) ? st.chat : [])
        .slice()
        .reverse()
        .map(m => String(m.mes ?? ""));
    if (extraText) chatStrings.push(String(extraText).slice(0, 2000));
    const wi = await activateWorldInfo(chatStrings);
    if (wi) parts.push(`WORLD INFO (activated):\n${wi}`);

    logDebug(`loreContext: deep context parts — card=${parts.some(p => p.startsWith("CHARACTER CARD"))}, `
        + `persona=${parts.some(p => p.startsWith("USER PERSONA"))}, `
        + `note=${parts.some(p => p.startsWith("AUTHOR'S NOTE"))}, `
        + `worldInfo=${wi ? `${wi.length} chars` : "none"} `
        + `(characterId=${st?.characterId}, name1=${st?.name1 || "(none)"})`);
    return parts.join("\n\n");
}
