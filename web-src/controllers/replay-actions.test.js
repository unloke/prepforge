import { afterEach, expect, it, vi } from "vitest";
import { buildReply, replayToAnalyze } from "./replay-actions.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const legalMoves = ["g8f6", "g8h6", "b8c6", "e7e5", "d7d5"];
const game = { repertoire_id: "rep-1", last_matched_node_id: "n2", departure_move_uci: "g8f6", user_color: "white" };

function harness(overrides = {}) {
  const node = { id: "n2", fen: AFTER_E4 };
  const deps = {
    editRepertoire: vi.fn(async () => {}),
    getNode: () => node,
    isBuildReadOnly: () => false,
    localBoardInfo: () => ({ legal_moves: legalMoves }),
    onBuildBoardMove: vi.fn(async () => {}),
    isCurrent: () => true,
    ...overrides,
  };
  return { deps, node };
}

it("Add reply plays the opponent's departure move into the matched line", async () => {
  const { deps } = harness();
  await buildReply(game, deps);
  expect(deps.editRepertoire).toHaveBeenCalledWith("rep-1", "n2");
  // The whole point of the button: the move is added, not just the position opened.
  expect(deps.onBuildBoardMove).toHaveBeenCalledWith("g8f6");
});

it("Add reply still plays the move when the payload color disagrees with the tree", async () => {
  // A white repertoire can hold a black reply; the side in the game payload
  // must not veto a move the matched node says is legal.
  const { deps } = harness();
  await buildReply({ ...game, user_color: "black" }, deps);
  expect(deps.onBuildBoardMove).toHaveBeenCalledWith("g8f6");
});

it("Add reply does nothing when the departure move is not legal on the matched node", async () => {
  const { deps } = harness({ localBoardInfo: () => ({ legal_moves: ["e7e5"] }) });
  await buildReply(game, deps);
  expect(deps.onBuildBoardMove).not.toHaveBeenCalled();
});

it("Add reply does not add a move after the view changed or into a read-only tree", async () => {
  const changed = harness({ isCurrent: () => false });
  await buildReply(game, changed.deps);
  expect(changed.deps.onBuildBoardMove).not.toHaveBeenCalled();
  const readOnly = harness({ isBuildReadOnly: () => true });
  await buildReply(game, readOnly.deps);
  expect(readOnly.deps.onBuildBoardMove).not.toHaveBeenCalled();
});

// ---- Games → Analyze notice ---------------------------------------------------

const replayGame = { lichess_id: 'A1b2C3d4', move_san_history: ['e4', 'e5', 'Nf3'], white: 'Alice', black: 'Bob', departure_ply: 3, result: '*' };
const savedReview = { game_id: 'saved-id', lichess_id: replayGame.lichess_id, white: 'Alice', black: 'Bob' };
function replayHarness(rows = []) {
  const input = { value: '' }, drawer = { open: false };
  vi.stubGlobal('document', { getElementById: id => id === 'pgn-input' ? input : drawer });
  return {
    switchView: vi.fn(), orientAnalysisForSelf: vi.fn(),
    loadPgnIntoAnalyze: vi.fn(async () => true), showAnalysisPly: vi.fn(async () => {}),
    api: vi.fn(async () => ({ analyses: rows })), recallAnalysis: vi.fn(async () => true),
    takeHandoff: () => null, setStatus: vi.fn(), isCurrent: () => true, sourceSeq: 7,
  };
}
afterEach(() => vi.unstubAllGlobals());

it('Games reuses the saved review instead of reparsing away its chart and grades', async () => {
  const deps = replayHarness([savedReview]);
  await replayToAnalyze(replayGame, deps);
  expect(deps.api).toHaveBeenCalledWith('/api/analyses?lichess_id=A1b2C3d4&limit=1');
  expect(deps.recallAnalysis).toHaveBeenCalledWith('saved-id', savedReview, { sourceSeq: 7 });
  expect(deps.loadPgnIntoAnalyze).not.toHaveBeenCalled();
  expect(deps.showAnalysisPly).toHaveBeenCalledWith(2);
  expect(deps.setStatus).toHaveBeenCalledWith('Loaded saved analysis for Alice vs Bob.');
});

it('an unsaved game loads its PGN ready for a first analysis', async () => {
  const deps = replayHarness();
  await replayToAnalyze(replayGame, deps);
  expect(deps.recallAnalysis).not.toHaveBeenCalled();
  expect(deps.loadPgnIntoAnalyze).toHaveBeenCalledWith(expect.stringContaining('1. e4 e5 2. Nf3'), { goToEnd: false, quiet: true, sourceSeq: 7 });
  expect(deps.setStatus).toHaveBeenCalledWith('Loaded Alice vs Bob. Press Review.');
});

it('a lookup finishing after another source is selected cannot load its game', async () => {
  const deps = replayHarness([savedReview]);
  let current = true, release;
  deps.isCurrent = () => current;
  deps.api.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = replayToAnalyze(replayGame, deps);
  current = false;
  release({ analyses: [savedReview] });
  await pending;
  expect(deps.recallAnalysis).not.toHaveBeenCalled();
  expect(deps.loadPgnIntoAnalyze).not.toHaveBeenCalled();
  expect(deps.showAnalysisPly).not.toHaveBeenCalled();
});

it('a failed recall does not replace a saved review with an unanalysed PGN', async () => {
  const deps = replayHarness([savedReview]);
  deps.recallAnalysis.mockResolvedValue(false);
  await replayToAnalyze(replayGame, deps);
  expect(deps.loadPgnIntoAnalyze).not.toHaveBeenCalled();
  expect(deps.showAnalysisPly).not.toHaveBeenCalled();
  expect(deps.setStatus).not.toHaveBeenCalled();
});

it('lookup errors reach the existing Games action error handler', async () => {
  const deps = replayHarness();
  deps.api.mockRejectedValue(new Error('Network unavailable'));
  await expect(replayToAnalyze(replayGame, deps)).rejects.toThrow('Network unavailable');
  expect(deps.loadPgnIntoAnalyze).not.toHaveBeenCalled();
});

it("names the button the user actually presses, and stays one line", async () => {
  // The Analyze panel's button reads "Review"; "press Analyze game" named no
  // control and wrapped onto two lines in the phone notice.
  const setStatus = vi.fn();
  const deps = {
    switchView: vi.fn(),
    orientAnalysisForSelf: vi.fn(),
    loadPgnIntoAnalyze: vi.fn(async () => true),
    showAnalysisPly: vi.fn(async () => {}),
    takeHandoff: () => null,
    setStatus,
    isCurrent: () => true,
    document: { getElementById: () => ({ value: "", open: false }) },
  };
  vi.stubGlobal("document", deps.document);
  try {
    await replayToAnalyze(
      { move_san_history: ["e4", "e5", "Nf3"], white: "W0a", black: "Anonymous", result: "1-0" },
      deps,
    );
  } finally {
    vi.unstubAllGlobals();
  }
  expect(setStatus).toHaveBeenCalledWith("Loaded W0a vs Anonymous. Press Review.");
});
