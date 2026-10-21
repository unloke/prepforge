import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";

// A stand-in for WebAudio that counts what a cue actually starts, and records
// the one call the cut makes on a sounding bus (cancelScheduledValues). A
// buffer keeps its samples, because every voice is now computed into one.
function fakeAudio() {
  const made = { contexts: 0, sources: 0, cancels: 0, buffers: [], sourceNodes: [], stops: 0, disconnections: 0 };
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {
      made.cancels += 1;
    },
  });
  const node = (extra = {}) => ({ connect: (target) => target, disconnect: () => { made.disconnections += 1; }, ...extra });
  class FakeContext {
    constructor() {
      made.contexts += 1;
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.state = "running";
      this.destination = node();
    }
    resume() {
      return Promise.resolve();
    }
    createBuffer(_channels, frames) {
      const data = new Float32Array(frames);
      const buffer = { length: frames, getChannelData: () => data };
      made.buffers.push(buffer);
      return buffer;
    }
    createBufferSource() {
      const source = node({ start: () => { made.sources += 1; }, stop: () => { made.stops += 1; } });
      made.sourceNodes.push(source);
      return source;
    }
    createOscillator() {
      return node({ frequency: param(), start: () => { made.sources += 1; }, stop() {} });
    }
    createBiquadFilter() {
      return node({ frequency: param(), Q: param() });
    }
    createGain() {
      return node({ gain: param() });
    }
  }
  return { FakeContext, made };
}

function position(moves) {
  const chess = new Chess();
  for (const move of moves) chess.move(move);
  const fen = chess.fen();
  const lastMove = chess.history({ verbose: true }).at(-1).lan;
  chess.undo();
  return { prevFen: chess.fen(), fen, lastMove };
}

// The module keeps its AudioContext between calls, so each test loads a fresh
// copy rather than inheriting the previous one.
async function soundWith({ sounds = true } = {}) {
  vi.resetModules();
  const { appState } = await import("../core/state.js");
  appState.prefs = { sounds };
  const audio = fakeAudio();
  globalThis.AudioContext = audio.FakeContext;
  const sound = await import("./sound.js");
  return { sound, made: audio.made, appState };
}

afterEach(() => {
  delete globalThis.AudioContext;
  delete globalThis.window;
});

describe("which cue a move plays", () => {
  it("is a plain tap for a quiet move", async () => {
    const { sound } = await soundWith();
    const move = position(["e4"]);
    expect(sound.moveCue(move.prevFen, move.fen, move.lastMove)).toBe("move");
  });

  it("is a capture when a piece leaves the board", async () => {
    const { sound } = await soundWith();
    const move = position(["e4", "d5", "exd5"]);
    expect(sound.moveCue(move.prevFen, move.fen, move.lastMove)).toBe("capture");
  });

  it("is a castle when the king moves two files", async () => {
    const { sound } = await soundWith();
    const move = position(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"]);
    expect(move.lastMove).toBe("e1g1");
    expect(sound.moveCue(move.prevFen, move.fen, move.lastMove)).toBe("castle");
  });

  it("keeps two-file knight, bishop and rook moves separate from castling", async () => {
    const { sound } = await soundWith();
    for (const move of [position(["d4", "d5", "Nd2"]), position(["e4", "e5", "Bd3"])]) {
      expect(sound.moveCue(move.prevFen, move.fen, move.lastMove)).toBe("move");
    }
    const chess = new Chess("4k3/8/8/8/8/8/8/R1n1K3 w - - 0 1");
    const before = chess.fen();
    chess.move("Rxc1");
    expect(sound.moveCue(before, chess.fen(), "a1c1")).toBe("capture");
  });

  it("is a promotion when a pawn arrives with a new piece", async () => {
    const { sound } = await soundWith();
    const chess = new Chess("8/P7/8/8/8/7k/8/7K w - - 0 1");
    const prevFen = chess.fen();
    chess.move({ from: "a7", to: "a8", promotion: "q" });
    expect(sound.moveCue(prevFen, chess.fen(), "a7a8q")).toBe("promotion");
  });

  it("is the check alert, outranking capture and castling", async () => {
    const { sound } = await soundWith();
    const chess = new Chess("4k3/8/8/8/8/8/8/R3K3 w Q - 0 1");
    const prevFen = chess.fen();
    chess.move("a1a8");
    expect(sound.moveCue(prevFen, chess.fen(), "a1a8")).toBe("check");
    const captureCheck = position(["e4", "e5", "Qh5", "Nc6", "Qxf7"]);
    expect(captureCheck.lastMove).toBe("h5f7");
    expect(sound.moveCue(captureCheck.prevFen, captureCheck.fen, captureCheck.lastMove)).toBe("check");
  });

  it("never throws on a position it cannot read", async () => {
    const { sound } = await soundWith();
    expect(sound.moveCue("not a fen", "not a fen", "e2e4")).toBe("move");
    expect(sound.moveCue(null, null, null)).toBe("move");
  });
});

describe("playing a cue", () => {
  it("starts the cue's voices when sounds are on", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("move");
    expect(made.sources).toBeGreaterThan(0);
  });

  it("stays silent when the preference is off, or the cue is unknown", async () => {
    const { sound, made } = await soundWith({ sounds: false });
    sound.playSound("move");
    expect(made.sources).toBe(0);
    const again = await soundWith();
    again.sound.playSound("nonsense");
    expect(again.made.sources).toBe(0);
  });

  it("drops a repeat inside the throttle and plays it again after", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("move");
    const afterOne = made.sources;
    sound.playSound("move");
    expect(made.sources).toBe(afterOne);
    expect(sound.cueAllowed("move", "move", sound.REPEAT_MS - 1)).toBe(false);
    expect(sound.cueAllowed("move", "move", sound.REPEAT_MS)).toBe(true);
    expect(sound.cueAllowed("capture", "move", 0)).toBe(true);
  });

  it("cuts the sounding cue so two never ring together", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("move");
    const afterMove = made.sources;
    sound.playSound("capture");
    expect(made.cancels).toBe(1);
    expect(made.sources).toBeGreaterThan(afterMove);
  });

  it("stops every scheduled voice of a replaced cue, including later capture taps", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("capture");
    expect(made.sourceNodes).toHaveLength(2);
    sound.playSound("move");
    expect(made.stops).toBe(2);
  });

  it("disconnects the cue only after its last voice ends", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("capture");
    made.sourceNodes[0].onended();
    expect(made.disconnections).toBe(2);
    made.sourceNodes[1].onended();
    expect(made.disconnections).toBe(5);
  });

  it("makes its context on the first gesture, then stops listening", async () => {
    const { sound, made } = await soundWith();
    const listeners = new Map();
    globalThis.window = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    };
    sound.installSoundUnlock();
    expect(listeners.size).toBe(3);
    expect(made.contexts).toBe(0);
    listeners.get("pointerdown")();
    expect(made.contexts).toBe(1);
    expect(made.sources).toBe(1); // the silent sample that clears the lock
    expect(listeners.size).toBe(0);
  });

  it("makes no context while sounds are off, and stays armed for when they return", async () => {
    const { sound, made, appState } = await soundWith({ sounds: false });
    const listeners = new Map();
    globalThis.window = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    };
    sound.installSoundUnlock();
    listeners.get("pointerdown")();
    expect(made.contexts).toBe(0);
    expect(listeners.size).toBe(3);
    appState.prefs.sounds = true;
    listeners.get("pointerdown")();
    expect(made.contexts).toBe(1);
    expect(listeners.size).toBe(0);
  });
});

describe("what a voice is made of", () => {
  // Every voice is computed into one buffer. Stacked oscillators were the bug
  // this replaced: WebAudio starts a sine at the phase the clock is in, so the
  // same cue came out up to 8 dB louder or quieter depending on when it played.
  it("renders a cue as buffers, with no oscillator that can drift in phase", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("move");
    expect(made.buffers.length).toBeGreaterThan(0);
    expect(made.sources).toBeGreaterThan(0);
  });

  it("rings in the low mids off a short strike, which is what reads as wood", async () => {
    const { sound, made } = await soundWith();
    sound.playSound("move");
    const knock = made.buffers.find((b) => b.length > 2000);
    expect(knock).toBeDefined();
    const data = knock.getChannelData(0);
    // Normalised to the same height whatever its modes, so its level is known.
    const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(1, 3);
    // It rises from silence and has died away by its end: no step at either edge.
    expect(Math.abs(data[0])).toBe(0);
    expect(Math.abs(data[data.length - 1])).toBeLessThan(1e-3);
    // It is a strike, not a note: most of its energy is in the first fifth.
    let early = 0, all = 0;
    const split = Math.round(data.length * 0.2);
    data.forEach((v, i) => { all += v * v; if (i < split) early += v * v; });
    expect(early / all).toBeGreaterThan(0.5);
    // And it still rings a third of the way in, rather than being one thump at
    // the start: a knock with no ring in the middle read as a kick drum.
    const span = Math.round(data.length / 30);
    let rings = 0;
    for (let at = Math.round(data.length * 0.15); at < data.length * 0.4 - span; at += span) {
      let block = 0;
      for (let i = at; i < at + span; i++) block += data[i] * data[i];
      if (Math.sqrt(block / span) > 0.01) rings += 1;
    }
    expect(rings).toBeGreaterThanOrEqual(4);
  });

  it("computes a cue the same way in every context, so a play cannot drift", async () => {
    const first = await soundWith();
    for (const cue of ["move", "complete"]) first.sound.playSound(cue);
    const second = await soundWith();
    for (const cue of ["move", "complete"]) second.sound.playSound(cue);
    const samples = (made) => made.buffers.map((b) => Array.from(b.getChannelData(0)));
    // Same samples on a reload: nothing here depends on the clock or on a
    // randomly phased oscillator.
    expect(samples(second.made)).toEqual(samples(first.made));
    // And a computed buffer starts from silence, so it cannot begin on a step.
    for (const data of samples(first.made)) expect(Math.abs(data[0])).toBe(0);
  });
});

describe("the cue table", () => {
  it("has a cue for every name the app asks for", async () => {
    vi.resetModules();
    const { CUE_NAMES } = await import("./sound.js");
    const asked = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".js") && !path.endsWith(".test.js")) scan(path);
      }
    };
    const scan = (path) => {
      const source = readFileSync(path, "utf8");
      for (const [, cue] of source.matchAll(/playSound\("([a-z]+)"\)/g)) asked.add(cue);
      for (const [, cue] of source.matchAll(/cue:\s*"([a-z]+)"/g)) asked.add(cue);
    };
    walk(fileURLToPath(new URL("../", import.meta.url)));
    expect(asked.size).toBeGreaterThan(0);
    for (const cue of asked) expect(CUE_NAMES).toContain(cue);
  });
});
