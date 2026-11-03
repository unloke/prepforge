import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrainSession } from "./train-session.js";
import { appState, boards } from "../core/state.js";
import { provideApp } from "../core/app-context.js";
import { invalidateAnalysisSource } from "./analyze-entry.js";

vi.mock("./train-home.js", async (importOriginal) => ({
  ...await importOriginal(),
  createTrainHome: () => ({ openTrain: vi.fn() }),
}));
vi.mock("../core/api.js", async (orig) => ({ ...await orig(), setStatus: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("Practice to Analyze account handoff", () => {
  it.each([
    ["white", "WhiteAccount", "WhiteAccount", "Maia 1500"],
    ["black", "BlackAccount", "Maia 1500", "BlackAccount"],
    ["white", undefined, "?", "Maia 1500"],
    ["black", "", "Maia 1500", "?"],
  ])("loads the %s player's PGN with account %s", async (userColor, lichessUsername, white, black) => {
    const input = { value: "" };
    const drawer = { open: false };
    vi.stubGlobal("document", {
      getElementById: (id) => ({ "pgn-input": input, "pgn-drawer": drawer })[id],
    });
    const loadPgnIntoAnalyze = vi.fn().mockResolvedValue(true);
    const runAnalysis = vi.fn().mockResolvedValue(undefined);
    const switchView = vi.fn();
    const setOrientation = vi.fn();
    Object.assign(appState, {
      lichessUsername,
      play: { userColor, book: "maia", rating: 1500, history: [{ san: "e4" }] },
    });
    boards.analysis = { setOrientation };
    provideApp({ loadPgnIntoAnalyze, switchView, runAnalysis });
    const session = createTrainSession();

    await session.openPlayInAnalyze();

    expect(input.value).toContain(`[White "${white}"]`);
    expect(input.value).toContain(`[Black "${black}"]`);
    expect(input.value).toContain("1. e4 *");
    expect(loadPgnIntoAnalyze).toHaveBeenCalledExactlyOnceWith(input.value, { goToEnd: false, quiet: true, sourceSeq: expect.any(Number) });
    expect(runAnalysis).toHaveBeenCalledTimes(1);
    expect(loadPgnIntoAnalyze.mock.invocationCallOrder[0]).toBeLessThan(runAnalysis.mock.invocationCallOrder[0]);
    expect(switchView).toHaveBeenCalledWith("analyze");
    expect(setOrientation).toHaveBeenCalledWith(userColor);
    expect(drawer.open).toBe(false);
  });

  it.each(["invalid", "rejected", "replaced", "owner"])("does not analyze a %s Practice handoff", async (failure) => {
    const input = { value: "" }, drawer = { open: false };
    vi.stubGlobal("document", { getElementById: (id) => ({ "pgn-input": input, "pgn-drawer": drawer })[id] });
    const runAnalysis = vi.fn();
    const loadPgnIntoAnalyze = vi.fn(async () => {
      if (failure === "rejected") throw new Error("parse failed");
      if (failure === "replaced") { input.value = "1. d4 *"; invalidateAnalysisSource(); }
      if (failure === "owner") appState.ownerGeneration++;
      return failure !== "invalid";
    });
    Object.assign(appState, { ownerGeneration: 1, play: { userColor: "white", book: "maia", history: [{ san: "e4" }] } });
    provideApp({ loadPgnIntoAnalyze, switchView: vi.fn(), runAnalysis });
    await createTrainSession().openPlayInAnalyze();
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("starts review after the move tree normalizes the PGN text", async () => {
    const input = { value: "" };
    vi.stubGlobal("document", { getElementById: (id) => id === "pgn-input" ? input : null });
    Object.assign(appState, { play: { userColor: "white", book: "maia", history: [{ san: "e4" }] } });
    const runAnalysis = vi.fn();
    provideApp({ switchView: vi.fn(), runAnalysis, loadPgnIntoAnalyze: vi.fn(async () => {
      input.value += "\n";
      return true;
    }) });
    await createTrainSession().openPlayInAnalyze();
    expect(runAnalysis).toHaveBeenCalledOnce();
  });
});
