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

// Master chain: volume -> lowpass. The lowpass rounds off the raw oscillator
// edges — without it the clicks and sawtooth slides sound harsh and buzzy.
function masterChain(c) {
    const v = Number(extension_settings[extensionName].sound_volume);
    const vol = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.6;
    const g = c.createGain();
    g.gain.value = vol;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    lp.Q.value = 0.5;
    g.connect(lp).connect(c.destination);
    return g;
}

// One short pitched blip with a soft attack and smooth decay envelope.
function blip(c, out, { freq, start, dur = 0.08, type = "triangle", gain = 0.5, slideTo = null }) {
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.015);
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
    const out = masterChain(c);
    const t0 = c.currentTime + 0.01;
    const dur = Math.max(0.2, durationMs / 1000);
    const clicks = Math.max(6, Math.round(dur * 7));
    for (let i = 0; i < clicks; i++) {
        blip(c, out, {
            freq: 240 + Math.random() * 380,
            start: t0 + Math.pow(i / clicks, 0.7) * dur * 0.92 + Math.random() * 0.02,
            dur: 0.07,
            type: "sine",
            gain: 0.1 + Math.random() * 0.06,
        });
    }
}

// Outcome jingle: distinct pitch contour per tier family. Matching is by
// keyword so LLM-provided tier names ("Critical Failure", "critical success",
// localized variants with the English keywords) all resolve.
export function playTierResult(tierName) {
    const c = audioCtx();
    if (!c) return;
    const out = masterChain(c);
    const t0 = c.currentTime + 0.01;
    const name = String(tierName || "").toLowerCase();
    const isCrit = name.includes("critical");
    const isFail = name.includes("fail");

    if (isFail && isCrit) {
        // Critical Failure — low descending "womp womp" (softened sawtooth).
        blip(c, out, { freq: 196, start: t0, dur: 0.26, type: "sawtooth", gain: 0.16, slideTo: 150 });
        blip(c, out, { freq: 147, start: t0 + 0.3, dur: 0.45, type: "sawtooth", gain: 0.16, slideTo: 98 });
    } else if (isFail) {
        // Failure — two descending minor notes.
        blip(c, out, { freq: 330, start: t0, dur: 0.18, type: "sine", gain: 0.28 });
        blip(c, out, { freq: 262, start: t0 + 0.2, dur: 0.32, type: "sine", gain: 0.28 });
    } else if (isCrit) {
        // Critical Success — warm ascending fanfare arpeggio.
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) => blip(c, out, {
            freq: f,
            start: t0 + i * 0.12,
            dur: i === notes.length - 1 ? 0.45 : 0.14,
            type: "triangle",
            gain: 0.26,
        }));
    } else {
        // Success — two ascending major notes.
        blip(c, out, { freq: 392, start: t0, dur: 0.16, type: "sine", gain: 0.28 });
        blip(c, out, { freq: 523, start: t0 + 0.18, dur: 0.34, type: "sine", gain: 0.28 });
    }
}
