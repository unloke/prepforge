import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atlasAnalysis, atlasScoreText, positionThumbnail, routeGlyph, subtreeNodes } from "./build-atlas.js";
import { indexTree } from "../build-tree.js";
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
  it("keeps the Atlas control beside the repertoire title", () => {
    const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const buildView = readFileSync(new URL("./build.js", import.meta.url), "utf8");
    const view = shell.slice(shell.indexOf('id="view-build"'));
    const buildHead = view.slice(view.indexOf('id="build-rep-header"'), view.indexOf('<div class="panel-body"'));
    expect(buildHead).toContain('id="build-atlas"');
    expect(buildHead).toMatch(/id="build-rep-name"[^>]*>[^<]*<\/h1>\s*<button[^>]*id="build-atlas"/);
    expect(buildHead.indexOf('id="build-atlas"')).toBeLessThan(buildHead.indexOf('id="build-menu"'));
    expect(buildView).toContain('const atlasButton = document.getElementById("build-atlas")');
    expect(buildView).toContain('atlasButton.innerHTML = glyph');
    expect(buildView).toContain('atlasButton.hidden = !glyph');
    expect(buildView).not.toContain('<button type="button" class="rep-route-mark"');
  });

  it("keeps unknown documentation distinct from a measured zero", () => {
    expect(atlasScoreText(null)).toBe("—");
    expect(atlasScoreText({ score: 0 })).toBe("0");
    expect(atlasScoreText({ score: 84.6 })).toBe("85");
    expect(atlasScoreText({ score: null })).toBe("—");
  });

  it("scores own enabled moves and excludes descendants of a disabled branch", () => {
    const tree = [
      { id: "r", parent_id: null },
      { id: "a", parent_id: "r", move_side: "white", ply: 1 },
      { id: "b", parent_id: "a", move_side: "black", ply: 2 },
      { id: "c", parent_id: "b", move_side: "white", ply: 3 },
      { id: "d", parent_id: "r", is_enabled: false, ply: 1 },
      { id: "e", parent_id: "d", move_side: "white", ply: 2 },
    ];
    const mastery = new Map([["a", "mastered"], ["b", "weak"], ["c", "due"], ["e", "weak"]]);
    const result = atlasAnalysis(tree, "white", (id) => mastery.get(id));
    expect(result.score).toBe(50);
    expect(result.trainable).toBe(2);
    expect(result.review).toBe(1);
    expect(result.deepest).toBe(2);
    expect(result.leaves.map((n) => n.id)).toEqual(["c"]);
    expect([...result.depths.values()].reduce((a, b) => a + b, 0)).toBe(result.leaves.length);
  });

  it("distinguishes untrained from a trained score of zero, including empty trees", () => {
    const mastery = new Map();
    const stateOf = (id) => mastery.get(id);
    expect(atlasAnalysis([], "white", stateOf).score).toBeNull();
    const tree = [{ id: "r", parent_id: null }, { id: "a", parent_id: "r", move_side: "white", ply: 1 }];
    expect(atlasAnalysis(tree, "white", stateOf).score).toBeNull();
    mastery.set("a", "learning");
    expect(atlasAnalysis(tree, "white", stateOf).score).toBe(0);
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
    const rootOnly = String(routeGlyph([nodes[0]], "root", "root"));
    expect(rootOnly).not.toMatch(/NaN|undefined/);
    expect(rootOnly).toContain('class="route-dots route-active"');
    expect(rootOnly).toMatch(/<svg class="route-glyph"/);
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

  it("caps routeGlyph SVG edges on large trees above 300 nodes while keeping active path", () => {
    const big = [{ id: "root", parent_id: null }];
    for (let i = 1; i <= 10; i += 1) {
      big.push({ id: `m${i}`, parent_id: i === 1 ? "root" : `m${i - 1}`, is_mainline: true });
    }
    for (let b = 0; b < 20; b += 1) {
      let parent = "m1";
      for (let k = 0; k < 20; k += 1) {
        const id = `b${b}_${k}`;
        big.push({ id, parent_id: parent });
        parent = id;
      }
    }
    const svg = String(routeGlyph(big, "root", "m10"));
    expect(svg).not.toMatch(/NaN|undefined/);
    expect((svg.match(/C/g) || []).length).toBeLessThanOrEqual(310);
  });
});
