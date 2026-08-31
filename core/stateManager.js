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

// Normalizes a character's progression track (level/exp/skill points). Present
// on every sheet; only meaningful when the progression feature is on.
function _normalizeProgression(c) {
    const p = c.progression && typeof c.progression === "object" && !Array.isArray(c.progression) ? c.progression : {};
    c.progression = {
        level: Math.max(1, Math.trunc(Number(p.level) || 1)),
        exp: Math.max(0, Math.trunc(Number(p.exp) || 0)),
        skill_points: Math.max(0, Math.trunc(Number(p.skill_points) || 0)),
    };
}

// Normalizes a character's skill tree ({generated_tiers, nodes}). Party-only:
// enemies can hold levels but never spend points or grow trees.
function _normalizeSkillTree(c) {
    const t = c.skillTree && typeof c.skillTree === "object" && !Array.isArray(c.skillTree) ? c.skillTree : {};
    c.skillTree = {
        generated_tiers: Math.max(0, Math.trunc(Number(t.generated_tiers) || 0)),
        nodes: (Array.isArray(t.nodes) ? t.nodes : []).filter(n => n && typeof n === "object" && n.id),
    };
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
        if (!Array.isArray(d.enemies)) d.enemies = [];
        if (!Array.isArray(d.enemyArchive)) d.enemyArchive = [];
        if (!Array.isArray(d.sharedResources)) d.sharedResources = [];
        if (!Array.isArray(d.roster)) d.roster = [];
        if (!Array.isArray(d.custom)) d.custom = [];
        if (!Array.isArray(d.warnings)) d.warnings = [];
        if (!Array.isArray(d.threads)) d.threads = [];
        // Per-scenario progression config (EXP curve, skill points). Absent
        // until the wizard proposes it or the user sets it by hand.
        if (d.progression !== null && (typeof d.progression !== "object" || Array.isArray(d.progression))) {
            delete d.progression;
        }
        for (const c of d.characters) {
            c.id = c.id || genId();
            c.name = c.name || "Unnamed";
            for (const key of CHARACTER_CONTAINERS) {
                if (!Array.isArray(c[key])) c[key] = [];
            }
            _normalizeProgression(c);
            _normalizeSkillTree(c);
            // Death flag: absent/false = alive (keeps old chats clean). The
            // reason only exists while dead.
            c.dead = c.dead === true;
            if (!c.dead) delete c.death_reason;
            // Knockout flag: absent/false = conscious (keeps old chats clean).
            c.knocked_out = c.knocked_out === true;
            if (!c.knocked_out) delete c.ko_reason;
            // Migration: custom features used to be per-character, now party-wide.
            if (Array.isArray(c.custom) && c.custom.length) {
                d.custom.push(...c.custom);
            }
            delete c.custom;
        }
        // Enemies share the party sheet shape (active + archived).
        for (const c of [...d.enemies, ...d.enemyArchive]) {
            c.id = c.id || genId();
            c.name = c.name || "Unnamed";
            for (const key of CHARACTER_CONTAINERS) {
                if (!Array.isArray(c[key])) c[key] = [];
            }
            _normalizeProgression(c);
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
        const char = this.getSheet(characterId);
        if (!char) return null;
        const entry = defaultEntry(type, overrides);
        char[GM_SCHEMA[type].container].push(entry);
        this.emitChange("add_entry");
        return entry;
    },

    updateEntry(characterId, type, entryId, patch) {
        const char = this.getSheet(characterId);
        if (!char) return;
        const entry = char[GM_SCHEMA[type].container].find(e => e.id === entryId);
        if (!entry) return;
        Object.assign(entry, patch);
        if (type === "resource") this._clampResource(entry);
        this.emitChange("update_entry");
    },

    removeEntry(characterId, type, entryId) {
        const char = this.getSheet(characterId);
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

    // Demotes a party character to the roster, KEEPING their full sheet so a
    // later promotion inherits the last state (mission-based party swaps:
    // mission -> demote -> weeks later -> promote -> same HP, items, skills).
    demoteCharacter(characterId) {
        const d = this.getData();
        const char = d.characters.find(c => c.id === characterId);
        if (!char) return null;
        const sheet = {};
        for (const key of CHARACTER_CONTAINERS) sheet[key] = structuredClone(char[key] || []);
        d.characters = d.characters.filter(c => c.id !== characterId);
        if (d.activeCharacterId === characterId) {
            d.activeCharacterId = d.characters[0]?.id ?? null;
        }
        const entry = defaultEntry("roster", { name: char.name, note: "" });
        entry.sheet = sheet;
        d.roster.push(entry);
        this.emitChange("demote_character");
        return entry;
    },

    // Promotes a roster ally to a fully tracked party character. Restores the
    // saved sheet when the ally was demoted from the party before; fresh
    // wizard/roster allies start with an empty sheet.
    promoteRosterEntry(id) {
        const d = this.getData();
        const entry = d.roster.find(x => x.id === id);
        if (!entry) return null;
        d.roster = d.roster.filter(x => x.id !== id);
        return this.addCharacter(entry.name, entry.sheet || null);
    },

    // ---------- death (permadeath) ----------
    // Death is a flag, not a container: the LLM reports it via <deaths>,
    // only the user (edit mode) can reverse it.
    isDead(idOrName) {
        const c = this.getCharacter(idOrName);
        return !!c?.dead;
    },

    setDead(idOrName, reason = "") {
        const c = this.getCharacter(idOrName);
        if (!c || c.dead === true) return null;
        c.dead = true;
        c.death_reason = String(reason || "").slice(0, 160);
        // The dead hold no cooldowns.
        for (const skill of c.skills || []) skill.cooldown_left = 0;
        this.emitChange("char_death");
        return c;
    },

    reviveChar(idOrName) {
        const c = this.getCharacter(idOrName);
        if (!c || c.dead !== true) return null;
        c.dead = false;
        delete c.death_reason;
        this.emitChange("char_revive");
        return c;
    },

    // ---------- knockout (recoverable unconsciousness) ----------
    // Like death, a flag rather than a container — but recoverable: the LLM
    // reports it via <knockouts> and clears it via <ko_clear> (rest, timeskip,
    // recovery), where death only the user can reverse.
    isKnockedOut(idOrName) {
        const c = this.getCharacter(idOrName);
        return !!c?.knocked_out;
    },

    setKnockedOut(idOrName, reason = "") {
        const c = this.getCharacter(idOrName);
        if (!c || c.dead === true || c.knocked_out === true) return null;
        c.knocked_out = true;
        c.ko_reason = String(reason || "").slice(0, 160);
        this.emitChange("char_knockout");
        return c;
    },

    clearKnockedOut(idOrName) {
        const c = this.getCharacter(idOrName);
        if (!c || c.knocked_out !== true) return null;
        c.knocked_out = false;
        delete c.ko_reason;
        this.emitChange("char_recover");
        return c;
    },

    // ---------- enemies (context-based, AI-managed) ----------
    // Enemies are full sheets like party characters, but their lifecycle is
    // driven by the scene: the AI adds/updates them via tool tags and removes
    // them when they become irrelevant (defeated, fled, scene moved on).
    // Removal ARCHIVES the sheet instead of deleting it, so a later
    // reappearance (recurring rival, respawning boss) inherits the last state.
    getEnemies() {
        return this.getData().enemies;
    },

    getEnemy(idOrName) {
        const list = this.getEnemies();
        const needle = String(idOrName ?? "").toLowerCase();
        return list.find(c => c.id === idOrName)
            || list.find(c => c.name.toLowerCase() === needle)
            || null;
    },

    // Resolves any sheet holder (party character OR enemy) by id or name —
    // used by the entry helpers and tool-tag scoping.
    getSheet(idOrName) {
        return this.getCharacter(idOrName) || this.getEnemy(idOrName);
    },

    // Creates an enemy, or restores its archived sheet when an enemy with the
    // same name reappears.
    addEnemy(name, templateEntries = null) {
        const d = this.getData();
        const needle = String(name ?? "").toLowerCase();
        const archivedIdx = d.enemyArchive.findIndex(e => String(e.name).toLowerCase() === needle);
        if (archivedIdx !== -1) {
            const enemy = d.enemyArchive.splice(archivedIdx, 1)[0];
            d.enemies.push(enemy);
            this.emitChange("restore_enemy");
            return enemy;
        }
        const enemy = { id: genId(), name };
        for (const key of CHARACTER_CONTAINERS) enemy[key] = [];
        if (templateEntries) {
            for (const key of CHARACTER_CONTAINERS) {
                enemy[key] = (templateEntries[key] || []).map(e => structuredClone(e));
            }
        }
        d.enemies.push(enemy);
        this.emitChange("add_enemy");
        return enemy;
    },

    // Removes an enemy from the active scene — archived, never deleted.
    removeEnemy(id) {
        const d = this.getData();
        const enemy = d.enemies.find(c => c.id === id);
        if (!enemy) return null;
        d.enemies = d.enemies.filter(c => c.id !== id);
        // Keep only the newest archive entry per enemy.
        d.enemyArchive = d.enemyArchive.filter(e => e.id !== id);
        d.enemyArchive.push(enemy);
        this.emitChange("remove_enemy");
        return enemy;
    },

    // Manually restores an archived enemy to the active scene (edit mode).
    restoreEnemy(id) {
        const d = this.getData();
        const entry = d.enemyArchive.find(e => e.id === id);
        if (!entry) return null;
        d.enemyArchive = d.enemyArchive.filter(e => e.id !== id);
        d.enemies.push(entry);
        this.emitChange("restore_enemy");
        return entry;
    },

    // Hard-deletes an archived enemy (edit mode only).
    purgeEnemy(id) {
        const d = this.getData();
        d.enemyArchive = d.enemyArchive.filter(e => e.id !== id);
        this.emitChange("purge_enemy");
    },

    // ---------- conversions (full sheet preserved in every direction) ----------
    // Roster ally -> enemy (restores their saved sheet when they had one).
    rosterToEnemy(id) {
        const d = this.getData();
        const entry = d.roster.find(x => x.id === id);
        if (!entry) return null;
        d.roster = d.roster.filter(x => x.id !== id);
        return this.addEnemy(entry.name, entry.sheet || null);
    },

    // Enemy joins the party (recruited) — keeps their full sheet.
    enemyToCharacter(id) {
        const d = this.getData();
        const enemy = d.enemies.find(c => c.id === id);
        if (!enemy) return null;
        const sheet = {};
        for (const key of CHARACTER_CONTAINERS) sheet[key] = structuredClone(enemy[key] || []);
        d.enemies = d.enemies.filter(c => c.id !== id);
        return this.addCharacter(enemy.name, sheet);
    },

    // Party member defects to the enemy side — keeps their full sheet.
    characterToEnemy(id) {
        const d = this.getData();
        const char = d.characters.find(c => c.id === id);
        if (!char) return null;
        const sheet = {};
        for (const key of CHARACTER_CONTAINERS) sheet[key] = structuredClone(char[key] || []);
        d.characters = d.characters.filter(c => c.id !== id);
        if (d.activeCharacterId === id) {
            d.activeCharacterId = d.characters[0]?.id ?? null;
        }
        const enemy = { id: genId(), name: char.name };
        for (const key of CHARACTER_CONTAINERS) enemy[key] = sheet[key];
        d.enemies.push(enemy);
        this.emitChange("character_to_enemy");
        return enemy;
    },

    // Enemy demoted to a lightweight roster ally — keeps their full sheet.
    enemyToRoster(id) {
        const d = this.getData();
        const enemy = d.enemies.find(c => c.id === id);
        if (!enemy) return null;
        const sheet = {};
        for (const key of CHARACTER_CONTAINERS) sheet[key] = structuredClone(enemy[key] || []);
        d.enemies = d.enemies.filter(c => c.id !== id);
        const entry = defaultEntry("roster", { name: enemy.name, note: "" });
        entry.sheet = sheet;
        d.roster.push(entry);
        this.emitChange("enemy_to_roster");
        return entry;
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
        const char = this.getSheet(characterId);
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
        const char = this.getSheet(characterId);
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
        const char = this.getSheet(characterId);
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

    // AI-facing: create/update a TEMPORARY per-character status by name
    // (Dazed, Drunk, Inspired...). Removed via removeStatusByName when it ends.
    updateStatus(characterId, { name, modifiers, effect } = {}) {
        if (!name) return false;
        const char = this.getSheet(characterId);
        if (!char) return false;
        if (!Array.isArray(char.statuses)) char.statuses = [];
        const needle = String(name).toLowerCase();
        let entry = char.statuses.find(e => String(e.name).toLowerCase() === needle);
        if (!entry) {
            entry = defaultEntry("status", { name });
            char.statuses.push(entry);
        }
        if (modifiers !== undefined && modifiers !== "") entry.modifiers = modifiers;
        if (effect !== undefined && effect !== "") entry.effect = effect;
        this.emitChange("update_status");
        return true;
    },

    // AI-facing: remove a status by name (when the condition ends).
    removeStatusByName(characterId, name) {
        const char = this.getSheet(characterId);
        if (!char || !name || !Array.isArray(char.statuses)) return false;
        const needle = String(name).toLowerCase();
        const before = char.statuses.length;
        char.statuses = char.statuses.filter(e => String(e.name).toLowerCase() !== needle);
        if (char.statuses.length === before) return false;
        this.emitChange("remove_status");
        return true;
    },

    // ---------- skill cooldowns (deterministic, code-controlled) ----------
    // Cooldowns are NEVER LLM-managed: the post-pass only REPORTS skill uses
    // (<use_skills> tool tag), the code sets cooldown_left = cooldown and
    // ticks it down once per fresh player message. LLMs only ever see a
    // boolean (on_cooldown) — they never reason about the remaining count.

    // Marks a skill as just used: starts its cooldown (in messages). Skills
    // with cooldown 0 are always ready and ignore this call.
    useSkill(characterId, skillName) {
        const char = this.getSheet(characterId);
        if (!char) return false;
        const needle = String(skillName ?? "").toLowerCase();
        const skill = (char.skills || []).find(s => String(s.name).toLowerCase() === needle);
        if (!skill) return false;
        const cd = Math.trunc(Number(skill.cooldown) || 0);
        if (cd <= 0) return false;
        skill.cooldown_left = cd;
        this.emitChange("use_skill");
        return true;
    },

    // Decrements every running cooldown by one message. Called once per fresh
    // player action, BEFORE the pre-pass judges it — so a skill used in the
    // previous exchange (cooldown 2) is still on cooldown this turn (1) and
    // frees up on the turn after (0).
    tickCooldowns() {
        const d = this.getData();
        let ticked = false;
        for (const c of [...(d.characters || []), ...(d.enemies || [])]) {
            for (const skill of c.skills || []) {
                const left = Number(skill.cooldown_left) || 0;
                if (left > 0) {
                    skill.cooldown_left = left - 1;
                    ticked = true;
                }
            }
        }
        if (ticked) this.emitChange("tick_cooldowns");
        return ticked;
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

    // ---------- party-level open threads (AI-managed, edit-mode-only UI) ----------
    // Open threads track UNTRACKED or UNFINISHED things the formal containers
    // cannot hold: ongoing trips (fuel spent so far), half-done actions,
    // secrets the player must not see. Each thread records where/when it
    // started (ref) so it can be compared later. They are visible only in
    // edit mode; the pre-pass and post-pass see them, the story prompt does
    // NOT — the pre-pass leaks what the scene demands via <note>.
    setThread({ name, text, ref } = {}) {
        if (!name) return false;
        const d = this.getData();
        const needle = String(name).toLowerCase();
        let entry = d.threads.find(t => String(t.name).toLowerCase() === needle);
        if (!entry) {
            entry = { id: genId(), name };
            d.threads.push(entry);
        }
        if (text !== undefined && text !== "") entry.text = text;
        if (ref !== undefined && ref !== "") entry.ref = ref;
        this.emitChange("set_thread");
        return true;
    },

    clearThread(name) {
        if (!name) return false;
        const d = this.getData();
        const needle = String(name).toLowerCase();
        const before = d.threads.length;
        d.threads = d.threads.filter(t => String(t.name).toLowerCase() !== needle);
        if (d.threads.length === before) return false;
        this.emitChange("clear_thread");
        return true;
    },

    removeThread(id) {
        const d = this.getData();
        d.threads = d.threads.filter(t => t.id !== id);
        this.emitChange("clear_thread");
    },
};