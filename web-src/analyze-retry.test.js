import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";

import {
  describeRetryHint,
  retryExercises,
  retryPlan,
} from "./analyze-retry.js";
import { createReviewBar } from "./views/analyze-review.js";
import { reviewMoments } from "./views/analyze-report.js";
import { sanOf } from "./chess-local.js";
import { asSlices } from "./state/as-slices.fixture.js";

const START = new Chess().fen();
function movesOf(sans, grades = [], best = {}) {
  const chess = new Chess();
  return sans.map((san, index) => {
    const fenBefore = chess.fen();
    const move = chess.move(san);
    return {
      ply: index + 1,
      move_number: Number(fenBefore.split(" ")[5]),
      side: move.color === "b" ? "black" : "white",
      san: move.san,
      uci: move.lan,
      fen_before: fenBefore,
      fen_after: chess.fen(),
      classification: grades[index] || "best",
      best_move_uci: best[index + 1] || move.lan,
    };
  });
}

const GAME = movesOf(
  ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"],
  ["best", "best", "blunder", "best", "missed_win", "best", "mistake", "blunder"],
  { 3: "d2d4", 5: "f1c4", 7: "b5c6", 8: "b7b5" },
);

const labelOf = (move) => `${move.move_number}${move.side === "black" ? "…" : "."}${move.san}`;

function engineMoment(ply, grade, bestUci, loss = 18) {
  const move = GAME[ply - 1];
  return {
    ply,
    side: move.side,
    label: labelOf(move),
    grade,
    loss,
    move,
    best: { uci: bestUci, san: sanOf(move.fen_before, bestUci) },
    departure: false,
    by: null,
    preparedMoves: [],
  };
}

function prepMoment(ply, answers, { repName = "Italian", repId = "rep-1", prescribedNodeId = "n-bc4" } = {}) {
  const move = GAME[ply - 1];
  return {
    ply,
    side: move.side,
    label: labelOf(move),
    grade: "mistake",
    move,
    best: { uci: "d2d4", san: "d4" },
    departure: true,
    by: "you",
    repName,
    repId,
    prescribedNodeId,
    preparedMoves: answers,
  };
}

function makeTree() {
  const root = { id: "root", isMainline: true, ply: 0, parent: null, children: [], fenAfter: START };
  const byId = new Map([["root", root]]);
  let prev = root;
  for (const move of GAME) {
    const node = {
      id: `m${move.ply}`,
      ply: move.ply,
      isMainline: true,
      parent: prev,
      uci: move.uci,
      san: move.san,
      fenBefore: move.fen_before,
      fenAfter: move.fen_after,
      moveNumber: move.move_number,
      side: move.side,
      children: [],
    };
    byId.set(node.id, node);
    prev.children.push(node);
    prev = node;
  }
  return { byId, root };
}

function harness(moments, { selfSide = "white", positionEvals = {}, canTrainPrep = false, recordPrepMiss = null } = {}) {
  let markup = "";
  const listeners = [];
  const bar = {
    hidden: true,
    dataset: {},
    addEventListener: vi.fn((_, fn) => listeners.push(fn)),
    contains: () => false,
    querySelector: () => null,
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = String(value); },
    replaceChildren() { markup = ""; },
  };
  const view = { dataset: {} };
  globalThis.document = {
    getElementById: (id) => (id === "coach-review" ? bar : id === "view-analyze" ? view : null),
    activeElement: null,
  };
  let orientation = "white";
  const renderBoard = vi.fn();
  const selectHintSquare = vi.fn();
  const setHintArrow = vi.fn();
  const setComparisonArrows = vi.fn();
  const setOrientation = vi.fn((next) => { orientation = next; });
  const playCue = vi.fn();
  const previewPosition = vi.fn();
  const appState = {
    analysisTree: makeTree(),
    analysisCurrentNodeId: "root",
    analysisPly: 0,
    analysis: { id: "game", moves: GAME, position_evals: positionEvals },
  };
  const review = createReviewBar({
    ...asSlices(appState),
    getReport: () => ({ moments, selfSide }),
    previewPosition,
    gradeAttempt: vi.fn(),
    showAnalysisPly: async (ply) => {
      appState.analysisCurrentNodeId = ply ? `m${ply}` : "root";
      appState.analysisPly = ply;
    },
    selectAnalysisNode: async (id) => {
      appState.analysisCurrentNodeId = id;
      appState.analysisPly = id.startsWith("m") ? Number(id.slice(1)) : 0;
      return true;
    },
    retryHooks: {
      renderBoard,
      selectHintSquare,
      setHintArrow,
      setComparisonArrows,
      getOrientation: () => orientation,
      setOrientation,
      playCue,
      canTrainPrep: () => canTrainPrep,
      recordPrepMiss,
    },
  });
  const click = async (kind, index = null) => {
    listeners[0]({ target: { closest: () => ({ dataset: { review: kind, ...(index != null ? { index: String(index) } : {}) }, disabled: false, getAttribute: () => null }) } });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { bar, view, appState, review, click, renderBoard, selectHintSquare, setHintArrow, setComparisonArrows, setOrientation, playCue, previewPosition };
}

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.document;
});

describe("standalone Analyze Retry engine", () => {
  it("includes missed_win moments in report moments and retry plans, wrapping at the end", () => {
    const moments = reviewMoments(GAME, []);
    expect(moments.some((m) => m.ply === 5 && m.grade === "missed")).toBe(true);
    const white = retryExercises(moments, 0, "white");
    expect(white.map((m) => [m.ply, m.grade])).toEqual([
      [3, "blunder"],
      [5, "missed"],
      [7, "mistake"],
    ]);
    expect(retryPlan(moments, 0, "white")).toMatchObject({ wrapped: false });
    expect(retryPlan(moments, 7, "white")).toMatchObject({
      wrapped: true,
      exercises: expect.arrayContaining([expect.objectContaining({ ply: 3 })]),
    });
  });

  it("shows spoiler-free game context, progressive piece hint, and PV continuation on solve/reveal", async () => {
    vi.useFakeTimers();
    const preFen = GAME[2].fen_before;
    const h = harness(
      [engineMoment(3, "blunder", "d2d4", 22), engineMoment(7, "mistake", "b5c6", 14)],
      {
        positionEvals: {
          [preFen]: { best_move_uci: "d2d4", pv: ["d2d4", "e5d4", "d1d4"] },
        },
      },
    );
    h.review.paint();
    await h.click("retry");

    expect(h.bar.innerHTML).toContain("2.Nf3 · Blunder");
    expect(h.bar.innerHTML).toContain("After 1…e5 · played 2.Nf3 (Blunder, −22%)");
    expect(h.bar.innerHTML).not.toContain("d4");

    await h.click("hint");
    expect(h.selectHintSquare).toHaveBeenCalledWith("d2");
    expect(h.bar.innerHTML).toContain("Hint · Move the pawn on d2");
    expect(h.bar.innerHTML).not.toContain("d4");

    // Wrong guess lands on board with grade badge, then snaps back cleanly and keeps piece hint
    h.review.tryReviewMove("g1f3", preFen);
    expect(h.playCue).toHaveBeenCalledWith("wrong");
    expect(h.bar.innerHTML).toContain("Played Nf3 in the game (Blunder)");
    expect(h.bar.innerHTML).toContain("Hint · Move the pawn on d2");
    await vi.advanceTimersByTimeAsync(520);
    expect(h.renderBoard).toHaveBeenLastCalledWith(expect.objectContaining({ fen: preFen, back: true }));
    expect(h.selectHintSquare).toHaveBeenLastCalledWith("d2");

    // Solving after a hint/miss clears the hint square, records "recovered", and shows PV continuation
    h.review.tryReviewMove("d2d4", preFen);
    expect(h.selectHintSquare).toHaveBeenLastCalledWith(null);
    expect(h.playCue).toHaveBeenCalledWith("right");
    expect(h.bar.innerHTML).toContain("d4 is the best move");
    expect(h.bar.innerHTML).toContain("Line: 2…exd4 3.Qxd4");
    expect(h.bar.innerHTML).toContain('data-pip="recovered"');
    expect(h.previewPosition.mock.calls.every(([arg]) => arg === null)).toBe(true);
  });

  it("renders dedicated recap summary with clickable red-vs-green board inspection, Follow-up PV, and Retry missed", async () => {
    vi.useFakeTimers();
    const moments = [
      engineMoment(3, "blunder", "d2d4"),
      engineMoment(5, "missed", "f1c4"),
      engineMoment(7, "mistake", "b5c6"),
    ];
    const h = harness(moments, {
      positionEvals: {
        [GAME[6].fen_before]: { best_move_uci: "b5c6", pv: ["b5c6", "d7c6", "f3e5"] },
      },
    });
    h.review.paint();
    await h.click("retry");

    // 1) Clean first-try solve on item 1
    h.review.tryReviewMove("d2d4", GAME[2].fen_before);
    await vi.advanceTimersByTimeAsync(700);
    await Promise.resolve();
    await Promise.resolve();

    // 2) Skip item 2
    await h.click("skip");
    expect(h.appState.analysisCurrentNodeId).toBe("m6");

    // 3) Show move on item 3 -> draws engine arrow, plays Follow-up PV, then playing or Continue finishes
    await h.click("show-move");
    expect(h.setHintArrow).toHaveBeenCalledWith("b5c6");
    expect(h.bar.innerHTML).toContain('data-review="follow-up"');
    await h.click("follow-up");
    await vi.advanceTimersByTimeAsync(700);
    expect(h.renderBoard).toHaveBeenLastCalledWith(expect.objectContaining({ lastMove: "f3e5" }));
    await h.click("continue");

    // Dedicated .cr-summary recap card with clickable rows, never hover-peek!
    expect(h.bar.innerHTML).toContain('class="cr-summary"');
    expect(h.bar.innerHTML).toContain("Practice complete");
    expect(h.bar.innerHTML).toContain("<b>1 / 3</b> first try");
    expect(h.bar.innerHTML).toContain("<b>2</b> missed");
    expect(h.bar.innerHTML).toContain("Retry missed (2)");
    // Focuses first missed item (index 1: 3.Bb5 vs Bc4) with red-vs-green comparison arrows
    expect(h.setComparisonArrows).toHaveBeenLastCalledWith(["Rf1b5", "Gf1c4"]);
    await h.click("inspect", 2);
    expect(h.setComparisonArrows).toHaveBeenLastCalledWith(["Rb5a4", "Gb5c6"]);
    expect(h.previewPosition.mock.calls.every(([arg]) => arg === null)).toBe(true);

    // Round 2 drills only the 2 missed exercises!
    await h.click("retry-missed");
    expect(h.bar.innerHTML).toContain("Retry · Round 2");
    expect(h.bar.innerHTML).toContain('<span class="train-count">1 / 2</span>');
    expect(h.appState.analysisCurrentNodeId).toBe("m4");
  });

  it("auto-orients the board for two-sided drills when selfSide is null and restores on exit", async () => {
    const moments = [engineMoment(3, "blunder", "d2d4"), engineMoment(8, "blunder", "b7b5")];
    const h = harness(moments, { selfSide: null });
    h.review.paint();
    await h.click("retry");
    expect(h.setOrientation).toHaveBeenLastCalledWith("white");

    await h.click("skip");
    expect(h.setOrientation).toHaveBeenLastCalledWith("black");

    await h.click("exit");
    expect(h.setOrientation).toHaveBeenLastCalledWith("white");
  });

  it("bridges a missed repertoire move directly into the training queue", async () => {
    const recordPrepMiss = vi.fn(async () => true);
    const h = harness([prepMoment(5, [{ uci: "f1c4", san: "Bc4" }])], {
      canTrainPrep: true,
      recordPrepMiss,
    });
    h.review.paint();
    await h.click("retry");
    await h.click("show-move");
    expect(h.bar.innerHTML).toContain("Add to training");

    await h.click("train-prep");
    expect(recordPrepMiss).toHaveBeenCalledWith(expect.objectContaining({
      repId: "rep-1",
      prescribedNodeId: "n-bc4",
    }));
    expect(h.bar.innerHTML).toContain("Added to Train");
  });

  it("describes castling hints as king safety", () => {
    const castleFen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    expect(describeRetryHint(castleFen, "e1g1")).toBe("Hint · Get your king to safety");
  });
});
