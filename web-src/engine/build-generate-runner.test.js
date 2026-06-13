import { describe, it, expect } from "vitest";

import {
  createEngineCandidateAdapter,
  createMaiaPredictionAdapter,
  createChessAdapter,
  runBrowserBuildGenerate,
} from "./build-generate-runner.js";
import { SOURCE } from "./build-generator.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Fool's mate — White is checkmated, no legal continuation.
const MATE_FEN = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

const pv = (rank, pv_uci, score_cp) => ({ rank, depth: 8, score_cp, mate_in: null, pv_uci, pv_san: [] });

// Fake Stockfish provider: open/update/snapshot/close. Completes immediately (running:false,
// current_depth == max_depth) and returns the configured pvs for the current fen, sliced to
// the requested MultiPV — exactly the contract the real provider exposes.
function fakeEngineProvider(pvsByFen, { maxDepth = 8 } = {}) {
  let current = null;
  let multipv = 1;
  const calls = [];
  const snap = () => ({
    running: false,
    current_depth: maxDepth,
    max_depth: maxDepth,
    engine: "fake-sf",
    error: null,
    pvs: (pvsByFen[current] || []).slice(0, multipv),
  });
  return {
    kind: "wasm",
    calls,
    async open({ fen, multipv: m }) { calls.push({ type: "open", fen, multipv: m }); current = fen; multipv = m; return snap(); },
    async update({ fen, multipv: m }) { calls.push({ type: "update", fen, multipv: m }); current = fen; multipv = m; return snap(); },
    snapshot: snap,
    async close() { calls.push({ type: "close" }); },
  };
}

function fakeMaiaProvider(predsByFen) {
  const calls = [];
  return {
    calls,
    terminated: false,
    async predictions({ fen, rating }) { calls.push({ fen, rating }); return predsByFen[fen] || []; },
    terminate() { this.terminated = true; },
  };
}

describe("engine candidate adapter", () => {
  it("maps the top MultiPV lines to ranked White-POV candidates and reuses one provider", async () => {
    const provider = fakeEngineProvider({
      [START_FEN]: [pv(1, ["e2e4"], 30), pv(2, ["d2d4"], 20)],
      "fen2": [pv(1, ["g1f3"], 15)],
    });
    const adapter = createEngineCandidateAdapter(provider);

    const first = await adapter.candidates(START_FEN, 2);
    expect(first).toEqual([
      { moveUci: "e2e4", rank: 1, evaluation: { engine: "fake-sf", depth: 8, score_cp: 30, mate_in: null, best_move_uci: "e2e4", pv: ["e2e4"] } },
      { moveUci: "d2d4", rank: 2, evaluation: { engine: "fake-sf", depth: 8, score_cp: 20, mate_in: null, best_move_uci: "d2d4", pv: ["d2d4"] } },
    ]);

    await adapter.candidates("fen2", 1);
    // one open then one update (single reused worker), never two opens
    expect(provider.calls.filter((c) => c.type === "open").length).toBe(1);
    expect(provider.calls.filter((c) => c.type === "update").length).toBe(1);
  });

  it("requests the full count when within the cap (no silent clamp)", async () => {
    const provider = fakeEngineProvider({
      [START_FEN]: [pv(1, ["e2e4"], 30), pv(2, ["d2d4"], 25), pv(3, ["c2c4"], 20), pv(4, ["g1f3"], 15), pv(5, ["b1c3"], 10), pv(6, ["e2e3"], 5)],
    });
    const adapter = createEngineCandidateAdapter(provider, { maxMultipv: 6 });
    const out = await adapter.candidates(START_FEN, 6);
    expect(provider.calls[0].multipv).toBe(6); // requested 6, not clamped
    expect(out).toHaveLength(6);
  });

  it("THROWS when the requested count exceeds the provider cap (never silently under-serves)", async () => {
    const provider = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    const adapter = createEngineCandidateAdapter(provider, { maxMultipv: 5 });
    await expect(adapter.candidates(START_FEN, 6)).rejects.toThrow(/at most 5 candidate lines/);
    expect(provider.calls).toEqual([]); // never even opened a search
  });

  it("THROWS on search timeout instead of returning a partial candidate set", async () => {
    // provider that never finishes: still running, no depth reached.
    const provider = {
      kind: "wasm",
      calls: [],
      async open() { return; },
      async update() { return; },
      snapshot: () => ({ running: true, current_depth: 0, max_depth: 8, error: null, pvs: [] }),
      async close() {},
    };
    const adapter = createEngineCandidateAdapter(provider, { maxMultipv: 5, pollMs: 1, timeoutMs: 30 });
    await expect(adapter.candidates(START_FEN, 1)).rejects.toThrow(/timed out after 30ms/);
  });

  it("returns [] for a terminal position without opening the provider", async () => {
    const provider = fakeEngineProvider({});
    const adapter = createEngineCandidateAdapter(provider);
    const out = await adapter.candidates(MATE_FEN, 3);
    expect(out).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    const adapter = createEngineCandidateAdapter(provider, { signal: controller.signal });
    await expect(adapter.candidates(START_FEN, 1)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces a provider error", async () => {
    const provider = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    provider.snapshot = () => ({ running: false, current_depth: 8, max_depth: 8, error: "engine died", pvs: [] });
    const adapter = createEngineCandidateAdapter(provider);
    await expect(adapter.candidates(START_FEN, 1)).rejects.toThrow(/engine died/);
  });
});

describe("maia prediction adapter", () => {
  it("passes the rating through and returns provider predictions", async () => {
    const provider = fakeMaiaProvider({ [START_FEN]: [{ move_uci: "e7e5", probability: 0.5, rank: 1 }] });
    const adapter = createMaiaPredictionAdapter(provider);
    const out = await adapter.predictions(START_FEN, 1900);
    expect(out).toEqual([{ move_uci: "e7e5", probability: 0.5, rank: 1 }]);
    expect(provider.calls).toEqual([{ fen: START_FEN, rating: 1900 }]);
  });

  it("passes through an empty (terminal) prediction list", async () => {
    const provider = fakeMaiaProvider({});
    const adapter = createMaiaPredictionAdapter(provider);
    expect(await adapter.predictions(START_FEN, 1500)).toEqual([]);
  });

  it("throws AbortError when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createMaiaPredictionAdapter(fakeMaiaProvider({}), { signal: controller.signal });
    await expect(adapter.predictions(START_FEN, 1500)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("chess adapter (real chess.js)", () => {
  const chess = createChessAdapter();
  it("reports side to move", () => {
    expect(chess.sideToMove(START_FEN)).toBe("white");
  });
  it("applies a legal move and returns the resulting fen", () => {
    const r = chess.applyUci(START_FEN, "e2e4");
    expect(r.uci).toBe("e2e4");
    expect(r.fenAfter.split(" ")[1]).toBe("b"); // black to move after 1.e4
  });
  it("returns null for an illegal move", () => {
    expect(chess.applyUci(START_FEN, "e2e5")).toBe(null);
  });
});

describe("orchestrator runBrowserBuildGenerate", () => {
  const build = {
    color: "white",
    repertoire_id: "r1",
    nodes: [
      { id: "anchor", parent_id: null, depth: 0, fen: START_FEN, side_to_move: "white", uci: null, source: "manual", is_mainline: true, is_prepared: false },
    ],
  };

  it("wires the real adapters end-to-end and tears the providers down", async () => {
    const engine = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    const maia = fakeMaiaProvider({});
    const plan = await runBrowserBuildGenerate({
      build,
      rootNodeId: "anchor",
      plyDepth: 1,
      detailMode: "balanced",
      maiaRating: 1500,
      createEngine: () => engine,
      createMaia: () => maia,
      isEngineAvailable: () => true,
    });

    expect(plan.rootNodeId).toBe("anchor");
    expect(plan.addedCount).toBe(1);
    expect(plan.changes[0]).toMatchObject({ action: "planned_add", moveUci: "e2e4", source: SOURCE.GENERATED_STOCKFISH, parentRef: "anchor" });
    // providers torn down
    expect(engine.calls.some((c) => c.type === "close")).toBe(true);
    expect(maia.terminated).toBe(true);
  });

  it("builds the engine at the requested Stockfish depth (Settings → maxDepth)", async () => {
    const engine = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    const maia = fakeMaiaProvider({});
    let engineOpts = null;
    await runBrowserBuildGenerate({
      build,
      rootNodeId: "anchor",
      plyDepth: 1,
      maiaRating: 1500,
      depth: 22, // a non-default Settings depth must reach the provider factory
      createEngine: (opts) => {
        engineOpts = opts;
        return engine;
      },
      createMaia: () => maia,
      isEngineAvailable: () => true,
    });
    expect(engineOpts).toMatchObject({ maxDepth: 22 });
  });

  it("defaults the engine depth when none is supplied", async () => {
    const engine = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    const maia = fakeMaiaProvider({});
    let engineOpts = null;
    await runBrowserBuildGenerate({
      build,
      rootNodeId: "anchor",
      plyDepth: 1,
      maiaRating: 1500,
      createEngine: (opts) => {
        engineOpts = opts;
        return engine;
      },
      createMaia: () => maia,
      isEngineAvailable: () => true,
    });
    expect(engineOpts.maxDepth).toBe(8); // DEFAULT_GEN_DEPTH
  });

  it("borrows a shared maia provider: reuses it, never terminates it, and routes+clears its init-progress handler (Stage 4b)", async () => {
    const engine = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e4"], 30)] });
    const handlerLog = [];
    const sharedMaia = {
      ...fakeMaiaProvider({}),
      handlers: handlerLog,
      setInitProgressHandler(fn) {
        handlerLog.push(fn === null ? "cleared" : "set");
      },
    };
    let factoryCalled = false;
    const plan = await runBrowserBuildGenerate({
      build,
      rootNodeId: "anchor",
      plyDepth: 1,
      maiaRating: 1500,
      createEngine: () => engine,
      // Borrowed provider is passed directly; createMaia must NOT be used for it.
      maiaProvider: sharedMaia,
      onMaiaInitProgress: () => {},
      createMaia: () => {
        factoryCalled = true;
        return fakeMaiaProvider({});
      },
      isEngineAvailable: () => true,
    });

    expect(plan.addedCount).toBe(1);
    expect(factoryCalled).toBe(false); // borrowed, not created
    expect(sharedMaia.terminated).toBe(false); // borrowed → stays warm for reuse
    expect(handlerLog).toEqual(["set", "cleared"]); // attached for the run, detached after
  });

  it("sizes the engine MultiPV cap to branchLimit + manual count so a >5-manual node still generates a new branch", async () => {
    // Anchor (white, our turn) already has 5 MANUAL prepared children. The server would ask
    // for 1 + 5 = 6 candidates, skip the 5 manual moves, and add the 6th as a new branch.
    // With the old hard cap of 5 this silently produced 0 new branches (drift). Now the
    // orchestrator sizes the provider to 6.
    const manualUcis = ["e2e4", "d2d4", "c2c4", "g1f3", "b1c3"];
    const buildWithManual = {
      color: "white",
      repertoire_id: "r1",
      nodes: [
        { id: "anchor", parent_id: null, depth: 0, fen: START_FEN, side_to_move: "white", uci: null, source: "manual", is_mainline: true, is_prepared: false },
        ...manualUcis.map((uci, i) => ({
          id: `m${i}`, parent_id: "anchor", depth: 1, fen: `after-${uci}`, side_to_move: "black",
          uci, source: "manual", is_mainline: i === 0, is_prepared: true,
        })),
      ],
    };
    // engine offers the 5 manual moves plus a new e2e3.
    const engine = fakeEngineProvider({
      [START_FEN]: [
        pv(1, ["e2e4"], 30), pv(2, ["d2d4"], 25), pv(3, ["c2c4"], 20),
        pv(4, ["g1f3"], 15), pv(5, ["b1c3"], 10), pv(6, ["e2e3"], 5),
      ],
    });
    const maia = fakeMaiaProvider({});
    const plan = await runBrowserBuildGenerate({
      build: buildWithManual,
      rootNodeId: "anchor",
      plyDepth: 1,
      maiaRating: 1500,
      createEngine: () => engine,
      createMaia: () => maia,
      isEngineAvailable: () => true,
    });

    expect(engine.calls[0].multipv).toBe(6); // sized to branchLimit(1) + manual(5)
    expect(plan.addedCount).toBe(1);
    expect(plan.changes[0]).toMatchObject({ moveUci: "e2e3", source: SOURCE.GENERATED_STOCKFISH, intendedMainline: false });
  });

  it("throws an actionable error (no fallback) when the browser engine is unavailable", async () => {
    await expect(
      runBrowserBuildGenerate({
        build,
        rootNodeId: "anchor",
        plyDepth: 1,
        maiaRating: 1500,
        isEngineAvailable: () => false,
      }),
    ).rejects.toThrow(/cross-origin isolated|no server fallback/i);
  });

  it("tears providers down even when generation throws", async () => {
    // engine returns an illegal move → planner throws; providers must still close.
    const engine = fakeEngineProvider({ [START_FEN]: [pv(1, ["e2e5"], 30)] });
    const maia = fakeMaiaProvider({});
    await expect(
      runBrowserBuildGenerate({
        build,
        rootNodeId: "anchor",
        plyDepth: 1,
        maiaRating: 1500,
        createEngine: () => engine,
        createMaia: () => maia,
        isEngineAvailable: () => true,
      }),
    ).rejects.toThrow(/illegal move/);
    expect(engine.calls.some((c) => c.type === "close")).toBe(true);
    expect(maia.terminated).toBe(true);
  });
});
