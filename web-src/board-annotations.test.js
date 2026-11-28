import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildArrowHeadPath, buildArrowPath, endsUnder } from "./board-arrows.js";
import { appSource } from "./test-app-source.js";
import { cssSource } from "./test-styles-source.js";

const source = appSource();
const renderAnnotations = (() => {
  const start = source.indexOf("function renderAnnotations(");
  const end = source.indexOf("export function squareCenter(", start);
  const sqStart = end + "export ".length;
  const sqEnd = source.indexOf("\n}\n", sqStart) + 3;
  const document = { createElementNS: (_ns, tag) => fakeNode(tag) };
  return new Function("document", "buildArrowPath", "buildArrowHeadPath", "endsUnder", "files",
    `${source.slice(start, end)}\n${source.slice(sqStart, sqEnd)}\nreturn renderAnnotations;`,
  )(document, buildArrowPath, buildArrowHeadPath, endsUnder, ["a", "b", "c", "d", "e", "f", "g", "h"]);
})();

// A minimal SVG DOM: enough for renderAnnotations to build its paths.
function fakeNode(tag) {
  return {
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(_) { this.children = []; },
  };
}
const attrsOf = (node, layer) => node.children.map(({ tag, attrs }) => ({ tag, layer, ...attrs }));
function render(...args) {
  const overlay = fakeNode("svg");
  renderAnnotations(overlay, ...args);
  return attrsOf(overlay, "upper");
}
function renderFork(...args) {
  const overlay = fakeNode("svg");
  const fork = fakeNode("svg");
  const full = [...args];
  while (full.length < 6) full.push(null);
  renderAnnotations(overlay, ...full, fork);
  return { upper: attrsOf(overlay, "upper"), fork: attrsOf(fork, "fork") };
}
const classes = (...args) => render(...args).map((attrs) => attrs.class);
function center(square, orientation = "white") {
  const file = "abcdefgh".indexOf(square[0]);
  const rank = Number(square[1]);
  return {
    x: (orientation === "white" ? file : 7 - file) * 12.5 + 6.25,
    y: (orientation === "white" ? 8 - rank : rank - 1) * 12.5 + 6.25,
  };
}
const arrow = (uci, role, orientation = "white") => buildArrowPath(
  center(uci.slice(0, 2), orientation), center(uci.slice(2, 4), orientation), role,
);
const head = (uci, role, orientation = "white") => buildArrowHeadPath(
  center(uci.slice(0, 2), orientation), center(uci.slice(2, 4), orientation), role,
);

describe("board annotation layering", () => {
  it("attaches the fork layer to the board and hides it while peeking", () => {
    const boardController = readFileSync(new URL("./board/board-controller.js", import.meta.url), "utf8");
    const css = cssSource("styles/board.css");
    expect(boardController).toContain('this.board.appendChild(this.forkLayer)');
    expect(css).toContain('.chessboard.is-peeking .fork-arrows');
  });

  it("paints fork options first, then the pick, better move, user, engine without a fork plane", () => {
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
    expect(out[1].d).toBe(arrow("g1f3", "user"));
    expect(out[3].d).toBe(head("g1f3", "branch"));
  });

  it("draws the engine's move once in engine ink when it matches a non-fork option", () => {
    expect(classes([], "white", "g1f3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-engine",
    ]);
    expect(classes([], "white", "b1c3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-engine",
    ]);
  });

  it("keeps the legacy stop head for non-Build overlapping automatic arrows", () => {
    const out = render([], "white", "f1c4", [], null, "f1d3");
    expect(out.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-better",
      "annot-arrow annot-engine",
      "annot-arrow annot-better annot-stop",
    ]);
  });
});

describe("Build fork plane", () => {
  it("draws nested e2e3 and e2e4 as two full arrows, longest first, in either selection", () => {
    const longPick = renderFork([], "white", null, ["e2e3", "e2e4"], "e2e4");
    expect(longPick.upper).toEqual([]);
    expect(longPick.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch",
    ]);
    expect(longPick.fork.map((attrs) => attrs.d)).toEqual([
      arrow("e2e4", "branch is-pick"),
      arrow("e2e3", "branch"),
    ]);
    expect(longPick.fork.every((attrs) => attrs.tag === "path")).toBe(true);

    const shortPick = renderFork([], "white", null, ["e2e3", "e2e4"], "e2e3");
    expect(shortPick.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
    ]);
    expect(shortPick.fork.map((attrs) => attrs.d)).toEqual([
      arrow("e2e4", "branch"),
      arrow("e2e3", "branch is-pick"),
    ]);
    expect(shortPick.fork[1].d).not.toBe(shortPick.fork[0].d);
  });

  it("keeps both nested arrowheads intact after a black-orientation flip", () => {
    const out = renderFork([], "black", null, ["e2e3", "e2e4"], "e2e3");
    expect(out.fork.map((attrs) => attrs.d)).toEqual([
      arrow("e2e4", "branch", "black"),
      arrow("e2e3", "branch is-pick", "black"),
    ]);
    expect(out.fork).toHaveLength(2);
  });

  it("uses one selected engine arrow when engine and pick are the same fork move", () => {
    const out = renderFork([], "white", "e2e4", ["e2e3", "e2e4"], "e2e4");
    expect(out.upper).toEqual([]);
    expect(out.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-engine is-pick",
      "annot-arrow annot-branch",
    ]);
    expect(out.fork[0].d).toBe(arrow("e2e4", "engine"));
    expect(out.fork[1].d).toBe(arrow("e2e3", "branch"));
    expect(out.fork.filter((attrs) => attrs.d === arrow("e2e4", "engine"))).toHaveLength(1);
  });

  it("keeps a distinct collinear engine and shorter selected branch as full arrows", () => {
    const out = renderFork([], "white", "e2e4", ["e2e3", "e2e4"], "e2e3");
    expect(out.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-engine",
      "annot-arrow annot-branch is-pick",
    ]);
    expect(out.fork.map((attrs) => attrs.d)).toEqual([
      arrow("e2e4", "engine"),
      arrow("e2e3", "branch is-pick"),
    ]);
  });

  it("draws three nested repertoire destinations as full paths without redraw stops or circles", () => {
    const out = renderFork([], "white", null, ["a1a2", "a1a3", "a1a4"], "a1a3");
    expect(out.upper).toEqual([]);
    expect(out.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch",
    ]);
    expect(out.fork.map((attrs) => attrs.d)).toEqual([
      arrow("a1a4", "branch"),
      arrow("a1a3", "branch is-pick"),
      arrow("a1a2", "branch"),
    ]);
    expect(out.fork.some((attrs) => attrs.class.includes("annot-stop") || attrs.tag === "circle")).toBe(false);
  });

  it("keeps unrelated engine, better, and manual marks on the upper plane", () => {
    const out = renderFork(["h2h3"], "white", "g1f3", ["e2e3", "e2e4"], "e2e4", "d2d4");
    expect(out.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch",
    ]);
    expect(out.upper.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-better",
      "annot-arrow annot-user",
      "annot-arrow annot-engine",
    ]);
  });

  it("pulls an independent collinear engine onto the fork plane so nested heads remain visible", () => {
    const out = renderFork([], "white", "e2e5", ["e2e3", "e2e4"], "e2e3");
    expect(out.upper).toEqual([]);
    expect(out.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-engine",
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
    ]);
    expect(out.fork.map((attrs) => attrs.d)).toEqual([
      arrow("e2e5", "engine"),
      arrow("e2e4", "branch"),
      arrow("e2e3", "branch is-pick"),
    ]);
  });

  it("keeps independent manual stop heads on the upper plane while fork arrows stay below", () => {
    const out = renderFork(["f1d3", "f1c4"], "white", null, ["e2e3", "e2e4"], "e2e4");
    expect(out.fork.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch",
    ]);
    expect(out.upper.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-user",
      "annot-arrow annot-user",
      "annot-arrow annot-user annot-stop",
    ]);
  });

  it("keeps a manual duplicate shaft upper and conveys the selected automatic role on its head", () => {
    const out = renderFork(["e2e4"], "white", null, ["e2e3", "e2e4"], "e2e4");
    expect(out.fork.map((attrs) => attrs.class)).toEqual(["annot-arrow annot-branch"]);
    expect(out.upper.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-user",
      "annot-arrow annot-branch is-pick",
    ]);
    expect(out.upper[0].d).toBe(arrow("e2e4", "user"));
    expect(out.upper[1].d).toBe(head("e2e4", "branch is-pick"));
  });

  it("clears both planes on repeated redraws and when fork data becomes empty", () => {
    const overlay = fakeNode("svg");
    const fork = fakeNode("svg");
    renderAnnotations(overlay, [], "white", null, ["e2e3", "e2e4"], "e2e4", null, fork);
    expect(fork.children).toHaveLength(2);
    renderAnnotations(overlay, [], "white", null, ["g1f3"], "g1f3", null, fork);
    expect(fork.children).toHaveLength(1);
    expect(overlay.children).toHaveLength(0);
    renderAnnotations(overlay, [], "white", null, [], null, null, fork);
    expect(fork.children).toHaveLength(0);
    expect(overlay.children).toHaveLength(0);
  });
});

describe("role arrow shape", () => {
  it("gives nearby roles different silhouettes for the same move", () => {
    const user = render(["g1f3"], "white")[0].d;
    const engine = render([], "white", "g1f3")[0].d;
    const better = render([], "white", null, [], null, "g1f3")[0].d;
    const branch = render([], "white", null, ["g1f3"])[0].d;
    expect(new Set([user, engine, better, branch]).size).toBe(4);
    const pick = render([], "white", null, ["g1f3"], "g1f3")[0].d;
    expect(pick).not.toBe(branch);
    expect(pick).toBe(arrow("g1f3", "branch is-pick"));
  });
});
