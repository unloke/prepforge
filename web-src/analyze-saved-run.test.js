import { describe, it, expect, vi } from "vitest";

import { savedRunCovers, seedSavedRun } from "./analyze-saved-run.js";
import { engineIdentity } from "./engine/stockfish-provider.js";
import { createPositionAnalysisStore } from "./engine/position-analysis-store.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";

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

describe("seedSavedRun", () => {
  it("publishes the saved reads of this run's positions at the review's depth", async () => {
    const store = { publishGame: vi.fn() };
    const fetchJson = vi.fn(async () => ({
      position_evals: {
        [A]: { engine: big, depth: 14, score_cp: 20, mate_in: null, best_move_uci: "e2e4", pv: ["e2e4"] },
        [B]: { engine: big, depth: 13, score_cp: null, mate_in: null, best_move_uci: null, pv: [] },
        [C]: { engine: lite, depth: 14, score_cp: null, mate_in: 3, best_move_uci: "g1f3" },
        "8/8/8/8/8/8/8/K6k w - - 0 1": { engine: big, depth: 14, score_cp: 0, mate_in: null, pv: [] },
      },
    }));
    const seeded = await seedSavedRun(store, prep({ engine: big, depth: 16 }, 14), fetchJson);
    expect(fetchJson).toHaveBeenCalledWith("/api/analyses/g1");
    expect(seeded).toBe(2);
    expect(store.publishGame.mock.calls.map(([fen]) => fen)).toEqual([A, C]);
    expect(store.publishGame).toHaveBeenCalledWith(C, expect.objectContaining({ mate_in: 3, pv: [] }), 16);
  });

  it("fetches nothing when the saved review does not cover the run", async () => {
    const store = { publishGame: vi.fn() };
    const fetchJson = vi.fn();
    expect(await seedSavedRun(store, prep({ engine: big, depth: 10 }), fetchJson)).toBe(0);
    expect(await seedSavedRun(store, prep(null), fetchJson)).toBe(0);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("leaves the pass to search when the saved review cannot be read", async () => {
    const store = { publishGame: vi.fn() };
    const fetchJson = vi.fn(async () => { throw Object.assign(new Error("gone"), { status: 404 }); });
    expect(await seedSavedRun(store, prep({ engine: big, depth: 14 }), fetchJson)).toBe(0);
    expect(store.publishGame).not.toHaveBeenCalled();
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
    expect(await seedSavedRun(store, run, async () => saved)).toBe(2);
    const evals = await store.analyzeGame({ positions: run.positions, depth: 14 });
    expect(searches).toEqual([C]);
    expect(evals.get(A)).toMatchObject({ score_cp: 20, best_move_uci: "e2e4" });
    expect(evals.get(B)).toMatchObject({ score_cp: -10 });
  });
});
