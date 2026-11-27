import { describe, expect, it } from "vitest";
import { buildArrowHeadPath, buildArrowPath, endsUnder } from "./board-arrows.js";
import { appSource } from "./test-app-source.js";

const source = appSource();

// A minimal SVG DOM: enough for renderAnnotations to build its paths.
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
  const end = source.indexOf("export function squareCenter(", start);
  const sqStart = end + "export ".length;
  const sqEnd = source.indexOf("\n}\n", sqStart) + 3;
  const document = { createElementNS: (_ns, tag) => fakeNode(tag) };
  const fn = new Function("document", "buildArrowPath", "buildArrowHeadPath", "endsUnder", "files",
    `${source.slice(start, end)}\n${source.slice(sqStart, sqEnd)}\nreturn renderAnnotations;`,
  )(document, buildArrowPath, buildArrowHeadPath, endsUnder, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  const overlay = fakeNode("svg");
  fn(overlay, ...args);
  return overlay.children.map(({ attrs }) => attrs);
}
const classes = (...args) => render(...args).map((attrs) => attrs.class);

describe("board annotation layering", () => {
  it("paints fork options first, then the pick, better move, user, engine", () => {
    expect(classes(["a2a4"], "white", "e2e4", ["g1f3", "b1c3", "d2d4"], "d2d4", "c2c4")).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-better",
      "annot-arrow annot-user",
      "annot-arrow annot-engine",
    ]);
  });

  it("shares the shaft when your arrow matches a fork option, adding the option's head", () => {
    const out = render(["g1f3", "a2a4"], "white", null, ["g1f3", "b1c3"], null);
    expect(out.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-user",
      "annot-arrow annot-user",
      "annot-arrow annot-branch",
    ]);
    const center = { x: 6.25 + 6 * 12.5, y: 6.25 + 7 * 12.5 };
    const nf3 = { x: 6.25 + 5 * 12.5, y: 6.25 + 5 * 12.5 };
    expect(out[1].d).toBe(buildArrowPath(center, nf3));
    expect(out[3].d).toBe(buildArrowHeadPath(center, nf3));
  });

  it("draws the engine's move once in engine ink when it matches a fork option", () => {
    expect(classes([], "white", "g1f3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-engine",
    ]);
    expect(classes([], "white", "b1c3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-engine",
    ]);
  });

  it("redraws the head of a move that ends under a longer arrow from the same square", () => {
    // 6. Bd3 (idle) and 6. Bc4 (the engine's move): one diagonal from f1.
    expect(classes([], "white", "f1c4", ["f1c4", "f1d3"], "f1c4")).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-engine",
      "annot-arrow annot-branch annot-stop",
    ]);
    // The shorter arrow drawn after the longer one still gets its stop head.
    const out = render([], "white", null, ["f1c4", "f1d3"], "f1d3");
    expect(out.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch is-pick annot-stop",
    ]);
    const f1 = { x: 6.25 + 5 * 12.5, y: 6.25 + 7 * 12.5 };
    const d3 = { x: 6.25 + 3 * 12.5, y: 6.25 + 5 * 12.5 };
    expect(out[2].d).toBe(buildArrowHeadPath(f1, d3));
  });
});

describe("uniform arrow shape", () => {
  it("renders every role with the same geometry for the same move", () => {
    expect(render([], "white", "g1f3")[0].d).toBe(render(["g1f3"], "white")[0].d);
    const user = render(["g1f3"], "white")[0].d;
    const engine = render([], "white", "g1f3")[0].d;
    const better = render([], "white", null, [], null, "g1f3")[0].d;
    const branch = render([], "white", null, ["g1f3"])[0].d;
    expect(new Set([user, engine, better, branch]).size).toBe(1);
  });
});
