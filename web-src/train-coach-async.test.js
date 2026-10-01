import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { coachTipMayReplace, wrongMoveTip } from "./train-hint.js";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
function harness() {
  const prompt = {
    kind: "due", fen_before: "position", expected_uci: "e2e4", expected_san: "e4",
    expected_node_id: "node", hint: { strategy: "Take space", piece: "Move the pawn" },
    target: { fen_after: "after", san: "e4" }, legal_moves: ["e2e4", "d2d4"],
  };
  const smart = { prompt, attempt: 1, retriesFixed: 0 };
  const appState = { smart, trainHintLevel: 0, trainBusy: false,
    trainStats: { mistakes: 0, correct: 0, history: [], streak: 0, best: 0 } };
  const banner = { dataset: { state: "move" }, title: "Your move", sub: "Review" };
  const coach = deferred();
  const sleepGate = deferred();
  const deps = {
    appState, document: { getElementById: (id) => id === "train-banner" ? banner : { textContent: banner.title } },
    boards: { train: { setPosition: vi.fn(), setEngineArrow: vi.fn() } },
    setTrainBanner: (state, title, sub) => { banner.dataset.state = state; banner.title = title; banner.sub = sub; },
    maiaPhaseCoach: () => coach.promise, trainTeachLine: () => "", coachTipMayReplace, wrongMoveTip,
    clearBlitzTimer: vi.fn(), optimisticBoardMove: async () => {}, queueTrainAttempt: vi.fn(),
    renderTrainStats: async () => {}, boardAfterMove: async () => ({ board: { fen: "preview" } }),
    playSound: vi.fn(), sleep: () => sleepGate.promise,
  };
  return { appState, banner, coach, sleepGate, deps, prompt };
}

describe("Smart coach response ownership", () => {
  it("keeps a hint requested while the initial coach inference is pending", async () => {
    const h = harness();
    compile("function prefetchTrainCoach(", h.deps)(h.prompt);
    h.appState.trainHintLevel = 2;
    h.banner.title = "Hint 2 · Piece";
    h.banner.sub = "Move the pawn";
    h.coach.resolve({ promptTip: "Generic idea" });
    await Promise.resolve();
    expect(h.banner.title).toBe("Hint 2 · Piece");
    expect(h.banner.sub).toBe("Move the pawn");
    expect(h.prompt.phaseCoach).toEqual({ promptTip: "Generic idea" });
  });

  it.each(["correct", "reveal"])("does not replace the %s banner with an earlier miss", async (state) => {
    const h = harness();
    const submit = compile("async function submitSmartMove(", h.deps);
    const miss = submit("d2d4");
    await vi.waitFor(() => expect(h.banner.dataset.state).toBe("wrong"));
    h.sleepGate.resolve();
    await miss;
    h.banner.dataset.state = state;
    h.banner.title = state === "correct" ? "Got it this time" : "It's e4";
    h.banner.sub = "Current feedback";
    h.coach.resolve({ tip: "Earlier miss explanation" });
    await Promise.resolve();
    expect(h.banner.dataset.state).toBe(state);
    expect(h.banner.sub).toBe("Current feedback");
  });
});
