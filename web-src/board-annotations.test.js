import { describe, expect, it } from "vitest";
import {
  CIRCLE_RADIUS,
  buildArrowHeadPath,
  buildArrowPath,
  endsUnder,
  parseArrowToken,
  parseCircleToken,
} from "./board-arrows.js";
import { appSource } from "./test-app-source.js";
import { cssSource } from "./test-styles-source.js";

const source = appSource();
const renderAnnotations = (() => {
  const start = source.indexOf("function renderAnnotations(");
  const end = source.indexOf("export function squareCenter(", start);
  const sqStart = end + "export ".length;
  const sqEnd = source.indexOf("\n}\n", sqStart) + 3;
  const document = { createElementNS: (_ns, tag) => fakeNode(tag) };
  return new Function(
    "document",
    "CIRCLE_RADIUS",
    "buildArrowPath",
    "buildArrowHeadPath",
    "endsUnder",
    "parseArrowToken",
    "parseCircleToken",
    "files",
    `${source.slice(start, end)}\n${source.slice(sqStart, sqEnd)}\nreturn renderAnnotations;`,
  )(
    document,
    CIRCLE_RADIUS,
    buildArrowPath,
    buildArrowHeadPath,
    endsUnder,
    parseArrowToken,
    parseCircleToken,
    ["a", "b", "c", "d", "e", "f", "g", "h"],
  );
})();

function fakeNode(tag) {
  return {
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(_) { this.children = []; },
  };
}
const attrsOf = (node) => node.children.map(({ tag, attrs }) => ({ tag, ...attrs }));
function render(...args) {
  const overlay = fakeNode("svg");
  renderAnnotations(overlay, ...args);
  return attrsOf(overlay);
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
const arrow = (uci, role, orientation = "white", options = {}) => buildArrowPath(
  center(uci.slice(0, 2), orientation), center(uci.slice(2, 4), orientation), role, options,
);
const head = (uci, role, orientation = "white", options = {}) => buildArrowHeadPath(
  center(uci.slice(0, 2), orientation), center(uci.slice(2, 4), orientation), role, options,
);

describe("unified upper-plane board annotations", () => {
  it("renders all marks above the pieces and hides the overlay while peeking", () => {
    const css = cssSource("styles/board.css");
    expect(css).toContain(".annotations.is-peeking");
    expect(css).not.toContain(".fork-arrows");
    expect(css).not.toContain(".square.highlighted");
  });

  it("paints circles first, then unpicked forks (longest first), Multi-PV alts, pick, better, user, top engine", () => {
    const out = render(
      ["Ra2a4"],
      "white",
      "e2e4",
      ["g1f3", "b1c3", "d2d4"],
      "d2d4",
      "c2c4",
      {
        circles: ["Yd5"],
        engineArrows: [
          { uci: "e2e4", scale: 1, rank: 1 },
          { uci: "e2e3", scale: 0.72, rank: 2 },
        ],
      },
    );
    expect(out.map((a) => a.class)).toEqual([
      "annot-circle annot-user brush-y",
      "annot-arrow annot-branch",
      "annot-arrow annot-branch",
      "annot-arrow annot-engine is-alt",
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-better",
      "annot-arrow annot-user brush-r",
      "annot-arrow annot-engine",
      "annot-arrow annot-engine is-alt annot-stop",
    ]);
  });

  it("shares the shaft when your arrow matches a fork option, adding the option's head", () => {
    const out = render(["Bg1f3", "Ga2a4"], "white", null, ["g1f3", "b1c3"], null);
    expect(out.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-user brush-b",
      "annot-arrow annot-user brush-g",
      "annot-arrow annot-branch",
    ]);
    expect(out[1].d).toBe(arrow("g1f3", "user"));
    expect(out[3].d).toBe(head("g1f3", "branch"));
  });

  it("draws the engine's move once in engine ink when it matches a fork option", () => {
    expect(classes([], "white", "g1f3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-engine is-pick",
    ]);
    expect(classes([], "white", "b1c3", ["g1f3", "b1c3"], "g1f3")).toEqual([
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-engine",
    ]);
  });

  it("surfaces a stop head when a shorter collinear arrow is painted before a longer wider arrow", () => {
    const out = render([], "white", "f1c4", [], null, "f1d3");
    expect(out.map((attrs) => attrs.class)).toEqual([
      "annot-arrow annot-better",
      "annot-arrow annot-engine",
      "annot-arrow annot-better annot-stop",
    ]);

    const forkLongPick = render([], "white", null, ["e2e3", "e2e4"], "e2e4");
    expect(forkLongPick.map((a) => a.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
      "annot-arrow annot-branch annot-stop",
    ]);

    // When the shorter branch is picked, it paints AFTER the longer branch, so both heads are already exposed.
    const forkShortPick = render([], "white", null, ["e2e3", "e2e4"], "e2e3");
    expect(forkShortPick.map((a) => a.class)).toEqual([
      "annot-arrow annot-branch",
      "annot-arrow annot-branch is-pick",
    ]);
  });

  it("shortens converging arrows that arrive at the same target square from different origins", () => {
    const out = render(["Gg1f3", "Bd1f3", "Ra2a4"], "white");
    expect(out[0].d).toBe(arrow("g1f3", "user", "white", { shorten: true }));
    expect(out[1].d).toBe(arrow("d1f3", "user", "white", { shorten: true }));
    expect(out[2].d).toBe(arrow("a2a4", "user", "white", { shorten: false }));
  });

  it("renders live right-drag previews and dims same-colour marks pending erase", () => {
    const previewNew = render(["Ge2e4"], "white", null, [], null, null, {
      circles: ["Rd4"],
      draft: { orig: "b1", dest: "c3", brush: "B" },
    });
    expect(previewNew.map((a) => a.class)).toEqual([
      "annot-circle annot-user brush-r",
      "annot-arrow annot-user brush-g",
      "annot-arrow annot-user brush-b is-preview",
    ]);

    const eraseArrow = render(["Ge2e4"], "white", null, [], null, null, {
      draft: { orig: "e2", dest: "e4", brush: "G" },
    });
    expect(eraseArrow.map((a) => a.class)).toEqual([
      "annot-arrow annot-user brush-g is-erasing",
    ]);

    const recolorArrow = render(["Ge2e4"], "white", null, [], null, null, {
      draft: { orig: "e2", dest: "e4", brush: "R" },
    });
    expect(recolorArrow.map((a) => a.class)).toEqual([
      "annot-arrow annot-user brush-g is-erasing",
      "annot-arrow annot-user brush-r is-preview",
    ]);

    const eraseCircle = render([], "white", null, [], null, null, {
      circles: ["Yd4"],
      draft: { orig: "d4", dest: "d4", brush: "Y" },
    });
    expect(eraseCircle.map((a) => a.class)).toEqual([
      "annot-circle annot-user brush-y is-erasing",
    ]);
  });
});

describe("role arrow shape", () => {
  it("gives nearby roles and Multi-PV ranks distinct silhouettes for the same move", () => {
    const user = render(["Gg1f3"], "white")[0].d;
    const engine = render([], "white", "g1f3")[0].d;
    const better = render([], "white", null, [], null, "g1f3")[0].d;
    const branch = render([], "white", null, ["g1f3"])[0].d;
    expect(new Set([user, engine, better, branch]).size).toBe(4);
    const pick = render([], "white", null, ["g1f3"], "g1f3")[0].d;
    expect(pick).not.toBe(branch);
    expect(pick).toBe(arrow("g1f3", "branch is-pick"));

    const mpv = render([], "white", null, [], null, null, {
      engineArrows: [
        { uci: "e2e4", scale: 1, rank: 1 },
        { uci: "d2d4", scale: 0.65, rank: 2 },
      ],
    });
    expect(mpv.map((a) => a.class)).toEqual([
      "annot-arrow annot-engine is-alt",
      "annot-arrow annot-engine",
    ]);
    expect(mpv[0].d).toBe(arrow("d2d4", "engine", "white", { scale: 0.65 }));
    expect(mpv[1].d).toBe(arrow("e2e4", "engine", "white", { scale: 1 }));
  });
});

describe("BoardController right-click live drawing, four-colour brushes and Multi-PV", async () => {
  const { createBoardController } = await import("./board/board-controller.js");

  function makeEl(tag = "div") {
    const classes = new Set();
    return {
      tag, children: [], dataset: {}, style: {}, attributes: {}, handlers: {}, parent: null, tabIndex: -1,
      classList: {
        add: (...n) => n.forEach((x) => classes.add(x)),
        remove: (...n) => n.forEach((x) => classes.delete(x)),
        toggle: (n, on) => (on === undefined ? (classes.has(n) ? classes.delete(n) : classes.add(n)) : (on ? classes.add(n) : classes.delete(n))),
        contains: (n) => classes.has(n),
      },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n)); },
      get className() { return [...classes].join(" "); },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      set innerHTML(_) { this.children = []; },
      insertAdjacentHTML() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      dispatch(type, event = {}) {
        const e = { preventDefault() {}, stopPropagation() {}, button: 0, detail: 1, target: this, ...event };
        (this.handlers[type] || []).forEach((fn) => fn(e));
      },
      contains(node) { return this === node || this.children.some((c) => c.contains?.(node)); },
      closest(sel) { return this.className.split(" ").includes(sel.replace(/^\./, "")) ? this : null; },
      getBoundingClientRect: () => ({ width: 800, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
  }

  function setupBoard() {
    const boardEl = makeEl("div");
    const overlayEl = fakeNode("svg");
    const winHandlers = {};
    let hovered = null;
    globalThis.document = {
      activeElement: null,
      body: makeEl("body"),
      getElementById: (id) => (id === "board" ? boardEl : overlayEl),
      createElement: (tag) => makeEl(tag),
      createElementNS: (_ns, tag) => fakeNode(tag),
      elementFromPoint: () => (hovered ? board.squares.get(hovered) : null),
    };
    globalThis.window = {
      addEventListener: (type, fn) => { (winHandlers[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => { winHandlers[type] = (winHandlers[type] || []).filter((f) => f !== fn); },
      setTimeout: () => 0,
    };
    const BoardController = createBoardController({
      pref: () => false, renderAnnotations, files: ["a", "b", "c", "d", "e", "f", "g", "h"],
      isPromotionMove: () => false, resolveBoardMove: () => {}, legalMoveFor: () => null,
      pieceSvg: () => "", parseFenBoard: () => ({}), playSound: () => {}, moveCue: () => null,
      pieceLabel: () => "", legalTargetsFrom: () => [],
    });
    const annotated = [];
    const board = new BoardController({
      boardId: "board", overlayId: "overlay", onMove: () => {},
      onAnnotate: (arrows, circles) => annotated.push({ arrows, circles }),
    });
    return { board, boardEl, overlayEl, winHandlers, annotated, hoverAt: (sq) => { hovered = sq; } };
  }

  it("tracks live right-drag preview, commits 4-colour arrows, recolors and toggles erase", () => {
    const { board, boardEl, overlayEl, winHandlers, annotated, hoverAt } = setupBoard();
    hoverAt("e2");
    boardEl.dispatch("pointerdown", { button: 2, target: board.squares.get("e2"), clientX: 10, clientY: 10 });
    expect(board.annotationDraft).toEqual({ orig: "e2", dest: "e2", brush: "G" });
    expect(overlayEl.children.map((c) => c.attrs.class)).toEqual(["annot-circle annot-user brush-g is-preview"]);

    hoverAt("e4");
    winHandlers.pointermove.forEach((fn) => fn({ clientX: 10, clientY: 20, shiftKey: true }));
    expect(board.annotationDraft).toEqual({ orig: "e2", dest: "e4", brush: "R" });
    expect(overlayEl.children.map((c) => c.attrs.class)).toEqual(["annot-arrow annot-user brush-r is-preview"]);

    winHandlers.pointerup.forEach((fn) => fn({ button: 2, clientX: 10, clientY: 20, shiftKey: true }));
    expect(board.annotationDraft).toBeNull();
    expect(board.arrows).toEqual(["Re2e4"]);
    expect(annotated.at(-1)).toEqual({ arrows: ["Re2e4"], circles: [] });

    // Recolor R -> B with Alt+right-drag
    hoverAt("e2");
    boardEl.dispatch("pointerdown", { button: 2, target: board.squares.get("e2"), altKey: true });
    hoverAt("e4");
    winHandlers.pointerup.forEach((fn) => fn({ button: 2, clientX: 10, clientY: 20, altKey: true }));
    expect(board.arrows).toEqual(["Be2e4"]);

    // Erase Be2e4 with same Alt+right-drag
    hoverAt("e2");
    boardEl.dispatch("pointerdown", { button: 2, target: board.squares.get("e2"), altKey: true });
    hoverAt("e4");
    winHandlers.pointerup.forEach((fn) => fn({ button: 2, clientX: 10, clientY: 20, altKey: true }));
    expect(board.arrows).toEqual([]);
  });

  it("aborts a right-drag cleanly when released off the board or cancelled with Escape, and supports Multi-PV", () => {
    const { board, boardEl, winHandlers, annotated, hoverAt } = setupBoard();
    hoverAt("g1");
    boardEl.dispatch("pointerdown", { button: 2, target: board.squares.get("g1") });
    hoverAt(null);
    winHandlers.pointerup.forEach((fn) => fn({ button: 2, clientX: -50, clientY: -50 }));
    expect(board.arrows).toEqual([]);
    expect(annotated).toEqual([]);

    hoverAt("d4");
    boardEl.dispatch("pointerdown", { button: 2, target: board.squares.get("d4"), ctrlKey: true });
    expect(board.annotationDraft?.brush).toBe("Y");
    winHandlers.keydown.forEach((fn) => fn({ key: "Escape", preventDefault() {} }));
    expect(board.annotationDraft).toBeNull();
    expect([...board.highlights]).toEqual([]);

    board.setEngineArrows([
      { uci: "e2e4", scale: 1, rank: 1 },
      { uci: "d2d4", scale: 0.74, rank: 2 },
    ]);
    expect(board.engineArrow).toBe("e2e4");
    expect(board.engineArrows).toHaveLength(2);
    board.setEngineArrow(null);
    expect(board.engineArrow).toBeNull();
    expect(board.engineArrows).toEqual([]);
  });
});
