import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { wrongMoveBanner } from "./train-hint.js";

// The sounds a Train answer makes, run from the real source: the board's landing
// must stay quiet when the graded cue follows it, and a New move's demonstration
// must keep the board's own move sound instead of reading as a success.
const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness({ kind = "due", correct = true } = {}) {
  const prompt = {
    kind,
    fen_before: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    expected_uci: "g1f3",
    expected_node_id: "n1",
    target: {
      uci: "g1f3",
      san: "Nf3",
      fen_after: "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      reply: null,
    },
  };
  const smart = { prompt, attempt: 1, retriesFixed: 0, queue: [], cardIndex: 0, targetIndex: 0, cardsDone: 0 };
  const appState = {
    smart,
    trainHintLevel: 0,
    trainBusy: false,
    trainStats: { correct: 0, mistakes: 0, skipped: 0, streak: 0, best: 0, history: [] },
    play: null,
    training: null,
  };
  const setPosition = vi.fn();
  const playSound = vi.fn();
  const optimisticBoardMove = vi.fn(async () => true);
  const sleepGate = deferred();
  const noop = () => {};
  const deps = {
    appState,
    boards: { train: { setPosition, setEngineArrow: vi.fn() } },
    document: { getElementById: () => ({ textContent: "", dataset: {}, style: {}, hidden: false }) },
    setTrainBanner: vi.fn(),
    maiaPhaseCoach: () => deferred().promise,
    trainTeachLine: () => "",
    coachTipMayReplace: () => false,
    wrongMoveTip: () => "",
    clearBlitzTimer: noop,
    optimisticBoardMove,
    queueTrainAttempt: noop,
    trackPreparationPractice: noop,
    wrongMoveBanner,
    renderTrainStats: async () => {},
    boardAfterMove: async (fen, uci) => ({
      board: { fen: `after-${uci}` },
      move: { san: "Nf3" },
    }),
    playSound,
    sleep: () => sleepGate.promise,
    rememberSmartSession: noop,
    renderTraining: async () => {},
    // The tail of the answer belongs to the session report, which has its own
    // tests: everything below it is stubbed so this test sees only the sounds.
    finishSmartSession: noop,
    syncTrainSessionControls: noop,
    updateTrainTurnBadge: noop,
    clearBlitzTimerFinally: noop,
    setBlitzBarVisible: noop,
    setStatus: noop,
    setTrainHintLine: noop,
    invalidateTrainSessionPreview: noop,
    markTrainPositionDirty: noop,
    requeueSmartCard: () => false,
    renderSmartQueueStrip: noop,
    smartLocalPrompt: () => null,
    presentSmartPrompt: async () => {},
    skipSmartCard: noop,
    smartHint: noop,
    showSmartSummary: noop,
    renderSmartSummaryStats: async () => {},
    smartSessionOutcomeText: () => "",
    celebrate: noop,
    flushTrainSync: async () => {},
    api: async () => ({}),
    localDateString: () => "2026-10-20",
    renderSmartSummary: noop,
    refreshRepertoireHead: noop,
    refreshDashboardRepertoires: noop,
    paintTrainStartDisabled: noop,
    refreshTrainSessionPreview: noop,
    currentOwnerId: () => "u1",
    trainSessionMemo: null,
  };
  return { deps, prompt, setPosition, playSound, optimisticBoardMove, sleepGate, appState, correct };
}

async function playAnswer(h, uci) {
  const submit = compile("async function submitSmartMove(", h.deps);
  const pending = submit(uci);
  // Let the landing and its cue happen, then release the animation sleeps so
  // the call can finish.
  await vi.waitFor(() => expect(h.setPosition).toHaveBeenCalled());
  h.sleepGate.resolve();
  await pending;
}

describe("Train answer sounds", () => {
  it("plays the success cue instead of a second, bare move sound", async () => {
    const h = harness();
    await playAnswer(h, "g1f3");
    expect(h.playSound.mock.calls.map(([cue]) => cue)).toEqual(["right"]);
    // Both the optimistic landing and the authoritative render stay silent:
    // each names the cue the answer owns.
    expect(h.optimisticBoardMove).toHaveBeenCalled();
    expect(h.optimisticBoardMove.mock.calls[0][3]).toBe(false);
    const landings = h.setPosition.mock.calls.map(([arg]) => arg.cue);
    expect(landings.length).toBeGreaterThan(0);
    expect(landings.every((cue) => cue === false || cue === undefined)).toBe(true);
    expect(landings).toContain(false);
  });

  it("plays the wrong cue, once, for a miss", async () => {
    const h = harness({ correct: false });
    await playAnswer(h, "d2d4");
    expect(h.playSound.mock.calls.map(([cue]) => cue)).toEqual(["wrong"]);
    expect(h.optimisticBoardMove.mock.calls[0][3]).toBe(false);
  });

  it("keeps the board's move sound for a New move's demonstration", async () => {
    const h = harness({ kind: "new" });
    await playAnswer(h, "g1f3");
    expect(h.playSound.mock.calls.map(([cue]) => cue)).toEqual([]);
    const landing = h.setPosition.mock.calls.find(([arg]) => arg.lastMove === "g1f3");
    expect(landing[0].cue).toBeUndefined();
  });

  it("counts only a scored miss answered on the free retry as fixed on retry", async () => {
    for (const [kind, attempt, fixed] of [["due", 2, 1], ["due", 3, 0], ["new", 2, 0]]) {
      const h = harness({ kind });
      h.appState.smart.attempt = attempt;
      await playAnswer(h, "g1f3");
      expect([kind, attempt, h.appState.smart.retriesFixed]).toEqual([kind, attempt, fixed]);
    }
  });
});
