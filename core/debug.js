import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";

export function logDebug(...args) {
    try {
        if (extension_settings[extensionName]?.debug_mode) {
            console.log("[Game Manager]", ...args);
        }
    } catch {
        // Settings not ready yet — ignore.
    }
}

export function gmNotify(message, type = "info", timeOut) {
    if (typeof toastr !== "undefined") {
        toastr[type](message, "Game Manager", timeOut ? { timeOut } : undefined);
    } else {
        console.log(`[Game Manager][${type}]`, message);
    }
}