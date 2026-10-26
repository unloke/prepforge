import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";

// A decoded cue as the fake decoder returns it: a few samples of priming
// silence (an MP3 decoder may leave the encoder's in), then the sound.
const PRIMING = 96;
function decodedCue() {
  const data = new Float32Array(2048);
  for (let i = PRIMING; i < data.length; i++) data[i] = Math.exp(-(i - PRIMING) / 200) * (i % 2 ? 1 : -1);
  return { sampleRate: 48000, length: data.length, getChannelData: () => data };
}

// A stand-in for WebAudio that counts what a cue actually starts, and records
// the one call the cut makes on a sounding bus (cancelScheduledValues).
function fakeAudio() {
  const made = {
    contexts: 0, sources: 0, cancels: 0, buffers: [], sourceNodes: [], starts: [], stops: 0, disconnections: 0,
    decodes: 0, fetched: [],
  };
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
      // A real context starts suspended until a gesture resumes it (iOS).
      this.state = "suspended";
      this.destination = node();
      made.context = this;
    }
    resume() {
      made.resumes = (made.resumes || 0) + 1;
      this.state = "running";
      return Promise.resolve();
    }
    createBuffer(_channels, frames) {
      const data = new Float32Array(frames);
      const buffer = { length: frames, getChannelData: () => data };
      made.buffers.push(buffer);
      return buffer;
    }
    decodeAudioData() {
      made.decodes += 1;
      return Promise.resolve(decodedCue());
    }
    createBufferSource() {
      const source = node({
        start: (when, offset) => { made.sources += 1; made.starts.push({ when, offset }); },
        stop: () => { made.stops += 1; },
      });
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
  globalThis.fetch = vi.fn(async (url) => {
    audio.made.fetched.push(String(url));
    return { arrayBuffer: async () => new ArrayBuffer(8) };
  });
  const sound = await import("./sound.js");
  return { sound, made: audio.made, appState };
}

// Lets the fetch and decode promises settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A context with the set already decoded, as it is after the first gesture.
async function soundReady(options) {
  const loaded = await soundWith(options);
  const listeners = new Map();
  globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn) };
  loaded.sound.installSoundUnlock();
  listeners.get("pointerdown")();
  await settle();
  loaded.made.sources = 0;
  loaded.made.sourceNodes.length = 0;
  loaded.made.starts.length = 0;
  return loaded;
}

afterEach(() => {
  delete globalThis.AudioContext;
  delete globalThis.window;
  delete globalThis.fetch;
  vi.restoreAllMocks();
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
  it("starts the cue when sounds are on", async () => {
    const { sound, made } = await soundReady();
    sound.playSound("move");
    expect(made.sources).toBe(1);
  });

  it("stays silent when the preference is off, or the cue is unknown", async () => {
    const { sound, made } = await soundWith({ sounds: false });
    sound.playSound("move");
    await settle();
    expect(made.sources).toBe(0);
    expect(made.contexts).toBe(0);
    const again = await soundReady();
    again.sound.playSound("nonsense");
    expect(again.made.sources).toBe(0);
  });

  it("drops a repeat inside the throttle and plays it again after", async () => {
    const { sound, made } = await soundReady();
    sound.playSound("move");
    const afterOne = made.sources;
    sound.playSound("move");
    expect(made.sources).toBe(afterOne);
    expect(sound.cueAllowed("move", "move", sound.REPEAT_MS - 1)).toBe(false);
    expect(sound.cueAllowed("move", "move", sound.REPEAT_MS)).toBe(true);
    expect(sound.cueAllowed("capture", "move", 0)).toBe(true);
  });

  it("cuts the sounding cue so two never ring together", async () => {
    const { sound, made } = await soundReady();
    sound.playSound("capture");
    sound.playSound("move");
    expect(made.cancels).toBe(1);
    expect(made.stops).toBe(1);
    expect(made.sources).toBe(2);
  });

  it("disconnects the cue when its sound ends", async () => {
    const { sound, made } = await soundReady();
    const before = made.disconnections;
    sound.playSound("capture");
    made.sourceNodes[0].onended();
    expect(made.disconnections - before).toBe(2);
  });

  it("makes its context on the first gesture and wakes it after every interruption", async () => {
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
    // Running: a tap leaves it alone.
    listeners.get("pointerdown")();
    expect(made.sources).toBe(1);
    // iOS took the audio away (screen lock, a call, the tab in the background):
    // the listener is still there, and the next tap brings the sound back.
    made.context.state = "interrupted";
    listeners.get("touchstart")();
    expect(made.context.state).toBe("running");
    expect(made.sources).toBe(2);
    expect(listeners.size).toBe(3);
  });

  it("resumes an interrupted context when a cue plays, not only a suspended one", async () => {
    const { sound, made } = await soundReady();
    sound.playSound("move");
    made.context.state = "interrupted";
    const before = made.resumes;
    sound.playSound("capture");
    expect(made.resumes).toBe(before + 1);
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
    expect(made.fetched).toHaveLength(0);
    expect(listeners.size).toBe(3);
    appState.prefs.sounds = true;
    listeners.get("pointerdown")();
    expect(made.contexts).toBe(1);
  });
});

describe("the sound files", () => {
  it("are fetched and decoded once per context, on the first gesture", async () => {
    const { sound, made } = await soundReady();
    expect(made.decodes).toBe(sound.CUE_NAMES.length);
    sound.playSound("move");
    sound.playSound("wrong");
    await settle();
    expect(made.fetched).toHaveLength(sound.CUE_NAMES.length);
    expect(made.decodes).toBe(sound.CUE_NAMES.length);
  });

  it("plays a cue asked for before the decode once it lands, unless it would be late", async () => {
    const early = await soundWith();
    early.sound.playSound("move");
    expect(early.made.sources).toBe(0);
    await settle();
    expect(early.made.sources).toBe(1);

    const late = await soundWith();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    late.sound.playSound("move");
    now += 1000;
    await settle();
    expect(late.made.sources).toBe(0);
  });

  it("tries a failed fetch again on the next cue", async () => {
    const { sound, made } = await soundWith();
    globalThis.fetch.mockRejectedValueOnce(new Error("offline"));
    sound.playSound("move");
    await settle();
    expect(made.sources).toBe(0);
    sound.playSound("move");
    await settle();
    expect(made.sources).toBe(1);
  });

  it("starts a cue at its first sound, past any decoder priming", async () => {
    const { sound, made } = await soundReady();
    sound.playSound("move");
    // The first sample within 40 dB of the peak, less a quarter millisecond.
    expect(made.starts[0].offset).toBeCloseTo((PRIMING - 12) / 48000, 6);
    const data = new Float32Array(100);
    data[0] = 0.5;
    expect(sound.soundStart(data, 48000)).toBe(0);
  });

  it("ships one small file per cue", async () => {
    vi.resetModules();
    const { CUE_NAMES } = await import("./sound.js");
    const dir = fileURLToPath(new URL("../sounds/", import.meta.url));
    let total = 0;
    for (const cue of CUE_NAMES) {
      const bytes = statSync(join(dir, `${cue}.mp3`)).size;
      expect(bytes).toBeLessThan(8 * 1024);
      total += bytes;
    }
    expect(total).toBeLessThan(32 * 1024);
    expect(readdirSync(dir).sort()).toEqual(CUE_NAMES.map((cue) => `${cue}.mp3`).sort());
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
