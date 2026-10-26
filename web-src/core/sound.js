// The app's sound cues, synthesised with WebAudio: nothing to ship or fetch, a
// cue costs bytes of code. Each cue is a few short voices into its own bus, and
// the sounding bus is faded out when a newer cue starts, so stepping quickly
// through a move list reads as taps instead of a pile-up.
import { pref } from "./prefs.js";
import { Chess } from "chess.js";
import { fenInCheck } from "../chess-local.js";

// A repeat of the same cue closer than this is a fast step through the moves,
// not a new event; a newer cue fades the sounding one out over CUT_MS.
export const REPEAT_MS = 70;
const CUT_MS = 15;
// One master level for the whole set: it puts a plain move at the loudness the
// old move sound had, and leaves the hottest cue's peak near -3 dBFS, which is
// headroom for the moment a cue cuts its predecessor (both are audible then).
const MASTER = 0.62;
// Cues start a hair in the future so their first sample lands on the audio clock
// rather than being swallowed by the block that is already being rendered.
const LEAD_S = 0.005;

// --- which cue --------------------------------------------------------------

// Pieces counted straight off a FEN's placement field: a capture is the one move
// that takes a piece off the board, so two counts answer it without parsing
// squares.
function pieceCount(fen) {
  const found = String(fen || "").split(" ")[0].match(/[a-zA-Z]/g);
  return found ? found.length : 0;
}

const FILES = "abcdefgh";

// The cue a position change deserves. Check outranks everything else — the alert
// is what the player has to notice — then a pawn arriving on the last rank, then
// castling (only a king moves two files), then a capture.
export function moveCue(prevFen, fen, lastMove) {
  if (!lastMove || lastMove.length < 4) return "move";
  if (fenInCheck(fen)) return "check";
  if (lastMove.length > 4) return "promotion";
  if (lastMove[1] === lastMove[3] && Math.abs(FILES.indexOf(lastMove[0]) - FILES.indexOf(lastMove[2])) === 2) {
    try {
      if (new Chess(prevFen).get(lastMove.slice(0, 2))?.type === "k") return "castle";
    } catch { /* an unreadable position is not evidence of castling */ }
  }
  return pieceCount(prevFen) > pieceCount(fen) ? "capture" : "move";
}

// --- voices -----------------------------------------------------------------

// Every voice is filled into one buffer, sample by sample, then played. Two
// reasons. A sine oscillator starts at the phase the *clock* is in, not at its
// own start time, so partials stacked as oscillators summed differently on every
// play — the same tap measured anywhere from 0.46 to 1.23 in peak depending on
// when it fired, up to 8 dB apart. And a buffer of computed samples is exact:
// its partials and decays are the ones written here, and its peak is normalised
// once, so a cue sounds the same at every moment and its level is known.

const buffers = new WeakMap();
const cueSources = new WeakMap();

function playBuffer(ctx, bus, when, buffer, level) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const voice = ctx.createGain();
  voice.gain.value = level;
  source.connect(voice).connect(bus);
  const sources = cueSources.get(bus);
  sources.add(source);
  source.onended = () => {
    source.disconnect();
    voice.disconnect();
    sources.delete(source);
    if (!sources.size) bus.disconnect();
  };
  source.start(when);
}

// The computed samples for one voice, per context (sample rate) and key. The
// peak is taken out so a voice is the same height whatever its partials, and
// the first fraction of a millisecond rises from zero so the buffer cannot start
// on a step (a step at sample 0 is a click).
const RISE_S = 0.0002;
function voiceBuffer(ctx, key, seconds, fill) {
  let byKey = buffers.get(ctx);
  if (!byKey) buffers.set(ctx, (byKey = new Map()));
  const name = `${key}@${ctx.sampleRate}`;
  const hit = byKey.get(name);
  if (hit) return hit;
  const rate = ctx.sampleRate;
  const data = new Float32Array(Math.ceil(seconds * rate) + 1);
  fill(data, rate);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const rise = Math.max(1, Math.round(RISE_S * rate));
    for (let i = 0; i < data.length; i++) {
      const fade = i < rise ? 0.5 - 0.5 * Math.cos((Math.PI * i) / rise) : 1;
      data[i] = (data[i] / peak) * fade;
    }
  }
  const buffer = ctx.createBuffer(1, data.length, rate);
  buffer.getChannelData(0).set(data);
  byKey.set(name, buffer);
  return buffer;
}

// A decay that reaches -80 dB at `length`, the same shape the old exponential
// gain ramps had, so a voice's length still means what it says.
function decayAt(t, length) {
  return Math.exp((-9.2 * t) / length);
}

// A fixed pseudo-random stream, so a voice is identical from hit to hit.
function noiseSource() {
  let seed = 0x9e3779b9;
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
    return (seed / 0x100000000) * 2 - 1;
  };
}

// A wooden knock. Two things make wood: the strike, a few milliseconds of noise,
// and under it the modes of the piece and the board ringing down. Wood's modes
// are damped fast and packed close together, so what is left is a woody thud
// with a little pitch, not a note. Modes are [frequency, amplitude, decay] and
// the amplitudes are the balance between the bands — the body in the low mids
// where a piece on a board lives, the top octaves quiet, so it reads as wood and
// not as a drum. `strike` is [level, decay seconds, low-pass Hz, attack ms].
function knockSamples(ctx, { key, strike, modes }) {
  const longest = Math.max(...modes.map(([, , ring]) => ring));
  return voiceBuffer(ctx, `knock:${key}`, longest + 0.01, (data, rate) => {
    const [level, decay, top, attack] = strike;
    // The strike: noise shaped by a fast rise and a short exponential fall, then
    // a one-pole low-pass that takes the hiss off the top. Its mean is removed
    // because a low-pass on white noise carries the noise's DC into the thud.
    const noise = noiseSource();
    const bytes = Math.round(decay * rate);
    const pole = Math.exp((-2 * Math.PI * top) / rate);
    let lp = 0;
    let mean = 0;
    for (let i = 0; i < bytes; i++) {
      const t = i / rate;
      lp = lp * pole + noise() * (1 - pole);
      data[i] = lp * Math.min(1, t / (attack / 1000)) * decayAt(t, decay);
      mean += data[i];
    }
    mean /= bytes;
    for (let i = 0; i < bytes; i++) data[i] = (data[i] - mean) * level * 0.06;
    // The modes: each one a decaying sine, started at its own phase so a hit
    // does not begin with every partial aligned (that reads as a drum).
    modes.forEach(([freq, amp, ring], m) => {
      const phase = 0.35 + m * 0.7;
      const length = Math.min(data.length, Math.round(ring * rate));
      const fadeIn = Math.min(length, Math.round(0.0012 * rate));
      for (let i = 0; i < length; i++) {
        const t = i / rate;
        const glide = 1 + 0.012 * Math.exp(-t / 0.004);
        const rise = i < fadeIn ? i / fadeIn : 1;
        data[i] += amp * rise * Math.sin(2 * Math.PI * freq * glide * t + phase) * decayAt(t, ring);
      }
    });
  });
}

function knock(ctx, bus, when, mode, level = 1) {
  playBuffer(ctx, bus, when, knockSamples(ctx, mode), level);
}

const SOFT_KNOCK = {
  key: "soft",
  strike: [1, 0.006, 2400, 0.5],
  modes: [
    [196, 0.30, 0.085],
    [331, 0.34, 0.062],
    [534, 0.30, 0.045],
    [812, 0.30, 0.036],
    [1219, 0.28, 0.027],
    [1830, 0.20, 0.019],
    [2720, 0.11, 0.012],
  ],
};
// The same board struck with the weight of a piece leaving it: the hit is
// nearly twice the height and the wood is an octave-family lower, so a capture
// is heard as firmer than a move without being louder (the loudness evens out
// with its level). A hit is not just a longer move.
const HARD_KNOCK = {
  key: "hard",
  strike: [2.4, 0.010, 5200, 0.35],
  modes: [
    [147, 0.40, 0.090],
    [245, 0.36, 0.066],
    [367, 0.30, 0.048],
    [612, 0.30, 0.038],
    [1024, 0.28, 0.028],
    [1712, 0.20, 0.020],
    [2860, 0.11, 0.013],
  ],
};

// A struck note, on the same terms: sine partials at a marimba's ratios
// (1, 2.76, 5.4), each higher partial dying sooner, filled into its buffer so
// the partials cannot drift into a different sum on the next play. "dull" drops
// the bright partials, for a note that reads as a disappointment, not a chime.
const WOOD_PARTIALS = [
  [1, 1],
  [2.76, 0.4],
  [5.4, 0.15],
];
const DULL_PARTIALS = [
  [1, 1],
  [2, 0.12],
];

function noteSamples(freq, { decay, partials }) {
  return {
    seconds: decay + 0.01,
    fill: (data, rate) => {
      partials.forEach(([ratio, amp], p) => {
        const length = decay / Math.pow(ratio, 0.4);
        const phase = 0.3 + p * 0.9;
        const n = Math.min(data.length, Math.round((length + 0.01) * rate));
        const fadeIn = Math.round(0.004 * rate);
        for (let i = 0; i < n; i++) {
          const t = i / rate;
          const rise = i < fadeIn ? i / fadeIn : 1;
          data[i] += amp * rise * Math.sin(2 * Math.PI * freq * ratio * t + phase) * decayAt(t, length);
        }
      });
    },
  };
}

function note(ctx, bus, when, freq, { gain, decay, partials = WOOD_PARTIALS }) {
  const samples = noteSamples(freq, { decay, partials });
  playBuffer(ctx, bus, when, voiceBuffer(ctx, `note:${freq}:${decay}:${partials.length}`, samples.seconds, samples.fill), gain);
}

// --- the cues ---------------------------------------------------------------

// `level` is set so every cue lands at about the same loudness (the measured
// numbers and how they were tuned are in scripts/sound-cues.mjs): a drill cue
// must not shout over a move, and a move must not disappear under the rest.
const CUES = {
  // One soft tap: a piece set down.
  move: { level: 1.14, play: (ctx, bus, t) => knock(ctx, bus, t, SOFT_KNOCK) },
  // Two knocks, the first harder: a piece taken.
  capture: {
    level: 0.93,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, HARD_KNOCK);
      knock(ctx, bus, t + 0.06, SOFT_KNOCK, 0.7);
    },
  },
  // Two even taps in quick succession: king, then rook.
  castle: {
    level: 0.86,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK);
      knock(ctx, bus, t + 0.1, SOFT_KNOCK, 0.85);
    },
  },
  // The tap, then a rising three-note chime: the pawn that arrived.
  promotion: {
    level: 0.90,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK, 0.8);
      [660, 880, 1100].forEach((freq, i) =>
        note(ctx, bus, t + 0.06 + i * 0.08, freq, { gain: 0.3, decay: 0.4 }));
    },
  },
  // Check keeps the move's impact, with one short low note rather than the
  // rising fifth that earshot classified as a success chime (z +4.2).
  check: {
    level: 1.25,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, HARD_KNOCK, 0.85);
      note(ctx, bus, t + 0.035, 392, { gain: 0.18, decay: 0.16, partials: DULL_PARTIALS });
    },
  },
  // Right: two notes rising, over the sound of the move landing. The notes come
  // fast enough to read as one gesture, and the second is held so the shape
  // lifts rather than drifts.
  right: {
    level: 1.19,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK, 0.5);
      note(ctx, bus, t + 0.01, 587, { gain: 0.34, decay: 0.26 });
      note(ctx, bus, t + 0.14, 880, { gain: 0.32, decay: 0.42 });
    },
  },
  // Wrong: two notes falling, and dull, so a miss is heard but not scolded. No
  // knock underneath: a knock that leads reads as an ordinary move, and one that
  // does not is buried, so the answer is carried by the two notes alone.
  wrong: {
    level: 1.02,
    play: (ctx, bus, t) => {
      note(ctx, bus, t, 392, { gain: 0.5, decay: 0.26, partials: DULL_PARTIALS });
      note(ctx, bus, t + 0.14, 261, { gain: 0.32, decay: 0.5, partials: DULL_PARTIALS });
    },
  },
  // A session or a line finished: three notes up and the last one held, so the
  // phrase resolves. The first is struck rather than the last, or the peak
  // lands late and it reads as a swell instead of a phrase.
  // Its held last note made it the loudest cue at its loudest 400 ms (earshot:
  // -21.1 LUFS against a -23.4 median), so it sits 2.3 dB under the others' level.
  complete: {
    level: 0.87,
    play: (ctx, bus, t) => {
      [523, 659, 784].forEach((freq, i) =>
        note(ctx, bus, t + i * 0.11, freq, { gain: i === 0 ? 0.4 : 0.28, decay: 0.7 }));
    },
  },
};

export const CUE_NAMES = Object.keys(CUES);

// --- playing ----------------------------------------------------------------

let audio = null;
let active = null; // the sounding cue bus; a replacement stops its scheduled voices
let lastCue = null;
let lastAt = -1e9; // the audio clock, in seconds

// One AudioContext for the app, made on the first cue or the first user gesture.
// Browsers that keep it suspended (iOS) can then be resumed from a real gesture.
function context() {
  if (audio) return audio;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    audio = new AC();
  } catch {
    return null;
  }
  return audio;
}

// iOS stops the context whenever the page loses the audio session (the tab goes
// to the background, the screen locks, a call comes in) and reports
// "interrupted", not "suspended": anything but running is asked to resume.
function resume(ctx) {
  if (ctx.state !== "running") Promise.resolve(ctx.resume()).catch(() => {});
}

// Build a cue into any context at `when` seconds, returning its bus. The offline
// measurement harness in scripts/sound-cues.mjs calls exactly this.
export function renderCue(ctx, cue, destination = ctx.destination, when = 0) {
  const spec = CUES[cue];
  if (!spec) return null;
  const bus = ctx.createGain();
  cueSources.set(bus, new Set());
  // MASTER leaves headroom for the moment a cue cuts its predecessor: both are
  // audible for the first few milliseconds of the fade, and their peaks add.
  bus.gain.value = spec.level * MASTER;
  bus.connect(destination);
  spec.play(ctx, bus, when);
  return bus;
}

// A repeat of the same cue within REPEAT_MS is a fast step through the moves.
export function cueAllowed(cue, previous, sinceMs) {
  return cue !== previous || sinceMs >= REPEAT_MS;
}

export function playSound(cue) {
  if (!CUES[cue] || !pref("sounds")) return;
  const ctx = context();
  if (!ctx) return;
  resume(ctx);
  const now = ctx.currentTime;
  if (!cueAllowed(cue, lastCue, (now - lastAt) * 1000)) return;
  lastCue = cue;
  lastAt = now;
  if (active) {
    // Cut what is sounding instead of mixing with it: twenty moves a second must
    // not turn into a buzz.
    active.gain.cancelScheduledValues(now);
    active.gain.setValueAtTime(active.gain.value, now);
    active.gain.exponentialRampToValueAtTime(0.0001, now + CUT_MS / 1000);
    for (const source of cueSources.get(active) || []) {
      try { source.stop(now + CUT_MS / 1000); } catch { /* already ended */ }
    }
  }
  active = renderCue(ctx, cue, ctx.destination, now + LEAD_S);
}

const GESTURES = ["pointerdown", "keydown", "touchstart"];

// A gesture creates the context and, while it is not running, resumes it and
// plays one silent sample, which is what actually clears the lock on iOS. It stays
// armed for the whole session: iOS takes the audio away again on every
// interruption, and a resume that is not inside a gesture is refused, so the next
// tap after one is what brings the sound back. With sounds off no context is made.
export function installSoundUnlock() {
  if (typeof window === "undefined") return;
  const onGesture = () => {
    if (!pref("sounds")) return;
    const ctx = context();
    if (!ctx || ctx.state === "running") return;
    resume(ctx);
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();
  };
  GESTURES.forEach((type) =>
    window.addEventListener(type, onGesture, { capture: true, passive: true }));
}
