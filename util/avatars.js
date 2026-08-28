// Safe character avatar resolution for the Game Manager UI.
// Resolves through SillyTavern's getThumbnail API (which handles default
// avatars and missing files) instead of hand-building "User Avatars/<file>"
// URLs — a deleted or invalid avatar file therefore never produces raw 404s
// from the panel. The party list renders an icon placeholder first and only
// swaps in the picture once it has resolved; an <img> error handler restores
// the placeholder as a final safety net.

import { getContext } from "../../../../extensions.js";
import { logDebug } from "../core/debug.js";

const _cache = new Map(); // character name (lowercase) -> resolved url or null

export async function getCharacterAvatar(name) {
    const key = String(name ?? "").toLowerCase();
    if (_cache.has(key)) return _cache.get(key);

    let url = null;
    try {
        const st = getContext();
        const char = (st.characters || []).find(c => String(c.name).toLowerCase() === key);
        if (char) {
            if (typeof char.avatar === "string" && char.avatar.startsWith("data:")) {
                // Embedded avatar — use it directly, nothing to fetch.
                url = char.avatar;
            } else if (char.avatar && typeof st.getThumbnail === "function") {
                // ST's thumbnail API: falls back to the default avatar server-side
                // and rejects gracefully instead of leaking a raw 404 into the DOM.
                const result = st.getThumbnail("avatar", char.avatar);
                const resolved = (result && typeof result.then === "function") ? await result : result;
                url = (typeof resolved === "string" && resolved) ? resolved : null;
            }
        }
    } catch (e) {
        logDebug("avatar resolution failed for", name, e);
        url = null;
    }

    _cache.set(key, url);
    return url;
}

export function clearAvatarCache() {
    _cache.clear();
}