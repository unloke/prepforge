import { describe, it, expect, vi } from "vitest";

import { savedRunCovers, savedRunReads } from "./analyze-saved-run.js";
import { engineIdentity } from "./engine/stockfish-provider.js";
import { createPositionAnalysisStore } from "./engine/position-analysis-store.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";
import { appSource } from "./test-app-source.js";

const A = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const C = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const big = engineIdentity("big");
const lite = engineIdentity("lite");

const prep = (saved, depth = 14) => ({ game_id: "g1", depth, positions: [A, B, C], saved_analysis: saved });

describe("savedRunCovers", () => {
  it("covers a run its saved review searched at least as deep", () => {
    expect(savedRunCovers(prep({ engine: big, depth: 14, maia: false }))).toBe(true);
    expect(savedRunCovers(prep({ engine: lite, depth: 18, maia: true }))).toBe(true);
  });

  it("does not cover a deeper run, another engine or a game with no review", () => {
    expect(savedRunCovers(prep({ engine: big, depth: 12 }))).toBe(false);
    expect(savedRunCovers(prep({ engine: "stockfish-15 t1 h16", depth: 20 }))).toBe(false);
    expect(savedRunCovers(prep(null))).toBe(false);
    expect(savedRunCovers(null)).toBe(false);
  });
});

describe("savedRunReads", () => {
  it("keeps the saved reads of this run's positions that were searched deep enough", async () => {
    const fetchJson = vi.fn(async () => ({
      position_evals: {
        [A]: { engine: big, depth: 14, score_cp: 20, mate_in: null, best_move_uci: "e2e4", pv: ["e2e4"] },
        [B]: { engine: big, depth: 13, score_cp: null, mate_in: null, best_move_uci: null, pv: [] },
        [C]: { engine: lite, depth: 14, score_cp: null, mate_in: 3, best_move_uci: "g1f3" },
        "8/8/8/8/8/8/8/K6k w - - 0 1": { engine: big, depth: 14, score_cp: 0, mate_in: null, pv: [] },
      },
    }));
    const reads = await savedRunReads(prep({ engine: big, depth: 16 }, 14), fetchJson);
    expect(fetchJson).toHaveBeenCalledWith("/api/analyses/g1");
    expect([...reads.keys()]).toEqual([A, C]);
    expect(reads.get(C)).toMatchObject({ mate_in: 3, pv: [], depth: 14, engine: lite });
  });

  it("drops a read shallower than this run even when the review says it covers it", async () => {
    const fetchJson = async () => ({ position_evals: {
      [A]: { engine: big, depth: 10, score_cp: 20, mate_in: null, pv: [] },
      [B]: { engine: big, depth: 16, score_cp: 5, mate_in: null, pv: [] },
    } });
    expect([...(await savedRunReads(prep({ engine: big, depth: 16 }, 16), fetchJson)).keys()]).toEqual([B]);
  });

  it("fetches nothing when the saved review does not cover the run", async () => {
    const fetchJson = vi.fn();
    expect(await savedRunReads(prep({ engine: big, depth: 10 }), fetchJson)).toBe(null);
    expect(await savedRunReads(prep(null), fetchJson)).toBe(null);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("leaves the pass to search when the saved review cannot be read", async () => {
    const fetchJson = vi.fn(async () => { throw Object.assign(new Error("gone"), { status: 404 }); });
    expect(await savedRunReads(prep({ engine: big, depth: 14 }), fetchJson)).toBe(null);
  });
});

describe("a re-run of a reviewed game", () => {
  it("answers every seeded position from the saved review instead of searching it", async () => {
    const searches = [];
    const createProvider = () => {
      let snapshot;
      const read = async ({ fen }) => {
        searches.push(fen);
        snapshot = { running: false, fen, current_depth: 14, pvs: [{ score_cp: 5, mate_in: null, pv_uci: ["g1f3"] }] };
      };
      return { open: read, update: read, snapshot: () => snapshot, close: async () => {} };
    };
    const store = createPositionAnalysisStore({ createProvider,
      analyzeFn: (options) => analyzeGamePositions({ ...options, concurrency: 1, createProvider }) });
    const saved = { position_evals: {
      [A]: { engine: big, depth: 14, score_cp: 20, mate_in: null, best_move_uci: "e2e4", pv: ["e2e4"] },
      [B]: { engine: lite, depth: 14, score_cp: -10, mate_in: null, best_move_uci: "e7e5", pv: ["e7e5"] },
    } };
    const run = prep({ engine: big, depth: 14 }, 14);
    const reads = await savedRunReads(run, async () => saved);
    expect(reads.size).toBe(2);
    const evals = await store.analyzeGame({ positions: run.positions, depth: 14, saved: reads });
    expect(searches).toEqual([C]);
    expect(evals.get(A)).toMatchObject({ score_cp: 20, best_move_uci: "e2e4" });
    expect(evals.get(B)).toMatchObject({ score_cp: -10, engine: lite });
  });
});

describe("review findings: what a re-run may take from the saved review", () => {
  const searchingStore = (searches, depthReached = 16) => {
    const createProvider = () => {
      let snapshot;
      const read = async ({ fen }) => {
        searches.push(fen);
        snapshot = { running: false, fen, current_depth: depthReached, pvs: [{ score_cp: 5, mate_in: null, pv_uci: ["g1f3"] }] };
      };
      return { open: read, update: read, snapshot: () => snapshot, close: async () => {} };
    };
    return createPositionAnalysisStore({ createProvider,
      analyzeFn: (options) => analyzeGamePositions({ ...options, concurrency: 1, createProvider }) });
  };
  const read = (depth, score_cp = 20) => ({ engine: big, depth, score_cp, mate_in: null, best_move_uci: "e2e4", pv: ["e2e4"] });

  it("searches a position the saved review only read shallower than this run", async () => {
    const searches = [];
    const store = searchingStore(searches);
    const run = prep({ engine: big, depth: 16 }, 16);
    const saved = await savedRunReads(run, async () => ({ position_evals: { [A]: read(10), [B]: read(16) } }));
    await store.analyzeGame({ positions: run.positions, depth: 16, saved });
    expect(searches).toEqual([A, C]);
  });

  it("searches every position when the review read back is shallower than prepare said", async () => {
    const searches = [];
    const store = searchingStore(searches);
    const run = prep({ engine: big, depth: 16 }, 16);
    const saved = await savedRunReads(run, async () => ({ position_evals: { [A]: read(10), [B]: read(10), [C]: read(10) } }));
    await store.analyzeGame({ positions: run.positions, depth: 16, saved });
    expect(searches).toEqual([A, B, C]);
  });

  it("keeps every saved read of a game longer than the store's cache", async () => {
    const positions = Array.from({ length: 700 }, (_, i) => `8/8/8/8/8/8/P7/K6k w - - ${i} 1`);
    const position_evals = Object.fromEntries(positions.map((fen) => [fen, read(14, 0)]));
    const searches = [];
    const store = searchingStore(searches, 14);
    const run = { game_id: "g1", depth: 14, positions, saved_analysis: { engine: big, depth: 14 } };
    const saved = await savedRunReads(run, async () => ({ position_evals }));
    await store.analyzeGame({ positions, depth: 14, saved });
    expect(searches).toEqual([]);
  });
});

describe("the save of a re-run", () => {
  it("names the engine of each read taken from the saved review", () => {
    const source = appSource();
    const start = source.indexOf("function classifyPositions(");
    const classifyPositions = new Function(`return (${source.slice(start, source.indexOf("\n}\n", start) + 2)});`)();
    const evals = new Map([[A, { score_cp: 20, depth: 16, engine: big }], [B, { score_cp: 5, depth: 16 }]]);
    expect(classifyPositions([A, B], evals).map((p) => p.engine)).toEqual([big, null]);
  });
});
