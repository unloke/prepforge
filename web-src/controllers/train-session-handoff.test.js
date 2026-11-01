import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrainSession } from "./train-session.js";
import { appState, boards } from "../core/state.js";
import { provideApp } from "../core/app-context.js";

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
    const loadPgnIntoAnalyze = vi.fn().mockResolvedValue(undefined);
    const switchView = vi.fn();
    const setOrientation = vi.fn();
    Object.assign(appState, {
      lichessUsername,
      play: { userColor, book: "maia", rating: 1500, history: [{ san: "e4" }] },
    });
    boards.analysis = { setOrientation };
    provideApp({ loadPgnIntoAnalyze, switchView });
    const session = createTrainSession();

    await session.openPlayInAnalyze();

    expect(input.value).toContain(`[White "${white}"]`);
    expect(input.value).toContain(`[Black "${black}"]`);
    expect(input.value).toContain("1. e4 *");
    expect(loadPgnIntoAnalyze).toHaveBeenCalledExactlyOnceWith(input.value, { goToEnd: true, quiet: true });
    expect(switchView).toHaveBeenCalledWith("analyze");
    expect(setOrientation).toHaveBeenCalledWith(userColor);
    expect(drawer.open).toBe(true);
  });
});
