import { describe, expect, it } from "vitest";
import { atlasAnalysis, atlasProfile, indexTree, positionThumbnail, routeGlyph, subtreeNodes } from "./build-atlas.js";
import { html } from "../html.js";

const nodes = [
  { id: "root", parent_id: null },
  { id: "e4", parent_id: "root", is_mainline: true },
  { id: "d4", parent_id: "root" },
  { id: "e5", parent_id: "e4", is_mainline: true },
  { id: "c5", parent_id: "e4" },
  { id: "nf3", parent_id: "e5", is_mainline: true },
];

describe("Repertoire atlas", () => {
  it("profiles tree structure without inventing training evidence", () => {
    const tree = [{ id: "r", parent_id: null }, ...Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`, parent_id: i ? `p${i - 1}` : "r", ply: i + 1, move_side: i % 2 ? "black" : "white",
    }))];
    const untrained = atlasProfile(atlasAnalysis(tree, "black"), "black");
    expect(Number(untrained.index)).toBeGreaterThan(0);
    tree.forEach((n) => { n.mastery = "mastered"; });
    expect(atlasProfile(atlasAnalysis(tree, "black"), "black")).toEqual(untrained);
    expect(atlasProfile(atlasAnalysis([], "black"), "black").index).toBeNull();
    const shallow = atlasProfile(atlasAnalysis(tree.slice(0, 3), "black"), "black");
    expect(Number(untrained.index)).toBeGreaterThan(Number(shallow.index));
    expect(untrained.scores.every((n) => Number.isFinite(n) && n >= 0 && n <= 100)).toBe(true);
    const disabled = [...tree, { id: "off", parent_id: "r", is_enabled: false, ply: 500 }];
    expect(atlasProfile(atlasAnalysis(disabled, "black"), "black")).toEqual(untrained);
  });

  it("scores own enabled moves and excludes descendants of a disabled branch", () => {
    const tree = [
      { id: "r", parent_id: null },
      { id: "a", parent_id: "r", move_side: "white", mastery: "mastered", ply: 1 },
      { id: "b", parent_id: "a", move_side: "black", mastery: "weak", ply: 2 },
      { id: "c", parent_id: "b", move_side: "white", mastery: "due", ply: 3 },
      { id: "d", parent_id: "r", is_enabled: false, ply: 1 },
      { id: "e", parent_id: "d", move_side: "white", mastery: "weak", ply: 2 },
    ];
    const result = atlasAnalysis(tree, "white");
    expect(result.score).toBe(50);
    expect(result.trainable).toBe(2);
    expect(result.review).toBe(1);
    expect(result.deepest).toBe(2);
    expect(result.leaves.map((n) => n.id)).toEqual(["c"]);
    expect([...result.depths.values()].reduce((a, b) => a + b, 0)).toBe(result.leaves.length);
  });

  it("distinguishes untrained from a trained score of zero, including empty trees", () => {
    expect(atlasAnalysis([], "white").score).toBeNull();
    const tree = [{ id: "r", parent_id: null }, { id: "a", parent_id: "r", move_side: "white", ply: 1 }];
    expect(atlasAnalysis(tree, "white").score).toBeNull();
    tree[1].mastery = "learning";
    expect(atlasAnalysis(tree, "white").score).toBe(0);
  });
  it("focus keeps the selected branch and all its continuations, excluding siblings", () => {
    const branch = subtreeNodes(nodes[1], indexTree(nodes));
    expect(branch.map((n) => n.id)).toEqual(["e4", "e5", "nf3", "c5"]);
    expect(branch.some((n) => n.id === "d4")).toBe(false);
  });

  it("draws only actual edges and changes its highlighted route with the selection", () => {
    const first = String(routeGlyph(nodes, "root", "nf3"));
    expect((first.match(/C/g) || []).length).toBe(nodes.length - 1);
    expect(String(routeGlyph(nodes, "root", "c5"))).not.toBe(first);
    const family = String(routeGlyph(subtreeNodes(nodes[1], indexTree(nodes)), "e4", "nf3"));
    expect((family.match(/C/g) || []).length).toBe(3);
    expect(first).not.toMatch(/NaN|undefined/);
    expect(String(routeGlyph([nodes[0]], "root", "root"))).not.toMatch(/NaN|undefined/);
  });

  it("uses the real piece renderer and reverses both axes for Black", () => {
    const renderers = { parseFenBoard: () => ({ a8: "r", h1: "R" }), pieceSvg: (piece) => html`<b>${piece}</b>` };
    const white = String(positionThumbnail("position", "white", renderers));
    const black = String(positionThumbnail("position", "black", renderers));
    expect(white.match(/<span/g)).toHaveLength(64);
    expect(black.match(/<span/g)).toHaveLength(64);
    expect(white.indexOf("<b>r</b>")).toBeLessThan(white.indexOf("<b>R</b>"));
    expect(black.indexOf("<b>R</b>")).toBeLessThan(black.indexOf("<b>r</b>"));
  });
});
