// The app's sound cues, synthesised with WebAudio: nothing to ship or fetch, a
// cue costs bytes of code. Each cue is a few short voices into its own bus, and
// the sounding bus is faded out when a newer cue starts, so stepping quickly
// through a move list reads as taps instead of a pile-up.
import { pref } from "./prefs.js";
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
  if (Math.abs(FILES.indexOf(lastMove[0]) - FILES.indexOf(lastMove[2])) === 2) return "castle";
  return pieceCount(prevFen) > pieceCount(fen) ? "capture" : "move";
}

// --- voices -----------------------------------------------------------------

// The click that excites every knock: 2 ms of noise, made once per context and
// reused, because filling it sample by sample on every hit cost more than the
// rest of the cue. A fixed generator keeps a cue identical from hit to hit.
const clickBuffers = new WeakMap();
function clickBuffer(ctx) {
  let buffer = clickBuffers.get(ctx);
  if (buffer) return buffer;
  const frames = Math.max(1, Math.round(ctx.sampleRate * 0.002));
  buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x9e3779b9;
  for (let i = 0; i < frames; i++) {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
    data[i] = (seed / 0x100000000) * 2 - 1;
  }
  clickBuffers.set(ctx, buffer);
  return buffer;
}

// A wooden knock: a click drives a few resonant modes (the contact), and a sine
// dropping in pitch underneath is the piece's body meeting the board. Higher
// modes die sooner — that is what keeps a knock from ringing like a bell.
// Modes are [frequency, Q, share, decay seconds]. A narrow band passes only a
// sliver of a 2 ms click, so the click is driven hard, and each mode takes its
// share scaled by its bandwidth (sqrt of Q) to keep the shares comparable.
const SOFT_KNOCK = {
  drive: 2.3,
  modes: [
    [240, 9, 0.45, 0.16],
    [610, 8, 0.8, 0.11],
    [1550, 7, 0.7, 0.05],
    [3900, 5, 0.4, 0.02],
  ],
  body: [150, 0.11, 0.14],
};
const HARD_KNOCK = {
  drive: 2,
  modes: [
    [300, 8, 0.25, 0.17],
    [880, 7, 0.75, 0.12],
    [2300, 6, 1, 0.06],
    [5200, 5, 0.8, 0.022],
  ],
  body: [118, 0.12, 0.16],
};

function knock(ctx, bus, when, profile, level = 1) {
  const click = ctx.createBufferSource();
  click.buffer = clickBuffer(ctx);
  const drive = ctx.createGain();
  drive.gain.value = profile.drive;
  click.connect(drive);
  profile.modes.forEach(([freq, q, share, decay]) => {
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = freq;
    band.Q.value = q;
    const voice = ctx.createGain();
    voice.gain.setValueAtTime(share * Math.sqrt(q) * level, when);
    voice.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    drive.connect(band).connect(voice).connect(bus);
  });
  click.start(when);
  click.stop(when + 0.05);

  const [bodyFreq, bodyGain, bodyDecay] = profile.body;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(bodyFreq, when);
  osc.frequency.exponentialRampToValueAtTime(bodyFreq * 0.6, when + bodyDecay);
  const voice = ctx.createGain();
  voice.gain.setValueAtTime(0.0001, when);
  voice.gain.exponentialRampToValueAtTime(bodyGain * level, when + 0.005);
  voice.gain.exponentialRampToValueAtTime(0.0001, when + bodyDecay);
  osc.connect(voice).connect(bus);
  osc.start(when);
  osc.stop(when + bodyDecay + 0.02);
}

// Struck tones are sine partials at a marimba's ratios (1, 2.76, 5.4), each
// higher partial dying sooner. "dull" drops the bright partials, for a note that
// reads as a disappointment rather than a chime.
const WOOD_PARTIALS = [
  [1, 1],
  [2.76, 0.4],
  [5.4, 0.15],
];
const DULL_PARTIALS = [
  [1, 1],
  [2, 0.12],
];

function note(ctx, bus, when, freq, { gain, decay, partials = WOOD_PARTIALS }) {
  partials.forEach(([ratio, amp]) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * ratio;
    const length = decay / Math.pow(ratio, 0.4);
    const voice = ctx.createGain();
    voice.gain.setValueAtTime(0.0001, when);
    voice.gain.exponentialRampToValueAtTime(gain * amp, when + 0.004);
    voice.gain.exponentialRampToValueAtTime(0.0001, when + length);
    osc.connect(voice).connect(bus);
    osc.start(when);
    osc.stop(when + length + 0.02);
  });
}

// --- the cues ---------------------------------------------------------------

// `level` is set so every cue lands at about the same loudness (the measured
// numbers and how they were tuned are in scripts/sound-cues.mjs): a drill cue
// must not shout over a move, and a move must not disappear under the rest.
const CUES = {
  // One soft tap: a piece set down.
  move: { level: 1.68, play: (ctx, bus, t) => knock(ctx, bus, t, SOFT_KNOCK) },
  // Two knocks, the first harder: a piece taken.
  capture: {
    level: 1.12,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, HARD_KNOCK);
      knock(ctx, bus, t + 0.06, SOFT_KNOCK, 0.7);
    },
  },
  // Two even taps in quick succession: king, then rook.
  castle: {
    level: 1.68,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK);
      knock(ctx, bus, t + 0.1, SOFT_KNOCK, 0.85);
    },
  },
  // The tap, then a rising three-note chime: the pawn that arrived.
  promotion: {
    level: 0.91,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK, 0.8);
      [660, 880, 1100].forEach((freq, i) =>
        note(ctx, bus, t + 0.06 + i * 0.08, freq, { gain: 0.3, decay: 0.4 }));
    },
  },
  // A clear two-note alert, deliberately the brightest tone in the set.
  check: {
    level: 0.67,
    play: (ctx, bus, t) => {
      note(ctx, bus, t, 988, { gain: 0.4, decay: 0.55 });
      note(ctx, bus, t + 0.11, 1319, { gain: 0.26, decay: 0.45 });
    },
  },
  // Right: the move still lands, then two notes rising out of it.
  right: {
    level: 0.83,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK, 0.55);
      note(ctx, bus, t + 0.01, 587, { gain: 0.3, decay: 0.3 });
      note(ctx, bus, t + 0.1, 880, { gain: 0.32, decay: 0.45 });
    },
  },
  // Wrong: the same shape falling, and dull, so a miss is heard but not scolded.
  wrong: {
    level: 0.84,
    play: (ctx, bus, t) => {
      knock(ctx, bus, t, SOFT_KNOCK, 0.45);
      note(ctx, bus, t + 0.01, 330, { gain: 0.3, decay: 0.32, partials: DULL_PARTIALS });
      note(ctx, bus, t + 0.12, 247, { gain: 0.32, decay: 0.45, partials: DULL_PARTIALS });
    },
  },
  // A session or a line finished: three notes up, with room to ring.
  complete: {
    level: 0.67,
    play: (ctx, bus, t) => {
      [523, 659, 784].forEach((freq, i) =>
        note(ctx, bus, t + i * 0.11, freq, { gain: 0.34, decay: 0.8 }));
    },
  },
};

export const CUE_NAMES = Object.keys(CUES);

// --- playing ----------------------------------------------------------------

let audio = null;
let active = null; // the gain of the cue that is sounding, cut when the next one starts
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
  } catch (_) {
    return null;
  }
  return audio;
}

function resume(ctx) {
  if (ctx.state === "suspended") Promise.resolve(ctx.resume()).catch(() => {});
}

// Build a cue into any context at `when` seconds, returning its bus. The offline
// measurement harness in scripts/sound-cues.mjs calls exactly this.
export function renderCue(ctx, cue, destination = ctx.destination, when = 0) {
  const spec = CUES[cue];
  if (!spec) return null;
  const bus = ctx.createGain();
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
    active.cancelScheduledValues(now);
    active.setValueAtTime(active.value, now);
    active.exponentialRampToValueAtTime(0.0001, now + CUT_MS / 1000);
  }
  const bus = renderCue(ctx, cue, ctx.destination, now + LEAD_S);
  active = bus ? bus.gain : null;
}

const GESTURES = ["pointerdown", "keydown", "touchstart"];

// The first gesture creates and resumes the context (and plays one silent
// sample, which is what actually clears the lock on older iOS), so the first
// move after a reload already has sound. With sounds off no context is made;
// the listener stays for the gesture that follows the switch being turned on.
export function installSoundUnlock() {
  if (typeof window === "undefined") return;
  const onGesture = () => {
    if (!pref("sounds")) return;
    const ctx = context();
    if (ctx) {
      resume(ctx);
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      silent.connect(ctx.destination);
      silent.start();
    }
    GESTURES.forEach((type) => window.removeEventListener(type, onGesture, true));
  };
  GESTURES.forEach((type) =>
    window.addEventListener(type, onGesture, { capture: true, passive: true }));
}
