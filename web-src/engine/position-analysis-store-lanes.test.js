import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { createPositionAnalysisStore } from "./position-analysis-store.js";
import { stockfishBudget } from "./compute-budget.js";
import { createStockfishWasmProvider } from "./stockfish-provider.js";

// A real game's positions, for the tests that step for real: a step lands on a
// position nothing has searched, which is the case that boots a worker.
const GAME_MOVES =
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 " +
  "c4 c6 cxb5 axb5 Nc3 Bb7 Bg5 b4 Nb1 h6 Bh4 c5 dxe5 Nxe4 Bxe7 Qxe7 exd6 Qf6 " +
  "Nbd2 Nxd6 Nc4 Nxc4 Bxc4 Nb6 Ne5 Rae8 Bxf7+ Rxf7 Nxf7 Rxe1+ Qxe1 Kxf7";
const GAME_PLIES = (() => {
  const chess = new Chess();
  return GAME_MOVES.split(/\s+/).filter((t) => !/^\d+\.$/.test(t)).map((san) => {
    chess.move(san);
    return chess.fen();
  });
})();

// A Worker stand-in for the real provider: answers the handshake, reports one depth,
// and concludes a `stop` with `bestmove` the way a real engine does (the provider's
// drain waits for that line before it launches the next search).
class FakeEngineWorker {
  constructor() { this.posted = []; this.onmessage = null; this.terminated = false; this.searching = false; this.depth = 16; }
  postMessage(msg) {
    if (this.terminated) return;
    this.posted.push(msg);
    if (msg === "isready") queueMicrotask(() => this.emit("readyok"));
    if (typeof msg === "string" && msg.startsWith("go ")) {
      this.depth = Number((msg.match(/depth (\d+)/) || [])[1] || 16);
      this.searching = true;
    }
    if (msg === "stop" && this.searching) {
      this.searching = false;
      queueMicrotask(() => this.emit("bestmove e2e4"));
    }
  }
  emit(line) { if (!this.terminated) this.onmessage?.({ data: line }); }
  // The engine reaches its target depth and stops on its own.
  finish() {
    if (this.terminated || !this.searching) return;
    this.searching = false;
    this.emit(`info depth ${this.depth} score cp 20 pv e2e4 e7e5`);
    this.emit("bestmove e2e4");
  }
  terminate() { this.terminated = true; }
}

// Providers shaped exactly like the live one: a Stockfish WASM provider that takes a
// slot from the page-wide engine budget for the whole life of its worker and gives it
// back on close. A fake provider that never allocates never queues, so the budget's
// reclaim path — the thing that reboots a worker per ply on a one-engine phone — would
// never run and the test would pass while the app still OOMs.
const realShapedProvider = (created) => (options) => createStockfishWasmProvider({
  ...options,
  computeBudget: stockfishBudget,
  profileManaged: false,
  loadModule: async () => ({}),
  reserveMemory: () => ({}),
  createWorker: () => {
    const worker = new FakeEngineWorker();
    created.push(worker);
    return worker;
  },
});

// A phone runs one engine; every lane reserves a whole WASM heap, and a lane past the
// budget makes the budget reclaim a warm worker on each step — a fresh heap per ply.
// The lane count is internal (read from the engine budget), so these tests state the
// DEVICE by configuring that budget — as a Detect or a Settings pick does — and then
// count the Workers the store actually boots.
// The store's lanes follow the page-wide engine budget, which engine-profile.js
// configures from the device's usable profile. A test states the device by configuring
// that budget, exactly as a Detect or a Settings pick does — and restores the floor
// afterwards so a later file never inherits a three-engine device.
const deviceWithEngines = (workers) => stockfishBudget.configure(workers);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { deviceWithEngines(1); vi.useRealTimers(); });

describe("interactive lanes follow the device's engine budget", () => {
  it("steps 40 plies quickly on a one-engine phone without booting a worker per ply", async () => {
    deviceWithEngines(1);
    const created = [];
    const s = createPositionAnalysisStore({ createProvider: realShapedProvider(created) });
    // Two consumers on two DIFFERENT positions, which is what a fast step produces:
    // the Engine card holds the board's position, and the Coach asks for the position
    // BEFORE the move (its "best alternative" read) for the same ply. One lane cannot
    // serve both, so if a second lane existed it would register as idle, the budget
    // would reclaim the warm lane's worker to give it one, and the next ply would boot
    // another — a fresh whole-heap reservation per ply, which is what OOMs a phone.
    const card = s.createHandle({ maxDepth: 16 });
    let coach = null;
    for (let i = 0; i < 40; i += 1) {
      const step = card.update({ fen: GAME_PLIES[i], multipv: 1 });
      await vi.advanceTimersByTimeAsync(2);
      coach?.release();
      coach = s.acquire(GAME_PLIES[Math.max(0, i - 1)], { depth: 16, multipv: 2 });
      await vi.advanceTimersByTimeAsync(3);
      for (const worker of created) worker.finish();
      await vi.advanceTimersByTimeAsync(3);
      await step;
    }
    coach?.release();
    await card.close();
    s.clear();
    // One engine on this device: 40 plies must not boot a worker per ply. Measured
    // with a fixed two lanes instead of the budget's one: 39 workers for these steps.
    expect(created).toHaveLength(1);
    expect(stockfishBudget.snapshot().used).toBe(0);
  });

  it("runs one engine per lane on a three-engine device, never more", async () => {
    deviceWithEngines(3);
    const created = [];
    const s = createPositionAnalysisStore({ createProvider: realShapedProvider(created) });
    const leases = [0, 6, 12].map((i) => s.acquire(GAME_PLIES[i], { depth: 16, multipv: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    // Three readers on three positions: three engines, the whole device budget.
    expect(created).toHaveLength(3);
    for (const worker of created) worker.finish();
    await vi.advanceTimersByTimeAsync(10);
    for (const lease of leases) lease.release();
    s.clear();
    expect(stockfishBudget.snapshot().used).toBe(0);
  });
});
