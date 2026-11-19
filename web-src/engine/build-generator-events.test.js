import { expect, it } from "vitest";
import { generateBuildPlan, SOURCE } from "./build-generator.js";

it("streams every change kind in exactly plan order", async () => {
  const events = [];
  const plan = await generateBuildPlan({
    repertoireColor: "white", rootNodeId: "root", plyDepth: 1,
    existingSubtree: { id: "root", fen: "black", children: [
      { id: "old", fen: "white", move_uci: "a7a6", source: SOURCE.GENERATED_MAIA3,
        is_mainline: true, children: [] },
      { id: "best", fen: "white", move_uci: "e7e5", source: SOURCE.GENERATED_MAIA3,
        is_mainline: false, children: [] },
    ] },
    chess: { sideToMove: (fen) => fen, applyUci: () => ({ fenAfter: "white" }) },
    engine: { candidates: async () => [{ moveUci: "e7e5", evaluation: { score_cp: 0 } }] },
    maia: { predictions: async () => [{ move_uci: "c7c5", probability: 0.4 }] },
    onEvent: (event) => { if (event.type === "change") events.push(event.change); },
  });
  expect(events).toEqual(plan.changes);
  expect(events.map((change) => change.action)).toEqual(["updated", "set_mainline", "planned_add"]);
});
