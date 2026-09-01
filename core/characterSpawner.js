// Character spawner — bridges the post-pass tracker and the Add Character
// review flow. When the tracker reports a NEW character or enemy (the
// <new_characters> tool tag, or an <enemies action="add"> for an unknown
// name while spawn review is on), the brief is queued here instead of being
// auto-created as a minimal sheet. A persistent chip in the lower-right
// corner shows the pending count; clicking it generates the full sheet from
// the LLM's brief (core/characterGenerator.js) and opens the review page
// pre-filled (ui/characterCreator.js). NOTHING touches state until the user
// presses Apply — discarding simply drops the brief.
//
// Gated behind feature_spawn_review (+ enabled, auto_update and
// feature_character_creator); enemy briefs additionally require
// feature_enemies. The creator modal is loaded via dynamic import — a
// static one would create a core -> ui import cycle.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug, gmNotify } from "./debug.js";
import { stateManager } from "./stateManager.js";
import { progression } from "./progression.js";
import { generateCharacterProposal } from "./characterGenerator.js";

const MAX_QUEUE = 8; // sanity cap — oldest briefs are dropped first

function settings() {
    return extension_settings[extensionName];
}

// Master gate: the whole pipeline must be on for queued briefs to make sense.
export function spawnReviewEnabled() {
    const s = settings();
    return !!(s.enabled && s.auto_update && s.feature_character_creator && s.feature_spawn_review);
}

export const characterSpawner = {
    _queue: [],   // pending briefs: { name, kind, details, level }
    _busy: false, // a proposal is being generated right now

    // Queues one brief. Returns true when it was accepted (genuinely new —
    // not already tracked, archived or queued); false otherwise.
    queueBrief({ name, kind = "party", details = "", level = null } = {}) {
        if (!spawnReviewEnabled()) return false;
        name = String(name ?? "").trim();
        if (!name) return false;
        kind = kind === "enemy" ? "enemy" : "party";
        // Enemy briefs only when the enemies feature is on — otherwise the
        // sheet would be built for a tracker that is hidden.
        if (kind === "enemy" && !settings().feature_enemies) return false;
        const needle = name.toLowerCase();
        // Already tracked (party, roster, enemies) or archived? Not new.
        const d = stateManager.getData();
        const pool = [
            ...(d.characters || []),
            ...(d.roster || []),
            ...(d.enemies || []),
            ...(d.enemyArchive || []),
        ];
        if (pool.some(c => String(c.name).toLowerCase() === needle)) return false;
        // Already queued for review?
        if (this._queue.some(b => b.name.toLowerCase() === needle)) return false;
        if (this._queue.length >= MAX_QUEUE) this._queue.shift();
        this._queue.push({ name, kind, details: String(details || "").trim(), level: Number(level) || null });
        logDebug(`characterSpawner: queued "${name}" (${kind}) — ${this._queue.length} pending`);
        this._renderChip();
        return true;
    },

    pendingCount() {
        return this._queue.length;
    },

    // Chip click: generate the next brief's sheet and open the review page.
    async reviewNext() {
        if (this._busy || !this._queue.length) return;
        // A creator modal is already up — finish it first; the chip stays.
        if ($("#gm_creator_overlay").length) return;
        // Pop until a still-valid brief is found (the character may have
        // been created by hand since the brief was queued).
        let brief = null;
        while (this._queue.length) {
            const candidate = this._queue.shift();
            const needle = candidate.name.toLowerCase();
            const d = stateManager.getData();
            const known = [...(d.characters || []), ...(d.roster || []), ...(d.enemies || [])]
                .some(c => String(c.name).toLowerCase() === needle);
            if (!known) {
                brief = candidate;
                break;
            }
            logDebug(`characterSpawner: dropped "${candidate.name}" — already tracked`);
        }
        this._renderChip();
        if (!brief) return;
        this._busy = true;
        try {
            const char = await generateCharacterProposal({
                name: brief.name,
                details: brief.details,
                references: [],
                level: brief.level,
                kind: brief.kind,
                // The tracker brief carries no scene context of its own —
                // give the generator a wider recent-chat window than the
                // wizard default so it knows WHERE the character appeared.
                chatMessages: 10,
            });
            if (!char) {
                gmNotify(`Could not generate a sheet for ${brief.name} — check the connection profile.`, "error");
                return;
            }
            // Auto mode: adopt the LLM-inferred level for the review display
            // and the progression stamping on Apply (same as the creator).
            const level = progression.isEnabled() ? (brief.level ?? char.level ?? null) : null;
            // Dynamic import: a static one would create a core -> ui cycle.
            const { characterCreator } = await import("../ui/characterCreator.js");
            characterCreator.openWithProposal({ char, mode: brief.kind, level, details: brief.details });
        } catch (e) {
            console.error("[Game Manager] character spawn failed:", e);
        } finally {
            this._busy = false;
            this._renderChip();
        }
    },

    // Dismisses every pending brief (chip X button).
    clear() {
        this._queue = [];
        this._renderChip();
    },

    // ---------- chip UI ----------
    // Persistent pill while briefs are pending: icon + name/count, tooltip
    // listing everyone waiting, click = review the next one, X = drop all.
    // Anchored ABOVE the chat input area (like a notification) so it never
    // hides behind the main panel; body fallback keeps the old corner spot.
    _renderChip() {
        $("#gm_spawn_chip").remove();
        if (!this._queue.length || !spawnReviewEnabled()) return;
        const allEnemies = this._queue.every(b => b.kind === "enemy");
        const names = this._queue.map(b => `${b.name} (${b.kind})`).join(", ");
        const chip = $("<div>").attr({
            id: "gm_spawn_chip",
            title: `Waiting for review: ${names}`,
        }).toggleClass("gm_spawn_enemy", allEnemies);
        chip.append(
            $("<i>").addClass(allEnemies ? "fa-solid fa-skull" : "fa-solid fa-user-plus"),
            $("<span>").text(this._queue.length === 1 ? this._queue[0].name : `${this._queue.length} new characters`),
        );
        const dismiss = $("<i>")
            .addClass("fa-solid fa-xmark gm_spawn_dismiss")
            .attr("title", "Discard all pending character proposals");
        dismiss.on("click", (e) => {
            e.stopPropagation();
            this.clear();
        });
        chip.append(dismiss);
        chip.on("click", () => this.reviewNext());
        const host = $("#form_sheld");
        (host.length ? host : $("body")).append(chip);
    },
};
