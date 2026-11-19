import { expect, it } from "vitest";
import { getBuildTree, invalidateBuildTree, summarizeBuild } from "./build-tree.js";

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
