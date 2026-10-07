import { describe, expect, it } from "vitest";
import { buildArrowHeadPath, buildArrowPath, endsUnder } from "./board-arrows.js";
import { appSource } from "./test-app-source.js";

const source = appSource();

// A minimal SVG DOM: enough for renderAnnotations to build its paths and groups.
function fakeNode(tag) {
  return {
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(_) { this.children = []; },
  };
}
function render(...args) {
  const start = source.indexOf("function renderAnnotations(");
  const end = source.indexOf("\nfunction squareCenter(", start);
  const sqStart = end + 1;
  const sqEnd = source.indexOf("\n}\n", sqStart) + 3;
  const document = { createElementNS: (_ns, tag) => fakeNode(tag) };
  const fn = new Function("document", "buildArrowPath", "buildArrowHeadPath", "endsUnder", "files",
    `${source.slice(start, end)}\n${source.slice(sqStart, sqEnd)}\nreturn renderAnnotations;`,
  )(document, buildArrowPath, buildArrowHeadPath, endsUnder, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  const overlay = fakeNode("svg");
  fn(overlay, ...args);
  // Flatten to paint order: [class, inGroup].
  const out = [];
  for (const c of overlay.children) {
    if (c.tag === "g") c.children.forEach((p) => out.push(`${c.attrs.class} > ${p.attrs.class}`));
    else out.push(c.attrs.class);
  }
  return out;
}

describe("board annotation layering", () => {
  it("paints idle fork options first, grouped, then the pick, better move, user, engine", () => {
    const order = render(["a2a4"], "white", "e2e4", ["g1f3", "b1c3", "d2d4"], "d2d4", "c2c4");
    expect(order).toEqual([
      "annot-branches > annot-arrow annot-branch",
      "annot-branches > annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-better",
      "annot-arrow annot-user",
      "annot-arrow annot-engine",
    ]);
  });

  it("outlines a fork option on top of the user arrow drawn on the same move", () => {
    expect(render(["g1f3", "a2a4"], "white", null, ["g1f3", "b1c3"], null)).toEqual([
      "annot-branches > annot-arrow annot-branch",
      "annot-branches > annot-arrow annot-branch",
      "annot-arrow annot-user",
      "annot-arrow annot-user",
      "annot-arrow annot-branch is-echo",
    ]);
  });

  it("merges the engine's move into the fork option it matches instead of stacking two arrows", () => {
    expect(render([], "white", "g1f3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-branches > annot-arrow annot-branch",
      "annot-arrow annot-branch is-engine is-pick",
    ]);
    expect(render([], "white", "b1c3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch is-engine",
    ]);
  });
  it("redraws the head of a move that ends under a longer arrow from the same square", () => {
    // 6. Bd3 (idle) and 6. Bc4 (picked, the engine's move): one diagonal from f1.
    expect(render([], "white", "f1c4", ["f1c4", "f1d3"], "f1c4")).toEqual([
      "annot-branches > annot-arrow annot-branch",
      "annot-arrow annot-branch is-engine is-pick",
      "annot-arrow annot-branch annot-stop is-idle",
    ]);
    // The shorter arrow drawn last needs nothing extra.
    expect(render([], "white", null, ["f1c4", "f1d3"], "f1d3")).toEqual([
      "annot-branches > annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
    ]);
  });
});

describe("arrow scale", () => {
  it("thins the arrow but keeps its tip", () => {
    const from = { x: 56.25, y: 81.25 };
    const to = { x: 56.25, y: 56.25 };
    const pts = (d) => d.replace(/ Z$/, "").split(" ").map((c) => c.slice(1).split(",").map(Number));
    const full = pts(buildArrowPath(from, to));
    const slim = pts(buildArrowPath(from, to, { scale: 0.78 }));
    expect(slim[3]).toEqual(full[3]);
    const width = (p) => Math.abs(p[0][0] - p[6][0]);
    expect(width(slim)).toBeLessThan(width(full));
  });
});
