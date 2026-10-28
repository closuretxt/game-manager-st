// PER-CHAT FEATURE MODES — the gameplay feature flags and tab toggles can be
// overridden per chat on top of the global settings. Resolution order for a
// key: the chat's explicit override -> the chat's mode preset -> the global
// setting. A chat with no mode follows the global default_mode, so new chats
// start from the user's chosen default.
//
// Stored in chatMetadata.game_manager.features — NOT inside the game data:
// snapshots roll back the whole data object on swipe/delete, and a mode
// switch must survive that.
//
// Every read site goes through gmSettings(): a read-only view of the settings
// object where these keys resolve per chat. Writes through it still land on
// the global settings (so code that mutates `s.foo` keeps working).

import { extension_settings, getContext } from "../../../../extensions.js";
import { extensionName } from "./constants.js";

// Gameplay flags a chat may override (key -> label for the window's Chat Mode dialog).
export const FEATURE_LABELS = {
    feature_warnings: "Warnings",
    feature_dice: "Dice rolls",
    feature_transactions: "Transactions",
    feature_enemies: "Enemies",
    feature_combat: "Combat Mode",
    feature_ally_ai: "Ally AI",
    feature_rewrite: "Action rewrite",
    feature_skill_suggest: "Skill suggestions",
    feature_progression: "Progression",
    feature_skill_tree: "Skill Trees",
    feature_death: "Permadeath",
    feature_roster_rotation: "Roster rotation",
    feature_bonds: "Bonds",
};
export const CHAT_FEATURE_KEYS = Object.keys(FEATURE_LABELS);

// Opt-in per chat only: rotation moves characters on its own, so no mode
// preset switches it on (unlisted keys fall back to the global setting).
const OPT_IN = ["feature_roster_rotation"];

// Tab toggles: hiding a tab also stops tracking its container — the LLMs no
// longer see it in snapshots and the tracker's tags for it are ignored, so
// hidden data never evolves out of sight.
export const TAB_TOGGLES = [
    { key: "tab_inventory", label: "Inventory", containers: ["inventory"] },
    { key: "tab_skills", label: "Skills", containers: ["skills"] },
    { key: "tab_passives", label: "Passives", containers: ["passives"] },
    { key: "tab_statuses", label: "Statuses", containers: ["statuses"] },
    { key: "tab_shared", label: "Resource Manager", containers: ["sharedResources"] },
    { key: "tab_custom", label: "Custom", containers: ["custom"] },
];

export const OVERRIDABLE_KEYS = [...CHAT_FEATURE_KEYS, ...TAB_TOGGLES.map(t => t.key)];
const ALL_ON = Object.fromEntries(OVERRIDABLE_KEYS.filter(k => !OPT_IN.includes(k)).map(k => [k, true]));

const RPG_OFF = {
    feature_dice: false,
    feature_enemies: false,
    feature_combat: false,
    feature_ally_ai: false,
    feature_skill_suggest: false,
    feature_progression: false,
    feature_skill_tree: false,
    feature_death: false,
};

// Bonds (NPC feelings toward the player) belong to the relationship modes.
const NO_BONDS = { feature_bonds: false };

// Mode presets: only the keys a mode cares about; anything unlisted falls
// back to the global setting. "custom" lists nothing = the global settings.
export const FEATURE_MODES = {
    custom: { label: "Custom", values: {} },
    rpg: {
        label: "RPG",
        values: { ...ALL_ON, ...NO_BONDS },
    },
    romance: {
        label: "Romance",
        values: {
            ...RPG_OFF,
            feature_transactions: false,
            tab_inventory: false,
            tab_skills: false,
            tab_passives: false,
            tab_shared: false,
            feature_warnings: true,
            feature_rewrite: true,
            feature_bonds: true,
            tab_statuses: true,
            tab_custom: true,
        },
    },
    slice_of_life: {
        label: "Slice of life",
        values: {
            ...RPG_OFF,
            feature_dice: true,
            feature_transactions: true,
            feature_warnings: true,
            feature_rewrite: true,
            feature_bonds: true,
            tab_inventory: true,
            tab_skills: false,
            tab_passives: false,
            tab_statuses: true,
            tab_shared: true,
            tab_custom: true,
        },
    },
    survival: {
        label: "Survival",
        values: {
            ...ALL_ON,
            ...NO_BONDS,
            feature_progression: false,
            feature_skill_tree: false,
        },
    },
};

function globals() {
    return extension_settings[extensionName] || {};
}

// The chat's features bucket, or null when no chat is open (globals apply).
function chatBucket(create = false) {
    const st = getContext();
    if (!st?.chatMetadata || !st.getCurrentChatId?.()) return null;
    const gm = st.chatMetadata.game_manager;
    if (!gm && !create) return null;
    const store = gm || (st.chatMetadata.game_manager = {});
    if (!store.features && !create) return null;
    if (!store.features || typeof store.features !== "object") store.features = { mode: null, overrides: {} };
    if (!store.features.overrides || typeof store.features.overrides !== "object") store.features.overrides = {};
    return store.features;
}

function saveChat() {
    try {
        const st = getContext();
        if (typeof st.saveMetadataDebounced === "function") st.saveMetadataDebounced();
        else st.saveMetadata?.();
    } catch (e) {
        console.error("[Game Manager] saving chat features failed:", e);
    }
}

export function hasChat() {
    return !!getContext()?.getCurrentChatId?.();
}

// Explicit chat mode (null = follows the global default).
export function getChatMode() {
    const m = chatBucket()?.mode;
    return FEATURE_MODES[m] ? m : null;
}

export function getEffectiveMode() {
    const m = getChatMode() ?? globals().default_mode;
    return FEATURE_MODES[m] ? m : "custom";
}

export function getOverrides() {
    return { ...(chatBucket()?.overrides || {}) };
}

// The value a key would have from the mode alone (no chat override).
function modeValue(key) {
    const preset = FEATURE_MODES[getEffectiveMode()].values;
    return key in preset ? !!preset[key] : globals()[key] !== false;
}

export function getFeature(key) {
    const o = chatBucket()?.overrides;
    if (o && key in o) return !!o[key];
    return modeValue(key);
}

// Switching mode clears the chat's overrides: the mode is the new baseline.
export function setChatMode(mode) {
    const b = chatBucket(true);
    if (!b) return false;
    b.mode = FEATURE_MODES[mode] ? mode : null;
    b.overrides = {};
    saveChat();
    return true;
}

// An override equal to the mode's value is dropped — the bucket only holds
// real deviations, so "(modified)" stays honest.
export function setFeatureOverride(key, value) {
    if (!OVERRIDABLE_KEYS.includes(key)) return false;
    const b = chatBucket(true);
    if (!b) return false;
    if (!!value === modeValue(key)) delete b.overrides[key];
    else b.overrides[key] = !!value;
    saveChat();
    return true;
}

export function resetChatFeatures() {
    const b = chatBucket();
    if (!b) return;
    b.mode = null;
    b.overrides = {};
    saveChat();
}

// Container gate shared by the UI, the snapshot renderers and the parser.
// Containers no tab toggle covers (resources, attributes, traits) are always on.
export function containerEnabled(container) {
    const tab = TAB_TOGGLES.find(t => t.containers.includes(container));
    return !tab || getFeature(tab.key);
}

export function tabEnabled(key) {
    return getFeature(key);
}

// Read view over the settings: overridable keys resolve per chat, every other
// key (and every write) goes straight to the global settings object.
const _handler = {
    get(target, key) {
        if (typeof key === "string" && OVERRIDABLE_KEYS.includes(key)) return getFeature(key);
        return target[key];
    },
};
let _proxy = null, _proxyTarget = null;
export function gmSettings() {
    const s = globals();
    if (_proxyTarget !== s) {
        _proxyTarget = s;
        _proxy = new Proxy(s, _handler);
    }
    return _proxy;
}
