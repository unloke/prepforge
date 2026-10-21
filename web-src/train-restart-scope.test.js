// Two Train workflow fixes, tested through the real functions:
//
//  1. Finish -> "New session" keeps the queue's scope. finishSmartSession
//     releases appState.smart before the summary paints, so a queue drilled for
//     one repertoire used to restart as a MIXED queue over every active
//     repertoire (and the Train URL lost its ?rep=). The scope is remembered for
//     exactly that hand-off and fenced by owner + owner generation.
//  2. Line rehearsal: a failed /api/train/move put the board back on the played
//     (optimistic) move with no legal moves under a "Your move" banner, so the
//     card could not be answered again. An answer the server rejected (4xx)
//     restores the SAME prompt, and a late failure never repaints after the
//     card/mode/owner changed. An unconfirmed result (no server answer) is
//     reconciled instead — see train-recovery.test.js.
import { describe, expect, it, vi } from "vitest";

import {
  finishedQueueScopeFor, queueRepertoireForStart, rememberFinishedQueueScope,
} from "./train-start.js";
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

function state(overrides = {}) {
  return {
    accountUserId: "alice",
    ownerGeneration: 3,
    repertoireList: [
      { id: REP, name: "Caro-Kann", is_active: true },
      { id: "rep-2", name: "London", is_active: true },
    ],
    pendingRepDeletes: new Set(),
    ...overrides,
  };
}

describe("a new queue keeps the finished queue's scope", () => {
  it("restarts a single-repertoire queue as the same single-repertoire queue", () => {
    const appState = state();
    appState.finishedQueueScope = rememberFinishedQueueScope(appState, {
      mixed: false, repertoireId: REP,
    });
    expect(queueRepertoireForStart({
      requested: null, current: null, previous: appState.finishedQueueScope, state: appState, fresh: true,
    })).toBe(REP);
  });

  it("leaves a mixed queue mixed", () => {
    const appState = state();
    appState.finishedQueueScope = rememberFinishedQueueScope(appState, { mixed: true, repertoireId: null });
    expect(queueRepertoireForStart({
      previous: appState.finishedQueueScope, state: appState, fresh: true,
    })).toBeNull();
  });

  it("lets an explicit repertoire or a plain Start win over the remembered scope", () => {
    const appState = state();
    appState.finishedQueueScope = rememberFinishedQueueScope(appState, { mixed: false, repertoireId: REP });
    expect(queueRepertoireForStart({
      requested: "rep-2", previous: appState.finishedQueueScope, state: appState, fresh: true,
    })).toBe("rep-2");
    // A plain (non-fresh) Start still resumes whatever the server has.
    expect(queueRepertoireForStart({
      previous: appState.finishedQueueScope, state: appState, fresh: false,
    })).toBeNull();
  });

  it("drops the scope on another account, another generation, or a deleted repertoire", () => {
    const appState = state();
    const scope = rememberFinishedQueueScope(appState, { mixed: false, repertoireId: REP });
    expect(finishedQueueScopeFor(scope, state({ accountUserId: "bob" }))).toBeNull();
    expect(finishedQueueScopeFor(scope, state({ ownerGeneration: 4 }))).toBeNull();
    expect(finishedQueueScopeFor(scope, state({ repertoireList: [{ id: "rep-2", is_active: true }] }))).toBeNull();
    expect(finishedQueueScopeFor(scope, state({
      repertoireList: [{ id: REP, is_active: true }], pendingRepDeletes: new Set([REP]),
    }))).toBeNull();
    // Still the same owner/generation and still trainable: kept.
    expect(finishedQueueScopeFor(scope, appState)).toBe(scope);
    // The listing not loaded yet is not evidence the repertoire is gone.
    expect(finishedQueueScopeFor(scope, state({ repertoireList: [] }))).toBe(scope);
  });

  it("Finish remembers the scope before releasing the live session", async () => {
    const appState = { trainMode: "smart", trainStats: { correct: 1, mistakes: 0, skipped: 0, streak: 1, best: 1, history: [true] },
      accountUserId: "alice", ownerGeneration: 3, repertoireList: [{ id: REP, is_active: true }],
      smart: { sessionId: "s1", generation: "g1", mixed: false, repertoireId: REP, blitz: false, queue: [], prompt: {} } };
    const finish = compile("async function finishSmartSession(", {
      appState,
      rememberFinishedQueueScope,
      trainSessionMemo: { finishSmartSessionMemo: vi.fn() },
      currentOwnerId: () => appState.accountUserId,
      clearBlitzTimer: vi.fn(), setBlitzBarVisible: vi.fn(), boards: { train: { setEngineArrow: vi.fn(), setPosition: vi.fn() } },
      updateTrainTurnBadge: vi.fn(), setTrainBanner: vi.fn(), showSmartSummary: vi.fn(),
      invalidateTrainSessionPreview: vi.fn(), celebrate: vi.fn(), flushTrainSync: async () => true,
      api: async () => null, renderSmartSummary: vi.fn(async () => {}), syncTrainSessionControls: vi.fn(),
      refreshRepertoireHead: vi.fn(async () => {}), refreshDashboardRepertoires: vi.fn(async () => {}),
      paintTrainStartDisabled: vi.fn(),
      refreshTrainSessionPreview: vi.fn(async () => {}), localDateString: () => "2026-10-01",
      smartSessionOutcomeText: () => "",
      document: { getElementById: () => ({ style: {}, innerHTML: "", hidden: false, scrollIntoView() {} }) },
    });
    await finish();
    expect(appState.smart).toBeNull();
    expect(appState.finishedQueueScope).toEqual({
      ownerId: "alice", generation: 3, mixed: false, repertoireId: REP,
    });
    // And the restart built from it stays on that repertoire.
    expect(queueRepertoireForStart({
      previous: appState.finishedQueueScope, state: appState, fresh: true,
    })).toBe(REP);
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
