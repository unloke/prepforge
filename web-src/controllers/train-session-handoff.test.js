// Practice → Analyze: Train hands the finished game over by intent
// (handoffs.openAnalyzeGame) and Analyze owns loading and reviewing it, so Train
// never reaches into Analyze's loader or runner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrainSession } from "./train-session.js";
import { appState, boards, trainState } from "../core/state.js";
import { provideApp } from "../core/app-context.js";
import { createAnalyzeEntry, invalidateAnalysisSource, openAnalyzeGame } from "./analyze-entry.js";
import { setStatusError } from "../core/api.js";

vi.mock("./train-home.js", async (importOriginal) => ({
  ...await importOriginal(),
  createTrainHome: () => ({ openTrain: vi.fn() }),
}));
vi.mock("../core/api.js", async (orig) => ({ ...await orig(), setStatus: vi.fn(), setStatusError: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

const practiceGame = {
  pgn: "1. e4 *", orientation: "white",
  failure: "Could not load this Practice game. Try Analyze game again.",
  loading: "Loaded this Practice game · analyzing",
};

describe("Practice hands its game to Analyze", () => {
  it.each([
    ["white", "WhiteAccount", "WhiteAccount", "Maia 1500"],
    ["black", "BlackAccount", "Maia 1500", "BlackAccount"],
    ["white", undefined, "?", "Maia 1500"],
    ["black", "", "Maia 1500", "?"],
  ])("as the %s player with account %s", async (userColor, lichessUsername, white, black) => {
    const open = vi.fn(async () => {});
    provideApp({ handoffs: { openAnalyzeGame: open } });
    appState.lichessUsername = lichessUsername;
    trainState.play = { userColor, book: "maia", rating: 1500, history: [{ san: "e4" }] };

    await createTrainSession().openPlayInAnalyze();

    expect(open).toHaveBeenCalledOnce();
    const [{ pgn, ...rest }] = open.mock.calls[0];
    expect(pgn).toContain(`[White "${white}"]`);
    expect(pgn).toContain(`[Black "${black}"]`);
    expect(pgn).toContain("1. e4 *");
    expect(rest).toEqual({ orientation: userColor, failure: practiceGame.failure, loading: practiceGame.loading });
  });

  it("hands nothing over for a game with no moves", async () => {
    const open = vi.fn();
    provideApp({ handoffs: { openAnalyzeGame: open } });
    await createTrainSession().openPlayInAnalyze({ history: [] });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("Analyze opens a handed-over game", () => {
  function setup({ loadPgnIntoAnalyze, input = { value: "" }, drawer = { open: true } } = {}) {
    vi.stubGlobal("document", { getElementById: (id) => ({ "pgn-input": input, "pgn-drawer": drawer })[id] || null });
    const switchView = vi.fn(), runAnalysis = vi.fn(async () => {}), setOrientation = vi.fn();
    boards.analysis = { setOrientation };
    appState.ownerGeneration = 1;
    provideApp({ shell: { switchView, syncViewHeads: vi.fn() } });
    loadPgnIntoAnalyze ||= vi.fn(async () => true);
    createAnalyzeEntry({ loadPgnIntoAnalyze, runAnalysis });
    setStatusError.mockClear();
    return { input, drawer, switchView, runAnalysis, setOrientation, loadPgnIntoAnalyze };
  }

  it("loads the PGN, then reviews it, on the player's side", async () => {
    const h = setup();
    await openAnalyzeGame({ ...practiceGame, orientation: "black" });
    expect(h.input.value).toBe("1. e4 *");
    expect(h.drawer.open).toBe(false);
    expect(h.switchView).toHaveBeenCalledWith("analyze");
    expect(h.setOrientation).toHaveBeenCalledWith("black");
    expect(h.loadPgnIntoAnalyze).toHaveBeenCalledExactlyOnceWith("1. e4 *", { goToEnd: false, quiet: true, sourceSeq: expect.any(Number) });
    expect(h.runAnalysis).toHaveBeenCalledOnce();
    expect(h.loadPgnIntoAnalyze.mock.invocationCallOrder[0]).toBeLessThan(h.runAnalysis.mock.invocationCallOrder[0]);
  });

  it.each(["invalid", "rejected", "replaced", "owner"])("does not review a %s handoff", async (failure) => {
    const input = { value: "" };
    const h = setup({ input, loadPgnIntoAnalyze: vi.fn(async () => {
      if (failure === "rejected") throw new Error("parse failed");
      if (failure === "replaced") { input.value = "1. d4 *"; invalidateAnalysisSource(); }
      if (failure === "owner") appState.ownerGeneration++;
      return failure !== "invalid";
    }) });
    await openAnalyzeGame(practiceGame);
    expect(h.runAnalysis).not.toHaveBeenCalled();
    if (failure === "invalid") expect(setStatusError).toHaveBeenCalledWith(practiceGame.failure);
    if (failure === "rejected") expect(setStatusError).toHaveBeenCalledWith("parse failed");
    if (failure === "replaced" || failure === "owner") expect(setStatusError).not.toHaveBeenCalled();
  });

  it("starts review after the move tree normalizes the PGN text", async () => {
    const input = { value: "" };
    const h = setup({ input, loadPgnIntoAnalyze: vi.fn(async () => { input.value += "\n"; return true; }) });
    await openAnalyzeGame(practiceGame);
    expect(h.runAnalysis).toHaveBeenCalledOnce();
  });
});
