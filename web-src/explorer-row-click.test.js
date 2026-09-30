// Behavioural regression for the Explorer rapid-double-click "Illegal move".
//
// `onExplorerRowClick` is module-private in app.js, so this executes the REAL
// function source (extracted from app.js, not retyped here) with its three
// dependencies injected. That keeps this a behaviour test instead of the
// source-text substring assertion it replaces: if a refactor drops the guard,
// this fails.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, "app.js"), "utf8");

// Pull the function body out of app.js verbatim.
const FN_START = "async function onExplorerRowClick(rows, uci) {";
const extractFn = () => extractByMarker(FN_START);

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

// Compiles the real function once with injected dependencies.
function makeClick({ appState, onBuildBoardMove, boards = {} }) {
  const factory = new Function(
    "onBuildBoardMove",
    "sameFenPosition",
    "appState",
    "boards",
    `${extractFn()}\nreturn onExplorerRowClick;`,
  );
  return factory(onBuildBoardMove, sameFenPosition, appState, boards);
}

function makeAppState(fen) {
  const appState = { buildCurrentNodeId: "node", buildNodeById: new Map() };
  appState.buildNodeById.set("node", { fen });
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

describe("Explorer row clicks are single-flight (rapid double-click)", () => {
  it("a second click on the same rows is ignored while the first move is in flight", async () => {
    // The move resolves only when we release the deferred promise, so the
    // second click necessarily lands inside the first click's await.
    let release;
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    const onBuildBoardMove = vi.fn(() => inFlight);
    const click = makeClick({
      appState: makeAppState(START_FEN),
      onBuildBoardMove,
    });

    const rows = makeRows(START_FEN);
    const first = click(rows, "e7e5");

    // Second click: same rows element, still on the same position.
    const second = click(rows, "d7d5");

    expect(onBuildBoardMove).toHaveBeenCalledTimes(1);
    expect(onBuildBoardMove).toHaveBeenCalledWith("e7e5");

    release();
    await Promise.all([first, second]);
    expect(onBuildBoardMove).toHaveBeenCalledTimes(1);
  });

  it("does not restore rows when the move landed on a new position", async () => {
    const onBuildBoardMove = vi.fn(async () => {});
    const click = makeClick({
      appState: makeAppState(CHILD_FEN),
      onBuildBoardMove,
    });

    const rows = makeRows(START_FEN);
    // The board has advanced to the child while rows still carry the parent FEN,
    // so the very first click is already stale and must be a no-op.
    await click(rows, "e7e5");
    expect(onBuildBoardMove).not.toHaveBeenCalled();
    expect(rows.dataset.fen).toBe(START_FEN);
  });

  it("restores rows when the move did not land and the board is still there", async () => {
    const onBuildBoardMove = vi.fn(async () => {
      throw new Error("rejected");
    });
    const click = makeClick({
      appState: makeAppState(START_FEN),
      onBuildBoardMove,
    });

    const rows = makeRows(START_FEN);
    await click(rows, "e7e5").catch(() => {});
    // Cancelled / rejected: rows come back live so the user can retry.
    expect(rows.dataset.fen).toBe(START_FEN);
    expect(rows.classList.contains("is-stale")).toBe(false);
  });
});