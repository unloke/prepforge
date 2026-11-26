import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { mergeEngineIntoTargets } from "./scout.js";
import { createScanEvalCache, runScoutDeepScan } from "./scout-engine.js";
import { inferRefutation, pathEngineMoves } from "./scout-refutation.js";

const RUY = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7",
  "f1e1", "b7b5", "a4b3", "d7d6", "c2c3", "e8g8", "h2h3", "c6b8", "d2d4", "b8d7",
  "c3c4", "c7c6", "c4b5", "a6b5"];

function line(ucis) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const sans = [];
  for (const uci of ucis) {
    sans.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    fens.push(chess.fen());
  }
  return { fens, sans };
}

function memoryStore() {
  const data = new Map();
  return { data, get length() { return data.size; }, key: (i) => [...data.keys()][i],
    getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
}

// A Stockfish fake that counts workers and searches; evals come from `cpByFen` (White POV).
function countingEngine(cpByFen = new Map(), pvByFen = new Map()) {
  const counts = { providers: 0, searches: 0 };
  const createProvider = () => {
    counts.providers += 1;
    let fen = null;
    const search = async (req) => { fen = req.fen; counts.searches += 1; };
    return {
      open: search, update: search, close: async () => {},
      snapshot: () => ({ running: false, current_depth: 12, nodes: 1, fen,
        pvs: [{ score_cp: cpByFen.get(fen) ?? 0, mate_in: null, pv_uci: [pvByFen.get(fen) ?? "a2a3"], depth: 12 }] }),
    };
  };
  return { counts, createProvider };
}

function game(gameId, ucis, color = "white") {
  return { gameId, color, speed: "blitz", ucis, sans: line(ucis).sans };
}

describe("deep scan engine pass", () => {
  it("searches each distinct position once with one provider for the whole scan", async () => {
    const games = [game("a", RUY), game("b", RUY.slice(0, 20)), game("c", [...RUY.slice(0, 6), "d2d3"])];
    const engine = countingEngine();
    const result = await runScoutDeepScan({ games, oppColor: "white", storage: memoryStore(),
      createProvider: engine.createProvider });
    const distinct = new Set();
    for (const g of games) {
      const { fens } = line(g.ucis);
      for (let ply = 0; ply < g.ucis.length; ply += 2) { distinct.add(fens[ply]); distinct.add(fens[ply + 1]); }
    }
    expect(engine.counts.providers).toBe(1);
    expect(engine.counts.searches).toBe(distinct.size);
    expect(result.scanRecords.map((r) => r.gameId)).toEqual(["a", "b", "c"]);
    expect(result.scanRecords.every((r) => r.complete && r.analyzedOpponentPlies === r.eligibleOpponentPlies))
      .toBe(true);
  });

  it("shares evals across colours and caches each game for the next scan", async () => {
    const evalCache = createScanEvalCache();
    const storage = memoryStore();
    const engine = countingEngine();
    const white = [game("w1", RUY.slice(0, 8))];
    const black = [game("b1", RUY.slice(0, 8), "black")];
    await runScoutDeepScan({ games: white, oppColor: "white", storage, evalCache, createProvider: engine.createProvider });
    const afterWhite = engine.counts.searches;
    await runScoutDeepScan({ games: black, oppColor: "black", storage, evalCache, createProvider: engine.createProvider });
    // Black's positions are White's shifted by one ply: only the last one is new.
    expect(afterWhite).toBe(8);
    expect(engine.counts.searches).toBe(afterWhite + 1);
    const again = countingEngine();
    const cached = await runScoutDeepScan({ games: white, oppColor: "white", storage, createProvider: again.createProvider });
    expect(again.counts).toEqual({ providers: 0, searches: 0 });
    expect(cached.scanRecords[0].moves).toHaveLength(4);
  });

  it("keeps the games finished before a stop", async () => {
    const storage = memoryStore();
    const engine = countingEngine();
    let stop = false;
    const games = [game("g1", RUY.slice(0, 4)), game("g2", [...RUY.slice(0, 2), "d2d4", "e5d4"])];
    const progress = [];
    await expect(runScoutDeepScan({ games, oppColor: "white", storage, createProvider: engine.createProvider,
      shouldCancel: () => stop,
      onProgress: (done) => { progress.push(done); stop = true; } })).rejects.toMatchObject({ cancelled: true });
    expect(progress).toEqual([1]);
    const again = countingEngine();
    await runScoutDeepScan({ games: games.slice(0, 1), oppColor: "white", storage, createProvider: again.createProvider });
    expect(again.counts.searches).toBe(0);
  });

  it("keeps mistakes at ply 18 and ply 22 apart past the 16-ply trie key", async () => {
    const { fens } = line(RUY);
    // White (the scouted side) throws away 3 pawns with 10.d4 (ply 18) and 12.cxb5 (ply 22).
    const cpByFen = new Map([[fens[19], -300], [fens[23], -300]]);
    const engine = countingEngine(cpByFen, new Map([[fens[23], "a6b5"]]));
    const games = [game("x1", RUY), game("x2", RUY)];
    const { patterns, scanRecords } = await runScoutDeepScan({ games, oppColor: "white",
      storage: memoryStore(), createProvider: engine.createProvider });
    const key18 = RUY.slice(0, 18).join(">");
    const key22 = RUY.slice(0, 22).join(">");
    expect([...patterns.keys()].sort()).toEqual([key18, key22].sort());
    expect(patterns.get(key18)).toMatchObject({ playedUci: "d2d4", occurrences: 2 });
    expect(patterns.get(key22)).toMatchObject({ playedUci: "c4b5", occurrences: 2 });

    // A target through ply 22 takes the ply-22 pattern, one through ply 20 the ply-18 one.
    const [deep, mid] = mergeEngineIntoTargets(
      [{ ucis: RUY.slice(0, 23) }, { ucis: RUY.slice(0, 20) }], patterns);
    expect(deep.enginePattern.playedUci).toBe("c4b5");
    expect(mid.enginePattern.playedUci).toBe("d2d4");

    // The refutation rebuilds the full 22-ply path, so its reply is read on the right board.
    const moves = pathEngineMoves(scanRecords, RUY.slice(0, 23));
    expect(moves.map((m) => m.pathKey)).toEqual([key22, key22]);
    expect(inferRefutation(moves).refutation).toMatchObject({ suggestedUci: "a6b5", suggestedSan: "axb5" });
  });
});
