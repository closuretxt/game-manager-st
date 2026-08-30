// Central data store for the Game Manager.
// State is saved PER CHAT: it lives under chatMetadata.game_manager.data and is
// persisted through SillyTavern's saveMetadata(). If no chat is open it falls
// back to extension_settings[extensionName].data. UI modules subscribe via onChange.

import { extension_settings, getContext } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { extensionName } from "./constants.js";
import { CHARACTER_CONTAINERS, GM_SCHEMA, defaultEntry, genId } from "./schemas.js";
import { logDebug } from "./debug.js";

const _listeners = new Set();
let _data = null; // in-memory, chat-scoped state

function settings() {
    return extension_settings[extensionName];
}

// Returns the per-chat storage bucket (creating it if needed), or null when no chat is open.
function chatStore() {
    const st = getContext();
    if (st?.chatMetadata) {
        st.chatMetadata.game_manager = st.chatMetadata.game_manager || {};
        return st.chatMetadata.game_manager;
    }
    return null;
}

export const stateManager = {
    // ---------- lifecycle ----------
    getData() {
        if (_data) return _data;
        if (!settings().data || typeof settings().data !== "object") settings().data = {};
        return settings().data;
    },

    init() {
        this.loadForChat({ migrate: true });
    },

    // Loads (or seeds) the state for the currently open chat. Called on startup
    // and on CHAT_CHANGED so each chat carries its own party/resources/custom.
    loadForChat({ migrate = false } = {}) {
        const store = chatStore();
        const s = settings();
        _data = null;

        if (store) {
            if (store.data && typeof store.data === "object") {
                _data = store.data;
            } else if (migrate && s.data) {
                // One-time migration: seed this chat from the old global data.
                _data = s.data;
                delete s.data; // so other chats don't inherit it again
                saveSettingsDebounced();
                logDebug("migrated global game state into current chat");
            } else {
                _data = {};
            }
        } else {
            // No chat open — keep using the global settings bucket.
            if (!s.data || typeof s.data !== "object") s.data = {};
            _data = s.data;
        }

        this._normalize();
        this.persist();
        this.emitChange("chat_loaded");
    },

    _normalize() {
        const d = this.getData();
        if (!Array.isArray(d.characters)) d.characters = [];
        if (!Array.isArray(d.sharedResources)) d.sharedResources = [];
        if (!Array.isArray(d.roster)) d.roster = [];
        if (!Array.isArray(d.custom)) d.custom = [];
        if (!Array.isArray(d.warnings)) d.warnings = [];
        for (const c of d.characters) {
            c.id = c.id || genId();
            c.name = c.name || "Unnamed";
            for (const key of CHARACTER_CONTAINERS) {
                if (!Array.isArray(c[key])) c[key] = [];
            }
            // Migration: custom features used to be per-character, now party-wide.
            if (Array.isArray(c.custom) && c.custom.length) {
                d.custom.push(...c.custom);
            }
            delete c.custom;
        }
        if (!d.characters.some(c => c.id === d.activeCharacterId)) {
            d.activeCharacterId = d.characters[0]?.id ?? null;
        }
    },

    persist() {
        const store = chatStore();
        if (store) {
            store.data = _data;
            try {
                getContext().saveMetadata();
            } catch (e) {
                console.error("[Game Manager] saveMetadata failed:", e);
            }
        } else {
            settings().data = _data;
            saveSettingsDebounced();
        }
    },

    // Whole-state rollback (used by the snapshot system).
    replaceData(newState) {
        _data = structuredClone(newState || {});
        this._normalize();
        this.persist();
        this.emitChange("restore");
    },

    emitChange(reason = "change") {
        this.persist();
        logDebug("state changed:", reason);
        for (const cb of _listeners) {
            try { cb(reason); } catch (e) { console.error("[Game Manager] listener error", e); }
        }
    },

    onChange(cb) {
        _listeners.add(cb);
        return () => _listeners.delete(cb);
    },

    // ---------- characters ----------
    getCharacters() {
        return this.getData().characters;
    },

    getCharacter(idOrName) {
        const list = this.getCharacters();
        const needle = String(idOrName ?? "").toLowerCase();
        return list.find(c => c.id === idOrName)
            || list.find(c => c.name.toLowerCase() === needle)
            || null;
    },

    getActiveCharacter() {
        return this.getCharacters().find(c => c.id === this.getData().activeCharacterId) || null;
    },

    setActiveCharacter(id) {
        const d = this.getData();
        if (d.activeCharacterId !== id) {
            d.activeCharacterId = id;
            this.emitChange("select_character");
        }
    },

    addCharacter(name, templateEntries = null) {
        const d = this.getData();
        const char = { id: genId(), name };
        for (const key of CHARACTER_CONTAINERS) char[key] = [];
        if (templateEntries) {
            for (const key of CHARACTER_CONTAINERS) {
                char[key] = (templateEntries[key] || []).map(e => structuredClone(e));
            }
        }
        d.characters.push(char);
        d.activeCharacterId = char.id;
        this.emitChange("add_character");
        return char;
    },

    removeCharacter(id) {
        const d = this.getData();
        d.characters = d.characters.filter(c => c.id !== id);
        if (d.activeCharacterId === id) {
            d.activeCharacterId = d.characters[0]?.id ?? null;
        }
        this.emitChange("remove_character");
    },

    renameCharacter(id, name) {
        const c = this.getCharacter(id);
        if (c && name) {
            c.name = name;
            this.emitChange("rename_character");
        }
    },

    // ---------- per-character entries ----------
    addEntry(characterId, type, overrides = {}) {
        const char = this.getCharacter(characterId);
        if (!char) return null;
        const entry = defaultEntry(type, overrides);
        char[GM_SCHEMA[type].container].push(entry);
        this.emitChange("add_entry");
        return entry;
    },

    updateEntry(characterId, type, entryId, patch) {
        const char = this.getCharacter(characterId);
        if (!char) return;
        const entry = char[GM_SCHEMA[type].container].find(e => e.id === entryId);
        if (!entry) return;
        Object.assign(entry, patch);
        if (type === "resource") this._clampResource(entry);
        this.emitChange("update_entry");
    },

    removeEntry(characterId, type, entryId) {
        const char = this.getCharacter(characterId);
        if (!char) return;
        const container = char[GM_SCHEMA[type].container];
        const idx = container.findIndex(e => e.id === entryId);
        if (idx !== -1) {
            container.splice(idx, 1);
            this.emitChange("remove_entry");
        }
    },

    // ---------- party-level roster (lightweight allies, not fully tracked) ----------
    // Gacha-style scenarios can have DOZENS of allies; only the ones the user
    // promotes become full party sheets. Roster entries are never injected
    // and never rolled for.
    addRosterEntry(overrides = {}) {
        const entry = defaultEntry("roster", overrides);
        this.getData().roster.push(entry);
        this.emitChange("add_roster");
        return entry;
    },

    updateRosterEntry(id, patch) {
        const entry = this.getData().roster.find(x => x.id === id);
        if (entry) {
            Object.assign(entry, patch);
            this.emitChange("update_roster");
        }
    },

    removeRosterEntry(id) {
        const d = this.getData();
        d.roster = d.roster.filter(x => x.id !== id);
        this.emitChange("remove_roster");
    },

    // Promotes a roster ally to a fully tracked party character.
    promoteRosterEntry(id) {
        const d = this.getData();
        const entry = d.roster.find(x => x.id === id);
        if (!entry) return null;
        d.roster = d.roster.filter(x => x.id !== id);
        return this.addCharacter(entry.name);
    },

    // ---------- party-level shared resources ----------
    addSharedEntry(overrides = {}) {
        const entry = defaultEntry("shared", overrides);
        this.getData().sharedResources.push(entry);
        this.emitChange("add_shared");
        return entry;
    },

    updateSharedEntry(id, patch) {
        const entry = this.getData().sharedResources.find(x => x.id === id);
        if (entry) {
            Object.assign(entry, patch);
            this.emitChange("update_shared");
        }
    },

    removeSharedEntry(id) {
        const d = this.getData();
        d.sharedResources = d.sharedResources.filter(x => x.id !== id);
        this.emitChange("remove_shared");
    },

    // ---------- AI-facing mutation helpers (used by the tool-tag parser) ----------
    _clampResource(entry) {
        const min = Number.isFinite(+entry.min) ? +entry.min : 0;
        const max = Number.isFinite(+entry.max) ? +entry.max : Number.POSITIVE_INFINITY;
        let v = Number.isFinite(+entry.value) ? +entry.value : min;
        entry.value = Math.min(max, Math.max(min, v));
        entry.min = min;
        entry.max = Number.isFinite(+entry.max) ? +entry.max : 0;
    },

    // Change a resource/attribute by delta or to an absolute value. Matches by name (case-insensitive).
    applyDelta(characterId, type, name, { delta, value } = {}) {
        const char = this.getCharacter(characterId);
        if (!char) return false;
        const needle = String(name ?? "").toLowerCase();
        const entry = char[GM_SCHEMA[type].container].find(e => String(e.name).toLowerCase() === needle);
        if (!entry) {
            logDebug(`applyDelta: '${name}' not found on '${char.name}'`);
            return false;
        }
        if (delta !== undefined && delta !== null && delta !== "") {
            entry.value = ((Number(entry.value) || 0) + Number(delta)) || 0;
        } else if (value !== undefined && value !== null && value !== "") {
            entry.value = Number(value) || 0;
        }
        if (type === "resource") this._clampResource(entry);
        this.emitChange("apply_delta");
        return true;
    },

    addItem(characterId, { name, qty = 1, description = "" } = {}) {
        const char = this.getCharacter(characterId);
        if (!char || !name) return false;
        const needle = String(name).toLowerCase();
        const existing = char.inventory.find(e => String(e.name).toLowerCase() === needle);
        if (existing) {
            existing.qty = (Number(existing.qty) || 0) + (Number(qty) || 0);
        } else {
            char.inventory.push(defaultEntry("item", { name, qty: Number(qty) || 1, description }));
        }
        this.emitChange("add_item");
        return true;
    },

    removeItem(characterId, name, qty = null) {
        const char = this.getCharacter(characterId);
        if (!char || !name) return false;
        const needle = String(name).toLowerCase();
        const entry = char.inventory.find(e => String(e.name).toLowerCase() === needle);
        if (!entry) return false;
        if (qty === null || qty === undefined || qty === "") {
            char.inventory = char.inventory.filter(e => e !== entry);
        } else {
            entry.qty = (Number(entry.qty) || 0) - (Number(qty) || 0);
            if (entry.qty <= 0) char.inventory = char.inventory.filter(e => e !== entry);
        }
        this.emitChange("remove_item");
        return true;
    },

    // ---------- party-level custom features (AI-managed) ----------
    addCustomEntry(overrides = {}) {
        const entry = defaultEntry("custom", overrides);
        this.getData().custom.push(entry);
        this.emitChange("add_custom");
        return entry;
    },

    updateCustomEntry(id, patch) {
        const entry = this.getData().custom.find(x => x.id === id);
        if (entry) {
            Object.assign(entry, patch);
            this.emitChange("update_custom");
        }
    },

    removeCustomEntry(id) {
        const d = this.getData();
        d.custom = d.custom.filter(x => x.id !== id);
        this.emitChange("remove_custom");
    },

    // AI-facing: create/update a party-wide custom feature by name.
    updateCustom({ name, value, description } = {}) {
        if (!name) return false;
        const d = this.getData();
        const needle = String(name).toLowerCase();
        let entry = d.custom.find(e => String(e.name).toLowerCase() === needle);
        if (!entry) {
            entry = defaultEntry("custom", { name });
            d.custom.push(entry);
        }
        if (value !== undefined && value !== "") entry.value = value;
        if (description !== undefined && description !== "") entry.description = description;
        this.emitChange("update_custom");
        return true;
    },

    // ---------- party-level warnings (AI-managed, injected via low-priority) ----------
    // Warnings are short, minimalist remarks ("Food runs out in ~2 days") shown
    // to the player in the panel and injected into the story LLM context.
    setWarning({ name, text } = {}) {
        if (!name) return false;
        const d = this.getData();
        const needle = String(name).toLowerCase();
        let entry = d.warnings.find(w => String(w.name).toLowerCase() === needle);
        if (!entry) {
            entry = { id: genId(), name };
            d.warnings.push(entry);
        }
        if (text !== undefined && text !== "") entry.text = text;
        this.emitChange("set_warning");
        return true;
    },

    clearWarning(name) {
        if (!name) return false;
        const d = this.getData();
        const needle = String(name).toLowerCase();
        const before = d.warnings.length;
        d.warnings = d.warnings.filter(w => String(w.name).toLowerCase() !== needle);
        if (d.warnings.length === before) return false;
        this.emitChange("clear_warning");
        return true;
    },

    removeWarning(id) {
        const d = this.getData();
        d.warnings = d.warnings.filter(w => w.id !== id);
        this.emitChange("clear_warning");
    },
};