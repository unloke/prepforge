// Analyze session identity, end to end over the real parse/tree/selection code.
//
// Two contracts, both reachable by ordinary use:
//
//  1. The position the user selected must come back after a reload, whatever order
//     the branches were created in. The tree's `v<seq>` ids are a creation counter
//     live but depth-first numbering after a reload, so they are not an identity:
//     creating 1...d6 first and 2...a6 second and selecting the second used to come
//     back as the FIRST branch (or as nothing). Persisted identity is the
//     root-to-node UCI path (analyze-node-path.js), which both trees reproduce.
//
//  2. A multi-game paste analyzes ONE game, and only that game's branches may be
//     re-installed. Parsing the whole textarea glues the other games' movetext onto
//     this one (the parser strips every header block first), so their branches end
//     up hanging off this game's last move. The server names the analyzed game's own
//     PGN (`prepare.pgn`) and that is the only text parsed.
import { describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { appSource } from "./test-app-source.js";
import { parsePgn } from "./analyze-pgn.js";
import { createAnalyzeView } from "./views/analyze.js";
import { createAnalysisSelection } from "./controllers/analyze-selection.js";
import {
  ANALYSIS_ROOT_PATH, analysisNodeIdFromPath, analysisNodePath, isAnalysisNodePath,
} from "./analyze-node-path.js";
import { formatWorkspaceHash, parseWorkspaceHash, workspaceLocationFromState } from "./workspace-url.js";

const source = appSource();
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const BASE = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

// A real Analyze tree over a PGN, built by the view's own adaptParsedTree.
function buildTree(pgn) {
  const parsed = parsePgn(pgn);
  expect(parsed.ok).toBe(true);
  const state = { analysisVarNodes: new Map(), analysis: null };
  const view = createAnalyzeView({ appState: state, START_FEN });
  const { moves, varNodes } = view.adaptParsedTree(parsed.root);
  state.analysis = { moves };
  state.analysisVarNodes = varNodes;
  return { view, moves, varNodes, tree: view.buildAnalysisTree(moves) };
}

function boardAfter(fen, uci) {
  const chess = new Chess(fen);
  const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { board: { fen: chess.fen(), legal_moves: [] }, move: { san: move.san, uci } };
}

// The real selection module over the real tree, with recording seams. The saved
// snapshot is the real rule (serialize the current tree, then store the position's
// path), so a reload test walks the same data a browser would.
function harness({
  pgn = BASE,
  boardInfo = async () => ({ legal_moves: [] }),
  boardAfterMove = async (fen, uci) => boardAfter(fen, uci),
} = {}) {
  const fixture = buildTree(pgn);
  const appState = {
    analysis: fixture.state ? fixture.state.analysis : { moves: fixture.moves },
    analysisVarNodes: fixture.varNodes,
    analysisVarCounter: fixture.varNodes.size,
    analysisTree: fixture.tree,
    analysisCurrentNodeId: "root",
    analysisNodePath: null,
    analysisPly: 0,
    analysisBoardFen: START_FEN,
    explainContext: {},
  };
  const input = { value: pgn };
  const board = {
    fen: START_FEN, positions: [],
    setPosition: vi.fn(function setPosition(position) { this.fen = position.fen; this.positions.push(position); }),
    setMoveBadge: vi.fn(),
  };
  const saves = [];
  let sourceSeq = 1;
  const deps = {
    appState, START_FEN,
    boardInfo: vi.fn(boardInfo),
    boards: { analysis: board },
    boardAfterMove: vi.fn(boardAfterMove),
    highlightCurrentMove: vi.fn(),
    syncViewHeads: vi.fn(), syncWorkspaceUrl: vi.fn(),
    refreshAnalysisExplain: vi.fn(), setPositionCaption: vi.fn(),
    engineWidget: { onBoardChanged: vi.fn() },
    setStatusError: vi.fn(),
    analysisVariationLabel: (moveNumber, side, san) =>
      `${moveNumber}${side === "black" ? "..." : "."} ${san} · variation`,
    classBadgeSymbol: () => "",
    ensureAnalyzeView: vi.fn(async () => fixture.view),
    analysisSourceSeq: () => sourceSeq,
    currentOwnerId: () => "owner",
    ownerGeneration: () => 0,
  };
  let api;
  deps.syncPgnFromTree = vi.fn(async () => {
    input.value = fixture.view.serializeAnalysisPgn(input.value);
    appState.analysisPgnStale = false;
  });
  deps.persistAnalysisSession = vi.fn(async () => {
    await deps.syncPgnFromTree();
    saves.push({ pgn: input.value, node: api.selectedNodePath() });
  });
  api = createAnalysisSelection(deps);
  return {
    ...api, appState, board, deps, fixture, input, saves,
    bumpSource: () => { sourceSeq += 1; },
    syncPgnFromTree: deps.syncPgnFromTree,
  };
}

// The state a reload restores from: the saved PGN re-parsed, then the saved path
// resolved against the fresh tree.
function reload(save) {
  const fresh = buildTree(save.pgn);
  const nodeId = analysisNodeIdFromPath(save.node, fresh.tree);
  return { ...fresh, nodeId, node: nodeId ? fresh.tree.byId.get(nodeId) : null };
}

describe("a user-created branch is the same position after a reload", () => {
  it("creates A at move 1 then B at move 3, switches A/B, and restores B", async () => {
    const h = harness();
    await h.selectAnalysisNode("m1");
    await h.onAnalysisBoardMove("d7d6", h.appState.analysisBoardFen);   // A: 1... d6
    const A = { path: h.selectedNodePath(), fen: h.appState.analysisBoardFen };
    await h.selectAnalysisNode("m3");
    await h.onAnalysisBoardMove("a7a6", h.appState.analysisBoardFen);   // B: 2... a6
    const B = { path: h.selectedNodePath(), fen: h.appState.analysisBoardFen };
    // Ordinary browsing: back to A, then B again (by the ids the tree created).
    const ids = [...h.appState.analysisVarNodes.keys()];
    await h.selectAnalysisNode(ids[0]);
    await h.selectAnalysisNode(ids[1]);

    expect(A.path).toBe("e2e4-d7d6");
    expect(B.path).toBe("e2e4-e7e5-g1f3-a7a6");
    const save = h.saves.at(-1);
    expect(save.node).toBe(B.path);
    // The saved PGN is the CURRENT tree: both branches are in it.
    expect(save.pgn).toContain("(1... d6)");
    expect(save.pgn).toContain("(2... a6)");

    // Reload: the parser numbers these branches depth-first, so the old v2 is now
    // the FIRST branch — the path still lands on B's position.
    const after = reload(save);
    expect(after.varNodes.get("v1").san).toBe("a6");
    expect(after.node).not.toBeNull();
    expect(after.node.fenAfter).toBe(B.fen);
    expect(after.node.fenAfter).not.toBe(A.fen);
    expect(after.nodeId).toBe("v1");
  });

  it("keeps the position through the URL and through Back/Forward", async () => {
    const h = harness();
    await h.selectAnalysisNode("m3");
    await h.onAnalysisBoardMove("a7a6", h.appState.analysisBoardFen);
    const path = h.selectedNodePath();
    const url = formatWorkspaceHash(workspaceLocationFromState({
      currentView: "analyze", analysisPly: -1, analysisNodePath: path,
    }));
    expect(url).toBe(`#/analyze?node=${path}`);
    const loc = parseWorkspaceHash(url);
    expect(loc.node).toBe(path);
    const after = reload(h.saves.at(-1));
    expect(analysisNodeIdFromPath(loc.node, after.tree)).toBe(after.nodeId);

    // A mainline step still names the position by ply alone (unchanged contract):
    // the state carries no path for it, so the URL keeps its old shape.
    await h.selectAnalysisNode("m4");
    expect(h.selectedNodePath()).toBe("e2e4-e7e5-g1f3-b8c6");
    expect(h.appState.analysisNodePath).toBeNull();
    expect(formatWorkspaceHash(workspaceLocationFromState({
      currentView: "analyze", analysisPly: h.appState.analysisPly,
      analysisNodePath: h.appState.analysisNodePath,
    }))).toBe("#/analyze?ply=4");
  });

  it("does not select an unrelated position when the saved branch is gone", async () => {
    // The saved path names a branch this game no longer carries: the restore must
    // decline, not fall back to whatever node holds a similar id.
    const h = harness();
    const fresh = buildTree(BASE);
    const api = createAnalysisSelection({ ...h.deps, appState: { ...h.appState, analysisTree: fresh.tree } });
    await expect(api.selectAnalysisNodePath("e2e4-d7d6")).resolves.toBe(false);
    // A sequence id is not a path at all.
    await expect(api.selectAnalysisNodePath("v2")).resolves.toBe(false);
    expect(isAnalysisNodePath("v2")).toBe(false);
    expect(analysisNodePath("root", fresh.tree)).toBe(ANALYSIS_ROOT_PATH);
  });
});

describe("rebuildAnalysisVariations parses only the analyzed game", () => {
  // Two games whose movetext concatenates LEGALLY, so the whole-textarea parse
  // "succeeds" and silently attaches game 2's branch under game 1's last move.
  const G1 = "[Event \"G1\"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 g6 *";
  const G2 = "[Event \"G2\"]\n\n1. Nf3 (1. d4 d5) d5 2. g3 *";
  const MULTI = `${G1}\n\n${G2}\n`;

  // The real function from the session module.
  const rebuild = new Function("parsePgn", "ensureAnalyzeView", "appState",
    `${source.slice(source.indexOf("async function rebuildAnalysisVariations("),
      source.indexOf("\n}\n", source.indexOf("async function rebuildAnalysisVariations(")) + 2)}
    return rebuildAnalysisVariations;`);

  const viewFor = (appState) => createAnalyzeView({ appState, START_FEN });
  // `text` is what the caller hands the rebuild: the analyzed game's own PGN in
  // production, the whole textarea in the failure this pins.
  const rebuildWith = (appState, text) =>
    rebuild(parsePgn, async () => viewFor(appState), appState)(text);

  it("the whole textarea would glue game 2's branch under game 1's last move", async () => {
    // Proves the failure mode is real (and why the source must be one game).
    const glued = buildTree(MULTI);
    const g1 = buildTree(G1);
    expect(glued.moves.map((m) => m.san)).toEqual(["e4", "e5", "Qh5", "Nc6", "Bc4", "g6", "Nf3", "d5", "g3"]);
    const appState = { analysisVarNodes: new Map(), analysisVarCounter: 0, analysis: { moves: g1.moves },
      analysisTree: null };
    // Force the whole-textarea parse the old code did: this is the failure mode.
    await rebuildWith(appState, MULTI);
    const tree = viewFor(appState).buildAnalysisTree(g1.moves);
    const attached = [...appState.analysisVarNodes.values()]
      .filter((v) => tree.byId.has(v.parentId)).map((v) => `${v.san}@${tree.byId.get(v.parentId).san}`);
    expect(attached).toEqual(["d4@g6", "d5@d4"]);
  });

  it("the analyzed game's own PGN keeps every game's branch with its own mainline", async () => {
    // Game 1 first: its tree is e4 e5 Qh5 Nc6 Bc4 g6 and it has no branches.
    {
      const g1 = buildTree(G1);
      const appState = { analysisVarNodes: new Map(), analysisVarCounter: 0, analysis: { moves: g1.moves },
        analysisTree: null };
      await rebuildWith(appState, G1);
      expect(appState.analysisVarNodes.size).toBe(0);
      const tree = viewFor(appState).buildAnalysisTree(g1.moves);
      expect([...tree.byId.keys()]).toEqual(["root", "m1", "m2", "m3", "m4", "m5", "m6"]);
    }
    // Game 2: its own mainline plus its own two branches, attached where they belong.
    {
      const g2 = buildTree(G2);
      const appState = { analysisVarNodes: new Map(), analysisVarCounter: 0, analysis: { moves: g2.moves },
        analysisTree: null };
      await rebuildWith(appState, G2);
      const tree = viewFor(appState).buildAnalysisTree(g2.moves);
      const parentLabel = (id) => (id === "root" ? "root" : tree.byId.get(id)?.san ?? "DROPPED");
      const attached = [...appState.analysisVarNodes.values()]
        .map((v) => `${v.san}@${parentLabel(v.parentId)}`);
      expect(attached).toEqual(["d4@root", "d5@d4"]);
      expect(g2.moves.map((m) => m.san)).toEqual(["Nf3", "d5", "g3"]);
    }
  });
});

describe("a continuation belongs to the source it was started for", () => {
  // Starting a new source (a recall, a paste, a new run) bumps analysisRecallSeq
  // while the analysis object and the selected node id are still the old ones. A
  // board read already in flight must not paint the old position when it lands.
  it("a board read started before the source changed writes nothing", async () => {
    const slow = deferred();
    const h = harness({ boardInfo: async () => slow.promise });
    const pending = h.selectAnalysisNode("m5");
    await vi.waitFor(() => expect(h.deps.boardInfo).toHaveBeenCalled());
    // Same analysis object, same node id — only the source epoch moves.
    h.bumpSource();
    slow.resolve({ legal_moves: [] });
    await pending;
    expect(h.board.setPosition).not.toHaveBeenCalled();
    expect(h.board.setMoveBadge).not.toHaveBeenCalled();
    expect(h.deps.setPositionCaption).not.toHaveBeenCalled();
    expect(h.deps.refreshAnalysisExplain).not.toHaveBeenCalled();
    expect(h.deps.engineWidget.onBoardChanged).not.toHaveBeenCalled();
    expect(h.deps.persistAnalysisSession).not.toHaveBeenCalled();
  });

  it("a branch whose board read lands after the source changed is not recorded", async () => {
    const slow = deferred();
    const h = harness({ boardAfterMove: () => slow.promise });
    const before = h.appState.analysisVarNodes.size;
    await h.selectAnalysisNode("root");
    // A brand-new move from the root (no existing continuation to step into).
    const pending = h.onAnalysisBoardMove("d2d4", START_FEN);
    await vi.waitFor(() => expect(h.deps.boardAfterMove).toHaveBeenCalled());
    h.bumpSource();
    slow.resolve(boardAfter(START_FEN, "d2d4"));
    await pending;
    expect(h.appState.analysisVarNodes.size).toBe(before);
    // Only the root selection painted; the branch never reached the board.
    expect(h.board.setPosition).toHaveBeenCalledTimes(1);
    expect(h.board.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ lastMove: null }));
  });

  it("navigation stepped from a superseded source does not move the board", async () => {
    const h = harness();
    await h.selectAnalysisNode("m4");
    const gate = deferred();
    h.deps.ensureAnalyzeView = () => gate.promise;
    const nav = createAnalysisSelection(h.deps);
    const pending = nav.analysisTreeNav("next");
    h.bumpSource();
    gate.resolve(h.fixture.view);
    await pending;
    expect(h.appState.analysisCurrentNodeId).toBe("m4");
    expect(h.board.setPosition).toHaveBeenCalledTimes(1);
  });
});

describe("serialization never clobbers a textarea the user is editing", () => {
  // The real syncPgnFromTree from controllers/analyze-entry.js, over a real tree.
  const start = source.indexOf("export async function syncPgnFromTree(");
  const body = source.slice(start, source.indexOf("\n}\n", start) + 2).replace("export ", "");
  function syncHarness({ value, active }) {
    const fixture = buildTree(BASE);
    const input = { value };
    const appState = {
      analysis: { moves: fixture.moves }, analysisVarNodes: fixture.varNodes,
      analysisPgnStale: false,
    };
    const doc = { getElementById: () => input, activeElement: active ? input : null };
    const sync = new Function("appState", "document", "analysisRecallSeq", "ensureAnalyzeView",
      `${body} return syncPgnFromTree;`)(
      appState, doc, 1, async () => fixture.view,
    );
    return { sync, input, appState };
  }

  it("leaves a focused box the user has typed into alone", async () => {
    const typed = "1. d4 d5 2. c4";
    const h = syncHarness({ value: typed, active: true });
    await h.sync();
    expect(h.input.value).toBe(typed);
  });

  it("still writes a new branch into a focused box, so a reload keeps it", async () => {
    // A branch exists only in the tree until the box carries it; the box was not
    // edited since (analysisPgnStale), so this is not the user's keystroke.
    const h = syncHarness({ value: BASE, active: true });
    h.appState.analysisVarNodes.set("v1", {
      id: "v1", seq: 1, parentId: "m1", uci: "d7d6", san: "d6",
      fenBefore: START_FEN, fenAfter: START_FEN, moveNumber: 1, side: "black",
    });
    h.appState.analysisPgnStale = true;
    await h.sync();
    expect(h.input.value).toContain("(1... d6)");
    expect(h.appState.analysisPgnStale).toBe(false);
  });

  it("a user edit clears the branch-write permission immediately", async () => {
    // bindAnalyzePgnInput is the only place that clears it, so the flag cannot
    // survive an edit and later overwrite what the user is typing.
    const inputBinding = source.slice(
      source.indexOf('pgnInput.addEventListener("input",'),
      source.indexOf("\n  });", source.indexOf('pgnInput.addEventListener("input",')) + 6,
    );
    expect(inputBinding).toContain("appState.analysisPgnStale = false");
    expect(inputBinding).toContain("invalidateAnalysisSource()");
    // ...and the bump happens on input, not only in the debounced reload.
    expect(inputBinding.indexOf("invalidateAnalysisSource()"))
      .toBeLessThan(inputBinding.indexOf("setTimeout("));
  });
});

describe("the saved snapshot and the box agree", () => {
  // The real persistAnalysisSession from the session module.
  const start = source.indexOf("async function persistAnalysisSession(");
  const persistBody = source.slice(start, source.indexOf("\n}\n", start) + 2);
  function persistHarness({ active = false, stale = false } = {}) {
    const fixture = buildTree(BASE);
    const input = { value: BASE };
    const saves = [];
    const appState = {
      analysis: { moves: fixture.moves }, analysisVarNodes: fixture.varNodes,
      analysisPly: -1, analysisPgnStale: stale,
    };
    const doc = { getElementById: () => input, activeElement: active ? input : null };
    const persist = new Function("appState", "document", "clearReturnState", "saveReturnState",
      "syncPgnFromTree", "selectedNodePath", "ANALYSIS_ROOT_PATH",
      `${persistBody} return persistAnalysisSession;`)(
      appState, doc, vi.fn(), (view, state) => saves.push(state),
      async () => { input.value = fixture.view.serializeAnalysisPgn(input.value); appState.analysisPgnStale = false; },
      () => "e2e4-d7d6", ANALYSIS_ROOT_PATH,
    );
    return { persist, input, appState, saves };
  }

  it("saves the serialized tree, so a just-created branch survives the reload", async () => {
    const h = persistHarness();
    h.appState.analysisVarNodes.set("v1", {
      id: "v1", seq: 1, parentId: "m1", uci: "d7d6", san: "d6",
      fenBefore: START_FEN, fenAfter: START_FEN, moveNumber: 1, side: "black",
    });
    await h.persist();
    expect(h.saves.at(-1).pgn).toContain("(1... d6)");
    expect(h.saves.at(-1).node).toBe("e2e4-d7d6");
  });

  it("does not save a pair that mixes a focused box's new text with the old tree", async () => {
    const h = persistHarness({ active: true });
    h.input.value = "1. d4 d5 2. c4";
    await h.persist();
    expect(h.saves).toEqual([]);
  });

  it("still saves a branch into a focused box that has no user edit", async () => {
    const h = persistHarness({ active: true, stale: true });
    h.appState.analysisVarNodes.set("v1", {
      id: "v1", seq: 1, parentId: "m1", uci: "d7d6", san: "d6",
      fenBefore: START_FEN, fenAfter: START_FEN, moveNumber: 1, side: "black",
    });
    await h.persist();
    expect(h.saves.at(-1).pgn).toContain("(1... d6)");
  });
});

describe("the saved snapshot is the latest position, never an older one", () => {
  it("a serialization that finishes after the user moved on does not overwrite the newer snapshot", async () => {
    const h = harness();
    // Hold the first serialization open, select another node, then let it finish.
    const gate = deferred();
    let calls = 0;
    h.deps.syncPgnFromTree = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate.promise;
      h.input.value = h.fixture.view.serializeAnalysisPgn(h.input.value);
    });
    await h.selectAnalysisNode("m3");
    const first = h.deps.persistAnalysisSession.mock.results.at(-1);
    await h.selectAnalysisNode("m5");
    gate.resolve();
    await first.value;
    const paths = h.saves.map((s) => s.node);
    // The last write is the position the user is on now.
    expect(paths.at(-1)).toBe("e2e4-e7e5-g1f3-b8c6-f1b5");
    expect(paths).not.toContain("e2e4-e7e5-g1f3");
  });
});
