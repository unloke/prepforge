import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { buildExistingSubtreeFromFlatNodes, generateBuildPlan } from "../engine/build-generator.js";
import { estimateBuildGenerateTotal, generateExistingPlies, generateEstimateRange, generateEstimateText } from "./build-generate-estimate.js";

const options = { plyDepth: 3, userToMove: true, mainThreshold: 0.1, branchThreshold: 0.3 };

describe("Generate new-move estimate", () => {
  it("shows zero when the planner reuses the already generated candidate", async () => {
    const game = new Chess();
    const rootFen = game.fen();
    game.move("e4");
    const nodes = [{ id: "root", fen: rootFen },
      { id: "e4", parent_id: "root", uci: "e2e4", fen: game.fen(), source: "generated_stockfish", is_prepared: true }];
    const plan = await generateBuildPlan({
      rootFen, rootNodeId: "root", repertoireColor: "white", plyDepth: 1,
      existingSubtree: buildExistingSubtreeFromFlatNodes(nodes, "root"),
      engine: { candidates: async () => [{ moveUci: "e2e4", evaluation: { score_cp: 30 }, rank: 1 }] },
      maia: { predictions: async () => [] },
      chess: {
        sideToMove: (fen) => new Chess(fen).turn() === "w" ? "white" : "black",
        applyUci: (fen, uci) => {
          const position = new Chess(fen);
          position.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
          return { uci, fenAfter: position.fen() };
        },
      },
    });
    expect(plan.addedCount).toBe(0);
    expect(generateEstimateText({ ...options, plyDepth: 1 }, generateExistingPlies(nodes, "root", 1, "white"))).toBe("0");
  });

  it("counts only descendants of the anchor within the requested horizon", () => {
    const nodes = [
      { id: "root" }, { id: "anchor", parent_id: "root" },
      { id: "child", parent_id: "anchor" }, { id: "grandchild", parent_id: "child" },
      { id: "deep", parent_id: "grandchild" }, { id: "sibling", parent_id: "root" },
    ];
    expect(generateExistingPlies(nodes, "anchor", 2, "white")).toEqual([1, 1]);
    expect(generateExistingPlies([], "anchor", 2, "white")).toEqual([]);
    expect(generateExistingPlies(nodes, "missing", 2, "white")).toEqual([]);
  });

  it("does not discount manual prepared branches the planner skips", () => {
    const nodes = [{ id: "root" },
      { id: "manual", parent_id: "root", source: "manual", is_prepared: true, move_side: "white" },
      { id: "skipped", parent_id: "manual" },
      { id: "generated", parent_id: "root", source: "generated_stockfish", is_prepared: true, move_side: "white" },
      { id: "reply", parent_id: "generated" },
    ];
    expect(generateExistingPlies(nodes, "root", 3, "white")).toEqual([1, 1]);
  });

  it("discounts existing nodes at their own ply, not unrelated depth", () => {
    expect(generateEstimateRange(options, [100]).high).toBeGreaterThan(0);
    expect(generateEstimateRange(options, [1, 3, 3])).toEqual({ low: 0, high: 0 });
    expect(generateEstimateText(options, [1, 3, 3])).toBe("0");
    expect(generateEstimateRange({ ...options, plyDepth: 5 }, [1, 3, 3]).high).toBeGreaterThan(0);
  });

  it("handles opponent anchors and leaves room for missing replies", () => {
    const opponent = { ...options, userToMove: false, plyDepth: 2 };
    expect(generateEstimateRange(opponent, [3, 3])).toEqual({ low: 0, high: 0 });
    expect(generateEstimateRange(opponent, [1, 1]).high).toBeGreaterThan(0);
    expect(generateEstimateRange(opponent).high).toBeGreaterThan(generateEstimateRange(opponent, [1, 1]).high);
  });

  it("keeps the progress ceiling independent of existing nodes", () => {
    expect(estimateBuildGenerateTotal({ ...options, plyDepth: 1 })).toBe(4);
    expect(generateEstimateRange({ ...options, plyDepth: 1 }, [1]).high).toBe(0);
    expect(generateEstimateRange(options).high).toBeGreaterThan(0);
  });
});
