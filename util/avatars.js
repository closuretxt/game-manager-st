// Safe character avatar resolution for the Game Manager UI.
// Resolution chain (first hit wins):
//   1. UPLOADED — a picture the user uploaded for this character. The file
//      lives full-quality and UNTOUCHED on the ST server ("user/files/", via
//      the /api/files/upload attachment endpoint — raw bytes, no re-encode,
//      and invisible to the persona picker); only the returned file URL is
//      kept on the GM character (chat metadata), so uploads survive chat
//      switches and never bloat settings or metadata.
//   2. CHARACTER — a SillyTavern character with the same name (exact match,
//      otherwise the first partial string match).
//   3. PERSONA — a SillyTavern persona with the same name (same fallback).
//   4. null — the UI keeps its icon placeholder.
// resolveAvatar() is the core; getCharacterAvatar() is a compat wrapper.
// onAvatarResolved() hooks let other views (character page backdrops, etc.)
// consume the same pictures without duplicating this logic.

import { getContext } from "../../../../extensions.js";
import { getThumbnailUrl, getRequestHeaders } from "../../../../../script.js";
import { stateManager } from "../core/stateManager.js";
import { logDebug } from "../core/debug.js";

const _cache = new Map(); // name (lowercase) -> { resolution, expires }
const _hooks = new Set(); // fn(name, resolution) subscribers
const _colorCache = new Map(); // url -> "rgb(r, g, b)" | null
const NULL_TTL = 30 * 1000; // misses are retried after this long

//

// Thumbnail URL (ST's /thumbnail endpoint resizes server-side). A missing
// file just breaks the <img> load, which the UI's error handler reverts to
// the placeholder — no fetch needed, the URL is built client-side. This is
// also the ONLY thing that serves avatar images on modern builds (there is
// no static route for the "User Avatars" folder), so full-size use (sheet
// backdrop) goes through it too — t busts the cache for fresh pictures.
function thumbnailUrl(type, file, t = false) {
    if (typeof getThumbnailUrl === "function") return getThumbnailUrl(type, file, t);
    return `/thumbnail?type=${type}&file=${encodeURIComponent(file)}${t ? `&t=${Date.now()}` : ""}`;
}

//

// 1. Uploaded picture (file URL stored on the GM character — the raw
// full-quality original, directly servable).
async function _fromUpload(key) {
    const char = stateManager.getCharacters().find(c => String(c.name).toLowerCase() === key);
    const file = char?.avatarFile;
    if (!file) return null;
    return { url: file, fullUrl: file, source: "upload" };
}

// ---------- name matching ----------
// Index of the first name that equals the key, else the first whose WORD
// sequence contains the other's words contiguously and in the same order,
// in EITHER direction — "Komachi" finds "Komachi Onozuka" and vice versa,
// but "Aaru" and "Uraa" are different names (no whole word in common).
// -1 = none.
function _findNameIndex(key, names) {
    const exact = names.findIndex(n => n === key);
    if (exact !== -1) return exact;
    const kw = key.split(/\s+/).filter(Boolean);
    if (!kw.length) return -1;
    return names.findIndex(n => {
        const nw = String(n || "").split(/\s+/).filter(Boolean);
        if (!nw.length) return false;
        const [short, long] = kw.length <= nw.length ? [kw, nw] : [nw, kw];
        for (let i = 0; i <= long.length - short.length; i++) {
            let ok = true;
            for (let j = 0; j < short.length; j++) {
                if (long[i + j] !== short[j]) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    });
}

//

// 2. SillyTavern character with the same name (exact, else partial match).
async function _fromCharacter(key) {
    const st = getContext();
    const chars = st.characters || [];
    const idx = _findNameIndex(key, chars.map(c => String(c.name || "").toLowerCase()));
    const char = idx !== -1 ? chars[idx] : null;
    if (!char || !char.avatar || char.avatar === "default") return null;
    return { url: thumbnailUrl("avatar", char.avatar), fullUrl: thumbnailUrl("avatar", char.avatar, true), source: "character" };
}

// 3. SillyTavern persona with the same name (exact, else partial match).
// Read off the context (powerUserSettings) — script.js does not re-export
// power_user on every ST build. The persona NAME lives in pu.personas
// (avatarId -> name); persona_descriptions entries carry no name.
async function _fromPersona(key) {
    const pu = getContext()?.powerUserSettings;
    if (!pu) return null;
    const names = pu.personas || {};
    const ids = Object.keys(names);
    const idx = _findNameIndex(key, ids.map(id => String(names[id] || "").toLowerCase()));
    const id = idx !== -1 ? ids[idx] : null;
    if (!id) return null;
    return { url: thumbnailUrl("persona", id), fullUrl: thumbnailUrl("persona", id, true), source: "persona" };
}

//

// Core resolver: { url, fullUrl, source } or null (no picture found).
export async function resolveAvatar(name) {
    const key = String(name ?? "").toLowerCase();
    const cached = _cache.get(key);
    if (cached && (!cached.expires || cached.expires > Date.now())) return cached.resolution;

    let resolution = null;
    try {
        resolution = await _fromUpload(key) || await _fromCharacter(key) || await _fromPersona(key);
    } catch (e) {
        logDebug("avatar resolution failed for", name, e);
        resolution = null;
    }

    // Positives are cached until cleared; misses get a short TTL so a lookup
    // that ran before ST finished loading retries instead of sticking as the
    // placeholder forever.
    _cache.set(key, { resolution, expires: resolution ? 0 : Date.now() + NULL_TTL });

    for (const cb of _hooks) {
        try { cb(name, resolution); } catch (e) { console.error("[Game Manager] avatar hook error", e); }
    }
    return resolution;
}

// Compat wrapper: just the display URL (or null for the placeholder).
export async function getCharacterAvatar(name) {
    return (await resolveAvatar(name))?.url ?? null;
}

//

// Average color of a picture ("almost just the color of the image"): drawn
// to a tiny canvas and averaged. Same-origin pictures only — a tainted canvas
// makes getImageData throw, which is caught and returns null. Cached per URL.
export async function extractDominantColor(url) {
    if (!url) return null;
    if (_colorCache.has(url)) return _colorCache.get(url);
    let color = null;
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = reject;
            el.src = url;
        });
        const size = 16;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue; // skip transparent pixels
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        if (n) color = _readableColor(r / n, g / n, b / n);
    } catch (e) {
        logDebug("dominant color extraction failed for", url, e);
    }
    _colorCache.set(url, color);
    return color;
}

// Normalizes an average color into a readable TEXT color: keeps the hue but
// clamps lightness and saturation, so dark images can't produce dark-on-dark
// names (Aaru's dark red) and blinding ones don't vibrate.
function _readableColor(r, g, b) {
    const [h, s, l] = _rgbToHsl(r, g, b);
    const L = Math.min(0.78, Math.max(0.6, l));
    const S = Math.min(0.85, Math.max(0.35, s));
    return `hsl(${Math.round(h)}, ${Math.round(S * 100)}%, ${Math.round(L * 100)}%)`;
}

function _rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return [h, s, l];
}

//

// Hook API — fired after every resolution with (name, { url, fullUrl, source }).
// Returns an unsubscribe function.
export function onAvatarResolved(cb) {
    _hooks.add(cb);
    return () => _hooks.delete(cb);
}

export function offAvatarResolved(cb) {
    _hooks.delete(cb);
}

export function clearAvatarCache() {
    _cache.clear();
}

//

// ---------- upload / removal ----------
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",").pop() || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// Uploads a picture to the ST server via the user-files attachment endpoint
// (/api/files/upload): raw base64 bytes, so the file is stored UNTOUCHED at
// full quality, and it never shows up in the persona picker. Returns the
// servable URL ("user/files/<name>") that /api/files/delete accepts back.
// gm_-prefixed so GM uploads are identifiable.
export async function uploadCharacterAvatar(file, name) {
    const ext = (String(file?.name || "").match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
    const base = String(name || "character").toLowerCase()
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "character";
    const filename = `gm_${base}_${Date.now()}.${ext}`;
    const data = await fileToBase64(file);
    const res = await fetch("/api/files/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: filename, data }),
    });
    if (!res.ok) throw new Error(`avatar upload failed: ${res.status}`);
    const out = await res.json().catch(() => null);
    return out?.path || `user/files/${filename}`;
}

// Best-effort server-side delete of an uploaded picture. A leftover orphan
// file is harmless, so failures are logged and swallowed. Only gm_ files
// under "user/files/" are ever deleted — avatarFile lives in (shareable)
// chat metadata, so this guarantees GM can never touch anything else.
export async function deleteCharacterAvatar(file) {
    const path = String(file || "");
    if (!path.startsWith("user/files/") || !path.includes("gm_")) return;
    try {
        await fetch("/api/files/delete", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
    } catch (e) {
        logDebug("avatar delete failed for", path, e);
    }
}
