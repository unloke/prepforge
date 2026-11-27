import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, setup } from "./train-home.fixture.js";
import { createTrainHome, loadTrainRepertoireOptions } from "./train-home.js";
import { provideApp } from "../core/app-context.js";
vi.mock("../core/api.js", async (orig) => ({ ...await orig(), api: vi.fn(), localDateString: vi.fn() }));
vi.mock("../train-play.js", async (orig) => ({ ...await orig(), confirmAbandonGame: vi.fn() }));
vi.mock("./train-session.js", () => import("./train-session.fixture.js"));
vi.mock("../account-entry.js", async (orig) => ({ ...await orig(), requireSignIn: vi.fn() }));
vi.mock("../train-banner.js", () => ({ setTrainBanner: vi.fn(), updateTrainTurnBadge: vi.fn() }));

let doc;
beforeEach(() => {
  doc = fakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => vi.unstubAllGlobals());

describe("Train Home ownership across awaits", () => {
  it("does not let a late back invalidate a newer Train entry", async () => {
    const { appState, deps } = setup({ currentView: "train", trainMode: "smart", smart: { prompt: {} }, trainEntryVersion: 4 });
    let finishFlush;
    const flushing = new Promise((done) => { finishFlush = done; });
    const flush = vi.fn(() => flushing);
    provideApp({ persistence: { flushTrainSync: flush } });
    const home = createTrainHome(deps);
    const leaving = home.leaveToHome();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    const opening = home.openTrain({ mode: "smart", repertoireId: "r1" });
    expect(appState.trainEntryVersion).toBe(5);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));

    finishFlush(true);
    await leaving;
    await opening;

    expect(deps.startTraining).toHaveBeenCalledWith("smart", expect.objectContaining({ repertoireId: "r1" }));
    expect(appState.trainEntryVersion).toBe(5);
  });

  it("does not finish a back after Train itself was left", async () => {
    const smart = { prompt: {} };
    const { appState, deps } = setup({ currentView: "train", trainMode: "smart", smart, trainEntryVersion: 4 });
    let finishFlush;
    const flushing = new Promise((done) => { finishFlush = done; });
    const flush = vi.fn(() => flushing);
    provideApp({ persistence: { flushTrainSync: flush } });
    const home = createTrainHome(deps);
    const leaving = home.leaveToHome();
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());

    deps.switchView("games");
    finishFlush(true);
    await leaving;

    expect(appState.smart).toBe(smart);
    expect(deps.resetTrainBoardIdle).not.toHaveBeenCalled();
  });

  it("keeps the new account's listing loading when the prior account's request fails", async () => {
    const { appState, deps } = setup({ currentView: "train", repertoireList: [], sharedRepertoireList: [], repertoireListGeneration: -1 });
    let rejectOld;
    let resolveNew;
    deps.api.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    deps.api.mockImplementationOnce(() => new Promise((done) => { resolveNew = done; }));
    const old = loadTrainRepertoireOptions();
    appState.accountUserId = "u2";
    appState.ownerGeneration = 8;
    const next = loadTrainRepertoireOptions();

    rejectOld(new Error("A has a listing error"));
    await old;

    expect(appState.trainRepertoireOptionsError).toBe("");
    expect(doc.getElementById("train-due-retry").hidden).toBe(true);
    expect(doc.getElementById("train-home").getAttribute("aria-busy")).toBe("true");
    resolveNew({ repertoires: [], shared: [] });
    await next;
  });
});
