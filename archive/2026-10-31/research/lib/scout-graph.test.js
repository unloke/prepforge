import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import {
  createGraph,
  epdOf,
  graphAnchorTs,
  insertGame,
  nodeAt,
  projectFirstMoveDist,
  freshWindowBoundary,
  SCOUT_GAMEREFS_CAP,
} from "./scout-graph.js";

const MS_PER_DAY = 86_400_000;

function scoutGame({
  color = "white",
  score = 1,
  sans,
  ucis,
  datestamp = 1_000_000,
  status = null,
  totalPly = null,
  clockAfterPly = null,
  clockInitialSeconds = null,
  gameId = null,
}) {
  return {
    color,
    score,
    status,
    sans,
    ucis,
    openingSans: sans,
    openingUcis: ucis,
    datestamp,
    gameId,
    totalPly: totalPly ?? ucis?.length ?? 0,
    clockAfterPly: clockAfterPly ?? (ucis || []).map(() => null),
    clockInitialSeconds,
  };
}

describe("epdOf", () => {
  it("strips the last two FEN fields (halfmove clock and fullmove number)", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    expect(epdOf(fen)).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3");
  });
});

describe("graphAnchorTs", () => {
  it("returns Date.now() when no dated games", () => {
    const before = Date.now();
    expect(graphAnchorTs([])).toBeGreaterThanOrEqual(before);
  });

  it("returns the newest datestamp", () => {
    const games = [
      scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: 100 }),
      scoutGame({ ucis: ["d2d4"], sans: ["d4"], datestamp: 500 }),
    ];
    expect(graphAnchorTs(games)).toBe(500);
  });
});

describe("insertGame transpositions", () => {
  it("merges 1.d4 d5 2.c4 and 1.c4 d5 2.d4 to the same node after 3 plies", () => {
    const lineA = ["d2d4", "d7d5", "c2c4", "e7e6"];
    const lineB = ["c2c4", "d7d5", "d2d4", "e7e6"];
    const transposedPrefix = lineA.slice(0, 3);

    const chessA = new Chess();
    const chessB = new Chess();
    for (const uci of transposedPrefix) {
      chessA.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
      chessB.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    }
    expect(epdOf(chessA.fen())).toBe(epdOf(chessB.fen()));

    const g1 = scoutGame({ ucis: lineA, sans: ["d4", "d5", "c4", "e6"], datestamp: 1000 });
    const g2 = scoutGame({ ucis: lineB, sans: ["c4", "d5", "d4", "e6"], datestamp: 2000 });
    const anchor = 3000;

    let graph = createGraph();
    graph = insertGame(graph, g1, "white", { anchorTs: anchor, recency: false });
    graph = insertGame(graph, g2, "white", { anchorTs: anchor, recency: false });

    const node = nodeAt(graph, transposedPrefix);
    expect(node).not.toBeNull();
    expect(nodeAt(graph, lineB.slice(0, 3))).toBe(node);
    expect(node.totalN).toBe(2);
  });
});

describe("insertGame filters", () => {
  it("skips wrong-colour games", () => {
    const game = scoutGame({ color: "black", ucis: ["e7e5"], sans: ["e5"] });
    const graph = insertGame(createGraph(), game, "white", { recency: false });
    expect(graph.nodes.size).toBe(0);
  });

  it("skips early-resign collapse games when excludeCollapse is true", () => {
    const collapse = scoutGame({
      color: "white",
      score: 0,
      status: "resign",
      totalPly: 6,
      clockInitialSeconds: 180,
      clockAfterPly: [175, 178, 172, 176, 165, 174],
      ucis: ["e2e4", "e7e5"],
      sans: ["e4", "e5"],
    });
    const graph = insertGame(createGraph(), collapse, "white", { recency: false });
    expect(graph.nodes.size).toBe(0);
  });
});

describe("insertGame edge tallies", () => {
  it("accumulates n, w/d/l, and recentN vs olderN from datestamps", () => {
    const anchor = 1_000_000;
    const boundary = anchor - 60 * MS_PER_DAY;

    const recent = scoutGame({
      score: 1,
      ucis: ["e2e4"],
      sans: ["e4"],
      datestamp: anchor - 10 * MS_PER_DAY,
    });
    const older = scoutGame({
      score: 0,
      ucis: ["e2e4"],
      sans: ["e4"],
      datestamp: anchor - 90 * MS_PER_DAY,
    });
    const draw = scoutGame({
      score: 0.5,
      ucis: ["d2d4"],
      sans: ["d4"],
      datestamp: anchor - 5 * MS_PER_DAY,
    });

    let graph = createGraph();
    const opts = { anchorTs: anchor, recencyBoundaryTs: boundary, recency: false };
    graph = insertGame(graph, recent, "white", opts);
    graph = insertGame(graph, older, "white", opts);
    graph = insertGame(graph, draw, "white", opts);

    const root = graph.nodes.get(graph.root);
    const e4 = root.moves.get("e2e4");
    const d4 = root.moves.get("d2d4");

    expect(e4.n).toBe(2);
    expect(e4.w).toBe(1);
    expect(e4.l).toBe(1);
    expect(e4.recentN).toBe(1);
    expect(e4.olderN).toBe(1);

    expect(d4.n).toBe(1);
    expect(d4.d).toBe(1);
    expect(d4.recentN).toBe(1);
    expect(d4.olderN).toBe(0);
    expect(root.totalN).toBe(3);
  });
});

describe("projectFirstMoveDist", () => {
  it("returns shares summing to ~1 sorted by wN desc", () => {
    const anchor = 5_000_000;
    const g1 = scoutGame({
      ucis: ["e2e4"],
      sans: ["e4"],
      datestamp: anchor,
      score: 1,
    });
    const g2 = scoutGame({
      ucis: ["d2d4"],
      sans: ["d4"],
      datestamp: anchor - 30 * MS_PER_DAY,
      score: 0,
    });
    const g3 = scoutGame({
      ucis: ["e2e4"],
      sans: ["e4"],
      datestamp: anchor - 60 * MS_PER_DAY,
      score: 1,
    });

    let graph = createGraph();
    graph = insertGame(graph, g1, "white", { anchorTs: anchor });
    graph = insertGame(graph, g2, "white", { anchorTs: anchor });
    graph = insertGame(graph, g3, "white", { anchorTs: anchor });

    const dist = projectFirstMoveDist(graph);
    expect(dist.length).toBe(2);
    expect(dist[0].wN).toBeGreaterThanOrEqual(dist[1].wN);
    const shareSum = dist.reduce((s, row) => s + row.share, 0);
    expect(shareSum).toBeCloseTo(1, 9);
    expect(dist[0].san).toBeTruthy();
  });
});

describe("v6 provenance (§2.0)", () => {
  it("counts distinct playing days per edge, not raw plays", () => {
    // three plays of e4 across only two calendar days
    const games = [
      scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: 10 * MS_PER_DAY, gameId: "a" }),
      scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: 10 * MS_PER_DAY + 3600_000, gameId: "b" }),
      scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: 20 * MS_PER_DAY, gameId: "c" }),
    ];
    let graph = createGraph();
    for (const g of games) graph = insertGame(graph, g, "white", { recency: false });
    const e4 = graph.nodes.get(graph.root).moves.get("e2e4");
    expect(e4.n).toBe(3);
    expect(e4.distinctDateN).toBe(2);
    expect(e4.gameRefs.length).toBe(3);
    expect(e4.gameRefs[0]).toMatchObject({ gameId: "a", plyAtVisit: 0 });
  });

  it("caps gameRefs at SCOUT_GAMEREFS_CAP with FIFO eviction (keeps newest)", () => {
    let graph = createGraph();
    const total = SCOUT_GAMEREFS_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      graph = insertGame(
        graph,
        scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: (100 + i) * MS_PER_DAY, gameId: `g${i}` }),
        "white",
        { recency: false },
      );
    }
    const e4 = graph.nodes.get(graph.root).moves.get("e2e4");
    expect(e4.n).toBe(total);
    expect(e4.gameRefs.length).toBe(SCOUT_GAMEREFS_CAP);
    expect(e4.gameRefs[e4.gameRefs.length - 1].gameId).toBe(`g${total - 1}`); // newest retained
    expect(e4.gameRefs[0].gameId).toBe(`g5`); // oldest 5 evicted
  });

  it("fresh window counts freshK / freshN only within the boundary", () => {
    const fb = 500 * MS_PER_DAY;
    let graph = createGraph();
    graph = insertGame(graph, scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: 1 * MS_PER_DAY, gameId: "old" }), "white", { recency: false, freshBoundaryTs: fb });
    graph = insertGame(graph, scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: 900 * MS_PER_DAY, gameId: "new" }), "white", { recency: false, freshBoundaryTs: fb });
    const root = graph.nodes.get(graph.root);
    expect(root.reachK).toBe(2);
    expect(root.freshN).toBe(1);
    expect(root.moves.get("e2e4").freshK).toBe(1);
  });

  it("per-game guard: a repetition within one game counts reach/provenance once", () => {
    // Knights out and back → same EPD as before the shuffle; the guard must not double-count.
    const ucis = ["g1f3", "g8f6", "f3g1", "f6g8"]; // returns toward start position pattern
    const g = scoutGame({ ucis, sans: ["Nf3", "Nf6", "Ng1", "Ng8"], datestamp: 5 * MS_PER_DAY, gameId: "rep" });
    const graph = insertGame(createGraph(), g, "white", { recency: false });
    // The start EPD is revisited after 2 plies; reachK for that node stays 1 (one game).
    const startNode = graph.nodes.get(graph.root);
    expect(startNode.reachK).toBe(1);
  });

  it("freshWindowBoundary takes the larger of last-N-games and last-D-days", () => {
    const games = Array.from({ length: 30 }, (_, i) =>
      scoutGame({ ucis: ["e2e4"], sans: ["e4"], datestamp: (1000 - i) * MS_PER_DAY, gameId: `g${i}` }),
    );
    const anchor = 1000 * MS_PER_DAY;
    const b = freshWindowBoundary(games, "white", { anchorTs: anchor, freshGames: 20, freshDays: 120 });
    // last-20-games cutoff = day 981; last-120-days cutoff = day 880 → union takes the earlier (880)
    expect(b).toBe(880 * MS_PER_DAY);
  });
});

describe("anchor invariance", () => {
  it("keeps projectFirstMoveDist shares equal when anchorTs shifts by 30 days", () => {
    const games = [
      scoutGame({
        ucis: ["e2e4", "e7e5"],
        sans: ["e4", "e5"],
        datestamp: 1_000_000,
      }),
      scoutGame({
        ucis: ["d2d4", "d7d5"],
        sans: ["d4", "d5"],
        datestamp: 1_500_000,
      }),
      scoutGame({
        ucis: ["e2e4", "c7c5"],
        sans: ["e4", "c5"],
        datestamp: 2_000_000,
      }),
    ];

    const anchorA = 3_000_000;
    const anchorB = anchorA + 30 * MS_PER_DAY;

    let graphA = createGraph();
    let graphB = createGraph();
    for (const g of games) {
      graphA = insertGame(graphA, g, "white", { anchorTs: anchorA });
      graphB = insertGame(graphB, g, "white", { anchorTs: anchorB });
    }

    const distA = projectFirstMoveDist(graphA);
    const distB = projectFirstMoveDist(graphB);
    expect(distA.length).toBe(distB.length);

    const byUciA = new Map(distA.map((r) => [r.uci, r.share]));
    for (const row of distB) {
      expect(row.share).toBeCloseTo(byUciA.get(row.uci), 9);
    }
  });
});