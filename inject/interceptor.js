// The extension's one generate interceptor (manifest.json generate_interceptor
// names a single global). Quick battle first: when it cancels the story call,
// nothing else needs the prompt.

import { quickInterceptor } from "./quickBattle.js";
import { bondsInterceptor } from "./bondLine.js";

const INTERCEPTOR = "gmInterceptor"; // must match manifest.json

async function interceptor(chat, contextSize, abort, type) {
    try {
        if (await quickInterceptor(chat, contextSize, abort, type)) return;
    } catch (e) {
        console.error("[Game Manager] quick battle interceptor failed:", e);
    }
    await bondsInterceptor(chat, contextSize, abort, type);
}

export function initInterceptor() {
    globalThis[INTERCEPTOR] = interceptor;
    // The manifest's old name, for a page whose cached manifest still has it.
    globalThis.gmBondsInterceptor = interceptor;
}
