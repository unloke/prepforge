import { describe, expect, it } from "vitest";

import {
  EXPLORER_THIN_SAMPLE,
  pickExplorerReply,
  pickMaiaReply,
  pickOpponentReply,
  pickRepertoireReply,
  playPositionAfterReply,
} from "./train-opponent.js";

const LEGAL = ["e7e5", "c7c5", "e7e6", "c7c6", "g8f6"];

describe("pickExplorerReply", () => {
  it("never returns an illegal UCI even when it has the highest share", () => {
    const explorer = {
      totalGames: 1000,
      moves: [
        { uci: "a2a3", share: 0.9, total: 900 },
        { uci: "e7e5", share: 0.1, total: 100 },
      ],
    };
    for (let i = 0; i < 40; i++) {
      expect(LEGAL).toContain(pickExplorerReply(explorer, LEGAL, () => i / 40));
    }
  });

  it("prefers the high-share legal move", () => {
    const explorer = {
      totalGames: 100,
      moves: [
        { uci: "e7e5", share: 0.85, total: 85 },
        { uci: "c7c5", share: 0.15, total: 15 },
      ],
    };
    const counts = { e7e5: 0, c7c5: 0 };
    for (let i = 0; i < 200; i++) {
      const uci = pickExplorerReply(explorer, LEGAL, () => (i + 0.5) / 200);
      counts[uci] += 1;
    }
    expect(counts.e7e5).toBeGreaterThan(counts.c7c5);
    expect(counts.e7e5 + counts.c7c5).toBe(200);
  });
});

describe("pickOpponentReply", () => {
  it("falls back to a Maia-policy move when explorer sample is thinner than the cutoff", () => {
    expect(EXPLORER_THIN_SAMPLE).toBeGreaterThan(0);
    const reply = pickOpponentReply({
      book: "explorer",
      legalUcis: LEGAL,
      explorer: {
        totalGames: EXPLORER_THIN_SAMPLE - 1,
        moves: [{ uci: "e7e5", share: 1, total: EXPLORER_THIN_SAMPLE - 1 }],
      },
      maiaPredictions: [
        { move_uci: "c7c5", probability: 0.7 },
        { move_uci: "e7e5", probability: 0.2 },
      ],
      rng: () => 0,
    });
    expect(reply.source).toBe("maia");
    expect(reply.reason).toBe("thin-sample");
    expect(reply.uci).toBe("c7c5");
    expect(LEGAL).toContain(reply.uci);
  });

  it("uses explorer when the sample is thick enough", () => {
    const reply = pickOpponentReply({
      book: "explorer",
      legalUcis: LEGAL,
      explorer: {
        totalGames: EXPLORER_THIN_SAMPLE + 20,
        moves: [{ uci: "e7e5", share: 1, total: 40 }],
      },
      maiaPredictions: [{ move_uci: "c7c5", probability: 1 }],
      rng: () => 0,
    });
    expect(reply).toEqual({ uci: "e7e5", source: "explorer", reason: null });
  });

  it("repertoire replies only with a child of the current node", () => {
    const reply = pickOpponentReply({
      book: "repertoire",
      legalUcis: LEGAL,
      repertoireChildren: [{ uci: "c7c6" }, { uci: "a2a3" }],
      maiaPredictions: [{ move_uci: "e7e5", probability: 1 }],
      rng: () => 0,
    });
    expect(reply.source).toBe("repertoire");
    expect(reply.uci).toBe("c7c6");
    expect(LEGAL).toContain(reply.uci);
  });

  it("leaves the repertoire book for Maia when the node has no legal child", () => {
    const reply = pickOpponentReply({
      book: "repertoire",
      legalUcis: LEGAL,
      repertoireChildren: [{ uci: "a2a3" }],
      maiaPredictions: [{ move_uci: "g8f6", probability: 1 }],
      rng: () => 0,
    });
    expect(reply.source).toBe("maia");
    expect(reply.reason).toBe("out-of-book");
    expect(reply.uci).toBe("g8f6");
  });
});

describe("pickMaiaReply / pickRepertoireReply", () => {
  it("ignores Maia mass on illegal moves", () => {
    expect(
      pickMaiaReply(
        [
          { move_uci: "a2a3", probability: 0.9 },
          { move_uci: "e7e6", probability: 0.1 },
        ],
        LEGAL,
        () => 0,
      ),
    ).toBe("e7e6");
  });

  it("picks uniformly among legal repertoire children", () => {
    const kids = ["e7e5", "c7c5"];
    expect(pickRepertoireReply(kids, LEGAL, () => 0)).toBe("e7e5");
    expect(pickRepertoireReply(kids, LEGAL, () => 0.9)).toBe("c7c5");
  });
});

describe("playPositionAfterReply", () => {
  it("ends the session on opponent checkmate with no legal moves", () => {
    const out = playPositionAfterReply({
      fen: "end",
      legal_moves: ["a2a3"],
      status: { is_checkmate: true, is_stalemate: false },
    });
    expect(out.terminal).toBe(true);
    expect(out.active).toBe(false);
    expect(out.legalMoves).toEqual([]);
    expect(out.banner).toBe("Checkmate");
  });

  it("ends the session on opponent stalemate", () => {
    const out = playPositionAfterReply({
      legal_moves: ["a7a8q"],
      status: { is_checkmate: false, is_stalemate: true },
    });
    expect(out.terminal).toBe(true);
    expect(out.active).toBe(false);
    expect(out.banner).toBe("Draw");
    expect(out.legalMoves).toEqual([]);
  });

  it("keeps the session live when the user still has moves", () => {
    const out = playPositionAfterReply({
      legal_moves: ["e2e4", "d2d4"],
      status: { is_checkmate: false, is_stalemate: false },
    });
    expect(out.terminal).toBe(false);
    expect(out.active).toBe(true);
    expect(out.legalMoves).toEqual(["e2e4", "d2d4"]);
  });
});
