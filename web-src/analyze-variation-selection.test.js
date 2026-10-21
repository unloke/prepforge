// Analyze OFF-MAINLINE selection: the selected tree node is the one fact the board,
// the caption, the Coach's context and the engine card all read. Mainline plies and
// variation branches go through the same application path, so a branch jump cannot
// leave one of them describing a different position (the old split had
// `showAnalysisPly` re-check a source token after its board read while
// `selectAnalysisNode`'s variation branch painted unconditionally, and it compared
// plies — which a variation does not have — to decide the board's direction).
//
// The fixture is a legal PGN with a nested variation and two branches that share a
// move number but not a position:
//   1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5 (3... Nf6 4. d3) 4. c3) 3... a6 4. Ba4 Nf6
// so `m5` (3. Bb5), `v1` (3. Bc4) and the nested `v4` (3... Nf6) all sit at move 3.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createAnalysisSelection } from "./controllers/analyze-selection.js";
import { parsePgn } from "./analyze-pgn.js";
import { createAnalyzeView } from "./views/analyze.js";
import { formatWorkspaceHash, parseWorkspaceHash, workspaceLocationFromState } from "./workspace-url.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5 (3... Nf6 4. d3) 4. c3) 3... a6 4. Ba4 Nf6";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

// The real Analyze tree over the fixture PGN, built by the view's own
// adaptParsedTree + buildAnalysisTree, so the test walks the ids the UI renders.
function fixtureTree() {
  const parsed = parsePgn(PGN);
  expect(parsed.ok).toBe(true);
  const appState = { analysisVarNodes: new Map(), analysis: null };
  const view = createAnalyzeView({ appState, START_FEN });
  const { moves, varNodes } = view.adaptParsedTree(parsed.root);
  appState.analysisVarNodes = varNodes;
  appState.analysis = { moves };
  const tree = view.buildAnalysisTree(moves);
  return { moves, varNodes, tree, appState };
}

// Drives the real selection module with recording seams, so a test asserts on the
// same code the session wires up (controllers/analyze-selection.js).
function harness({ boardInfo = async () => ({ legal_moves: [] }) } = {}) {
  const fixture = fixtureTree();
  const appState = {
    analysis: fixture.appState.analysis,
    analysisVarNodes: fixture.varNodes,
    analysisVarCounter: fixture.varNodes.size,
    analysisTree: fixture.tree,
    analysisCurrentNodeId: "root",
    analysisPly: 0,
    analysisBoardFen: START_FEN,
    explainContext: {},
  };
  const board = {
    fen: START_FEN,
    positions: [],
    setPosition: vi.fn(function setPosition(position) { this.fen = position.fen; this.positions.push(position); }),
    setMoveBadge: vi.fn(),
    setBetterArrow: vi.fn(),
  };
  const deps = {
    appState, START_FEN,
    boardInfo: vi.fn(boardInfo),
    boards: { analysis: board },
    boardAfterMove: vi.fn(async (fen, uci) => ({
      board: { fen: `${fen.split(" ")[0]} b`, legal_moves: [] },
      move: { san: uci, uci },
    })),
    highlightCurrentMove: vi.fn(),
    persistAnalysisSession: vi.fn(),
    syncViewHeads: vi.fn(),
    syncWorkspaceUrl: vi.fn(),
    refreshAnalysisExplain: vi.fn(),
    setPositionCaption: vi.fn(),
    engineWidget: { onBoardChanged: vi.fn() },
    syncPgnFromTree: vi.fn(async () => {}),
    setStatusError: vi.fn(),
    analysisVariationLabel: (moveNumber, side, san) =>
      `${moveNumber}${side === "black" ? "..." : "."} ${san} · variation`,
    classBadgeSymbol: () => "",
    ensureAnalyzeView: vi.fn(async () => ({ buildAnalysisTree: () => appState.analysisTree })),
  };
  const api = createAnalysisSelection(deps);
  return { ...api, appState, board, deps, fixture };
}

const NODE_FEN = {
  root: START_FEN,
  m1: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  m3: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
  m4: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  m5: "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
  v1: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
  v3: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R b KQkq - 0 4",
  v5: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b KQkq - 0 4",
};

describe("Analyze selection follows the selected tree node", () => {
  it("puts the same-ply branch's own FEN, caption, Coach context and engine FEN in place", async () => {
    const h = harness();
    await h.selectAnalysisNode("m5");
    expect(h.board.fen).toBe(NODE_FEN.m5);
    expect(h.appState.analysisPly).toBe(5);

    // 3. Bc4 shares move 3 with 3. Bb5 and is a different position.
    await h.selectAnalysisNode("v1");
    expect(h.board.fen).toBe(NODE_FEN.v1);
    expect(h.board.setPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ fen: NODE_FEN.v1, lastMove: h.fixture.tree.byId.get("v1").uci }),
    );
    // The Coach reads the variation's own move and the position it came FROM.
    expect(h.deps.refreshAnalysisExplain).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fen: NODE_FEN.v1,
        prevFen: h.fixture.tree.byId.get("v1").fenBefore,
        lastUci: h.fixture.tree.byId.get("v1").uci,
        lastSan: "Bc4",
        // Not a mainline ply: the coach must not resolve a saved mainline verdict.
        ply: null,
      }),
    );
    expect(h.deps.setPositionCaption).toHaveBeenLastCalledWith("3. Bc4 · variation");
    // The engine card reads appState.analysisBoardFen, so it follows the node.
    expect(h.appState.analysisBoardFen).toBe(NODE_FEN.v1);
    expect(h.deps.engineWidget.onBoardChanged).toHaveBeenCalledTimes(2);
  });

  it("keeps a nested variation's own previous position, not its mainline cousin's", async () => {
    const h = harness();
    // v5 is 4. d3 inside the nested 3... Nf6 line (v4), whose parent chain never
    // touches the mainline 3... a6.
    await h.selectAnalysisNode("v5");
    const node = h.fixture.tree.byId.get("v5");
    expect(h.board.fen).toBe(NODE_FEN.v5);
    expect(h.deps.refreshAnalysisExplain).toHaveBeenLastCalledWith(
      expect.objectContaining({ fen: NODE_FEN.v5, prevFen: node.fenBefore, lastUci: node.uci }),
    );
    expect(h.deps.setPositionCaption).toHaveBeenLastCalledWith("4. d3 · variation");
  });

  it("marks a step from a variation onto its mainline trunk as backwards", async () => {
    // v3's parent chain is v2 -> v1 -> m4. Stepping to m4 (or v1) is a move back,
    // though the ply grows; the old ply comparison called it forward.
    const h = harness();
    await h.selectAnalysisNode("v3");
    await h.selectAnalysisNode("m4");
    expect(h.board.positions.at(-1)).toEqual(expect.objectContaining({ fen: NODE_FEN.m4, back: true }));
    // ...and stepping INTO a branch is not a move back.
    await h.selectAnalysisNode("v1");
    expect(h.board.positions.at(-1)).toEqual(expect.objectContaining({ fen: NODE_FEN.v1, back: false }));
  });

  it("keeps the -1 off-mainline sentinel and the mainline ply contract intact", async () => {
    const h = harness();
    await h.selectAnalysisNode("m3");
    expect(h.appState.analysisPly).toBe(3);
    await h.selectAnalysisNode("v1");
    expect(h.appState.analysisPly).toBe(-1);
    await h.showAnalysisPly(1);
    expect(h.appState.analysisPly).toBe(1);
    expect(h.appState.analysisCurrentNodeId).toBe("m1");
  });

  it("ignores a board read that resolves after the user selected another node", async () => {
    // The stale-continuation fence: a slow read for the variation must not paint
    // over the mainline node the user clicked while it was in flight.
    const slow = deferred();
    const h = harness({
      boardInfo: async (fen) => {
        if (fen === NODE_FEN.v1) return slow.promise;
        return { legal_moves: [] };
      },
    });
    const pendingVariation = h.selectAnalysisNode("v1");
    await vi.waitFor(() => expect(h.deps.boardInfo).toHaveBeenCalledWith(NODE_FEN.v1));
    await h.selectAnalysisNode("m3");
    expect(h.board.fen).toBe(NODE_FEN.m3);
    slow.resolve({ legal_moves: [] });
    await pendingVariation;
    expect(h.board.fen).toBe(NODE_FEN.m3);
    expect(h.appState.analysisBoardFen).toBe(NODE_FEN.m3);
    expect(h.appState.analysisCurrentNodeId).toBe("m3");
    expect(h.deps.setPositionCaption).toHaveBeenLastCalledWith("2. Nf3");
  });

  it("a burst of selection intents settles on the last one, in every direction", async () => {
    const h = harness();
    const burst = ["v1", "m3", "v2", "m4", "v5"];
    await Promise.all(burst.map((id) => h.selectAnalysisNode(id)));
    // Every call bumps the token synchronously, so only the last may paint.
    expect(h.appState.analysisCurrentNodeId).toBe("v5");
    expect(h.board.fen).toBe(NODE_FEN.v5);
    expect(h.appState.analysisBoardFen).toBe(NODE_FEN.v5);
    expect(h.deps.refreshAnalysisExplain).toHaveBeenCalledTimes(1);
    expect(h.deps.refreshAnalysisExplain).toHaveBeenLastCalledWith(expect.objectContaining({ fen: NODE_FEN.v5 }));
  });

  it("steps Prev from the node the user was on, even if a lazy view load lands first", async () => {
    // `analysisTreeNav` used to read the current node AFTER awaiting the view, so a
    // variation click that landed during the await made Prev step from the
    // variation instead of from the move the arrow was pressed on.
    const h = harness();
    await h.selectAnalysisNode("m4");
    const gate = deferred();
    // A view load that resolves only after the click below.
    h.deps.ensureAnalyzeView = () => gate.promise;
    const nav = createAnalysisSelection(h.deps);
    const pending = nav.analysisTreeNav("prev");
    await nav.selectAnalysisNode("v1");
    gate.resolve({ buildAnalysisTree: () => h.fixture.tree });
    await pending;
    // The arrow was pressed on m4, but the later click wins: the selection is v1.
    expect(h.appState.analysisCurrentNodeId).toBe("v1");
    expect(h.board.fen).toBe(NODE_FEN.v1);
  });

  it("steps Prev from the pressed node when nothing supersedes it", async () => {
    const h = harness();
    await h.selectAnalysisNode("m4");
    const gate = deferred();
    h.deps.ensureAnalyzeView = () => gate.promise;
    const nav = createAnalysisSelection(h.deps);
    const pending = nav.analysisTreeNav("prev");
    gate.resolve({ buildAnalysisTree: () => h.fixture.tree });
    await pending;
    expect(h.appState.analysisCurrentNodeId).toBe("m3");
    expect(h.board.fen).toBe(NODE_FEN.m3);
  });

  it("a user branch is created from the selected variation and becomes the selection", async () => {
    const h = harness();
    await h.selectAnalysisNode("v1");
    // The branch's board read must resolve before it can be recorded.
    h.deps.boardAfterMove = vi.fn(async (fen) => ({
      board: { fen: `${fen.split(" ")[0]} b`, legal_moves: [] },
      move: { san: "d5", uci: "d7d5" },
    }));
    const before = h.appState.analysisVarNodes.size;
    await h.onAnalysisBoardMove("d7d5", NODE_FEN.v1);
    expect(h.appState.analysisVarNodes.size).toBe(before + 1);
    const created = [...h.appState.analysisVarNodes.values()].at(-1);
    expect(created.parentId).toBe("v1");
    expect(h.appState.analysisCurrentNodeId).toBe(created.id);
    expect(h.appState.analysisPly).toBe(-1);
    expect(h.deps.refreshAnalysisExplain).toHaveBeenLastCalledWith(
      expect.objectContaining({ fen: created.fenAfter, prevFen: NODE_FEN.v1, ply: null }),
    );
  });

  it("does not record a branch against a position the user has already left", async () => {
    const slow = deferred();
    const h = harness();
    h.deps.boardAfterMove = vi.fn(() => slow.promise);
    await h.selectAnalysisNode("v1");
    const before = h.appState.analysisVarNodes.size;
    const pending = h.onAnalysisBoardMove("d7d5", NODE_FEN.v1);
    await h.selectAnalysisNode("m5");
    slow.resolve({ board: { fen: "somewhere-else", legal_moves: [] }, move: { san: "d5" } });
    await pending;
    expect(h.appState.analysisVarNodes.size).toBe(before);
    expect(h.appState.analysisCurrentNodeId).toBe("m5");
  });
});

describe("Analyze's session identity survives reload and Back/Forward", () => {
  it("saves the selected node, not just the mainline ply", () => {
    const sessionSource = readFileSync(new URL("./controllers/analyze-session.js", import.meta.url), "utf8");
    const start = sessionSource.indexOf("function persistAnalysisSession(");
    const end = sessionSource.indexOf("function resetAnalysisVariations(", start);
    const fn = new Function("appState", "document", "clearReturnState", "saveReturnState", "START_FEN",
      `${sessionSource.slice(start, end)} return persistAnalysisSession;`);
    const saveReturnState = vi.fn();
    const persist = fn(
      { analysis: { moves: [{ ply: 1 }] }, analysisPly: -1, analysisCurrentNodeId: "v3" },
      { getElementById: () => ({ value: PGN }) },
      vi.fn(), saveReturnState, START_FEN,
    );
    persist();
    expect(saveReturnState).toHaveBeenCalledWith("analyze", expect.objectContaining({ node: "v3" }));
  });

  it("carries an off-mainline node in the URL and restores it", () => {
    // A mainline position keeps the plain ?ply= link it has always had.
    expect(formatWorkspaceHash({ view: "analyze", ply: 5 })).toBe("#/analyze?ply=5");
    expect(formatWorkspaceHash({ view: "analyze", node: "v3" })).toBe("#/analyze?node=v3");
    expect(parseWorkspaceHash("#/analyze?node=v3")).toEqual(
      expect.objectContaining({ view: "analyze", node: "v3" }),
    );
    // The state's selected node is what the URL names.
    expect(
      workspaceLocationFromState({ currentView: "analyze", analysisPly: -1, analysisCurrentNodeId: "v3" }).node,
    ).toBe("v3");
    expect(
      workspaceLocationFromState({ currentView: "analyze", analysisPly: 5, analysisCurrentNodeId: "m5" }).node,
    ).toBeNull();
  });
});
