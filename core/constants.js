// Global constants — kept in their own module to avoid circular imports.
export const extensionName = "GameManager";
export const extensionFolderPath = "scripts/extensions/third-party/game-manager-st";

// Character states — the single generic state slot a character can occupy
// (character.state = { mode, reason }). One registry entry per mode: adding a
// future state (petrified, captured...) means adding a row here, not touching
// every subsystem. llm_clearable: the tracker may clear it via <ko_clear>
// (rest/timeskip); otherwise only the user (edit mode) can.
export const CHARACTER_STATES = {
    dead: {
        label: "DEAD",
        status: "dead",
        icon: "fa-solid fa-skull",
        banner: "gm_death_banner",
        chip: "gm_death_chip",
        row: "gm_dead_row",
        llm_clearable: false,
    },
    ko: {
        label: "KNOCKED OUT",
        status: "knocked_out",
        icon: "fa-solid fa-face-dizzy",
        banner: "gm_ko_banner",
        chip: "gm_ko_chip",
        row: "gm_ko_row",
        llm_clearable: true,
    },
};