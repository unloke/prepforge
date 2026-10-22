import { describe, it, expect, vi } from "vitest";

import { createStockfishWasmProvider } from "./stockfish-provider.js";
import { localSanLine, pvSan } from "../chess-local.js";

vi.mock("./engine-profile.js", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, reserveEngineMemory: vi.fn(() => ({})), engineStarted: vi.fn() };
});
vi.mock("./engine-assets.js", async importOriginal => ({
  ...await importOriginal(), loadEngineModule: vi.fn(async () => ({})),
}));

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// A stand-in for the Stockfish worker: records what was posted, replays UCI lines on demand.
class FakeWorker {
  constructor() { this.posted = []; this.terminated = false; }
  postMessage(msg) { this.posted.push(msg); if (msg === "isready") this.emit("readyok"); }
  terminate() { this.terminated = true; }
  emit(line) { this.onmessage?.({ data: line }); }
}

function makeProvider() {
  const fake = new FakeWorker();
  return { provider: createStockfishWasmProvider({ createWorker: () => fake, computeBudget: null }), fake };
}

// Replaying a line costs a full chess.js pass over it. The engine reports every PV at every
// depth (MultiPV × depth lines per position) while only the final line per rank is ever
// stored or painted: measured on 12 positions × MultiPV 3 × depth 18, the eager conversion
// ran 648 times (~130 ms) where 36 conversions (~18 ms) produce identical SAN.
describe("SAN is converted when a line is shown or final, not as it arrives", () => {
  it("keeps intermediate info lines UCI-only", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN, multipv: 2 });
    fake.emit("info depth 3 multipv 1 score cp 10 pv e2e4 e7e5");
    fake.emit("info depth 3 multipv 2 score cp 5 pv d2d4 d7d5");
    fake.emit("info depth 12 multipv 1 score cp 20 pv g1f3 b8c6");
    const snap = provider.snapshot();
    // Numbers and UCI stay live at every depth...
    expect(snap.current_depth).toBe(12);
    expect(snap.pvs[0].pv_uci).toEqual(["g1f3", "b8c6"]);
    expect(snap.pvs[0].score_cp).toBe(20);
    // ...and nothing was replayed into SAN for a version nobody read.
    expect(snap.pvs.map((pv) => pv.pv_san)).toEqual([undefined, undefined]);
  });

  it("gives a stopped search's last valid result SAN when it is read", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN, multipv: 1 });
    fake.emit("info depth 9 score cp 18 pv e2e4 e7e5 g1f3");
    provider.stopSearch();
    fake.emit("bestmove e2e4");
    const snap = await provider.waitForSearchComplete({ targetDepth: 9, timeoutMs: 1000 });
    expect(snap.running).toBe(false);
    expect(pvSan(snap.fen, snap.pvs[0])).toEqual(["e4", "e5", "Nf3"]);
  });

  it("gives a timeout's accepted shallow result SAN when it is read", async () => {
    vi.useFakeTimers();
    try {
      const { provider, fake } = makeProvider();
      await provider.open({ fen: FEN, multipv: 1 });
      fake.emit("info depth 6 score cp 12 pv c2c4 e7e6");
      const waiting = provider.waitForSearchComplete({
        targetDepth: 20, timeoutMs: 500, acceptShallowOnTimeout: true,
      });
      await vi.advanceTimersByTimeAsync(500);
      const snap = await waiting;
      expect(snap.current_depth).toBe(6);
      expect(pvSan(snap.fen, snap.pvs[0])).toEqual(["c4", "e6"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the final SAN matches what the eager conversion produced", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN, multipv: 1 });
    fake.emit("info depth 2 score cp 5 pv e2e4");
    fake.emit("info depth 4 score cp 8 pv e2e4 e7e5");
    fake.emit("info depth 6 score cp 12 pv e2e4 e7e5 g1f3");
    fake.emit("bestmove e2e4");
    const top = provider.snapshot().pvs[0];
    expect(pvSan(FEN, top)).toEqual(localSanLine(FEN, top.pv_uci));
  });

  it("reads a line once per version, not once per snapshot", async () => {
    const { provider, fake } = makeProvider();
    await provider.open({ fen: FEN, multipv: 1 });
    fake.emit("info depth 6 score cp 12 pv e2e4 e7e5");
    const first = pvSan(FEN, provider.snapshot().pvs[0]);
    // The panel repaints on every animation frame; each snapshot is a fresh copy object,
    // but the PV array inside is the same version, so the memo answers.
    const again = pvSan(FEN, provider.snapshot().pvs[0]);
    expect(again).toBe(first);
  });
});
