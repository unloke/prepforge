// Copy line PGN builds the same text the server's line export did, from the
// tree this tab holds, so an unsaved move copies too and nothing is requested.
import { describe, expect, it } from "vitest";
import { linePath, linePgn } from "./build-line-pgn.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function tree(rootFen = START, color = "white") {
  const nodes = [
    { id: "root", parent_id: null, fen: rootFen, san: "root" },
    { id: "e4", parent_id: "root", san: "e4", move_number: 1, move_side: "white" },
    { id: "e5", parent_id: "e4", san: "e5", move_number: 1, move_side: "black" },
    { id: "tmp-9", parent_id: "e5", san: "Nf3", move_number: 2, move_side: "white", is_enabled: false },
  ];
  return { build: { name: 'My "KP"', color, nodes }, byId: new Map(nodes.map((node) => [node.id, node])) };
}

describe("linePgn", () => {
  it("matches the server's line export, unsaved moves included", () => {
    const { build, byId } = tree();
    expect(linePgn(build, byId, "tmp-9")).toBe([
      '[Event "My \\"KP\\""]',
      '[Site "PrepForge Chess"]',
      '[White "Repertoire"]',
      '[Black "?"]',
      '[Result "*"]',
      "",
      "1. e4 e5 2. Nf3 *",
    ].join("\n"));
  });

  it("starts a line from a set-up position with its FEN and a black move number", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const { build, byId } = tree(fen, "black");
    byId.set("c5", { id: "c5", parent_id: "root", san: "c5", move_number: 1, move_side: "black" });
    const text = linePgn(build, byId, "c5");
    expect(text).toContain('[White "?"]\n[Black "Repertoire"]');
    expect(text).toContain(`[SetUp "1"]\n[FEN "${fen}"]`);
    expect(text.endsWith("1... c5 *")).toBe(true);
  });

  it("gives the root an empty line and an unknown node nothing", () => {
    const { build, byId } = tree();
    expect(linePgn(build, byId, "root").endsWith("\n\n*")).toBe(true);
    expect(linePgn(build, byId, "gone")).toBeNull();
    byId.delete("e4");
    expect(linePath(byId, "e5")).toBeNull();
  });
});
