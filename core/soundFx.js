// Sound FX — synthesized dice sounds via the Web Audio API. No audio assets:
// the rolling tumble is a burst of pitched clicks, and each of the four tiers
// (Critical Failure / Failure / Success / Critical Success) gets its own short
// jingle so the outcome is recognizable by ear alone. Gated behind the sound
// settings (Interface → Sounds) and the extension master switch.

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from "./constants.js";
import { logDebug } from "./debug.js";

let _ctx = null;

function audioCtx() {
    try {
        const s = extension_settings[extensionName];
        if (!s.enabled || !s.sound_enabled) return null;
        if (!_ctx || _ctx.state === "closed") {
            _ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_ctx.state === "suspended") _ctx.resume();
        return _ctx;
    } catch (e) {
        logDebug("soundFx: audio unavailable", e);
        return null;
    }
}

function masterGain(c) {
    const v = Number(extension_settings[extensionName].sound_volume);
    const vol = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.6;
    const g = c.createGain();
    g.gain.value = vol;
    g.connect(c.destination);
    return g;
}

// One short pitched blip with a fast attack/decay envelope.
function blip(c, out, { freq, start, dur = 0.08, type = "triangle", gain = 0.5, slideTo = null }) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(env).connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.02);
}

// Tumbling dice: a dozen-ish clicks, denser at the start, random pitch —
// scheduled across `durationMs` to match the bubble's roll animation.
export function playRoll(durationMs = 1500) {
    const c = audioCtx();
    if (!c) return;
    const out = masterGain(c);
    const t0 = c.currentTime + 0.01;
    const dur = Math.max(0.2, durationMs / 1000);
    const clicks = Math.max(6, Math.round(dur * 9));
    for (let i = 0; i < clicks; i++) {
        blip(c, out, {
            freq: 320 + Math.random() * 520,
            start: t0 + Math.pow(i / clicks, 0.7) * dur * 0.92 + Math.random() * 0.02,
            dur: 0.045,
            type: "square",
            gain: 0.16 + Math.random() * 0.1,
        });
    }
}

// Outcome jingle: distinct pitch contour per tier family. Matching is by
// keyword so LLM-provided tier names ("Critical Failure", "critical success",
// localized variants with the English keywords) all resolve.
export function playTierResult(tierName) {
    const c = audioCtx();
    if (!c) return;
    const out = masterGain(c);
    const t0 = c.currentTime + 0.01;
    const name = String(tierName || "").toLowerCase();
    const isCrit = name.includes("critical");
    const isFail = name.includes("fail");

    if (isFail && isCrit) {
        // Critical Failure — low descending "womp womp".
        blip(c, out, { freq: 196, start: t0, dur: 0.22, type: "sawtooth", gain: 0.3, slideTo: 150 });
        blip(c, out, { freq: 147, start: t0 + 0.26, dur: 0.4, type: "sawtooth", gain: 0.3, slideTo: 98 });
    } else if (isFail) {
        // Failure — two descending minor notes.
        blip(c, out, { freq: 330, start: t0, dur: 0.16, type: "triangle", gain: 0.35 });
        blip(c, out, { freq: 262, start: t0 + 0.18, dur: 0.28, type: "triangle", gain: 0.35 });
    } else if (isCrit) {
        // Critical Success — bright ascending fanfare arpeggio.
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) => blip(c, out, {
            freq: f,
            start: t0 + i * 0.11,
            dur: i === notes.length - 1 ? 0.4 : 0.12,
            type: "triangle",
            gain: 0.35,
        }));
    } else {
        // Success — two ascending major notes.
        blip(c, out, { freq: 392, start: t0, dur: 0.14, type: "triangle", gain: 0.35 });
        blip(c, out, { freq: 523, start: t0 + 0.16, dur: 0.3, type: "triangle", gain: 0.35 });
    }
}
