// Default presets. A preset = a character template (resources/attributes/etc.)
// + party-wide shared resources. Users can save/load their own from the
// settings menu.
export const defaultPresets = [
    {
        name: "Default Preset",
        characterTemplate: {
            resources: [
                { name: "Health", value: 100, min: 0, max: 100 },
                { name: "Mana", value: 50, min: 0, max: 50 },
                { name: "Stamina", value: 30, min: 0, max: 30 },
                { name: "Sanity", value: 80, min: 0, max: 100 },
                { name: "Stress", value: 20, min: 0, max: 100 },
                { name: "Ammo", value: 24, min: 0, max: 36 },
            ],
            attributes: [
                { name: "Strength", value: 5 },
                { name: "Fortitude", value: 5 },
                { name: "Dexterity", value: 5 },
                { name: "Charisma", value: 5 },
            ],
            inventory: [],
            skills: [],
            passives: [],
        },
        sharedResources: [
            { name: "Dinheiro", qty: 0, description: "Party money." },
            { name: "Expendable", qty: 0, description: "Party expendable supplies." },
        ],
    },
];
