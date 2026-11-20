import { expect, it } from "vitest";
import { getBuildTree, indexBuildNodes, invalidateBuildTree, summarizeBuild } from "./build-tree.js";

it("indexes the original nodes and shares only empty lists and equal strings", () => {
  const root = { id: "root", fen: "root-fen", fen_after: "root-fen", arrows: [], circles: [], tags: [] };
  const tags = ["study"];
  const child = { id: "child", parent_id: "root", fen: "child-fen", fen_before: "root-fen", tags, arrows: [] };
  const custom = { id: "custom", parent_id: "child", fen: "custom-fen", fen_before: "other-fen", fen_after: "also-other-fen" };
  const nodes = [root, child, custom];
  const original = structuredClone(nodes);
  const byId = indexBuildNodes(nodes);
  expect(nodes).toEqual(original);
  expect(byId.get("root")).toBe(root);
  expect(byId.get("child")).toBe(child);
  expect(child.arrows).toBe(root.arrows);
  expect(root.circles).toBe(root.tags);
  expect(Object.isFrozen(root.tags)).toBe(true);
  expect(child.tags).toBe(tags);
  child.arrows = [{ from: "e2", to: "e4" }];
  expect(root.arrows).toEqual([]);
});

it("keeps move metadata, optional fields, and annotations intact while indexing repeated strings", () => {
  const original = [
    { id: "root", depth: 0, san: null, uci: null },
    { id: "a", parent_id: "root", san: "e4", uci: "e2e4", source: "manual",
      move_side: "white", side_to_move: "black", mastery: "untrained", comment: "註解" },
    { id: "b", parent_id: "a", san: "e5", uci: "e7e5", source: "imported_pgn",
      move_side: "black", side_to_move: "white", mastery: null, circles: ["e5"] },
    { id: "c", parent_id: "b", san: "e4", uci: "e2e4", source: "manual",
      move_side: "white", side_to_move: "black", mastery: "untrained" },
    ...Array.from({ length: 1024 }, (_, i) => ({
      id: `extra-${i}`, parent_id: "c", san: "c6", uci: "c7c6", source: "manual",
      move_side: "black", side_to_move: "white", mastery: null,
    })),
  ].map((node) => ({
    ...node,
    fen: `fen-${node.id}`,
    fen_before: node.parent_id ? `fen-${node.parent_id}` : null,
    fen_after: `fen-${node.id}`,
  }));
  const nodes = JSON.parse(JSON.stringify(original));
  const indexed = indexBuildNodes(nodes);
  expect(nodes).toStrictEqual(original);
  expect(indexed.size).toBe(nodes.length);
  expect(indexed.get("c")).toBe(nodes[3]);
  nodes[1].mastery = "learning";
  expect(nodes[3].mastery).toBe("untrained");
});

it("reuses the ordered child index until the loaded tree changes", () => {
  const root = { id: "root", parent_id: null, depth: 0 };
  const a = { id: "a", parent_id: root.id };
  const b = { id: "b", parent_id: root.id, is_mainline: true };
  const build = { nodes: [root, a, b], revision: 1 };
  const initial = getBuildTree(build);
  expect(initial.root).toBe(root);
  expect(initial.children.get(root.id)).toEqual([b, a]);
  expect(getBuildTree(build)).toBe(initial);

  const c = { id: "c", parent_id: a.id };
  build.nodes.push(c);
  expect(getBuildTree(build).children.get(a.id)).toEqual([c]);
  c.parent_id = b.id;
  invalidateBuildTree(build);
  expect(getBuildTree(build).children.get(b.id)).toEqual([c]);

  build.nodes = [root, a, { ...b, is_mainline: false }, c];
  expect(getBuildTree(build).children.get(root.id).map(({ id }) => id)).toEqual(["a", "b"]);
});

it("counts a deep tree without recursing through its ancestors", () => {
  const nodes = Array.from({ length: 20_001 }, (_, depth) => ({
    id: String(depth), depth, parent_id: depth ? String(depth - 1) : null,
    move_side: depth % 2 === 0 ? "black" : "white",
  })).reverse();
  expect(summarizeBuild({ nodes, color: "white" })).toEqual({ moves: 20_000, lines: 1, train: 10_000 });
  nodes.at(-5).is_enabled = false;
  expect(summarizeBuild({ nodes, color: "white" })).toEqual({ moves: 20_000, lines: 1, train: 2 });
});
