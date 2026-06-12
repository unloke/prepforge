import { describe, expect, it } from "vitest";

import { buildWalk, runCoverageScan } from "./coverage.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_E4E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";
const AFTER_E4C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2";

// My white repertoire: 1.e4 with e5 AND c5 prepared, one reply deep each.
const NODES = [
  { id: "root", depth: 0, parent_id: null, uci: null, fen: START },
  { id: "e4", depth: 1, parent_id: "root", uci: "e2e4", fen: AFTER_E4 },
  { id: "e5", depth: 2, parent_id: "e4", uci: "e7e5", fen: AFTER_E4E5 },
  { id: "c5", depth: 2, parent_id: "e4", uci: "c7c5", fen: AFTER_E4C5 },
];

// Maia stub: after 1.e4 humans play e5 45%, c5 30%, e6 20% (e6 unprepared).
function stubProvider(calls = []) {
  return {
    async predictions({ fen }) {
      calls.push(fen);
      if (fen === AFTER_E4) {
        return [
          { move_uci: "e7e5", probability: 0.45 },
          { move_uci: "c7c5", probability: 0.3 },
          { move_uci: "e7e6", probability: 0.2 },
        ];
      }
      return [];
    },
  };
}

describe("buildWalk", () => {
  it("indexes enabled nodes and children", () => {
    const walk = buildWalk(NODES);
    expect(walk.rootId).toBe("root");
    expect(walk.children.get("e4").map((n) => n.id)).toEqual(["e5", "c5"]);
  });
  it("ignores disabled nodes", () => {
    const walk = buildWalk([...NODES.slice(0, 3), { ...NODES[3], is_enabled: false }]);
    expect(walk.children.get("e4").map((n) => n.id)).toEqual(["e5"]);
  });
});

describe("runCoverageScan", () => {
  it("scores covered probability mass and names the biggest gap", async () => {
    const calls = [];
    const result = await runCoverageScan({
      nodes: NODES,
      myColor: "white",
      rating: 1700,
      provider: stubProvider(calls),
    });
    // One opponent node scanned (after 1.e4); root is my move, leaves end the walk.
    expect(calls).toEqual([AFTER_E4]);
    expect(result.scannedNodes).toBe(1);
    expect(result.coverage).toBeCloseTo(0.75); // e5 + c5 covered
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ nodeId: "e4", moveUci: "e7e6", moveSan: "e6" });
    expect(result.gaps[0].impact).toBeCloseTo(0.2);
    expect(result.truncated).toBe(false);
  });

  it("aborts cleanly via an AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCoverageScan({
        nodes: NODES,
        myColor: "white",
        rating: 1700,
        provider: stubProvider(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("respects the maxNodes cap and reports truncation", async () => {
    // Two parallel opponent nodes: 1.e4 e5 and 1.e4 c5 each have a prepared reply,
    // making the *next* opponent positions scannable; cap at 1 keeps it to one.
    const deeper = [
      ...NODES,
      { id: "nf3", depth: 3, parent_id: "e5", uci: "g1f3",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2" },
      { id: "nc6", depth: 4, parent_id: "nf3", uci: "b8c6",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3" },
    ];
    const provider = {
      async predictions({ fen }) {
        if (fen === AFTER_E4) return [{ move_uci: "e7e5", probability: 0.9 }];
        return [{ move_uci: "b8c6", probability: 0.8 }];
      },
    };
    const result = await runCoverageScan({
      nodes: deeper,
      myColor: "white",
      rating: 1700,
      provider,
      maxNodes: 1,
    });
    expect(result.scannedNodes).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
