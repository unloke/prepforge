// Line rehearsal: a failed /api/train/move must never invite replaying an answer
// the server may already have graded. POST /train/move commits the grade and the
// advance before writing its response, so a lost response leaves the server on
// the NEXT own move. These tests drive the real controller function:
//
//   - a rejection the server answered (4xx) provably did not grade -> same card.
//   - no answer (abort/timeout/offline/5xx) -> reconcile with GET /train/session,
//     retry blocked until the server's current prompt is known.
//   - a failed reconciliation keeps the board locked behind a Retry sync action.
//   - owner/mode/prompt changes win over a late reconciliation.
import { describe, expect, it, vi } from "vitest";

import { createTrainRecovery, trainMoveResultUnconfirmed, trainRecoveryIsCurrent } from "./train-recovery.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const FEN_E4 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2";
const CARD_E4 = { session_id: "sess-1", fen_before: FEN_E4, legal_moves: ["e2e4", "d2d4"] };
const CARD_NF3 = { session_id: "sess-1", fen_before: FEN_NF3, legal_moves: ["g1f3"], current_index: 0 };

function harness({ move, read } = {}) {
  const appState = {
    trainMode: "all_lines",
    trainBusy: false,
    trainHintLevel: 0,
    accountUserId: "alice",
    ownerGeneration: 2,
    training: { prompt: CARD_E4 },
    trainStats: { correct: 0, mistakes: 0, skipped: 0, streak: 0, best: 0, history: [], lastStreak: 0 },
    trainReview: { queue: [], index: 0, active: false, savedStreak: 0, recovered: 0 },
  };
  const board = { fen: "moved", setPosition: vi.fn((next) => { board.fen = next.fen; }), setEngineArrow: vi.fn() };
  const pending = deferred();
  const readDeferred = deferred();
  const reads = [];
  const notices = { show: vi.fn(() => ({ dismiss: vi.fn() })) };
  const deps = {
    appState,
    currentOwnerId: () => appState.accountUserId,
    boards: { train: board },
    notices,
    optimisticBoardMove: vi.fn(async () => true),
    api: move || vi.fn((path) => {
      if (String(path).startsWith("/api/train/session/")) {
        reads.push(path);
        return read ? read(path) : readDeferred.promise;
      }
      return pending.promise;
    }),
    localDateString: () => "2026-10-01",
    setTrainBanner: vi.fn(),
    setStatus: vi.fn(),
    setStatusError: vi.fn(),
    syncTrainSessionControls: vi.fn(),
    boardAfterMove: vi.fn(async () => ({ board: { fen: "after" }, move: { san: "e4" } })),
    renderTrainStats: vi.fn(),
    sleep: async () => {},
    playSound: vi.fn(),
    enterReviewRound: vi.fn(),
    finishTrainingSession: vi.fn(),
    renderTraining: vi.fn(async () => {}),
    currentTrainingPrompt: () => appState.training.prompt,
  };
  deps.trainRecovery = createTrainRecovery(deps);
  const submit = compile("async function submitTrainingMove(", deps);
  return { appState, board, notices, pending, readDeferred, reads, deps, submit };
}

describe("classifying a failed rehearsal answer", () => {
  it("only an answered 4xx proves the move was not graded", () => {
    expect(trainMoveResultUnconfirmed(Object.assign(new Error("bad"), { status: 400 }))).toBe(false);
    expect(trainMoveResultUnconfirmed(Object.assign(new Error("nope"), { status: 404 }))).toBe(false);
    expect(trainMoveResultUnconfirmed(new Error("Failed to fetch"))).toBe(true);
    expect(trainMoveResultUnconfirmed(Object.assign(new Error("boom"), { status: 503 }))).toBe(true);
    expect(trainMoveResultUnconfirmed(Object.assign(new Error("timeout"), {
      name: "RequestTimeoutError", resultUnconfirmed: true,
    }))).toBe(true);
  });
});

describe("reconciling an unconfirmed answer", () => {
  it("a rejected answer (server answered 4xx) restores the same card", async () => {
    const h = harness();
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(Object.assign(new Error("Couldn't save"), { status: 400 }));
    await attempt;
    expect(h.board.setPosition).toHaveBeenLastCalledWith({
      fen: FEN_E4, legalMoves: ["e2e4", "d2d4"], lastMove: null,
    });
    expect(h.deps.setTrainBanner).toHaveBeenCalledWith("move", "Your move", "That answer didn't save. Play it again.");
    expect(h.deps.setStatusError).toHaveBeenCalledWith("Couldn't save");
    expect(h.reads).toEqual([]); // nothing to reconcile: the server refused it
    expect(h.appState.trainBusy).toBe(false);
  });

  it("a lost response adopts the server's current prompt instead of the old card", async () => {
    const h = harness({ read: async () => ({ prompt: CARD_NF3 }) });
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(new Error("Failed to fetch"));
    await attempt;
    expect(h.reads).toEqual(["/api/train/session/sess-1"]);
    // The e4 card is never repainted: the server already graded it.
    expect(h.board.setPosition).not.toHaveBeenCalledWith(expect.objectContaining({ fen: FEN_E4 }));
    expect(h.deps.setTrainBanner).toHaveBeenCalledWith("move", "Checking your answer", "");
    // The advanced card is what the player answers next.
    expect(h.deps.renderTraining).toHaveBeenCalledWith(CARD_NF3);
    expect(h.appState.trainBusy).toBe(false);
  });

  it("a finished session is ended, not repainted as a waiting card", async () => {
    const h = harness({ read: async () => ({ prompt: null }) });
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(new Error("Failed to fetch"));
    await attempt;
    expect(h.deps.finishTrainingSession).toHaveBeenCalled();
    expect(h.deps.renderTraining).not.toHaveBeenCalled();
    expect(h.appState.trainBusy).toBe(false);
  });

  it("keeps the board locked behind a Retry sync action while the read fails", async () => {
    const h = harness({ read: async () => { throw new Error("Failed to fetch"); } });
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(new Error("Failed to fetch"));
    await attempt;
    // No dead "Your move" on a card the server may have advanced past.
    expect(h.deps.setTrainBanner).toHaveBeenCalledWith(
      "done", "Couldn't confirm that answer", "Retry sync to catch up with the server.",
    );
    expect(h.appState.trainBusy).toBe(true);
    const [, options] = h.notices.show.mock.calls[0];
    expect(options.tone).toBe("error");
    expect(options.actions[0].label).toBe("Retry sync");
    expect(h.board.setPosition).not.toHaveBeenCalled();
  });

  it("Retry sync adopts the server's prompt once the read succeeds", async () => {
    let calls = 0;
    const h = harness({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Failed to fetch");
        return { prompt: CARD_NF3 };
      },
    });
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(new Error("Failed to fetch"));
    await attempt;
    const [, options] = h.notices.show.mock.calls[0];
    options.actions[0].onClick();
    await vi.waitFor(() => expect(h.deps.renderTraining).toHaveBeenCalledWith(CARD_NF3));
    expect(calls).toBe(2);
    expect(h.appState.trainBusy).toBe(false);
  });

  it("a newer card, another account, or a mode switch wins over a late read", async () => {
    for (const change of ["prompt", "owner", "generation", "mode"]) {
      const h = harness();
      const attempt = h.submit("e2e4");
      await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
      h.pending.reject(new Error("Failed to fetch"));
      await vi.waitFor(() => expect(h.reads.length).toBe(1));
      if (change === "prompt") h.appState.training.prompt = CARD_NF3;
      else if (change === "owner") h.appState.accountUserId = "bob";
      else if (change === "generation") h.appState.ownerGeneration += 1;
      else h.appState.trainMode = "play";
      h.readDeferred.resolve({ prompt: CARD_NF3 });
      await attempt;
      expect(h.deps.renderTraining, change).not.toHaveBeenCalled();
      expect(h.deps.finishTrainingSession, change).not.toHaveBeenCalled();
      expect(h.board.setPosition, change).not.toHaveBeenCalled();
      // The abandoned reconciliation owns no lock: the new card stays playable.
      expect(h.appState.trainBusy, change).toBe(false);
    }
  });

  it("a new session opened while the answer is unconfirmed is not left locked", async () => {
    const h = harness();
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(new Error("Failed to fetch"));
    await vi.waitFor(() => expect(h.reads.length).toBe(1));
    expect(h.appState.trainBusy).toBe(true);
    // "New session" replaces the rehearsal before the late read comes back.
    h.appState.training = { prompt: CARD_NF3 };
    h.readDeferred.resolve({ prompt: CARD_NF3 });
    await attempt;
    expect(h.deps.renderTraining).not.toHaveBeenCalled();
    expect(h.appState.trainBusy).toBe(false);
  });

  it("a failed read that a newer card superseded does not strand the retry notice", async () => {
    let fail;
    const h = harness({ read: () => new Promise((_, no) => { fail = no; }) });
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.reject(new Error("Failed to fetch"));
    await vi.waitFor(() => expect(h.reads.length).toBe(1));
    h.appState.training = { prompt: CARD_NF3 };
    fail(new Error("Failed to fetch"));
    await attempt;
    expect(h.notices.show).not.toHaveBeenCalled();
    expect(h.appState.trainBusy).toBe(false);
  });

  it("a normal correct answer still advances without a reconciliation read", async () => {
    const h = harness();
    const attempt = h.submit("e2e4");
    await vi.waitFor(() => expect(h.deps.api).toHaveBeenCalled());
    h.pending.resolve({
      correct: true,
      played_uci: "e2e4",
      fen_after_player: "after-player",
      reply_uci: "e7e5",
      fen_after_reply: "after-reply",
      prompt: CARD_NF3,
    });
    await attempt;
    expect(h.reads).toEqual([]);
    expect(h.deps.renderTraining).toHaveBeenCalledWith(CARD_NF3);
    expect(h.appState.trainStats.correct).toBe(1);
    expect(h.appState.trainBusy).toBe(false);
  });
});

describe("the recovery fences", () => {
  const base = {
    training: { prompt: CARD_E4 }, owner: "alice", generation: 2, mode: "all_lines", prompt: CARD_E4,
  };
  const state = () => ({ appState: { training: base.training, trainMode: "all_lines", accountUserId: "alice", ownerGeneration: 2 }, currentOwnerId: () => "alice" });

  it("accepts the exact rehearsal it started from", () => {
    expect(trainRecoveryIsCurrent(base, state())).toBe(true);
  });

  it("refuses a newer card, account, generation, mode, or a smart session", () => {
    const cases = [
      { appState: { ...state().appState, training: { prompt: CARD_NF3 } } },
      { currentOwnerId: () => "bob" },
      { appState: { ...state().appState, ownerGeneration: 3 } },
      { appState: { ...state().appState, trainMode: "play" } },
      { appState: { ...state().appState, smart: { prompt: {} } } },
    ];
    for (const change of cases) expect(trainRecoveryIsCurrent(base, { ...state(), ...change })).toBe(false);
  });
});
