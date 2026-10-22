// A move link selects the node a line ends on when the tree already has it, and
// otherwise leaves the tree alone (the line is walked on the board instead).
import { describe, expect, it } from "vitest";
import { treeNodeForLine } from "./move-links.js";
import { walkLine } from "./move-text.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// A Build-shaped repertoire: 1.e4 e5 2.Nf3, and 1.Nf3 e5 2.e4 (the same position).
function repertoire() {
  const nodes = [{ id: "root", parent_id: null, fen: START }];
  const add = (id, parent, moves) => {
    nodes.push({ id, parent_id: parent, fen: walkLine(START, moves).plies.at(-1).fen });
  };
  add("e4", "root", ["e4"]);
  add("e5", "e4", ["e4", "e5"]);
  add("nf3", "e5", ["e4", "e5", "Nf3"]);
  add("Nf3", "root", ["Nf3"]);
  add("Nf3-e5", "Nf3", ["Nf3", "e5"]);
  add("Nf3-e5-e4", "Nf3-e5", ["Nf3", "e5", "e4"]);
  return {
    nodes,
    fenOf: (n) => n.fen,
    childrenOf: (n) => nodes.filter((c) => c.parent_id === n.id),
    currentId: "root",
  };
}

describe("treeNodeForLine", () => {
  it("follows the line from its start position", () => {
    const tree = repertoire();
    const line = walkLine(START, ["e4", "e5", "Nf3"]);
    expect(treeNodeForLine(line, 3, tree).id).toBe("nf3");
    expect(treeNodeForLine(line, 1, tree).id).toBe("e4");
  });

  it("starts from a node in the middle of the tree", () => {
    const tree = repertoire();
    const base = tree.nodes.find((n) => n.id === "e4").fen;
    expect(treeNodeForLine(walkLine(base, ["e5", "Nf3"]), 2, tree).id).toBe("nf3");
  });

  it("finds a transposition when the path itself is not in the tree", () => {
    const tree = repertoire();
    const add = (id, parent, moves) => tree.nodes.push({ id, parent_id: parent, fen: walkLine(START, moves).plies.at(-1).fen });
    add("Nc3", "root", ["Nc3"]);
    add("Nc3-Nc6", "Nc3", ["Nc3", "Nc6"]);
    add("Nc3-Nc6-Nf3", "Nc3-Nc6", ["Nc3", "Nc6", "Nf3"]);
    // 1.Nf3 Nc6 2.Nc3 is not a path here, but 1.Nc3 Nc6 2.Nf3 reaches its position.
    const node = treeNodeForLine(walkLine(START, ["Nf3", "Nc6", "Nc3"]), 3, tree);
    expect(node.id).toBe("Nc3-Nc6-Nf3");
    const other = treeNodeForLine(walkLine(START, ["d4", "e5", "e4"]), 1, tree);
    expect(other).toBe(null);
  });

  it("returns nothing for a line the tree does not have, or no tree", () => {
    const tree = repertoire();
    expect(treeNodeForLine(walkLine(START, ["d4"]), 1, tree)).toBe(null);
    expect(treeNodeForLine(walkLine(START, ["e4"]), 1, { ...tree, nodes: [] })).toBe(null);
    expect(treeNodeForLine(null, 1, tree)).toBe(null);
  });
});
