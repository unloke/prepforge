import { describe, it, expect } from "vitest";

import {
  PHASE_LABELS,
  phaseOfFen,
  isStartFen,
  promptTipFor,
  rankMove,
  buildPhaseCoach,
  clusterQueueByPhase,
} from "./phase-coach.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KP_VS_K = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 40";
const MIDDLEGAME = "r2q1rk1/pppbbppp/2n2n2/3pp3/3PP3/2NQBN2/PPP1BPPP/R4RK1 w - - 0 10";

describe("phaseOfFen", () => {
  it("reads the start FEN as opening", () => {
    expect(phaseOfFen(START)).toBe("opening");
  });

  it("reads K+P vs K as endgame", () => {
    expect(phaseOfFen(KP_VS_K)).toBe("endgame");
  });
});

describe("PHASE_LABELS", () => {
  it("names each phase", () => {
    expect(PHASE_LABELS.opening).toBe("Opening");
    expect(PHASE_LABELS.middlegame).toBe("Middlegame");
    expect(PHASE_LABELS.endgame).toBe("Endgame");
  });
});

describe("rankMove", () => {
  it("ranks from the real probability field, ignoring a fake rank blob", () => {
    // Unsorted on purpose, and every `rank` field is a lie. Ranking must follow
    // probability, not a hardcoded oracle copy.
    const predictions = [
      { move_uci: "g1f3", probability: 0.1, rank: 1 },
      { move_uci: "e2e4", probability: 0.5, rank: 99 },
      { move_uci: "d2d4", probability: 0.22, rank: 1 },
      { move_uci: "c2c4", probability: 0.18, rank: 0 },
    ];
    expect(rankMove(predictions, "e2e4")).toEqual({
      rank: 1,
      probability: 0.5,
      move_uci: "e2e4",
    });
    expect(rankMove(predictions, "d2d4")).toEqual({
      rank: 2,
      probability: 0.22,
      move_uci: "d2d4",
    });
    expect(rankMove(predictions, "c2c4").rank).toBe(3);
    expect(rankMove(predictions, "g1f3").rank).toBe(4);
    expect(rankMove(predictions, "g1f3").probability).toBe(0.1);
  });

  it("returns null when the move is missing or the list is empty", () => {
    expect(rankMove(null, "e2e4")).toBeNull();
    expect(rankMove([], "e2e4")).toBeNull();
    expect(rankMove([{ move_uci: "e2e4", probability: 0.4 }], "d2d4")).toBeNull();
  });
});

describe("buildPhaseCoach", () => {
  const OPENING_PREDS = [
    { move_uci: "e2e4", probability: 0.42 },
    { move_uci: "d2d4", probability: 0.28 },
    { move_uci: "g1f3", probability: 0.15 },
    { move_uci: "b2b3", probability: 0.02 },
  ];

  it("says nothing when Maia has no read: no canned phase advice", () => {
    for (const predictions of [[], null]) {
      const coach = buildPhaseCoach({ fen: START, predictions, expectedUci: "e2e4" });
      expect(coach.phase).toBe("opening");
      expect(coach.title).toBe("Opening");
      expect(coach.agreement).toBe("unknown");
      expect(coach.tip).toBe("");
      expect(coach.generic).toBe(true);
    }
  });

  it("never fills the Your-move banner with phase advice", () => {
    expect(promptTipFor(START, "opening")).toBe("");
    expect(promptTipFor(MIDDLEGAME, "middlegame")).toBe("");
    const coach = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, expectedUci: "e2e4" });
    expect(coach.promptTip).toBe("");
  });

  it("teach card: the prepared move is also the popular one", () => {
    const coach = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, expectedUci: "e2e4", rating: 1500 });
    expect(coach.agreement).toBe("prepared");
    expect(coach.humanSan).toBe("e4");
    expect(coach.expectedPct).toBe(42);
    expect(coach.tip).toBe("Also the most popular move among players at your level.");
  });

  it("teach card: a common but not top choice gives its share", () => {
    const coach = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, expectedUci: "g1f3", rating: 1500 });
    expect(coach.agreement).toBe("human-also");
    expect(coach.tip).toBe("A common choice among players at your level (15%).");
  });

  it("teach card: a rare prepared move is flagged as a surprise", () => {
    const coach = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, expectedUci: "b2b3" });
    expect(coach.agreement).toBe("surprise");
    expect(coach.tip).toBe("Only 2% of players play it, so expect a surprise.");
  });

  it("first miss: talks about the move played, never the prepared one", () => {
    const popular = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, expectedUci: "g1f3", playedUci: "e2e4" });
    expect(popular.tip).toBe("e4 is popular here, but it isn't your prep.");
    const rare = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, expectedUci: "e2e4", playedUci: "h2h4" });
    expect(rare.tip).toBe("Few players play h4 here.");
    for (const c of [popular, rare]) expect(c.tip).not.toMatch(/Nf3|e4 is your/);
  });

  it("reveal: names the prepared move with its share", () => {
    const coach = buildPhaseCoach({
      fen: START,
      predictions: OPENING_PREDS,
      expectedUci: "e2e4",
      expectedSan: "e4",
      playedUci: "h2h4",
      reveal: true,
    });
    expect(coach.tip).toBe("e4 is your prep; 42% of players play it.");
  });

  it("Analyze: says how common the move just played is", () => {
    const top = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, playedUci: "e2e4", rating: 1500 });
    expect(top.tip).toBe("e4 is the most common choice among players at your level (42%).");
    const other = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, playedUci: "d2d4" });
    expect(other.tip).toBe("e4 is the usual move among players (42%); d4 gets 28%.");
    const unlisted = buildPhaseCoach({ fen: START, predictions: OPENING_PREDS, playedUci: "a2a3" });
    expect(unlisted.tip).toBe("e4 is the usual move among players (42%); a3 gets under 1%.");
  });

  it("treats an expected move within 5 points of the top as prepared", () => {
    const coach = buildPhaseCoach({
      fen: START,
      predictions: [
        { move_uci: "e2e4", probability: 0.4 },
        { move_uci: "d2d4", probability: 0.37 },
      ],
      expectedUci: "d2d4",
    });
    expect(coach.agreement).toBe("prepared");
    expect(coach.tip).toBe("One of the main moves among players.");
  });

  it("reads endgame and middlegame positions with the same rules", () => {
    const end = buildPhaseCoach({ fen: KP_VS_K, predictions: [{ move_uci: "e1d2", probability: 0.6 }], playedUci: "e1d2" });
    expect(end.phase).toBe("endgame");
    expect(end.tip).toBe("Kd2 is the most common choice among players (60%).");
    const mid = buildPhaseCoach({ fen: MIDDLEGAME, predictions: [{ move_uci: "e4d5", probability: 0.5 }], expectedUci: "e4d5" });
    expect(mid.phase).toBe("middlegame");
    expect(mid.tip).toBe("Also the most popular move among players.");
  });
});

describe("clusterQueueByPhase", () => {
  it("majority-votes cards by the first target FEN", () => {
    const cluster = clusterQueueByPhase([
      { targets: [{ fen_before: START }] },
      { targets: [{ fen_before: START }] },
      { targets: [{ fen_before: KP_VS_K }] },
      { targets: [] },
    ]);
    expect(cluster.total).toBe(3);
    expect(cluster.counts.opening).toBe(2);
    expect(cluster.counts.endgame).toBe(1);
    expect(cluster.majority).toBe("opening");
    expect(cluster.majorityLabel).toBe("Opening");
  });
});
