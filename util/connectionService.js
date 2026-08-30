// Connection service — profile helpers and per-request profile routing.
// Uses SillyTavern's ConnectionManagerRequestService so the extension can run
// its own AI calls (agentic updates) through a specific connection profile
// WITHOUT touching the user's active connection. The old swap-based approach
// lives in util/profileSwapper.js and is only used when the legacy advanced
// option is enabled.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

export function isConnectionManagerActive(st = getContext()) {
    return !st?.extensionSettings?.disabledExtensions?.includes("connection-manager")
        && !!st?.extensionSettings?.connectionManager;
}

export function getConnectionProfiles(st = getContext()) {
    if (!isConnectionManagerActive(st)) {
        return [];
    }
    return st.extensionSettings.connectionManager.profiles || [];
}

export function hasConnectionProfile(st, profileId) {
    if (!profileId) return true;
    return getConnectionProfiles(st).some(p => p.id === profileId);
}

export function getProfileNameById(st, profileId) {
    if (!profileId) return null;
    const profile = getConnectionProfiles(st).find(p => p.id === profileId);
    return profile ? profile.name : null;
}

// Resolves which profile id to use: the preferred one if valid, otherwise the
// currently selected profile, otherwise "" (same as current connection).
export function resolveConnectionProfile(st, preferredProfileId = "") {
    const selected = st?.extensionSettings?.connectionManager?.selectedProfile || "";
    if (!isConnectionManagerActive(st)) {
        return "";
    }
    if (preferredProfileId && hasConnectionProfile(st, preferredProfileId)) {
        return preferredProfileId;
    }
    if (preferredProfileId) {
        logDebug(`Requested profile '${preferredProfileId}' not found. Falling back to current profile.`);
    }
    if (selected && hasConnectionProfile(st, selected)) {
        return selected;
    }
    return "";
}

// Resolves which profile id to use for PRE-MASTER calls (dice/transactions):
// its own setting, falling back to the agentic profile, then selected/current.
export function resolvePremasterProfile(st, premasterProfileId = "", agenticProfileId = "") {
    const agentic = resolveConnectionProfile(st, agenticProfileId);
    if (!premasterProfileId || !hasConnectionProfile(st, premasterProfileId)) {
        return agentic;
    }
    return premasterProfileId;
}

// Resolves which profile id to use for the scenario build wizard (a less
// agentic, one-shot JSON call): its own setting, falling back to the
// pre-master chain.
export function resolveWizardProfile(st, wizardProfileId = "", premasterProfileId = "", agenticProfileId = "") {
    if (wizardProfileId && hasConnectionProfile(st, wizardProfileId)) {
        return wizardProfileId;
    }
    return resolvePremasterProfile(st, premasterProfileId, agenticProfileId);
}

// Sends a chat-completion style request through a specific connection profile
// via ConnectionManagerRequestService. Returns the full text response.
// With { stream: true } and an onChunk callback, partial text is reported as
// it arrives (used by the dice roll bubble to stream tier options).
export async function sendRequestViaProfile(profileId, messages, { stream = false, onChunk = null } = {}) {
    const st = getContext();
    if (!st?.ConnectionManagerRequestService?.sendRequest) {
        throw new Error("ConnectionManagerRequestService.sendRequest is unavailable.");
    }

    logDebug(`sendRequestViaProfile: profile='${profileId || "<same-as-current>"}', stream=${stream}`);

    const createGenerator = await st.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        undefined,
        { stream }
    );

    if (typeof createGenerator === "function") {
        const generator = createGenerator();
        let result = "";
        for await (const chunk of generator) {
            if (chunk && chunk.text !== undefined) {
                result = chunk.text;
                if (onChunk) onChunk(result);
            }
        }
        return result;
    }

    if (createGenerator && typeof createGenerator === "object") {
        const text = createGenerator.content || createGenerator.text || String(createGenerator);
        if (onChunk) onChunk(text);
        return text;
    }

    return "";
}