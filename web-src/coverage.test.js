import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { buildWalk, coverageTreeKey, runCoverageScan } from "./coverage.js";

function tree(lines) {
  const start = new Chess();
  const nodes = [{ id: "root", depth: 0, parent_id: null, fen: start.fen(), is_enabled: true }];
  for (const line of lines) {
    const chess = new Chess();
    let parent = nodes[0];
    for (const san of line) {
      const own = chess.turn() === "w";
      const move = chess.move(san);
      const uci = move.from + move.to + (move.promotion || "");
      let node = nodes.find((n) => n.parent_id === parent.id && n.uci === uci);
      if (!node) {
        node = { id: `n${nodes.length}`, parent_id: parent.id, depth: parent.depth + 1,
          uci, san, fen: chess.fen(), is_prepared: own, is_enabled: true,
          is_mainline: !nodes.some((n) => n.parent_id === parent.id) };
        nodes.push(node);
      }
      parent = node;
    }
  }
  return nodes;
}
const provider = (predictions) => ({ predictions: async ({ fen }) => predictions(new Chess(fen)) });
const scan = (nodes, options = {}) => runCoverageScan({ nodes, myColor: "white", rating: 1700,
  maxDepth: 3, provider: provider(() => [{ move_uci: "e7e5", probability: 0.75 },
    { move_uci: "e7e6", probability: 0.25 }]), ...options });
function mass(result) {
  expect(result.coveredMass + result.gapMass + result.unknownMass).toBeCloseTo(1, 10);
}

describe("coverage walk and snapshot identity", () => {
  it("indexes enabled nodes and leaves disabled descendants unreachable", () => {
    const nodes = tree([["e4", "e5", "Nf3"]]);
    nodes[1].is_enabled = false;
    const walk = buildWalk(nodes);
    expect(walk.byId.has(nodes[1].id)).toBe(false);
    expect(walk.byId.has(nodes[2].id)).toBe(true);
    expect(walk.children.get("root")).toBeUndefined();
  });
  it("includes optimistic changes and preparation flags, excludes mastery and annotations", () => {
    const nodes = tree([["e4"]]);
    const key = coverageTreeKey(nodes);
    expect(coverageTreeKey(nodes.map((n) => ({ ...n, mastery: "due", arrows: ["a1a2"] })))).toBe(key);
    expect(coverageTreeKey([...nodes, ...tree([["d4"]]).slice(1)])).not.toBe(key);
    expect(coverageTreeKey(nodes.map((n) => ({ ...n, is_prepared: false })))).not.toBe(key);
  });
});

describe("first-gap coverage", () => {
  it("only credits a branch with an enabled prepared own answer", async () => {
    const result = await scan(tree([["e4", "e5", "Nf3"]]));
    expect(result.coverage).toBe(0.75);
    expect(result.gapMass).toBe(0.25);
    expect(result.gaps[0]).toMatchObject({ moveSan: "e6", kind: "missing_branch", pathSans: ["e4"] });
    expect(result.status).toBe("complete");
    mass(result);
  });
  it("detects a stored opponent move without an own reply", async () => {
    const result = await scan(tree([["e4", "e5"]]));
    expect(result.coverage).toBe(0);
    expect(result.gaps.find((g) => g.moveSan === "e5").kind).toBe("missing_reply");
    expect(result.gapMass).toBe(1);
    mass(result);
  });
  it("scans opponent leaves instead of declaring no holes", async () => {
    const result = await scan(tree([["e4"]]));
    expect(result.scannedNodes).toBe(1);
    expect(result.totalGapCount).toBe(2);
    expect(result.coverage).toBe(0);
    mass(result);
  });
  it("does not silently turn a missing own policy into coverage", async () => {
    const result = await scan(tree([]));
    expect(result.scannedNodes).toBe(0);
    expect(result.unknownMass).toBe(1);
    expect(result.stopReasons).toContain("no-own-policy");
  });
  it("treats unprepared or disabled own replies as missing", async () => {
    for (const patch of [{ is_prepared: false }, { is_enabled: false }]) {
      const nodes = tree([["e4", "e5", "Nf3"]]);
      Object.assign(nodes[3], patch);
      const result = await scan(nodes);
      expect(result.coverage).toBe(0);
      expect(result.gaps.some((g) => g.kind === "missing_reply")).toBe(true);
    }
  });
  it("rejects illegal stored replies and legal moves paired with the wrong position", async () => {
    for (const patch of [{ uci: "e2e5" }, { fen: new Chess().fen() }]) {
      const nodes = tree([["e4", "e5", "Nf3"]]);
      Object.assign(nodes[3], patch);
      await expect(scan(nodes)).rejects.toThrow(/illegal move|position disagree/);
    }
    const nodes = tree([["e4", "e5", "Nf3"]]);
    nodes[2].fen = new Chess().fen();
    await expect(scan(nodes)).rejects.toThrow(/position disagree/);
  });

  it("follows one own policy, never sums mutually exclusive openings", async () => {
    let calls = 0;
    const result = await scan(tree([["e4", "e5", "Nf3"], ["d4", "d5", "c4"]]), {
      provider: provider((chess) => { calls++; expect(chess.get("e4")?.type).toBe("p");
        return [{ move_uci: "e7e5", probability: 1 }]; }),
    });
    expect(calls).toBe(1);
    expect(result.coverage).toBe(1);
    mass(result);
  });
  it("multiplies reach over decisions instead of averaging local coverage", async () => {
    const nodes = tree([["e4", "e5", "Nf3", "Nc6", "Bc4"]]);
    const result = await scan(nodes, { maxDepth: 5,
      provider: provider((c) => c.get("f3") ? [{ move_uci: "b8c6", probability: 0.8 },
        { move_uci: "g8f6", probability: 0.2 }] : [{ move_uci: "e7e5", probability: 0.8 },
        { move_uci: "e7e6", probability: 0.2 }]) });
    expect(result.coverage).toBeCloseTo(0.64);
    expect(result.gapMass).toBeCloseTo(0.36);
    mass(result);
  });
  it("retains small gaps and counts gaps omitted by display limit", async () => {
    const nodes = tree([["e4"]]);
    const result = await scan(nodes, { maxGaps: 1,
      provider: provider(() => [{ move_uci: "e7e5", probability: 0.95 }, { move_uci: "e7e6", probability: 0.05 }]) });
    expect(result.totalGapCount).toBe(2);
    expect(result.omittedGapCount).toBe(1);
    expect(result.gapMass).toBe(1);
    mass(result);
  });
  it("keeps incomplete model probability mass unknown", async () => {
    const result = await scan(tree([["e4", "e5", "Nf3"]]), {
      provider: provider(() => [{ move_uci: "e7e5", probability: 0.6 }]),
    });
    expect(result.coverage).toBe(0.6);
    expect(result.unknownMass).toBe(0.4);
    expect(result.stopReasons).toContain("model-mass");
    mass(result);
  });
  it("reports node and reach pruning as unknown", async () => {
    const nodes = tree([["e4", "e5", "Nf3", "Nc6", "Bc4"]]);
    for (const opts of [{ maxNodes: 1 }, { minReach: 0.9 }]) {
      const result = await scan(nodes, { maxDepth: 5, ...opts });
      expect(result.coverage).toBe(0);
      expect(result.unknownMass).toBe(0.75);
      expect(result.status).toBe("partial");
      mass(result);
    }
  });
  it("uses relative depth for a reachable branch scope", async () => {
    const nodes = tree([["e4", "e5", "Nf3", "Nc6", "Bc4"]]);
    const result = await scan(nodes, { rootNodeId: nodes[3].id, maxDepth: 2,
      provider: provider(() => [{ move_uci: "b8c6", probability: 1 }]) });
    expect(result.coverage).toBe(1);
    expect(result.rootNodeId).toBe(nodes[3].id);
    nodes[1].is_enabled = false;
    await expect(scan(nodes, { rootNodeId: nodes[3].id })).rejects.toThrow(/disabled/);
  });
  it("credits a terminal position without model inference", async () => {
    const nodes = tree([["f3", "e5", "g4", "Qh4#"]]);
    const result = await scan(nodes, { rootNodeId: nodes[4].id,
      provider: { predictions: () => { throw new Error("should not run"); } } });
    expect(result.coverage).toBe(1);
    expect(result.scannedNodes).toBe(0);
  });
  it("rejects illegal, duplicate, nonfinite and overfull distributions", async () => {
    for (const predictions of [
      [{ move_uci: "e2e4", probability: 1 }],
      [{ move_uci: "e7e5", probability: NaN }],
      [{ move_uci: "e7e5", probability: -0.1 }],
      [{ move_uci: "e7e5", probability: 0.6 }, { move_uci: "e7e6", probability: 0.6 }],
      [{ move_uci: "e7e5", probability: 0.3 }, { move_uci: "e7e5", probability: 0.3 }],
    ]) await expect(scan(tree([["e4"]]), { provider: provider(() => predictions) })).rejects.toThrow(/probabilit/);
  });
  it("cancels immediately even when shared inference has not answered", async () => {
    const controller = new AbortController();
    const result = scan(tree([["e4"]]), { signal: controller.signal,
      provider: { predictions: () => new Promise(() => {}) } });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
