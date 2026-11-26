import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { planPgnMerge, pgnMergeSummary } from "./build-pgn-merge.js";
import { START_FEN } from "./core/board-constants.js";

// A repertoire tree in the /api/build/load node shape, from SAN lines that all
// start at `startFen`. Ids are "n:<san path>", so a test can name a node.
function tree(lines, { startFen = START_FEN, idOf = (path) => `n:${path}` } = {}) {
  const root = { id: "root", parent_id: null, depth: 0, fen: startFen, uci: null };
  const nodes = [root];
  const byPath = new Map([["", root]]);
  for (const line of lines) {
    const chess = new Chess(startFen);
    let path = "";
    for (const san of line.split(" ")) {
      const parent = byPath.get(path);
      const move = chess.move(san);
      path = path ? `${path} ${san}` : san;
      if (byPath.has(path)) continue;
      const node = { id: idOf(path), parent_id: parent.id, depth: parent.depth + 1, fen: chess.fen(), uci: move.lan, san };
      nodes.push(node);
      byPath.set(path, node);
    }
  }
  return nodes;
}

// The SAN lines a plan would add, rebuilt from its parent references.
function addedLines(plan, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pathOf = (move) => {
    const prefix = move.parentId
      ? (byId.get(move.parentId).id === "root" ? "" : byId.get(move.parentId).id.slice(2))
      : pathOf(plan.moves[move.parentIndex]);
    return prefix ? `${prefix} ${move.after.move.san}` : move.after.move.san;
  };
  return plan.moves.map(pathOf);
}

describe("planPgnMerge", () => {
  it("adds only moves the tree lacks, parents before children, variations included", () => {
    const nodes = tree(["e4 e5 Nf3"]);
    const plan = planPgnMerge(nodes, "1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 3. Bb5 *");
    expect(plan.ok).toBe(true);
    expect(plan.anchor.id).toBe("root");
    expect(addedLines(plan, nodes)).toEqual(["e4 e5 Nf3 Nc6", "e4 e5 Nf3 Nc6 Bb5", "e4 c5", "e4 c5 Nf3"]);
    expect(plan.existing).toBe(3);
    expect(plan.skipped).toBe(0);
    // Each planned move carries the local board result the outbox node is built from.
    expect(plan.moves[0]).toMatchObject({ parentId: "n:e4 e5 Nf3", parentIndex: null, uci: "b8c6" });
    expect(plan.moves[1]).toMatchObject({ parentId: null, parentIndex: 0, uci: "f1b5" });
    expect(plan.moves[1].after.board.fen).toContain(" b KQkq ");
  });

  it("reports nothing new when the whole PGN is already there", () => {
    const nodes = tree(["e4 e5 Nf3", "e4 c5"]);
    const plan = planPgnMerge(nodes, "1. e4 e5 (1... c5) 2. Nf3 *");
    expect(plan).toMatchObject({ ok: true, moves: [], existing: 4, skipped: 0 });
    expect(pgnMergeSummary(plan)).toBe("Everything in this PGN is already in the repertoire");
  });

  it("adds a line the PGN repeats in two variations once", () => {
    const nodes = tree([]);
    const plan = planPgnMerge(nodes, "1. d4 (1. d4 d5) d5 2. c4 *");
    expect(addedLines(plan, nodes)).toEqual(["d4", "d4 d5", "d4 d5 c4"]);
  });

  it("matches castling written king-to-rook in the tree", () => {
    const nodes = tree(["e4 e5 Nf3 Nc6 Bc4 Bc5"]);
    nodes.push({ id: "castle", parent_id: "n:e4 e5 Nf3 Nc6 Bc4 Bc5", depth: 7, fen: "x", uci: "e1h1", san: "O-O" });
    const plan = planPgnMerge(nodes, "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O *");
    expect(plan).toMatchObject({ ok: true, moves: [], existing: 7 });
  });

  it("anchors on the shallowest node in the PGN's start position when it is not the root", () => {
    const nodes = tree(["e4 e5 Nf3 Nc6", "Nf3 Nc6 e4 e5"]);
    const chess = new Chess();
    for (const san of ["e4", "e5", "Nf3", "Nc6"]) chess.move(san);
    // Same position as both 2...Nc6 nodes, different move counters.
    const fen = chess.fen().replace(/ \d+ \d+$/, " 0 9");
    const plan = planPgnMerge(nodes, `[FEN "${fen}"]\n\n9. Bb5 a6 *`);
    expect(plan.ok).toBe(true);
    expect(["n:e4 e5 Nf3 Nc6", "n:Nf3 Nc6 e4 e5"]).toContain(plan.anchor.id);
    expect(plan.moves.map((m) => m.uci)).toEqual(["f1b5", "a7a6"]);
    // The new node follows the tree's move counters, not the PGN's.
    expect(plan.moves[0].after.board.fen.endsWith(" 3")).toBe(true);
  });

  it("adds nothing when no position matches the PGN's start", () => {
    const nodes = tree(["e4 e5"]);
    const plan = planPgnMerge(nodes, '[FEN "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2"]\n\n2. c4 *');
    expect(plan).toEqual({ ok: false, error: "This PGN starts from a position that isn't in the repertoire" });
  });

  it("passes parse errors and empty games through as errors", () => {
    expect(planPgnMerge(tree([]), "1. e4 e4 *")).toMatchObject({ ok: false });
    expect(planPgnMerge(tree([]), "[Event \"x\"]\n\n*")).toEqual({ ok: false, error: "This PGN has no moves" });
    expect(planPgnMerge(tree([]), '[Event "a"]\n1. e4 *\n\n[Event "b"]\n1. d4 *').error).toContain("Multiple games");
  });

  it("skips new moves more than the depth limit below the last saved node", () => {
    const nodes = tree(["e4 e5"]);
    const pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O) 4. Ba4 *";
    const plan = planPgnMerge(nodes, pgn, { maxDepth: 3 });
    // Nf3 Nc6 Bb5 (3 new) fit; a6 / Ba4 and Nf6 / O-O are the 4th and 5th in a row.
    expect(addedLines(plan, nodes)).toEqual(["e4 e5 Nf3", "e4 e5 Nf3 Nc6", "e4 e5 Nf3 Nc6 Bb5"]);
    expect(plan.skipped).toBe(4);
    expect(pgnMergeSummary(plan)).toBe("Added 3 moves from PGN (2 already in the repertoire) · 4 moves skipped: more than 64 new moves in a row");
  });

  it("counts moves still waiting in the outbox toward the depth limit", () => {
    const nodes = tree(["e4 e5 Nf3"], { idOf: (path) => (path === "e4" ? `n:${path}` : `tmp-t-${path}`) });
    const plan = planPgnMerge(nodes, "1. e4 e5 2. Nf3 Nc6 3. Bb5 *", { maxDepth: 3 });
    // e5 and Nf3 are unsaved, so only Nc6 fits under the limit of 3.
    expect(plan.moves.map((m) => m.uci)).toEqual(["b8c6"]);
    expect(plan.skipped).toBe(1);
  });

  it("refuses a PGN that would add more moves than one import allows", () => {
    const plan = planPgnMerge(tree([]), "1. e4 e5 2. Nf3 Nc6 *", { maxMoves: 3 });
    expect(plan).toEqual({ ok: false, error: "This PGN would add more than 3 moves. Split it and add it in parts." });
    expect(planPgnMerge(tree([]), "1. e4 e5 2. Nf3 *", { maxMoves: 3 }).ok).toBe(true);
  });
});

describe("applyPgnMergePlan", () => {
  it("queues the plan on the Build outbox, each move under its planned parent", async () => {
    const { applyPgnMergePlan } = await import("./controllers/build-pgn-merge-dialog.js");
    const { buildState } = await import("./core/state.js");
    const nodes = tree(["e4"]);
    Object.assign(buildState, {
      build: { repertoire_id: "r1", color: "white", nodes: nodes.slice() },
      buildNodeById: new Map(nodes.map((n) => [n.id, n])),
      buildPending: [],
    });
    const plan = planPgnMerge(buildState.build.nodes, "1. e4 e5 (1... c5) 2. Nf3 *");
    const added = applyPgnMergePlan(plan);
    expect(added.map((n) => n.san)).toEqual(["e5", "Nf3", "c5"]);
    expect(buildState.buildPending.map((m) => [m.uci, m.parentRef])).toEqual([
      ["e7e5", "n:e4"], ["g1f3", added[0].id], ["c7c5", "n:e4"],
    ]);
    expect(added.every((n) => n.id.startsWith("tmp-") && buildState.buildNodeById.get(n.id) === n)).toBe(true);
    // The first move under a parent is its mainline, as when moves are played.
    expect(added.map((n) => n.is_mainline)).toEqual([true, true, false]);
    expect(buildState.buildPending.every((m) => m.repertoire_id === "r1")).toBe(true);
  });
});
