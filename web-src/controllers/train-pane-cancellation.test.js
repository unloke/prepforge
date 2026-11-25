// Home's Drill / Practice tabs: a Random-position discovery belongs to the
// Practice pane, so leaving that pane cancels the run before its late
// position can open a game over the Drill rows. Retapping the current tab is
// not a switch, a live game is never the discovery's, and back on Practice
// the retry begins at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, setup } from "./train-home.fixture.js";
import { beginLuckyDiscovery, finishLuckyDiscovery, luckyDiscoveryCurrent } from "../train-lucky-control.js";
import { provideApp } from "../core/app-context.js";
vi.mock("../core/api.js", async (orig) => ({ ...await orig(), api: vi.fn(), localDateString: vi.fn() }));
vi.mock("../train-play.js", async (orig) => ({ ...await orig(), confirmAbandonGame: vi.fn() }));
vi.mock("./train-session.js", () => import("./train-session.fixture.js"));

let doc;
beforeEach(() => {
  doc = fakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => vi.unstubAllGlobals());

// A tap on the tab strip, as the container's click listener receives it.
const tapTab = (pane) => doc.getElementById("train-tabs").listeners.click({
  target: { closest: (sel) => (sel === ".seg-btn" ? { dataset: { pane } } : null) },
});

describe("leaving the Practice pane", () => {
  it("cancels the in-flight Random discovery: busy released, run aborted, session gate closed, banner cleared", () => {
    const setTrainBanner = vi.fn();
    const { appState } = setup({ currentView: "train", trainMode: "play", playStartToken: 1 });
    provideApp({ setTrainBanner });
    tapTab("play");
    const run = beginLuckyDiscovery(appState);
    expect(luckyDiscoveryCurrent(appState, run)).toBe(true);

    tapTab("drill");

    expect(appState.luckyRun).toBeNull();
    expect(appState.luckyBusy).toBe(false);
    expect(run.controller.signal.aborted).toBe(true);
    // The gate the discovery's startSession closure checks is closed, so the
    // late position cannot open its game over the Drill rows.
    expect(luckyDiscoveryCurrent(appState, run)).toBe(false);
    // The button frees immediately and the run's banner line is cleared.
    expect(doc.getElementById("feeling-lucky").disabled).toBe(false);
    expect(setTrainBanner).toHaveBeenCalledWith("move", "", "");
  });

  it("retapping the Practice tab keeps the discovery running", () => {
    const setTrainBanner = vi.fn();
    const { appState } = setup({ currentView: "train", trainMode: "play", playStartToken: 1 });
    provideApp({ setTrainBanner });
    tapTab("play");
    const run = beginLuckyDiscovery(appState);

    tapTab("play");

    expect(appState.luckyRun).toBe(run);
    expect(appState.luckyBusy).toBe(true);
    expect(run.controller.signal.aborted).toBe(false);
    expect(luckyDiscoveryCurrent(appState, run)).toBe(true);
    expect(setTrainBanner).not.toHaveBeenCalled();
  });

  it("a pane switch with no discovery running leaves the banner and a live game alone", () => {
    const setTrainBanner = vi.fn();
    const play = { active: true, history: ["e2e4"] };
    const { appState } = setup({ currentView: "train", trainMode: "play", play, playStartToken: 1 });
    provideApp({ setTrainBanner });

    tapTab("play");
    tapTab("drill");

    expect(appState.play).toBe(play);
    expect(setTrainBanner).not.toHaveBeenCalled();
  });

  it("back on Practice the retry begins at once and the canceled run cannot clear its replacement", () => {
    const { appState } = setup({ currentView: "train", trainMode: "play", playStartToken: 1 });
    tapTab("play");
    const first = beginLuckyDiscovery(appState);
    tapTab("drill");

    tapTab("play");
    const second = beginLuckyDiscovery(appState);

    expect(second).not.toBeNull();
    expect(appState.luckyBusy).toBe(true);
    finishLuckyDiscovery(appState, first);
    expect(appState.luckyRun).toBe(second);
    expect(luckyDiscoveryCurrent(appState, second)).toBe(true);
  });
});
