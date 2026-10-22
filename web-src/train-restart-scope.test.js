// Two Train workflow fixes, tested through the real functions:
//
//  1. Result -> "Again" keeps the run's scope. The scope is explicit state
//     (appState.trainScope / trainingRepertoireId), so a queue drilled for one
//     repertoire restarts on it and an all-repertoires queue stays mixed.
//  2. Line rehearsal: a failed /api/train/move put the board back on the played
//     (optimistic) move with no legal moves under a "Your move" banner, so the
//     card could not be answered again. An answer the server rejected (4xx)
//     restores the SAME prompt, and a late failure never repaints after the
//     card/mode/owner changed. An unconfirmed result (no server answer) is
//     reconciled instead — see train-recovery.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeDocument, setup } from "./controllers/train-home.fixture.js";
import { appSource } from "./test-app-source.js";
import { createTrainRecovery } from "./train-recovery.js";

const source = appSource();
function compile(marker, deps, prelude = "") {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `${prelude}\nreturn (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const REP = "rep-1";
const FEN_BEFORE = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";


describe("Again keeps the finished run's scope", () => {
  let doc;
  beforeEach(() => { doc = fakeDocument(); vi.stubGlobal("document", doc); });
  afterEach(() => vi.unstubAllGlobals());

  it("restarts a one-repertoire queue on that repertoire", async () => {
    const { deps } = setup({ currentView: "train", trainMode: "smart", trainScope: { repertoireId: REP, label: "Caro-Kann" }, trainResult: { mode: "smart" } });
    await doc.getElementById("train-summary-new").click();
    await vi.waitFor(() => expect(deps.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: REP, targetNodeIds: [] }));
  });

  it("leaves an all-repertoires queue on all of them", async () => {
    const { deps } = setup({ currentView: "train", trainMode: "smart", trainScope: { repertoireId: null, label: "All repertoires" }, trainResult: { mode: "smart" } });
    await doc.getElementById("train-summary-new").click();
    await vi.waitFor(() => expect(deps.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: null, targetNodeIds: [] }));
  });

  it("rehearses the same repertoire again", async () => {
    const { deps } = setup({ currentView: "train", trainMode: "all_lines", trainingRepertoireId: "rep-2", trainResult: { mode: "all_lines" } });
    await doc.getElementById("train-summary-new").click();
    await vi.waitFor(() => expect(deps.startTraining).toHaveBeenCalledWith("all_lines", expect.objectContaining({ repertoireId: "rep-2" })));
  });
});

function rehearsalHarness({ move } = {}) {
  const appState = {
    trainMode: "all_lines",
    trainBusy: false,
    trainHintLevel: 0,
    accountUserId: "alice",
    training: { prompt: { session_id: "sess-1", fen_before: FEN_BEFORE, legal_moves: ["e2e4"] } },
    trainStats: { correct: 0, mistakes: 0, skipped: 0, streak: 0, best: 0, history: [], lastStreak: 0 },
    trainReview: { queue: [], index: 0, active: false, savedStreak: 0, recovered: 0 },
  };
  const board = { fen: "moved", setPosition: vi.fn((next) => { board.fen = next.fen; }) };
  const pending = deferred();
  const deps = {
    appState,
    currentOwnerId: () => appState.accountUserId,
    boards: { train: board },
    optimisticBoardMove: vi.fn(async () => true),
    api: move || vi.fn(() => pending.promise),
    localDateString: () => "2026-10-01",
    setTrainBanner: vi.fn(),
    setStatusError: vi.fn(),
    syncTrainSessionControls: vi.fn(),
    boardAfterMove: vi.fn(async () => ({ board: { fen: "after" }, move: { san: "e4" } })),
    renderTrainStats: vi.fn(),
    sleep: async () => {},
    playSound: vi.fn(),
    enterReviewRound: vi.fn(),
    finishTrainingSession: vi.fn(),
    currentTrainingPrompt: () => appState.training.prompt,
  };
  deps.trainRecovery = createTrainRecovery(deps);
  const submit = compile("async function submitTrainingMove(", deps);
  return { appState, board, pending, deps, submit };
}

describe("a failed rehearsal answer keeps the same card answerable", () => {
  it("puts the board back on the prompt's position and asks for the move again", async () => {
    const h = rehearsalHarness();
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(Object.assign(new Error("Failed to fetch"), { status: 400 }));
    await attempt;
    // The optimistic move is undone: the same position, with its legal moves.
    expect(h.board.setPosition).toHaveBeenLastCalledWith({
      fen: FEN_BEFORE, legalMoves: ["e2e4"], lastMove: null,
    });
    expect(h.deps.setTrainBanner).toHaveBeenCalledWith("move", "Your move", "That answer didn't save. Play it again.");
    expect(h.deps.setStatusError).toHaveBeenCalledWith("Failed to fetch");
    expect(h.appState.trainBusy).toBe(false);
    // Nothing was graded, so the card is still the one on screen.
    expect(h.appState.training.prompt.session_id).toBe("sess-1");
  });

  it("a late failure after the card advanced does not repaint the board", async () => {
    const h = rehearsalHarness();
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    // The session moved on (another prompt) while the request was in flight.
    h.appState.training = { prompt: { session_id: "sess-2", fen_before: FEN_BEFORE, legal_moves: [] } };
    h.pending.reject(Object.assign(new Error("Failed to fetch"), { status: 400 }));
    await attempt;
    expect(h.board.setPosition).not.toHaveBeenCalled();
    expect(h.deps.setTrainBanner).not.toHaveBeenCalled();
    expect(h.deps.setStatusError).not.toHaveBeenCalled();
  });

  it("a late failure after a mode switch or account change does not repaint either", async () => {
    for (const change of ["mode", "owner"]) {
      const h = rehearsalHarness();
      const attempt = h.submit("e2e4");
      await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
      if (change === "mode") h.appState.trainMode = "play";
      else h.appState.accountUserId = "bob";
      h.pending.reject(Object.assign(new Error("Failed to fetch"), { status: 400 }));
      await attempt;
      expect(h.board.setPosition).not.toHaveBeenCalled();
      expect(h.deps.setTrainBanner).not.toHaveBeenCalled();
    }
  });
});
