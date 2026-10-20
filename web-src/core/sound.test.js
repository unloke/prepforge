import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";

// A stand-in for WebAudio that counts what a cue actually starts, and records
// the one call the cut makes on a sounding bus (cancelScheduledValues).
function fakeAudio() {
  const made = { contexts: 0, sources: 0, cancels: 0 };
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {
      made.cancels += 1;
    },
  });
  const node = (extra = {}) => ({ connect: (target) => target, ...extra });
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
      return { getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() {
      return node({ start: () => { made.sources += 1; }, stop() {} });
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
