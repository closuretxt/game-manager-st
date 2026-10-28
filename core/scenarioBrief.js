// Scenario brief — one per-chat text that explains the scenario (premise,
// tone, rules of the world, what matters). Every extension LLM call (wizard,
// generators, pre-pass, specialists, post-pass) receives it, so all engines
// judge the same world. Optionally it is also injected into the story prompt
// through the low-priority macro, like a custom field.
//
// Stored with the chat's game state: d.scenario = { text, inject }.

import { getContext } from "../../../../extensions.js";
import { substituteParams } from "../../../../../script.js";
import { stateManager } from "./stateManager.js";

const MAX_BRIEF = 6000;

const esc = v => String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function getScenario() {
    const d = stateManager.getData();
    if (!d.scenario || typeof d.scenario !== "object") d.scenario = { text: "", inject: false };
    return d.scenario;
}

export function getScenarioBriefText() {
    return String(getScenario().text || "").trim().slice(0, MAX_BRIEF);
}

export function setScenarioBrief({ text, inject } = {}) {
    const sc = getScenario();
    if (text !== undefined) sc.text = String(text);
    if (inject !== undefined) sc.inject = !!inject;
    stateManager.emitChange("scenario_brief");
}

// ST macros ({{char}}, {{user}}...) resolve like in custom instructions.
function rendered() {
    const text = getScenarioBriefText();
    if (!text) return "";
    try {
        const st = getContext();
        return substituteParams(text, { name2Override: st.characters?.[st.characterId]?.name });
    } catch {
        return text;
    }
}

// Block for the extension's own engine prompts ("" when no brief is set).
export function scenarioBriefBlock() {
    const text = rendered();
    if (!text) return "";
    return `<scenario_brief note="The scenario as defined by the player: premise, tone and rules of this world. Every judgment must fit it.">\n${text}\n</scenario_brief>`;
}

// Line for the story prompt's low-priority macro (only when flagged).
export function scenarioBriefInjection() {
    if (!getScenario().inject) return "";
    const text = rendered();
    return text ? `<scenario>${esc(text)}</scenario>` : "";
}
