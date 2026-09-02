// IMPORTS
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
// Settings
import { loadSettings, saveSettings, defaultSettings, initSettingsListeners } from "./settings/settingsManager.js";
export { loadSettings, saveSettings, defaultSettings };
// Core
import { extensionName, extensionFolderPath } from "./core/constants.js";
export { extensionName };
import { stateManager } from "./core/stateManager.js";
import { logDebug } from "./core/debug.js";
export { logDebug };
// UI
import { mainPanel } from "./ui/mainPanel.js";
import { settingsUI } from "./ui/settingsUI.js";
import { notifications } from "./ui/notifications.js";
// Injection
import { initMacros } from "./inject/macro.js";
import { initPreTurn } from "./inject/preTurn.js";
import { initPostTurn } from "./inject/postTurn.js";
// Connection profiles
import { swapProfile } from "./util/profileSwapper.js";
export { swapProfile };

// Base functions
// Utility to get ST context
function getST() {
    return getContext();
}

// Startup
jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);
        const tempDiv = $("<div>").html(settingsHtml);

        // Floating window goes on <body>; settings drawer goes into the extensions menu.
        $("body").append(tempDiv.find("#gm_floating_window"));
        $("#extensions_settings").append(tempDiv.find("#gm_settings_block"));

        await loadSettings();
        initSettingsListeners();
        settingsUI.init();
        notifications.init();
        mainPanel.init();
        initMacros();
        initPreTurn();
        initPostTurn();

        logDebug("Game Manager initialized.", extension_settings[extensionName]);
    } catch (e) {
        console.error("[Game Manager] Failed to initialize:", e);
    }
});