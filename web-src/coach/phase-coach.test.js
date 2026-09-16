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
  it("still returns phase + a generic tip when predictions are empty", () => {
    const coach = buildPhaseCoach({ fen: START, predictions: [] });
    expect(coach.phase).toBe("opening");
    expect(coach.phaseLabel).toBe("Opening");
    expect(coach.title).toBe("Opening coach");
    expect(coach.humanUci).toBeNull();
    expect(coach.humanSan).toBeNull();
    expect(coach.humanPct).toBeNull();
    expect(coach.expectedPct).toBeNull();
    expect(coach.playedPct).toBeNull();
    expect(coach.agreement).toBe("unknown");
    expect(coach.tip).toMatch(/develop/i);
    expect(coach.tip).not.toMatch(/%/);
    expect(coach.tip).not.toMatch(/Maia/i);
  });

  it("treats null predictions the same as empty (unknown, no Maia numbers)", () => {
    const coach = buildPhaseCoach({ fen: START, predictions: null, expectedUci: "e2e4" });
    expect(coach.agreement).toBe("unknown");
    expect(coach.humanUci).toBeNull();
    expect(coach.tip.length).toBeGreaterThan(10);
  });

  it("marks top Maia = expected as prepared and sets humanSan", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.42, rank: 1 },
      { move_uci: "d2d4", probability: 0.28, rank: 2 },
      { move_uci: "g1f3", probability: 0.18, rank: 3 },
    ];
    const coach = buildPhaseCoach({
      fen: START,
      predictions,
      expectedUci: "e2e4",
      rating: 1500,
    });
    expect(coach.phase).toBe("opening");
    expect(coach.agreement).toBe("prepared");
    expect(coach.humanUci).toBe("e2e4");
    expect(coach.humanSan).toBe("e4");
    expect(coach.humanPct).toBe(42);
    expect(coach.expectedPct).toBe(42);
    expect(coach.tip).toMatch(/first move of your repertoire/i);
    expect(coach.tip).toMatch(/e4/);
    expect(coach.tip).not.toMatch(/actually play|everyone|humans go/i);
    expect(coach.promptTip).toBe("Play the first move of your repertoire.");
    expect(coach.promptTip).not.toMatch(/e4/);
  });

  it("does not name e4 as the crowd move while waiting at the start FEN with no prep", () => {
    const coach = buildPhaseCoach({
      fen: START,
      predictions: [
        { move_uci: "e2e4", probability: 0.52 },
        { move_uci: "d2d4", probability: 0.28 },
      ],
    });
    expect(isStartFen(START)).toBe(true);
    expect(coach.humanSan).toBe("e4");
    expect(coach.tip).not.toMatch(/e4/);
    expect(coach.tip).not.toMatch(/everyone|humans go|actually play/i);
    expect(coach.promptTip).not.toMatch(/e4/);
  });

  it("keeps crowd copy after a move is actually played from the start", () => {
    const coach = buildPhaseCoach({
      fen: START,
      predictions: [
        { move_uci: "e2e4", probability: 0.42 },
        { move_uci: "d2d4", probability: 0.28 },
      ],
      expectedUci: "e2e4",
      playedUci: "e2e4",
      rating: 1500,
    });
    expect(coach.tip).toMatch(/players at your rating actually play/i);
    expect(coach.tip).toMatch(/e4/);
  });

  it("never puts the prepared SAN on promptTip (Train Your-move must not leak)", () => {
    const coach = buildPhaseCoach({
      fen: MIDDLEGAME,
      predictions: [
        { move_uci: "c3d5", probability: 0.36 },
        { move_uci: "e4d5", probability: 0.22 },
      ],
      expectedUci: "c3d5",
    });
    expect(coach.tip).toMatch(/Nxd5/);
    expect(coach.promptTip).not.toMatch(/Nxd5|Nxd5|c3d5/i);
    expect(promptTipFor(MIDDLEGAME, "middlegame")).not.toMatch(/Nxd5/);
  });

  it("marks a rare expected move (<8%) as surprise", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.51 },
      { move_uci: "d2d4", probability: 0.31 },
      { move_uci: "g1f3", probability: 0.12 },
      { move_uci: "a2a3", probability: 0.03 },
    ];
    const coach = buildPhaseCoach({
      fen: START,
      predictions,
      expectedUci: "a2a3",
      expectedSan: "a3",
    });
    expect(coach.agreement).toBe("surprise");
    expect(coach.expectedPct).toBe(3);
    expect(coach.humanSan).toBe("e4");
    expect(coach.tip).toMatch(/trap|sideline/i);
    expect(coach.tip).toMatch(/a3/);
  });

  it("on a first miss, does not name the prepared SAN (retry is not a reveal)", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.48 },
      { move_uci: "d2d4", probability: 0.3 },
      { move_uci: "g1f3", probability: 0.16 },
      { move_uci: "a2a4", probability: 0.02 },
    ];
    const coach = buildPhaseCoach({
      fen: START,
      predictions,
      expectedUci: "e2e4",
      expectedSan: "e4",
      playedUci: "a2a4",
      rating: 1600,
    });
    expect(coach.playedPct).toBe(2);
    expect(coach.expectedPct).toBe(48);
    expect(coach.tip).toMatch(/almost never play that/i);
    expect(coach.tip).not.toMatch(/e4/);
  });

  it("names the prepared SAN only when reveal is set (second miss)", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.48 },
      { move_uci: "a2a4", probability: 0.02 },
    ];
    const coach = buildPhaseCoach({
      fen: START,
      predictions,
      expectedUci: "e2e4",
      expectedSan: "e4",
      playedUci: "a2a4",
      reveal: true,
    });
    expect(coach.tip).toMatch(/e4/);
    expect(coach.tip).toMatch(/almost never play that/i);
  });

  it("calls expected in Maia's top 3 (but not near the top) human-also", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.5 },
      { move_uci: "d2d4", probability: 0.25 },
      { move_uci: "g1f3", probability: 0.15 },
    ];
    const coach = buildPhaseCoach({
      fen: START,
      predictions,
      expectedUci: "g1f3",
    });
    expect(coach.agreement).toBe("human-also");
    expect(coach.humanSan).toBe("e4");
    expect(coach.expectedPct).toBe(15);
    expect(coach.tip).toMatch(/Nf3/);
  });

  it("treats expected within 5% of the top move as prepared", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.4 },
      { move_uci: "d2d4", probability: 0.37 },
    ];
    const coach = buildPhaseCoach({
      fen: START,
      predictions,
      expectedUci: "d2d4",
    });
    expect(coach.agreement).toBe("prepared");
    expect(coach.humanSan).toBe("e4");
    expect(coach.humanPct).toBe(40);
    expect(coach.expectedPct).toBe(37);
  });

  it("names the human conversion move in a K+P vs K endgame", () => {
    // Pawn sits on e2, so the king activates via d2 (e1e2 is illegal).
    const predictions = [
      { move_uci: "e1d2", probability: 0.62 },
      { move_uci: "e2e4", probability: 0.24 },
    ];
    const coach = buildPhaseCoach({
      fen: KP_VS_K,
      predictions,
      expectedUci: "e1d2",
    });
    expect(coach.phase).toBe("endgame");
    expect(coach.title).toBe("Endgame coach");
    expect(coach.agreement).toBe("prepared");
    expect(coach.humanSan).toBe("Kd2");
    expect(coach.tip).toMatch(/Kd2/);
    expect(coach.tip).toMatch(/conversion/i);
    expect(coach.tip).toMatch(/don't rush tactics/i);
  });

  it("in the middlegame, names the human plans from the top Maia moves", () => {
    const predictions = [
      { move_uci: "c3d5", probability: 0.36 },
      { move_uci: "e4d5", probability: 0.22 },
      { move_uci: "f3g5", probability: 0.14 },
    ];
    const coach = buildPhaseCoach({
      fen: MIDDLEGAME,
      predictions,
      expectedUci: "c3d5",
    });
    expect(coach.phase).toBe("middlegame");
    expect(coach.agreement).toBe("prepared");
    expect(coach.humanSan).toBe("Nxd5");
    expect(coach.tip).toMatch(/Nxd5/);
    expect(coach.tip).toMatch(/human choice/i);
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
