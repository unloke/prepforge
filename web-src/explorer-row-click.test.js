// Behavioural tests for the Build Explorer rows.
//
// A row click ADDS the move to the repertoire (or navigates to it when it is
// already there). Both handlers are module-private in app.js, so this executes
// the REAL function source (extracted from app.js, not retyped here) with its
// dependencies injected. If a refactor drops the add path's single-flight
// guard, or a click stops adding, these fail.
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { localBoardAfterMove, localBoardInfo } from "./chess-local.js";
import { appSource } from "./test-app-source.js";

const root = dirname(fileURLToPath(import.meta.url));
const app = appSource();

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
function makeAdd({ appState, onBuildBoardMove, boards = {} }) {
  const factory = new Function(
    "onBuildBoardMove",
    "sameFenPosition",
    "appState",
    "boards",
    `${extractByMarker(ADD_START)}\nreturn onExplorerRowAdd;`,
  );
  return factory(onBuildBoardMove, sameFenPosition, appState, boards);
}

// Compiles the real click handler with injected dependencies.
function makeClick({ appState, existing = null }) {
  const deps = {
    onExplorerRowAdd: vi.fn(async () => {}),
    selectBuildNode: vi.fn(async () => {}),
    buildChildForUci: vi.fn(() => existing),
  };
  const factory = new Function(
    "sameFenPosition",
    "appState",
    "boards",
    "onExplorerRowAdd",
    "selectBuildNode",
    "buildChildForUci",
    `${extractByMarker(CLICK_START)}\nreturn onExplorerRowClick;`,
  );
  const click = factory(
    sameFenPosition,
    appState,
    {},
    deps.onExplorerRowAdd,
    deps.selectBuildNode,
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

describe("Explorer row click adds the move", () => {
  it("adds a move that is not in the repertoire", async () => {
    const appState = makeAppState(START_FEN);
    const rows = makeRows(START_FEN);
    const { click, onExplorerRowAdd, selectBuildNode } = makeClick({ appState });
    await click(rows, "e7e5");
    expect(onExplorerRowAdd).toHaveBeenCalledTimes(1);
    expect(onExplorerRowAdd).toHaveBeenCalledWith(rows, "e7e5");
    expect(selectBuildNode).not.toHaveBeenCalled();
  });

  it("navigates to a move that is already in the repertoire", async () => {
    const appState = makeAppState(START_FEN);
    const { click, onExplorerRowAdd, selectBuildNode } = makeClick({
      appState,
      existing: { id: "child" },
    });
    await click(makeRows(START_FEN), "e7e5");
    expect(selectBuildNode).toHaveBeenCalledWith("child");
    expect(onExplorerRowAdd).not.toHaveBeenCalled();
  });

  it("ignores rows that belong to another position", async () => {
    const appState = makeAppState(CHILD_FEN);
    const { click, onExplorerRowAdd, selectBuildNode } = makeClick({ appState });
    await click(makeRows(START_FEN), "e7e5");
    expect(onExplorerRowAdd).not.toHaveBeenCalled();
    expect(selectBuildNode).not.toHaveBeenCalled();
  });
});

describe("Explorer row add is single-flight (rapid double-click)", () => {
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
});

describe("Explorer rows markup", () => {
  it("makes the whole row the add action, with no preview strip or separate + button", () => {
    const render = extractByMarker("function renderExplorerRows(stats, fen) {");
    expect(render).toContain("data-explorer-pick");
    expect(render).toContain("Add ${m.san} to repertoire");
    expect(render).not.toContain("data-explorer-add");
    expect(render).not.toContain("Preview");
    expect(render).toContain("onExplorerRowClick(rows, uci)");
    expect(app).not.toContain("buildPreview");
  });
});

describe("Explorer add / mutation integration", () => {
  function makeAddHarness(fen, uci) {
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
    const normalizeUci = (u) => ({ e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" })[u] || u;
    const deps = {
      appState, boards: { build: board }, boardAfterMove: async (f, u) => localBoardAfterMove(f, u),
      normalizeUci, localBoardInfo, setStatus: status,
      isBuildReadOnly: () => false, optimisticBoardMove: async () => false, selectBuildNode,
      setBuildSync: vi.fn(), scheduleBuildFlush: vi.fn(),
      buildProvisionalNode: (p, u, after) => ({ id: "new", parent_id: p.id, uci: u, fen: after.board.fen }),
    };
    const make = new Function(...Object.keys(deps), `
      ${extractByMarker("function canonicalBuildUci(fen, uci) {")}
      ${extractByMarker("async function onBuildBoardMove(moveUci) {")}
      return { add: () => onBuildBoardMove(${JSON.stringify(uci)}) };
    `);
    return { ...make(...Object.values(deps)), appState, board, status, selectBuildNode };
  }

  for (const [side, raw, canonical] of [
    ["w", "e1h1", "e1g1"], ["w", "e1a1", "e1c1"],
    ["b", "e8h8", "e8g8"], ["b", "e8a8", "e8c8"],
  ]) {
    it(`queues ${raw} as canonical castling ${canonical}`, async () => {
      const fen = `r3k2r/8/8/8/8/8/8/R3K2R ${side} KQkq - 0 1`;
      const h = makeAddHarness(fen, raw);
      const expected = localBoardAfterMove(fen, canonical).board.fen;
      await h.add();
      expect(h.status).not.toHaveBeenCalledWith("Illegal move");
      expect(h.appState.buildPending).toHaveLength(1);
      expect(h.appState.buildPending[0]).toMatchObject({ repertoire_id: "rep", uci: canonical });
      expect(h.appState.buildPending[0].node.fen).toBe(expected);
      expect(h.selectBuildNode).toHaveBeenCalledWith("new");
    });
  }
  it("keeps a legal rook move on castling-shaped squares unchanged", async () => {
    const fen = "k7/8/8/8/8/8/8/K3R3 w - - 0 1";
    const h = makeAddHarness(fen, "e1h1");
    await h.add();
    expect(h.appState.buildPending[0].uci).toBe("e1h1");
    expect(h.appState.buildPending[0].node.fen).toBe(localBoardAfterMove(fen, "e1h1").board.fen);
  });
});
