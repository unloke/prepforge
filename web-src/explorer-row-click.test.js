// Behavioural tests for the Build Explorer rows.
//
// A row click PREVIEWS the move (board only, nothing persisted); adding it to
// the repertoire is the explicit "+" (onExplorerRowAdd). Both handlers are
// module-private in app.js, so this executes the REAL function source
// (extracted from app.js, not retyped here) with its dependencies injected.
// If a refactor makes a plain click persist again, or drops the add path's
// single-flight guard, these fail.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { localBoardAfterMove, localBoardInfo } from "./chess-local.js";

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, "app.js"), "utf8");

const CLICK_START = "async function onExplorerRowClick(rows, uci) {";
const ADD_START = "async function onExplorerRowAdd(rows, uci) {";

// The real sameFenPosition, also private to app.js. A bare function declaration
// evaluates to undefined, so the extracted source is returned explicitly.
const SAME_FEN_START = "function sameFenPosition(a, b) {";
const sameFenPosition = new Function(
  "return (" + extractByMarker(SAME_FEN_START) + ");",
)();

function extractByMarker(marker) {
  const start = app.indexOf(marker);
  if (start < 0) throw new Error("marker not found in app.js: " + marker);
  const nl = app.includes("\r\n") ? "\r\n" : "\n";
  const end = app.indexOf(`${nl}}${nl}`, start) + nl.length + 2;
  return app.slice(start, end);
}

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const CHILD_FEN =
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";

// Compiles the real add handler once with injected dependencies.
function makeAdd({
  appState,
  onBuildBoardMove,
  boards = {},
  takeBuildPreview = () => false,
  restoreBuildBoard = vi.fn(async () => {}),
}) {
  const factory = new Function(
    "onBuildBoardMove",
    "sameFenPosition",
    "appState",
    "boards",
    "takeBuildPreview",
    "restoreBuildBoard",
    `${extractByMarker(ADD_START)}\nreturn onExplorerRowAdd;`,
  );
  return factory(
    onBuildBoardMove,
    sameFenPosition,
    appState,
    boards,
    takeBuildPreview,
    restoreBuildBoard,
  );
}

// Compiles the real click (preview) handler with injected dependencies.
function makeClick({ appState, buildPreview = null, existing = null }) {
  const deps = {
    onBuildBoardMove: vi.fn(async () => {}),
    selectBuildNode: vi.fn(async () => {}),
    previewBuildMove: vi.fn(async () => {}),
    exitBuildPreview: vi.fn(async () => {}),
    buildChildForUci: vi.fn(() => existing),
  };
  const factory = new Function(
    "sameFenPosition",
    "appState",
    "boards",
    "buildPreview",
    "onBuildBoardMove",
    "selectBuildNode",
    "previewBuildMove",
    "exitBuildPreview",
    "buildChildForUci",
    `${extractByMarker(CLICK_START)}\nreturn onExplorerRowClick;`,
  );
  const click = factory(
    sameFenPosition,
    appState,
    {},
    buildPreview,
    deps.onBuildBoardMove,
    deps.selectBuildNode,
    deps.previewBuildMove,
    deps.exitBuildPreview,
    deps.buildChildForUci,
  );
  return { click, ...deps };
}

function makeAppState(fen) {
  const appState = { buildCurrentNodeId: "node", buildNodeById: new Map() };
  appState.buildNodeById.set("node", { id: "node", fen });
  return appState;
}
function makeRows(fen) {
  const classes = new Set();
  return {
    dataset: fen === undefined ? {} : { fen },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    get classes() {
      return classes;
    },
  };
}

describe("Explorer row click previews instead of adding", () => {
  it("previews a move that is not in the repertoire and never persists it", async () => {
    const appState = makeAppState(START_FEN);
    const { click, onBuildBoardMove, previewBuildMove, selectBuildNode } = makeClick({ appState });
    await click(makeRows(START_FEN), "e7e5");
    expect(previewBuildMove).toHaveBeenCalledTimes(1);
    expect(previewBuildMove).toHaveBeenCalledWith(appState.buildNodeById.get("node"), "e7e5");
    expect(onBuildBoardMove).not.toHaveBeenCalled();
    expect(selectBuildNode).not.toHaveBeenCalled();
  });

  it("navigates to a move that is already in the repertoire", async () => {
    const appState = makeAppState(START_FEN);
    const { click, onBuildBoardMove, previewBuildMove, selectBuildNode } = makeClick({
      appState,
      existing: { id: "child" },
    });
    await click(makeRows(START_FEN), "e7e5");
    expect(selectBuildNode).toHaveBeenCalledWith("child");
    expect(previewBuildMove).not.toHaveBeenCalled();
    expect(onBuildBoardMove).not.toHaveBeenCalled();
  });

  it("clicking the row being previewed toggles back to the position", async () => {
    const appState = makeAppState(START_FEN);
    const { click, exitBuildPreview, previewBuildMove } = makeClick({
      appState,
      buildPreview: { parentId: "node", uci: "e7e5" },
    });
    await click(makeRows(START_FEN), "e7e5");
    expect(exitBuildPreview).toHaveBeenCalledTimes(1);
    expect(previewBuildMove).not.toHaveBeenCalled();
  });

  it("ignores rows that belong to another position", async () => {
    const appState = makeAppState(CHILD_FEN);
    const { click, previewBuildMove, selectBuildNode } = makeClick({ appState });
    await click(makeRows(START_FEN), "e7e5");
    expect(previewBuildMove).not.toHaveBeenCalled();
    expect(selectBuildNode).not.toHaveBeenCalled();
  });
});

describe("Explorer row add (+) is single-flight (rapid double-click)", () => {
  it("a second click on the same rows is ignored while the first move is in flight", async () => {
    // The move resolves only when we release the deferred promise, so the
    // second click necessarily lands inside the first click's await.
    let release;
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    const onBuildBoardMove = vi.fn(() => inFlight);
    const add = makeAdd({
      appState: makeAppState(START_FEN),
      onBuildBoardMove,
    });

    const rows = makeRows(START_FEN);
    const first = add(rows, "e7e5");

    // Second click: same rows element, still on the same position.
    const second = add(rows, "d7d5");

    expect(onBuildBoardMove).toHaveBeenCalledTimes(1);
    expect(onBuildBoardMove).toHaveBeenCalledWith("e7e5");

    release();
    await Promise.all([first, second]);
    expect(onBuildBoardMove).toHaveBeenCalledTimes(1);
  });

  it("does not restore rows when the move landed on a new position", async () => {
    const onBuildBoardMove = vi.fn(async () => {});
    const add = makeAdd({
      appState: makeAppState(CHILD_FEN),
      onBuildBoardMove,
    });

    const rows = makeRows(START_FEN);
    // The board has advanced to the child while rows still carry the parent FEN,
    // so the very first click is already stale and must be a no-op.
    await add(rows, "e7e5");
    expect(onBuildBoardMove).not.toHaveBeenCalled();
    expect(rows.dataset.fen).toBe(START_FEN);
  });

  it("restores rows when the move did not land and the board is still there", async () => {
    const onBuildBoardMove = vi.fn(async () => {
      throw new Error("rejected");
    });
    const add = makeAdd({
      appState: makeAppState(START_FEN),
      onBuildBoardMove,
    });

    const rows = makeRows(START_FEN);
    await add(rows, "e7e5").catch(() => {});
    // Cancelled / rejected: rows come back live so the user can retry.
    expect(rows.dataset.fen).toBe(START_FEN);
    expect(rows.classList.contains("is-stale")).toBe(false);
  });

  it("ends a preview before adding, and puts the board back if the add did not land", async () => {
    const order = [];
    const onBuildBoardMove = vi.fn(async () => {
      order.push("add");
    });
    const restoreBuildBoard = vi.fn(async () => {});
    const add = makeAdd({
      appState: makeAppState(START_FEN),
      onBuildBoardMove,
      takeBuildPreview: () => {
        order.push("take");
        return true;
      },
      restoreBuildBoard,
    });
    await add(makeRows(START_FEN), "e7e5");
    expect(order).toEqual(["take", "add"]);
    // Still on the parent (nothing landed): the preview board is replaced.
    expect(restoreBuildBoard).toHaveBeenCalledWith("node");
  });
});

describe("Explorer rows markup", () => {
  it("renders a separate, labelled add button instead of a whole-row add", () => {
    const render = extractByMarker("function renderExplorerRows(stats, fen) {");
    expect(render).toContain('aria-label="Add ${escapeHtml(m.san)} to repertoire"');
    expect(render).toContain("data-explorer-add");
    expect(render).toContain("data-explorer-pick");
    expect(render).not.toContain('title="Add ${escapeHtml(m.san)} to the repertoire">');
    expect(render).toContain("onExplorerRowAdd(rows, uci)");
    expect(render).toContain("onExplorerRowClick(rows, uci)");
  });
});

describe("Explorer preview / engine / mutation integration", () => {
  function makePreviewHarness(fen, uci) {
    const parent = { id: "parent", fen, depth: 0 };
    const appState = {
      build: { repertoire_id: "rep", nodes: [parent] }, buildCurrentNodeId: parent.id,
      buildNodeById: new Map([[parent.id, parent]]), buildPending: [], buildUndoCommitByMove: new Map(),
    };
    const board = {
      fen, legalMoves: [], setPosition(next) { Object.assign(this, next); },
      setAnnotations() {}, setBranchArrows() {},
    };
    const selectBuildNode = vi.fn(async (id) => { appState.buildCurrentNodeId = id; });
    const status = vi.fn();
    const widget = { onBoardChanged: vi.fn() };
    const normalizeUci = (u) => ({ e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" })[u] || u;
    const currentStart = app.indexOf("  currentFen() {");
    const currentEnd = app.indexOf("\n  }", currentStart) + 4;
    const getter = app.slice(currentStart, currentEnd).replace("currentFen()", "function currentFen()");
    const deps = {
      appState, boards: { build: board }, boardAfterMove: async (f, u) => localBoardAfterMove(f, u),
      normalizeUci, localBoardInfo, setStatus: status, engineWidget: widget, paintBuildPreview: () => {},
      activeViewName: () => "build", START_FEN: fen, isBuildReadOnly: () => false,
      optimisticBoardMove: async () => false, selectBuildNode, setBuildSync: vi.fn(), scheduleBuildFlush: vi.fn(),
      buildProvisionalNode: (p, u, after) => ({ id: "new", parent_id: p.id, uci: u, fen: after.board.fen }),
    };
    const make = new Function(...Object.keys(deps), `
      let buildPreview = null;
      ${extractByMarker("function buildPreviewActive() {")}
      ${extractByMarker("async function previewBuildMove(parent, uci) {")}
      ${extractByMarker("function canonicalBuildUci(fen, uci) {")}
      ${extractByMarker("async function onBuildBoardMove(moveUci) {")}
      ${getter}
      return { preview: () => previewBuildMove(appState.build.nodes[0], ${JSON.stringify(uci)}),
        currentFen, add: () => onBuildBoardMove(${JSON.stringify(uci)}) };
    `);
    return { ...make(...Object.values(deps)), appState, board, status, selectBuildNode };
  }

  it("the live engine follows the preview while the repertoire stays at its parent", async () => {
    const h = makePreviewHarness(START_FEN, "e7e5");
    await h.preview();
    expect(h.currentFen()).toBe(h.board.fen);
    expect(h.currentFen()).not.toBe(START_FEN);
    expect(h.appState.buildCurrentNodeId).toBe("parent");
    expect(h.appState.build.nodes).toHaveLength(1);
    expect(h.appState.buildPending).toEqual([]);
  });

  for (const [side, raw, canonical] of [
    ["w", "e1h1", "e1g1"], ["w", "e1a1", "e1c1"],
    ["b", "e8h8", "e8g8"], ["b", "e8a8", "e8c8"],
  ]) {
    it(`previews and queues ${raw} as canonical castling ${canonical}`, async () => {
      const fen = `r3k2r/8/8/8/8/8/8/R3K2R ${side} KQkq - 0 1`;
      const h = makePreviewHarness(fen, raw);
      await h.preview();
      const previewFen = h.board.fen;
      await h.add();
      expect(h.status).not.toHaveBeenCalledWith("Illegal move");
      expect(h.appState.buildPending).toHaveLength(1);
      expect(h.appState.buildPending[0]).toMatchObject({ repertoire_id: "rep", uci: canonical });
      expect(h.appState.buildPending[0].node.fen).toBe(previewFen);
      expect(h.selectBuildNode).toHaveBeenCalledWith("new");
    });
  }
  it("keeps a legal rook move on castling-shaped squares unchanged", async () => {
    const h = makePreviewHarness("k7/8/8/8/8/8/8/K3R3 w - - 0 1", "e1h1");
    await h.preview();
    const previewFen = h.board.fen;
    await h.add();
    expect(h.appState.buildPending[0].uci).toBe("e1h1");
    expect(h.appState.buildPending[0].node.fen).toBe(previewFen);
  });
});
