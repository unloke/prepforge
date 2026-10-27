// The app's sound cues: one small decoded file per cue, each played into its own
// bus, and the sounding bus is faded out when a newer cue starts, so stepping
// quickly through a move list reads as taps instead of a pile-up.
import { pref } from "./prefs.js";
import { Chess } from "chess.js";
import { fenInCheck } from "../chess-local.js";

// A repeat of the same cue closer than this is a fast step through the moves,
// not a new event; a newer cue fades the sounding one out over CUT_MS.
export const REPEAT_MS = 70;
const CUT_MS = 15;
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

const BOARD_FILES = "abcdefgh";

// The cue a position change deserves. Check outranks everything else — the alert
// is what the player has to notice — then a pawn arriving on the last rank, then
// castling (only a king moves two files), then a capture.
export function moveCue(prevFen, fen, lastMove) {
  if (!lastMove || lastMove.length < 4) return "move";
  if (fenInCheck(fen)) return "check";
  if (lastMove.length > 4) return "promotion";
  if (lastMove[1] === lastMove[3] && Math.abs(BOARD_FILES.indexOf(lastMove[0]) - BOARD_FILES.indexOf(lastMove[2])) === 2) {
    try {
      if (new Chess(prevFen).get(lastMove.slice(0, 2))?.type === "k") return "castle";
    } catch { /* an unreadable position is not evidence of castling */ }
  }
  return pieceCount(prevFen) > pieceCount(fen) ? "capture" : "move";
}

// --- the sounds -------------------------------------------------------------

// Each cue is one short 128 kbps MP3 (1.6-11 KB, 39 KB for the set) cut from
// real recordings, all CC0 (sources and trims in ../sounds/CREDITS.md): the
// wood cues are real pieces set down on a real board, as on Lichess and
// Chess.com, 40-140 ms with a ~30 ms decay; the feedback cues are real marimba
// and glockenspiel notes.
//   move       one piece set down (taure, Freesound 555190)
//   capture    a brighter, harder set-down from the same take
//   castle     king, then rook 65 ms later (the move and capture strikes)
//   check      the move strike with a quiet glockenspiel C7 20 ms in
//   promotion  the move strike with a glockenspiel C7 40 ms in
//   right      marimba C5, then G5 85 ms later (VSCO 2 CE)
//   wrong      two damped low marimba notes falling a semitone (G#3, G3)
//   complete   marimba C5 E5 G5 C6 70 ms apart with a soft glockenspiel top
//   illegal    the move strike a fourth lower and muffled: a piece dropped where
//              it cannot go, as Chess.com answers an illegal drop
// Levels are set against the move click (true peak -1.8 dBTP before encoding):
// capture +2 LU, check +1.5, castle and promotion +1, and the feedback cues +5,
// the way Chess.com and Lichess sit their feedback sounds over the move click.
const FILES = {
  move: new URL("../sounds/move.mp3", import.meta.url).href,
  capture: new URL("../sounds/capture.mp3", import.meta.url).href,
  castle: new URL("../sounds/castle.mp3", import.meta.url).href,
  promotion: new URL("../sounds/promotion.mp3", import.meta.url).href,
  check: new URL("../sounds/check.mp3", import.meta.url).href,
  right: new URL("../sounds/right.mp3", import.meta.url).href,
  wrong: new URL("../sounds/wrong.mp3", import.meta.url).href,
  complete: new URL("../sounds/complete.mp3", import.meta.url).href,
  illegal: new URL("../sounds/illegal.mp3", import.meta.url).href,
};

export const CUE_NAMES = Object.keys(FILES);

// A cue asked for before the files are decoded (the first tap of a session)
// still plays if they arrive within this; later than that it would be late.
const LATE_MS = 150;

const loading = new WeakMap(); // context -> Promise of the decoded set
const decoded = new WeakMap(); // context -> Map cue -> { buffer, offset }
const sources = new WeakMap(); // cue bus -> its source, for the cut

// Where the sound starts in a decoded buffer. An MP3 decoder may or may not
// strip the encoder's priming silence (tens of milliseconds), so the start is
// read off the samples rather than trusted: the first one within 40 dB of the
// peak, less a quarter millisecond.
export function soundStart(data, rate) {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const floor = peak * 0.01;
  const first = data.findIndex((v) => Math.abs(v) > floor);
  return Math.max(0, first - Math.round(rate * 0.00025)) / rate;
}

// Fetch and decode the whole set once per context.
export function loadCues(ctx) {
  let pending = loading.get(ctx);
  if (!pending) {
    pending = Promise.all(CUE_NAMES.map(async (cue) => {
      const response = await fetch(FILES[cue]);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      return [cue, { buffer, offset: soundStart(buffer.getChannelData(0), buffer.sampleRate) }];
    })).then((entries) => {
      const set = new Map(entries);
      decoded.set(ctx, set);
      return set;
    }, (error) => {
      loading.delete(ctx); // a failed fetch is tried again by the next cue
      throw error;
    });
    loading.set(ctx, pending);
  }
  return pending;
}

// --- playing ----------------------------------------------------------------

let audio = null;
let master = null; // the volume: every cue plays into this gain
let active = null; // the sounding cue bus; a replacement stops its source
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

// The Settings volume (0-100) as a gain. Loudness is heard on a log scale, so
// the slider is squared: its midpoint is a quarter of full gain (-12 dB).
export function volumeGain(volume) {
  const v = Math.min(100, Math.max(0, Number(volume) || 0)) / 100;
  return v * v;
}

function output(ctx) {
  if (!master) {
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  master.gain.value = volumeGain(pref("soundVolume"));
  return master;
}

// iOS stops the context whenever the page loses the audio session (the tab goes
// to the background, the screen locks, a call comes in) and reports
// "interrupted", not "suspended": anything but running is asked to resume.
function resume(ctx) {
  if (ctx.state !== "running") Promise.resolve(ctx.resume()).catch(() => {});
}

// Play a decoded cue into any context at `when` seconds, returning its bus (null
// until loadCues has decoded the set). The offline measurement harness in
// scripts/sound-cues.mjs calls exactly this.
export function renderCue(ctx, cue, destination = ctx.destination, when = 0) {
  const sound = decoded.get(ctx)?.get(cue);
  if (!sound) return null;
  const bus = ctx.createGain();
  const source = ctx.createBufferSource();
  source.buffer = sound.buffer;
  sources.set(bus, source);
  source.connect(bus).connect(destination);
  source.onended = () => {
    source.disconnect();
    bus.disconnect();
  };
  source.start(when, sound.offset);
  return bus;
}

// A repeat of the same cue within REPEAT_MS is a fast step through the moves.
export function cueAllowed(cue, previous, sinceMs) {
  return cue !== previous || sinceMs >= REPEAT_MS;
}

export function playSound(cue) {
  if (!FILES[cue] || !pref("sounds")) return;
  const ctx = context();
  if (!ctx) return;
  resume(ctx);
  if (!decoded.has(ctx)) {
    const asked = Date.now();
    loadCues(ctx).then(() => {
      if (Date.now() - asked < LATE_MS) playSound(cue);
    }, () => {});
    return;
  }
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
    try { sources.get(active).stop(now + CUT_MS / 1000); } catch { /* already ended */ }
  }
  active = renderCue(ctx, cue, output(ctx), now + LEAD_S);
}

const GESTURES = ["pointerdown", "keydown", "touchstart"];

// A gesture creates the context, starts decoding the set and, while it is not running, resumes it and
// plays one silent sample, which is what actually clears the lock on iOS. It stays
// armed for the whole session: iOS takes the audio away again on every
// interruption, and a resume that is not inside a gesture is refused, so the next
// tap after one is what brings the sound back. With sounds off no context is made.
export function installSoundUnlock() {
  if (typeof window === "undefined") return;
  const onGesture = () => {
    if (!pref("sounds")) return;
    const ctx = context();
    if (!ctx) return;
    loadCues(ctx).catch(() => {});
    if (ctx.state === "running") return;
    resume(ctx);
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();
  };
  GESTURES.forEach((type) =>
    window.addEventListener(type, onGesture, { capture: true, passive: true }));
}
