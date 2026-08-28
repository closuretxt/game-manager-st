// Modular type registry.
// This is THE seam for future additions (skill trees, combat system, maps, etc.):
// a new trackable type only needs one entry here — the settings editors, list
// renderers, presets and tool-tag parser all derive from these definitions.

let _idCounter = 0;
export function genId() {
    return `gm_${Date.now().toString(36)}_${(_idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const GM_SCHEMA = {
    resource: {
        label: "Resource",
        plural: "Resources",
        icon: "fa-solid fa-heart-pulse",
        container: "resources",
        description: "Tracked value with a custom range (e.g. Health 1-100, Ammo 1-36).",
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Resource" },
            { key: "value", label: "Current", type: "number", default: 10 },
            { key: "min", label: "Min", type: "number", default: 0 },
            { key: "max", label: "Max", type: "number", default: 100 },
        ],
    },
    attribute: {
        label: "Attribute",
        plural: "Attributes",
        icon: "fa-solid fa-dumbbell",
        container: "attributes",
        description: "Milestone-based stat with no hard cap (e.g. Strength, Charisma).",
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Attribute" },
            { key: "value", label: "Value", type: "number", default: 5 },
        ],
    },
    item: {
        label: "Item",
        plural: "Inventory",
        icon: "fa-solid fa-box-open",
        container: "inventory",
        description: "Unique inventory item (crafting materials, keys, etc).",
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Item" },
            { key: "qty", label: "Qty", type: "number", default: 1 },
            { key: "description", label: "Description", type: "textarea", default: "" },
        ],
    },
    skill: {
        label: "Skill",
        plural: "Skills (Actives)",
        icon: "fa-solid fa-bolt",
        container: "skills",
        description: "Active ability with an optional resource cost.",
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Skill" },
            { key: "cost", label: "Cost", type: "text", default: "" },
            { key: "description", label: "Description", type: "textarea", default: "" },
        ],
    },
    passive: {
        label: "Passive",
        plural: "Passives",
        icon: "fa-solid fa-shield-halved",
        container: "passives",
        description: "Passive effect — either Special or a Stats modifier.",
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Passive" },
            { key: "ptype", label: "Type", type: "select", options: ["special", "stat"], default: "special" },
            { key: "description", label: "Description", type: "textarea", default: "" },
        ],
    },
    custom: {
        label: "Custom Feature",
        plural: "Custom Features",
        icon: "fa-solid fa-seedling",
        container: "custom",
        description: "AI-managed party-wide gimmick tracked during roleplay (e.g. planted seeds, ongoing effects).",
        aiManaged: true,
        partyLevel: true,
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Feature" },
            { key: "value", label: "Value / State", type: "text", default: "" },
            { key: "description", label: "Description", type: "textarea", default: "" },
        ],
    },
    shared: {
        label: "Shared Resource",
        plural: "Shared Resources",
        icon: "fa-solid fa-coins",
        container: "sharedResources",
        description: "Party-wide resource managed only by the user (e.g. Dinheiro, Expendable).",
        partyLevel: true,
        fields: [
            { key: "name", label: "Name", type: "text", default: "New Shared Resource" },
            { key: "qty", label: "Qty", type: "number", default: 0 },
            { key: "description", label: "Description", type: "textarea", default: "" },
            { key: "always_inject", label: "Always inject value into context", type: "checkbox", default: false },
        ],
    },
};

// Containers that live on each character sheet.
export const CHARACTER_CONTAINERS = ["resources", "attributes", "inventory", "skills", "passives"];

// container name -> type key (reverse lookup, used by presets & parsers).
export const CONTAINER_TYPES = Object.fromEntries(
    Object.entries(GM_SCHEMA).map(([type, def]) => [def.container, type])
);

// Build a fresh entry for a type, merging schema defaults with the given overrides.
export function defaultEntry(type, overrides = {}) {
    const def = GM_SCHEMA[type];
    if (!def) throw new Error(`[Game Manager] Unknown trackable type: ${type}`);
    const entry = { id: genId() };
    for (const field of def.fields) {
        entry[field.key] = field.default !== undefined ? structuredClone(field.default) : null;
    }
    return Object.assign(entry, overrides);
}