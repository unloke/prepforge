// A multi-game paste stays multi-game only until the user picks a game: from then
// on the box, the move tree and the saved checkpoint must all name the SAME game.
//
// The regression this pins: persistence serializes the current tree into the box,
// and the old serializer kept every `[Tag ...]` line of the source text. In multi
// mode the box still held the whole paste, so after analyzing game 1 the box became
// one header block carrying G1 AND G2's tags over G1's movetext. The import picker
// then re-posted that box with select_index 1 and the real server answered
// "select_index 1 is out of range (1 games)." — which does not match the
// `/games in the PGN/i` recovery, so no Analyze-batch dialog appeared — and a plain
// single-mode Analyze put G1's moves under G2's tags.
//
// Two contracts, both over real code:
//   1. `serializeAnalysisPgn` never merges header blocks (first block only).
//   2. `runAnalysis` makes the box the analyzed game's own PGN, keeps the paste for
//      the picker, and a picker switch posts THAT paste so each pasted game can be
//      analyzed with its own tags and its own moves.
import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { html } from "./html.js";
import { parsePgn } from "./analyze-pgn.js";
import { createAnalyzeView } from "./views/analyze.js";

const source = appSource();
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
function body(marker) {
  const start = source.indexOf(marker);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

const G1 = '[Event "G1"]\n[White "Alice"]\n[Black "Bob"]\n[Result "*"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 g6 *';
const G2 = '[Event "G2"]\n[White "Carol"]\n[Black "Dave"]\n[Result "*"]\n\n1. d4 d5 2. c4 e6 *';
const PASTE = `${G1}\n\n${G2}`;

const sansOf = (pgn) => {
  const parsed = parsePgn(pgn);
  expect(parsed.ok).toBe(true);
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      out.push(child.san);
      walk(child);
    }
  };
  walk(parsed.root);
  return out;
};

// ---- 1. the serializer ------------------------------------------------------

function serializer({ pgn, analysis, varNodes = new Map() }) {
  const appState = { analysis, analysisVarNodes: varNodes };
  const view = createAnalyzeView({ appState, START_FEN });
  return view.serializeAnalysisPgn(pgn);
}

function treeOf(pgn) {
  const appState = { analysisVarNodes: new Map(), analysis: null };
  const view = createAnalyzeView({ appState, START_FEN });
  const parsed = parsePgn(pgn);
  const { moves, varNodes } = view.adaptParsedTree(parsed.root);
  return { view, moves, varNodes };
}

describe("serializeAnalysisPgn keeps one game's header block", () => {
  it("never merges a second pasted game's tags onto this game's movetext", () => {
    const g1 = treeOf(G1);
    const out = serializer({ pgn: PASTE, analysis: { moves: g1.moves }, varNodes: g1.varNodes });
    // Exactly one game: one Event tag, and it is game 1's.
    expect(out.match(/\[Event /g)).toHaveLength(1);
    expect(out).toContain('[Event "G1"]');
    expect(out).not.toContain('[Event "G2"]');
    expect(out).not.toContain('[White "Carol"]');
    // The movetext is game 1's, so its tags are game 1's too.
    expect(sansOf(out)).toEqual(["e4", "e5", "Qh5", "Nc6", "Bc4", "g6"]);
  });

  it("keeps the analyzed game's tags when the box already holds only that game", () => {
    const g2 = treeOf(G2);
    const out = serializer({ pgn: G2, analysis: { moves: g2.moves }, varNodes: g2.varNodes });
    expect(out.match(/\[Event /g)).toHaveLength(1);
    expect(out).toContain('[White "Carol"]');
    expect(sansOf(out)).toEqual(["d4", "d5", "c4", "e6"]);
  });

  it("still writes the tree's branches and a headerless paste stays headerless", () => {
    const headerless = "1. e4 e5 2. Qh5 Nc6 3. Bc4 (3. Nf3 Nf6) g6";
    const g1 = treeOf(headerless);
    const out = serializer({ pgn: headerless, analysis: { moves: g1.moves }, varNodes: g1.varNodes });
    expect(out).not.toContain("[Event");
    expect(out).toContain("(3. Nf3 Nf6)");
  });
});

// ---- 2. the run + the import picker ----------------------------------------

// The real runAnalysis, renderImportPicker, rebuildAnalysisVariations and
// loadPgnIntoAnalyze from the session module, over real parse/tree code. The
// prepare stub behaves like the real server: it splits the POSTED text into games
// (single mode refuses a multi-game paste; multi mode indexes into them and answers
// with that game's own PGN), so a box that no longer matches select_index is a 400
// here exactly as it is in production.
function harness() {
  const viewState = { analysisVarNodes: new Map(), analysis: null };
  const view = createAnalyzeView({ appState: viewState, START_FEN });
  // The view's RENDERERS paint into the real DOM; the parse/tree/serialize code is
  // what this test exercises, so rendering is recorded rather than drawn.
  for (const name of ["renderAnalysisTree", "renderEvalChart", "renderReport", "renderAnalysis", "liveEvalChart"]) {
    view[name] = vi.fn(() => vi.fn());
  }
  const input = { value: "" };
  const pickerHost = { hidden: true, innerHTML: "" };
  const select = { value: "0", listeners: {}, addEventListener: (type, fn) => { select.listeners[type] = fn; } };
  pickerHost.querySelector = (selector) => (selector === "#analysis-import-select" ? select : null);
  const doc = {
    activeElement: null,
    getElementById: (id) => (id === "pgn-input" ? input
      : id === "analysis-import-picker" ? pickerHost
        : id === "run-analysis" ? { disabled: false } : null),
  };
  const appState = {
    analysis: null, analysisVarNodes: new Map(), analysisVarCounter: 0, analysisTree: null,
    analysisCurrentNodeId: "root", analysisNodePath: null, analysisPly: 0,
    analysisBoardFen: START_FEN, analysisSourcePgn: null, analysisMultiPgn: null,
    analysisPgnStale: false, explainContext: {},
  };
  const posts = [];
  const prepared = [];
  // The server, over the POSTED text.
  const server = (posted, mode, selectIndex) => {
    const games = [G1, G2];
    const count = posted.includes('Event "G2"') ? 2 : 1;
    if (mode === "single" && count !== 1) {
      const error = new Error(`Found ${count} games in the PGN — this flow analyzes one game at a time.`);
      error.status = 400;
      throw error;
    }
    if (selectIndex >= count) {
      const error = new Error(`select_index ${selectIndex} is out of range (${count} games).`);
      error.status = 400;
      throw error;
    }
    const pgn = count === 1 ? posted : games[selectIndex];
    prepared.push({ pgn, mode, selectIndex, count });
    const parsed = parsePgn(pgn);
    const moves = [];
    const walk = (node, onMain) => {
      for (const child of node.children) {
        if (onMain) moves.push(child.san);
        walk(child, onMain && node.children[0] === child);
      }
    };
    walk(parsed.root, true);
    const skeleton = treeOf(pgn).moves;
    return {
      game_id: `game-${selectIndex + 1}`, pgn, depth: 4,
      positions: skeleton.map((m) => m.fen_after),
      moves: skeleton.map((m) => ({ ply: m.ply, san: m.san })),
      brilliant: { enabled: false },
      import_summary: {
        mode, total_games: count, imported_count: count, existing_count: 0, failed_count: 0,
        selected_index: selectIndex, selected_game_id: `game-${selectIndex + 1}`,
        games: games.slice(0, count).map((_, index) => ({
          index, game_id: `game-${index + 1}`, status: "imported",
          white: index === 0 ? "Alice" : "Carol", black: index === 0 ? "Bob" : "Dave", error: null,
        })),
      },
      ...{ sans: moves },
    };
  };
  const deps = {
    html, appState, document: doc, START_FEN, parsePgn, ANALYSIS_ROOT_PATH: "root",
    isBrowserEngineAvailable: () => true,
    setStatus: vi.fn(), setStatusError: vi.fn(), setCoachProse: vi.fn(),
    notices: {
      isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), lockJob: vi.fn(),
      completeJob: vi.fn(), cancelJob: vi.fn(), failJob: vi.fn(), show: vi.fn(),
    },
    requireSignIn: () => true,
    currentOwnerId: () => "owner",
    hideAnalysisHandoff: vi.fn(), hideAnalysisResults: vi.fn(), revealAnalysisResults: vi.fn(),
    engineLifecycleMark: vi.fn(),
    postJson: vi.fn(async (path, payload) => {
      if (path === "/api/analyze/prepare") {
        posts.push(payload);
        return server(String(payload.pgn || ""), payload.mode, Number(payload.select_index) || 0);
      }
      const prep = prepared.at(-1);
      return {
        game_id: `game-${prep.selectIndex + 1}`, engine: "sf-test", depth: 4, summary: {},
        moves: treeOf(prep.pgn).moves.map((m) => ({ ...m, classification: "good", comment: "" })),
        eval_graph: [], position_evals: {},
      };
    }),
    showConfirmModal: vi.fn(async () => false),
    maiaAnalysisEnabled: () => false,
    analysisStore: async () => ({
      analyzeGame: async ({ positions }) => new Map(positions.map((fen) => [fen, { score_cp: 20 }])),
    }),
    ensureAnalyzeView: async () => view,
    createEngineAnalysisRun: () => ({ profile: () => ({ net: "big" }), done: vi.fn(), error: null }),
    readyIfCached: async () => {},
    engineIdentity: () => "sf-test",
    saveCheckpoint: vi.fn(async () => true),
    refreshAnalysisHistoryIfOpen: vi.fn(),
    activeViewName: () => "analyze",
    switchView: vi.fn(),
    renderAnalysisTree: vi.fn(), renderAnalysisTreeEmptyState: vi.fn(),
    syncAnalysisEvalCard: vi.fn(),
    renderAnalysis: vi.fn(async () => {}),
    updateAnalysisHandoff: vi.fn(async () => {}),
    showAnalysisRetrySave: vi.fn(),
    isAuthError: () => false,
    accountService: () => ({ handleAuthRequired: vi.fn() }),
    analysisRecallSeq: 0,
    invalidateAnalysisSource: () => { appState.analysisMultiPgn = null; return 1; },
    loadCheckpoint: () => null,
    evalMapFrom: () => new Map(),
  };
  // Real selection module for showAnalysisPly/resetAnalysisVariations' consumers.
  const showAnalysisPly = vi.fn(async (ply) => { appState.analysisPly = ply; });
  const resetAnalysisVariations = () => {
    appState.analysisVarNodes = new Map();
    appState.analysisVarCounter = 0;
    appState.analysisCurrentNodeId = "root";
    appState.analysisNodePath = null;
    appState.analysisTree = null;
  };
  const functions = [
    body("async function finishAnalyzeCheckpoint("),
    body("async function rebuildAnalysisVariations("),
    body("async function loadPgnIntoAnalyze("),
    body("async function runAnalysis("),
    body("function renderImportPicker("),
  ].join("\n");
  const params = {
    ...deps, resetAnalysisVariations, showAnalysisPly,
    markCheckpointSaved: vi.fn(async () => {}), clearCheckpoint: vi.fn(async () => true),
    refreshAnalyzeRecovery: vi.fn(async () => {}),
  };
  delete params.analysisRecallSeq;
  delete params.invalidateAnalysisSource;
  const session = new Function(...Object.keys(params), `
    let analysisRecallSeq = 0;
    // The real rule: a new source ends the batch and bumps the epoch.
    const invalidateAnalysisSource = () => { appState.analysisMultiPgn = null; return ++analysisRecallSeq; };
    ${functions}
    return { runAnalysis, renderImportPicker, rebuildAnalysisVariations, loadPgnIntoAnalyze };
  `);
  const built = session(...Object.values(params));
  return { ...built, appState, input, view, posts, prepared, pickerHost, select, deps: params };
}

describe("a multi-game paste analyzes one game at a time", () => {
  it("after game 1 the box holds game 1 only, and the picker switches with the paste", async () => {
    const h = harness();
    h.input.value = PASTE;
    await h.runAnalysis({ mode: "multi", selectIndex: 0 });

    // Game 1 was analyzed from the paste.
    expect(h.posts[0]).toMatchObject({ mode: "multi", select_index: 0 });
    expect(h.posts[0].pgn).toContain('Event "G2"');
    // The box now names exactly one game — the analyzed one.
    expect(h.input.value.match(/\[Event /g)).toHaveLength(1);
    expect(h.input.value).toContain('[Event "G1"]');
    expect(h.input.value).not.toContain('Event "G2"');
    expect(h.appState.analysisSourcePgn).toContain('[Event "G1"]');
    expect(h.appState.analysisSourcePgn).not.toContain('Event "G2"');
    expect(h.appState.analysis.moves.map((m) => m.san)).toEqual(["e4", "e5", "Qh5", "Nc6", "Bc4", "g6"]);
    // The paste is still reachable for the picker that was just rendered.
    expect(h.appState.analysisMultiPgn.trim()).toBe(PASTE);
    expect(h.pickerHost.hidden).toBe(false);

    // Switch to game 2 through the picker's own change handler.
    h.select.value = "1";
    h.select.listeners.change();
    await vi.waitFor(() => expect(h.posts).toHaveLength(2));
    await vi.waitFor(() => expect(h.appState.analysisSourcePgn).toContain('Event "G2"'));
    // The POST is the paste (the server indexes into it), never the one-game box.
    expect(h.posts[1]).toMatchObject({ mode: "multi", select_index: 1 });
    expect(h.posts[1].pgn).toBe(PASTE);
    // Game 2's own tags with game 2's own moves.
    expect(h.input.value).toContain('[Event "G2"]');
    expect(h.input.value).not.toContain('Event "G1"');
    expect(sansOf(h.input.value)).toEqual(["d4", "d5", "c4", "e6"]);
    expect(h.appState.analysis.moves.map((m) => m.san)).toEqual(["d4", "d5", "c4", "e6"]);
    expect(h.appState.analysisSourcePgn).toContain('[Event "G2"]');
    expect(h.appState.analysisVarNodes.size).toBe(0);
  });

  it("a single-mode re-run of the box after a multi run keeps the selected game's tags and moves", async () => {
    const h = harness();
    h.input.value = PASTE;
    await h.runAnalysis({ mode: "multi", selectIndex: 1 });
    expect(h.input.value).toContain('[Event "G2"]');

    // The user presses Analyze again on what the box holds now: one game, so the
    // single flow accepts it and the tags still match the moves.
    await h.runAnalysis();
    expect(h.posts.at(-1)).toMatchObject({ mode: "single", select_index: 0 });
    expect(h.posts.at(-1).pgn).toContain('[Event "G2"]');
    expect(h.posts.at(-1).pgn).not.toContain('Event "G1"');
    expect(sansOf(h.posts.at(-1).pgn)).toEqual(["d4", "d5", "c4", "e6"]);
    expect(h.appState.analysis.moves.map((m) => m.san)).toEqual(["d4", "d5", "c4", "e6"]);
  });

  it("a picker left on screen cannot post an index into a box that no longer holds the paste", async () => {
    const h = harness();
    h.input.value = PASTE;
    await h.runAnalysis({ mode: "multi", selectIndex: 0 });
    // A new source (a paste, a recall, an account switch) ends the batch.
    h.appState.analysisMultiPgn = null;
    h.select.value = "1";
    h.select.listeners.change();
    expect(h.posts).toHaveLength(1);
    expect(h.pickerHost.hidden).toBe(true);
  });
});
