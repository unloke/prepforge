// Key-moment browsing and the ahead-only blind practice session.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";

import { createReviewBar, retryExercises } from "./analyze-review.js";
import { noteTriedGrade, noteUngraded } from "../analyze-tried-grade.js";
import { sanOf } from "../chess-local.js";
import { asSlices } from "../state/as-slices.fixture.js";

const START = new Chess().fen();
function movesOf(sans) {
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
    };
  });
}
const GAME = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6"]);
const labelOf = (move) => `${move.move_number}${move.side === "black" ? "…" : "."}${move.san}`;
function engineMoment(ply, grade, bestUci) {
  const move = GAME[ply - 1];
  return {
    ply, side: move.side, label: labelOf(move), grade, move,
    best: { uci: bestUci, san: sanOf(move.fen_before, bestUci) },
    departure: false, by: null, preparedMoves: [],
  };
}
function prepMoment(ply, answers, grade = "blunder") {
  const move = GAME[ply - 1];
  return {
    ply, side: move.side, label: labelOf(move), grade, move,
    best: { uci: "d2d4", san: "d4" }, departure: true, by: "you", preparedMoves: answers,
  };
}
const firstEngine = () => engineMoment(3, "blunder", "d2d4");
const secondEngine = () => engineMoment(7, "mistake", "b5c6");
const prep = (answers = [{ uci: "f1c4", san: "Bc4" }]) => prepMoment(5, answers);

function makeTree() {
  const root = { id: "root", isMainline: true, ply: 0, parent: null, children: [], fenAfter: START };
  const byId = new Map([["root", root]]);
  let prev = root;
  for (const move of GAME) {
    const node = {
      id: `m${move.ply}`, ply: move.ply, isMainline: true, parent: prev,
      uci: move.uci, san: move.san, fenBefore: move.fen_before, fenAfter: move.fen_after,
      moveNumber: move.move_number, side: move.side, children: [],
    };
    byId.set(node.id, node);
    prev.children.push(node);
    prev = node;
  }
  return { byId, root };
}

function setup(moments = [firstEngine(), secondEngine()], { selfSide = "white", selectPane = null } = {}) {
  let markup = "";
  const listeners = [];
  const bar = {
    hidden: true, dataset: {},
    addEventListener: vi.fn((_, fn) => listeners.push(fn)),
    contains: () => false,
    querySelector: () => null,
    get innerHTML() { return markup; }, set innerHTML(value) { markup = String(value); },
    replaceChildren() { markup = ""; },
  };
  const view = { dataset: {} };
  const runLabel = { textContent: "Review" };
  const runAttrs = {};
  const runButton = {
    dataset: {}, title: "",
    querySelector: (sel) => sel === ".bl" ? runLabel : null,
    addEventListener: vi.fn(),
    setAttribute: (name, value) => { runAttrs[name] = String(value); },
    removeAttribute: (name) => { delete runAttrs[name]; },
    getAttribute: (name) => runAttrs[name] ?? null,
  };
  globalThis.document = { getElementById: (id) => (id === "coach-review" ? bar : id === "view-analyze" ? view : id === "run-analysis" ? runButton : null), activeElement: null };
  const appState = { analysisTree: makeTree(), analysisCurrentNodeId: "root", analysisPly: 0, analysis: { id: "game" } };
  const calls = { show: [], select: [] };
  const previewPosition = vi.fn();
  const gradeAttempt = vi.fn();
  const review = createReviewBar({
    ...asSlices(appState),
    getReport: () => ({ moments, selfSide }),
    previewPosition,
    gradeAttempt,
    selectPane,
    showAnalysisPly: async (ply) => {
      calls.show.push(ply);
      appState.analysisCurrentNodeId = ply ? `m${ply}` : "root";
      appState.analysisPly = ply;
    },
    selectAnalysisNode: async (id) => {
      calls.select.push(id);
      appState.analysisCurrentNodeId = id;
      appState.analysisPly = id.startsWith("m") ? Number(id.slice(1)) : 0;
      return true;
    },
  });
  const at = (id, ply) => {
    appState.analysisCurrentNodeId = id;
    appState.analysisPly = ply;
    review.paint();
  };
  const click = async (kind) => {
    listeners[0]({ target: { closest: () => ({ dataset: { review: kind }, disabled: false, getAttribute: () => null }) } });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { bar, view, appState, calls, review, at, click, listeners, runButton, runLabel, previewPosition, gradeAttempt };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.document;
});

describe("retry exercise selection", () => {
  it("is strictly ahead, monotonic, own-side when known, and prep takes priority", () => {
    const moments = [firstEngine(), prep(), secondEngine()];
    expect(retryExercises(moments, 0, "white").map((m) => [m.ply, m.kind])).toEqual([[3, "engine"], [5, "prep"], [7, "engine"]]);
    expect(retryExercises(moments, 3, "white").map((m) => m.ply)).toEqual([5, 7]);
    expect(retryExercises(moments, 5, "white").map((m) => m.ply)).toEqual([7]);
    expect(retryExercises(moments, 7, "white")).toEqual([]);
    expect(retryExercises(moments, 8, "white")).toEqual([]);
    // Unknown-side analysis keeps the old ordinary engine behavior: either side can be drilled.
    expect(retryExercises(moments, 0, null).map((m) => [m.ply, m.kind])).toEqual([[3, "engine"], [5, "prep"], [7, "engine"]]);
    const opponent = { ...secondEngine(), ply: 4, side: "black" };
    expect(retryExercises([opponent], 0, "white")).toEqual([]);
    expect(retryExercises([opponent], 0, null)).toHaveLength(1);
  });
});

describe("ordinary key navigation", () => {
  it("clicking or Shift-stepping to a retryable key is normal navigation, never concealment", async () => {
    const h = setup();
    h.at("root", 0);
    await h.click("next");
    expect(h.calls.show).toEqual([3]);
    expect(h.view.dataset.reviewBlind).toBeUndefined();
    expect(h.bar.innerHTML).not.toContain("Show analysis");
    expect(h.bar.innerHTML).toContain("2.Nf3");
  });

  it("keeps a single key reachable before and after it, but disables the dead control on it", async () => {
    const h = setup([firstEngine()]);
    h.at("root", 0);
    expect(h.bar.innerHTML).toContain("Next key move: 2.Nf3");
    await h.click("next");
    expect(h.calls.show).toEqual([3]);
    h.review.paint();
    expect(h.bar.innerHTML).toContain("Only key move");
    expect(h.bar.innerHTML).toContain("2.Nf3");
    expect(h.bar.innerHTML).toMatch(/class="cr-control cr-preview[^>]*disabled/);
    expect(h.review.stepOrWrap()).toBe(false);
    expect(h.runLabel.textContent).toBe("Only key");
    expect(h.runButton.getAttribute("aria-disabled")).toBe("true");

    h.at("m4", 4);
    expect(h.bar.innerHTML).toContain("Back to key move: 2.Nf3");
    expect(h.runLabel.textContent).toBe("First key");
    await h.click("next");
    expect(h.calls.show).toEqual([3, 3]);
  });

  it("keeps Retry visible but disabled in a loaded game with no retryable positions", () => {
    const h = setup([]);
    h.at("root", 0);
    expect(h.bar.hidden).toBe(false);
    expect(h.bar.innerHTML).toContain("No key moves");
    expect(h.bar.innerHTML).toMatch(/data-review="retry"[^>]*disabled/);
    expect(h.bar.innerHTML).toContain("No more retry positions ahead");
    expect(h.runLabel.textContent).toBe("Review");
    expect(h.runButton.getAttribute("aria-disabled")).toBeNull();
  });

  it("lets a forced Find great moves rerun through while intercepting the dead only-key primary", () => {
    const h = setup([firstEngine()]);
    h.at("m3", 3);
    expect(h.runButton.getAttribute("aria-disabled")).toBe("true");
    const listener = h.runButton.addEventListener.mock.calls.find(([type]) => type === "click")?.[1];
    expect(listener).toBeTypeOf("function");

    h.runButton.dataset.forceReview = "1";
    const forced = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    listener(forced);
    expect(forced.preventDefault).not.toHaveBeenCalled();
    expect(forced.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(h.runButton.dataset.forceReview).toBeUndefined();

    const dead = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    listener(dead);
    expect(dead.preventDefault).toHaveBeenCalled();
    expect(dead.stopImmediatePropagation).toHaveBeenCalled();
  });
});

describe("ahead-only retry sessions", () => {
  it("from before the first key starts at the next pre-position and conceals analysis", async () => {
    const h = setup();
    h.at("root", 0);
    await h.click("retry");
    expect(h.calls.select).toEqual(["m2"]);
    expect(h.view.dataset.reviewBlind).toBe("1");
    expect(h.bar.innerHTML).toContain("What would you play here?");
    expect(h.bar.innerHTML).toContain('data-state="move"');
    expect(h.bar.innerHTML).toContain('aria-label="White to move"');
    expect(h.bar.innerHTML).toContain('aria-valuenow="0"');
    expect(h.bar.innerHTML).toContain('<span class="train-count">1 / 2</span>');
    expect(h.bar.innerHTML).not.toContain("d4 is the best move");
  });

  it("from the middle or exactly on an exercise starts only after it; at the end Retry stays disabled", async () => {
    const middle = setup();
    middle.at("m4", 4);
    await middle.click("retry");
    expect(middle.calls.select).toEqual(["m6"]);
    expect(middle.bar.innerHTML).toContain("1 / 1");

    const equal = setup();
    equal.at("m3", 3);
    await equal.click("retry");
    expect(equal.calls.select).toEqual(["m6"]);

    const end = setup();
    end.at("m7", 7);
    expect(end.bar.innerHTML).toMatch(/data-review="retry"[^>]*disabled/);
    expect(end.bar.innerHTML).toContain("No more retry positions ahead");
  });

  it("a wrong original move is answer-free feedback and the board is ready for another guess", async () => {
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    const preFen = GAME[2].fen_before;
    expect(h.review.tryReviewMove("g1f3", preFen)).toBe(true);
    expect(h.bar.innerHTML).toContain("What else would you try?");
    expect(h.bar.innerHTML).toContain('data-state="wrong"');
    expect(h.bar.innerHTML).not.toContain("d4");
    expect(h.gradeAttempt).not.toHaveBeenCalled();
    expect(h.previewPosition).toHaveBeenLastCalledWith(null);

    expect(h.review.tryReviewMove("d2d4", preFen)).toBe(true);
    expect(h.bar.innerHTML).toContain("d4 is the best move");
  });

  it("engine-only guesses use the ephemeral grade hook, reject worse moves and accept equivalent ones", async () => {
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    const preFen = GAME[2].fen_before;
    expect(h.review.tryReviewMove("c2c4", preFen)).toBe(true);
    expect(h.bar.innerHTML).toContain("Checking that move…");
    expect(h.gradeAttempt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ prevFen: preFen, lastUci: "c2c4", ply: null }));
    noteTriedGrade(preFen, "c2c4", "mistake");
    await tick();
    expect(h.bar.innerHTML).toContain("What else would you try?");

    expect(h.review.tryReviewMove("a2a3", preFen)).toBe(true);
    noteTriedGrade(preFen, "a2a3", "great");
    await tick();
    expect(h.bar.innerHTML).toContain("As good as d4");
    expect(h.previewPosition).toHaveBeenCalledWith(expect.objectContaining({ lastMove: "a2a3" }));
  });

  it("ordinary good is not equivalent, and an ungraded read ends without hanging", async () => {
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    const preFen = GAME[2].fen_before;
    h.review.tryReviewMove("g2g3", preFen);
    noteTriedGrade(preFen, "g2g3", "good");
    await tick();
    expect(h.bar.innerHTML).toContain("What else would you try?");
    h.review.tryReviewMove("b2b3", preFen);
    noteUngraded({ prevFen: preFen, lastUci: "b2b3" });
    await tick();
    expect(h.bar.innerHTML).toContain("Not graded");
    expect(h.bar.innerHTML).toContain("Show move");
  });
});

describe("preparation exercises", () => {
  it("asks the repertoire question, rejects even an engine-best non-book move, and accepts any prepared answer", async () => {
    vi.useFakeTimers();
    const moment = prep([{ uci: "f1c4", san: "Bc4" }, { uci: "d2d3", san: "d3" }]);
    const h = setup([moment]);
    h.at("root", 0);
    await h.click("retry");
    const preFen = GAME[4].fen_before;
    expect(h.bar.innerHTML).toContain("Which move did you prepare here?");
    const childCount = h.appState.analysisTree.byId.get("m4").children.length;

    expect(h.review.tryReviewMove("d2d4", preFen)).toBe(true);
    expect(h.bar.innerHTML).toContain("That&#39;s not in your repertoire. What did you prepare?");
    expect(h.gradeAttempt).not.toHaveBeenCalled();
    expect(h.appState.analysisTree.byId.get("m4").children).toHaveLength(childCount);

    expect(h.review.tryReviewMove("d2d3", preFen)).toBe(true);
    expect(h.bar.innerHTML).toContain("d3 is a prepared move");
    expect(h.bar.innerHTML).not.toContain("best move");
    expect(h.previewPosition).toHaveBeenCalledWith(expect.objectContaining({ lastMove: "d2d3" }));
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(h.bar.innerHTML).toContain("Practice complete");
    expect(h.bar.innerHTML).toContain('data-state="done"');
    expect(h.bar.innerHTML).toContain('<span class="train-count">1 / 1</span>');
    expect(h.bar.innerHTML).toContain('aria-valuenow="1"');
    expect(h.bar.innerHTML).not.toContain('data-review="continue"');
    expect(h.view.dataset.reviewBlind).toBe("1");
  });

  it("explicit reveal names prepared moves without calling them best, then Continue advances", async () => {
    const moment = prep([{ uci: "f1c4", san: "Bc4" }, { uci: "d2d3", san: "d3" }]);
    const h = setup([moment, secondEngine()]);
    h.at("root", 0);
    await h.click("retry");
    await h.click("show-move");
    expect(h.bar.innerHTML).toContain("Your repertoire: Bc4 / d3");
    expect(h.bar.innerHTML).toContain('data-state="reveal"');
    expect(h.bar.innerHTML).not.toContain('aria-label="White to move"');
    expect(h.bar.innerHTML).not.toContain("Best move");
    expect(h.previewPosition).toHaveBeenCalledWith(expect.objectContaining({ lastMove: "f1c4" }));
    await h.click("continue");
    expect(h.calls.select).toEqual(["m4", "m6"]);
    expect(h.bar.innerHTML).toContain("What would you play here?");
  });
});

describe("session progression and cancellation", () => {
  it("automatically advances after correct answers and finishes once", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.at("root", 0);
    await h.click("retry");
    h.review.tryReviewMove("d2d4", GAME[2].fen_before);
    expect(h.bar.innerHTML).toContain("d4 is the best move");
    expect(h.bar.innerHTML).toContain('data-state="correct"');
    expect(h.bar.innerHTML).toContain('aria-valuenow="1"');
    expect(h.bar.innerHTML).not.toContain('aria-label="White to move"');
    expect(h.bar.innerHTML).not.toContain("2.Nf3 · 1 / 2");
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(h.calls.select).toEqual(["m2", "m6"]);
    expect(h.bar.innerHTML).toContain('aria-label="White to move"');
    expect(h.bar.innerHTML).toContain('<span class="train-count">2 / 2</span>');
    expect(h.bar.innerHTML).toContain('aria-valuenow="1"');
    expect(h.bar.innerHTML).toContain('data-state="move"');

    h.review.tryReviewMove("b5c6", GAME[6].fen_before);
    expect(h.bar.innerHTML).toContain("Bxc6 is the best move");
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(h.bar.innerHTML).toContain("Practice complete");
    expect(h.bar.innerHTML).toContain('data-state="done"');
    expect(h.bar.innerHTML).toContain('aria-valuenow="2"');
    expect(h.bar.innerHTML).toContain('<span class="train-count">2 / 2</span>');
    expect(h.bar.innerHTML).toContain("Back to analysis");
    expect(h.view.dataset.reviewBlind).toBe("1");
  });

  it("Back to analysis leaves the completed session at the final game move", async () => {
    vi.useFakeTimers();
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    h.review.tryReviewMove("d2d4", GAME[2].fen_before);
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    await h.click("back-analysis");
    expect(h.calls.show).toContain(3);
    expect(h.view.dataset.reviewBlind).toBeUndefined();
  });

  it("manual navigation and exit cancel timers, previews and stale grade callbacks", async () => {
    vi.useFakeTimers();
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    h.review.tryReviewMove("d2d4", GAME[2].fen_before);
    expect(h.bar.innerHTML).toContain("d4 is the best move");
    h.review.endReview();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(h.calls.select).toEqual(["m2"]);
    expect(h.view.dataset.reviewBlind).toBeUndefined();
    expect(h.previewPosition).toHaveBeenLastCalledWith(null);
    noteTriedGrade(GAME[2].fen_before, "c2c4", "best");
    await tick();
    expect(h.gradeAttempt).not.toHaveBeenCalled();
  });

  it("swallows stale board input while entering, advancing and complete", async () => {
    vi.useFakeTimers();
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    h.review.paint();
    const childCount = () => h.appState.analysisTree.byId.get("m2").children.length;
    h.listeners[0]({ target: { closest: () => ({ dataset: { review: "retry" }, disabled: false, getAttribute: () => null }) } });
    expect(h.review.tryReviewMove("d2d4", GAME[2].fen_before)).toBe(true);
    expect(childCount()).toBe(1);
    await tick();
    expect(h.bar.innerHTML).toContain("What would you play here?");

    h.review.tryReviewMove("d2d4", GAME[2].fen_before);
    expect(h.bar.innerHTML).toContain("d4 is the best move");
    expect(h.review.tryReviewMove("e2e4", GAME[2].fen_before)).toBe(true);
    expect(childCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(h.bar.innerHTML).toContain("Practice complete");
    expect(h.review.tryReviewMove("d2d4", GAME[2].fen_before)).toBe(true);
    expect(childCount()).toBe(1);
  });

  it("keeps the last answer focused until Back, while manual navigation cancels completion", async () => {
    vi.useFakeTimers();
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    h.review.tryReviewMove("d2d4", GAME[2].fen_before);
    await vi.advanceTimersByTimeAsync(700);
    await tick();
    expect(h.bar.innerHTML).toContain("Practice complete");
    expect(h.view.dataset.reviewBlind).toBe("1");
    expect(h.previewPosition).toHaveBeenLastCalledWith(expect.objectContaining({ lastMove: "d2d4" }));

    h.at("root", 0);
    expect(h.view.dataset.reviewBlind).toBeUndefined();
    expect(h.bar.innerHTML).toContain("Retry");
    expect(h.previewPosition).toHaveBeenLastCalledWith(null);
  });

  it("a quick step with no target restores ordinary controls at the drill position", async () => {
    const h = setup([firstEngine()], { selfSide: null });
    h.at("root", 0);
    await h.click("retry");
    h.review.step("prev");
    await tick();
    expect(h.view.dataset.reviewBlind).toBeUndefined();
    expect(h.bar.innerHTML).toContain("data-review=\"retry\"");
    expect(h.bar.innerHTML).toContain("2.Nf3");
    expect(h.calls.select).toEqual(["m2", "m2"]);
  });

  it("quick navigation exits an active drill before navigating", async () => {
    const h = setup();
    h.at("root", 0);
    await h.click("retry");
    h.review.step("next");
    await tick();
    expect(h.view.dataset.reviewBlind).toBeUndefined();
    expect(h.calls.show.length).toBeGreaterThan(0);
  });

  it("selects the coach pane on phone only for Retry, not ordinary key navigation", async () => {
    vi.stubGlobal("innerWidth", 390);
    const selectPane = vi.fn();
    const h = setup([firstEngine()], { selectPane });
    h.at("root", 0);
    h.review.stepOrWrap();
    await tick();
    expect(selectPane).not.toHaveBeenCalled();
    h.at("root", 0);
    await h.click("retry");
    expect(selectPane).toHaveBeenCalledWith("coach", { store: false });
    vi.unstubAllGlobals();
  });
});

describe("blind retry board tint", () => {
  it("neutralizes the previous move grade only while the drill is concealed", () => {
    const css = readFileSync(new URL("./analyze/panel.css", import.meta.url), "utf8");
    expect(css).toContain("#view-analyze[data-review-blind] #analysis-board");
    expect(css).toContain("--move-light: var(--last-move)");
    expect(css).toContain("--move-dark: var(--last-move)");
  });
});
