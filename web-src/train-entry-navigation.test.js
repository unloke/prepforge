import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { beginLuckyDiscovery, cancelLuckyDiscovery } from "./train-lucky-control.js";

const source = appSource();

function wrapperRuntime() {
  const appState = {};
  const train = { openTrain: vi.fn(async () => true) };
  const loadTrainSession = vi.fn(async () => train);
  const invalidateTrainEntries = () => { appState.trainEntryVersion = (appState.trainEntryVersion || 0) + 1; };
  const start = source.indexOf("const openTrain = (options = {}) =>");
  const body = source.slice(start, source.indexOf("\nconst submitTrainingMove", start));
  const openTrain = new Function("appState", "loadTrainSession", "invalidateTrainEntries", `${body}; return openTrain;`)(appState, loadTrainSession, invalidateTrainEntries);
  return { appState, train, loadTrainSession, openTrain, invalidateTrainEntries };
}

describe("Train entry navigation ordering", () => {
  it("the newest scoped action is the only one whose guard stays valid", async () => {
    const { train, openTrain } = wrapperRuntime();
    const first = openTrain({ mode: "smart", repertoireId: "r1" });
    await vi.waitFor(() => expect(train.openTrain).toHaveBeenCalledTimes(1));
    const second = openTrain({ mode: "smart", repertoireId: "r2" });
    await vi.waitFor(() => expect(train.openTrain).toHaveBeenCalledTimes(2));
    expect(train.openTrain.mock.calls[0][0].isCurrent()).toBe(false);
    expect(train.openTrain.mock.calls[1][0].isCurrent()).toBe(true);
    await Promise.all([first, second]);
  });

  it("navigation invalidation reaches a route-specific entry guard", async () => {
    const { openTrain, train, invalidateTrainEntries } = wrapperRuntime();
    let routeActive = true;
    void openTrain({ mode: "smart", repertoireId: "r1", isCurrent: () => routeActive });
    await vi.waitFor(() => expect(train.openTrain).toHaveBeenCalled());
    invalidateTrainEntries();
    expect(routeActive).toBe(true);
    expect(train.openTrain.mock.calls[0][0].isCurrent()).toBe(false);
  });

  it("publishes the entry version before the lazy session load starts", async () => {
    const { appState, openTrain } = wrapperRuntime();
    const opening = openTrain({ mode: "smart", repertoireId: "r1" });
    expect(appState.trainEntryVersion).toBe(1);
    await opening;
  });

  it("does not invoke a Train entry invalidated while its lazy chunk was loading", async () => {
    const { openTrain, train, loadTrainSession, invalidateTrainEntries } = wrapperRuntime();
    let finishLoad;
    loadTrainSession.mockReturnValueOnce(new Promise((done) => { finishLoad = done; }));
    const pending = openTrain({ mode: "play", autostart: false });
    invalidateTrainEntries();
    finishLoad(train);
    await expect(pending).resolves.toBe(false);
    expect(train.openTrain).not.toHaveBeenCalled();
  });

  it("an old entry settling cannot clear the newer pending route", async () => {
    const { appState, train, openTrain } = wrapperRuntime();
    const finish = [];
    train.openTrain.mockImplementation(() => new Promise((done) => finish.push(done)));
    const first = openTrain({ mode: "smart", repertoireId: "r1" });
    await vi.waitFor(() => expect(train.openTrain).toHaveBeenCalledTimes(1));
    const second = openTrain({ mode: "smart", repertoireId: "r2" });
    await vi.waitFor(() => expect(train.openTrain).toHaveBeenCalledTimes(2));
    expect(appState.trainPendingRoute).toEqual({ repertoireId: "r2", trainMode: "smart" });
    finish[0]();
    await first;
    expect(appState.trainPendingRoute).toEqual({ repertoireId: "r2", trainMode: "smart" });
    finish[1]();
    await second;
    expect(appState.trainPendingRoute).toBeUndefined();
  });

  it("plain Train navigation centrally cancels a pending scoped route and start state", () => {
    expect(source).toContain('if (name !== "train" || name === "train" && !appState.trainEntering)');
    expect(source).toContain("cancelActiveTrainStart();");
    expect(source).toContain("delete appState.trainPendingRoute;");
  });

  it("Train this repertoire enters the guarded wrapper before waiting on Build sync", async () => {
    const start = source.indexOf("async function trainRepertoire(");
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    expect(body).not.toContain("await hardFlushBuild");
    const openTrain = vi.fn(async () => {});
    const run = new Function("openTrain", `return (${body});`)(openTrain);
    await run("r1", { targetNodeIds: ["n1"] });
    expect(openTrain).toHaveBeenCalledWith({ mode: "smart", repertoireId: "r1", targets: ["n1"] });
  });

  it("navigation cancellation clears the transient start and repaints Home immediately", async () => {
    const start = source.indexOf("function cancelActiveTrainStart(");
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const appState = { trainStarting: true, trainStartToken: {}, playStarting: Promise.resolve(), playStartToken: 7 };
    const train = { syncTrainControls: vi.fn() };
    const setTrainBanner = vi.fn();
    const boards = { train: { setPremove: vi.fn() } };
    const cancel = new Function("appState", "setTrainBanner", "trainSessionLoading", "boards", "cancelLuckyDiscovery", `${body}; return cancelActiveTrainStart;`)(appState, setTrainBanner, Promise.resolve(train), boards, cancelLuckyDiscovery);
    cancel();
    expect(appState.trainStarting).toBe(false);
    expect(appState.trainStartToken).toBeNull();
    expect(appState.playStarting).toBeNull();
    expect(appState.playStartToken).toBe(8);
    expect(boards.train.setPremove).toHaveBeenCalledWith(null);
    expect(setTrainBanner).toHaveBeenCalledWith("move", "", "");
    await vi.waitFor(() => expect(train.syncTrainControls).toHaveBeenCalled());
  });

  it("navigation cancellation releases Random discovery before the old work settles", () => {
    const start = source.indexOf("function cancelActiveTrainStart(");
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const appState = { playStartToken: 7 };
    const run = beginLuckyDiscovery(appState);
    const train = { syncTrainControls: vi.fn() };
    const setTrainBanner = vi.fn();
    const cancel = new Function("appState", "setTrainBanner", "trainSessionLoading", "boards", "cancelLuckyDiscovery", `${body}; return cancelActiveTrainStart;`)(appState, setTrainBanner, Promise.resolve(train), { train: { setPremove: vi.fn() } }, cancelLuckyDiscovery);
    cancel();
    expect(appState.luckyBusy).toBe(false);
    expect(appState.luckyRun).toBeNull();
    expect(run.controller.signal.aborted).toBe(true);
    expect(setTrainBanner).toHaveBeenCalledWith("move", "", "");
  });

  it("navigation cancellation leaves an already established Practice game alone", () => {
    const start = source.indexOf("function cancelActiveTrainStart(");
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const play = { active: true };
    const appState = { play, trainStarting: true, playStarting: Promise.resolve(), playStartToken: 3 };
    const train = { syncTrainControls: vi.fn() };
    const cancel = new Function("appState", "setTrainBanner", "trainSessionLoading", "boards", "cancelLuckyDiscovery", `${body}; return cancelActiveTrainStart;`)(appState, vi.fn(), Promise.resolve(train), { train: { setPremove: vi.fn() } }, cancelLuckyDiscovery);
    cancel();
    expect(appState.play).toBe(play);
    expect(appState.playStartToken).toBe(3);
    expect(appState.playStarting).not.toBeNull();
    expect(train.syncTrainControls).not.toHaveBeenCalled();
  });

  it("scoped popstate entries use the retryable Train entry path", () => {
    expect(source).toContain("if (trainNeedsQueue) await retryTrainEntry");
  });
});
