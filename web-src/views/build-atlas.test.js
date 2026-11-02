import { describe, expect, it } from "vitest";
import { indexTree, positionThumbnail, routeGlyph, subtreeNodes } from "./build-atlas.js";
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
