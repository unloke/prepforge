import { describe, expect, it } from "vitest";

import {
  START_FEN,
  isStartFen,
  keyPositionsFromGame,
  keyPositionsFromTree,
  luckyStartFromWorkspace,
  pickLuckyStart,
} from "./train-lucky.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const SICILIAN = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

describe("isStartFen", () => {
  it("flags the start position and not a book ply", () => {
    expect(isStartFen(START_FEN)).toBe(true);
    expect(isStartFen(AFTER_E4)).toBe(false);
  });
});

describe("keyPositionsFromGame", () => {
  it("takes fen_before of an engine-marked miss, never the start", () => {
    const keys = keyPositionsFromGame({
      moves: [
        { fen_before: START_FEN, fen_after: AFTER_E4, classification: "book", uci: "e2e4" },
        { fen_before: AFTER_E4, fen_after: SICILIAN, classification: "blunder", uci: "c7c5" },
      ],
    });
    expect(keys).toHaveLength(1);
    expect(keys[0].reason).toBe("miss");
    expect(keys[0].fen).toBe(AFTER_E4);
    expect(isStartFen(keys[0].fen)).toBe(false);
  });

  it("reconstructs a book-departure FEN from SAN history", () => {
    const keys = keyPositionsFromGame({
      departure_reason: "user_left_preparation",
      departure_ply: 2,
      move_san_history: ["e4", "c5"],
    });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].reason).toBe("departure");
    expect(keys[0].fen.split(" ")[0]).toBe(AFTER_E4.split(" ")[0]);
    expect(isStartFen(keys[0].fen)).toBe(false);
  });
});

describe("keyPositionsFromTree", () => {
  it("marks a parent with two children as a fork", () => {
    const keys = keyPositionsFromTree([
      { id: "root", parent_id: null, fen: START_FEN },
      { id: "e4", parent_id: "root", uci: "e2e4", fen: AFTER_E4, fen_before: START_FEN },
      { id: "c5", parent_id: "e4", uci: "c7c5", fen: SICILIAN, fen_before: AFTER_E4 },
      { id: "e5", parent_id: "e4", uci: "e7e5", fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", fen_before: AFTER_E4 },
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0].reason).toBe("fork");
    expect(keys[0].fen).toBe(AFTER_E4);
    expect(keys[0].replies).toBe(2);
    expect(keys[0].nodeId).toBe("e4");
  });
});

describe("pickLuckyStart", () => {
  it("returns different non-start FENs for two different analyzed games", () => {
    const gameA = {
      moves: [{ fen_before: AFTER_E4, classification: "mistake", uci: "g8f6" }],
    };
    const gameB = {
      moves: [{ fen_before: AFTER_D4, classification: "blunder", uci: "g8f6" }],
    };
    const a = pickLuckyStart({ games: [gameA], rng: () => 0 });
    const b = pickLuckyStart({ games: [gameB], rng: () => 0 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(isStartFen(a.fen)).toBe(false);
    expect(isStartFen(b.fen)).toBe(false);
    expect(a.fen).not.toBe(b.fen);
    expect(a.reason).toBe("miss");
    expect(b.reason).toBe("miss");
  });

  it("returns different non-start FENs for two different fork trees", () => {
    const treeA = [
      { id: "root", parent_id: null, fen: START_FEN },
      { id: "e4", parent_id: "root", fen: AFTER_E4 },
      { id: "c5", parent_id: "e4", uci: "c7c5", fen_before: AFTER_E4 },
      { id: "e5", parent_id: "e4", uci: "e7e5", fen_before: AFTER_E4 },
    ];
    const treeB = [
      { id: "root", parent_id: null, fen: START_FEN },
      { id: "d4", parent_id: "root", fen: AFTER_D4 },
      { id: "d5", parent_id: "d4", uci: "d7d5", fen_before: AFTER_D4 },
      { id: "nf6", parent_id: "d4", uci: "g8f6", fen_before: AFTER_D4 },
    ];
    const a = pickLuckyStart({ trees: [treeA], rng: () => 0 });
    const b = pickLuckyStart({ trees: [treeB], rng: () => 0 });
    expect(a.fen).toBe(AFTER_E4);
    expect(b.fen).toBe(AFTER_D4);
    expect(a.fen).not.toBe(b.fen);
    expect(a.reason).toBe("fork");
    expect(b.reason).toBe("fork");
  });

  it("returns null when nothing is interesting", () => {
    expect(pickLuckyStart({ games: [], trees: [] })).toBeNull();
    expect(
      pickLuckyStart({
        games: [{ moves: [{ fen_before: START_FEN, classification: "book" }] }],
      }),
    ).toBeNull();
  });
});

describe("luckyStartFromWorkspace", () => {
  const forkTree = [
    { id: "root", parent_id: null, fen: START_FEN },
    { id: "e4", parent_id: "root", fen: AFTER_E4 },
    { id: "c5", parent_id: "e4", uci: "c7c5", fen_before: AFTER_E4 },
    { id: "e5", parent_id: "e4", uci: "e7e5", fen_before: AFTER_E4 },
  ];

  it("loads the selected repertoire before picking when Build is empty", async () => {
    let loaded = null;
    const picked = await luckyStartFromWorkspace({
      book: "repertoire",
      repertoireId: "rep-1",
      currentBuild: null,
      loadRepertoire: async (id) => {
        loaded = id;
        return { repertoire_id: id, nodes: forkTree };
      },
      rng: () => 0,
    });
    expect(loaded).toBe("rep-1");
    expect(picked).not.toBeNull();
    expect(picked.fen).toBe(AFTER_E4);
    expect(picked.reason).toBe("fork");
    expect(isStartFen(picked.fen)).toBe(false);
  });

  it("does not skip the load when a different repertoire is already in memory", async () => {
    let loaded = null;
    const other = [
      { id: "root", parent_id: null, fen: START_FEN },
      { id: "d4", parent_id: "root", fen: AFTER_D4 },
      { id: "d5", parent_id: "d4", uci: "d7d5", fen_before: AFTER_D4 },
      { id: "nf6", parent_id: "d4", uci: "g8f6", fen_before: AFTER_D4 },
    ];
    const picked = await luckyStartFromWorkspace({
      book: "repertoire",
      repertoireId: "rep-2",
      currentBuild: { repertoire_id: "rep-1", nodes: forkTree },
      loadRepertoire: async (id) => {
        loaded = id;
        return { repertoire_id: id, nodes: other };
      },
      rng: () => 0,
    });
    expect(loaded).toBe("rep-2");
    expect(picked.fen).toBe(AFTER_D4);
  });
});
