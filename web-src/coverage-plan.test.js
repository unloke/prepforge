import { describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { prepareCoverageReply } from "./coverage-plan.js";

function fixture(existing = false) {
  const c = new Chess();
  const nodes = [{ id: "root", depth: 0, parent_id: null, fen: c.fen() }];
  c.move("e4"); nodes.push({ id: "e4", depth: 1, parent_id: "root", fen: c.fen(), uci: "e2e4", is_prepared: true });
  const gap = { nodeId: "e4", fen: c.fen(), moveUci: "e7e5", moveSan: "e5", prob: 0.8 };
  if (existing) { c.move("e5"); nodes.push({ id: "e5", depth: 2, parent_id: "e4", fen: c.fen(), uci: "e7e5", is_enabled: true }); }
  return { build: { repertoire_id: "rep", color: "white", revision: 1, nodes }, gap };
}
const generate = vi.fn(async ({ rootNodeId }) => ({ rootNodeId, changes: [
  { action: "planned_add", tempId: "tmp-1", parentRef: rootNodeId, moveUci: "g1f3", source: "generated_stockfish", intendedMainline: true },
  { action: "planned_add", tempId: "tmp-2", parentRef: "tmp-1", moveUci: "b8c6", source: "generated_stockfish", intendedMainline: true },
  { action: "planned_add", tempId: "tmp-3", parentRef: "tmp-2", moveUci: "f1c4", source: "generated_stockfish", intendedMainline: true },
] }));

describe("atomic Coverage preview plan", () => {
  it("uses a virtual anchor without editing the live repertoire", async () => {
    const f = fixture();
    const before = JSON.stringify(f.build);
    const result = await prepareCoverageReply({ ...f, generate, rating: 1700, depth: 12 });
    expect(JSON.stringify(f.build)).toBe(before);
    expect(result.plan.rootNodeId).toBe("e4");
    expect(result.plan.changes[0]).toMatchObject({ parentRef: "e4", moveUci: "e7e5", tempId: "tmp-coverage-opponent" });
    expect(result.plan.changes[1].parentRef).toBe("tmp-coverage-opponent");
    expect(result.line).toBe("1... e5 2. Nf3 Nc6 3. Bc4");
    expect(result.addedMoves).toBe(4);
  });
  it("shows sibling replies as variations, not one sequence", async () => {
    const f = fixture();
    const branching = async ({ rootNodeId }) => ({ rootNodeId, changes: [
      { action: "planned_add", tempId: "tmp-1", parentRef: rootNodeId, moveUci: "g1f3" },
      { action: "planned_add", tempId: "tmp-2", parentRef: "tmp-1", moveUci: "b8c6" },
      { action: "planned_add", tempId: "tmp-3", parentRef: "tmp-1", moveUci: "g8f6" },
      { action: "planned_add", tempId: "tmp-4", parentRef: "tmp-2", moveUci: "f1b5" },
      { action: "planned_add", tempId: "tmp-5", parentRef: "tmp-3", moveUci: "f3e5" },
    ] });
    const result = await prepareCoverageReply({ ...f, gap: { ...f.gap, pathSans: ["e4"] }, generate: branching });
    expect(result.line).toBe("1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5) 3. Bb5");
  });
  it("does not duplicate an existing opponent branch", async () => {
    const f = fixture(true);
    const result = await prepareCoverageReply({ ...f, generate });
    expect(result.plan.changes).toHaveLength(3);
    expect(result.plan.changes[0].parentRef).toBe("e5");
  });
  it("does not silently resurrect disabled branches", async () => {
    const f = fixture(true); f.build.nodes[2].is_enabled = false;
    await expect(prepareCoverageReply({ ...f, generate })).rejects.toThrow(/disabled/);
  });
  it("fails before persistence on stale, illegal or empty generated replies", async () => {
    const f = fixture();
    await expect(prepareCoverageReply({ ...f, gap: { ...f.gap, fen: "stale" }, generate })).rejects.toThrow(/changed/);
    await expect(prepareCoverageReply({ ...f, gap: { ...f.gap, moveUci: "e2e4" }, generate })).rejects.toThrow();
    await expect(prepareCoverageReply({ ...f, generate: async () => ({ changes: [] }) })).rejects.toThrow(/No prepared reply/);
  });
  it("does not offer an aborted plan for saving", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(prepareCoverageReply({ ...f, generate, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
