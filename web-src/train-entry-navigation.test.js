import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

function wrapperRuntime() {
  const appState = {};
  const train = { openTrain: vi.fn(async () => {}) };
  const loadTrainSession = vi.fn(async () => train);
  const invalidateTrainEntries = () => { appState.trainEntryVersion = (appState.trainEntryVersion || 0) + 1; };
  const start = source.indexOf("const openTrain = (options = {}) =>");
  const body = source.slice(start, source.indexOf("\nconst submitTrainingMove", start));
  const openTrain = new Function("appState", "loadTrainSession", "invalidateTrainEntries", `${body}; return openTrain;`)(appState, loadTrainSession, invalidateTrainEntries);
  return { appState, train, openTrain, invalidateTrainEntries };
}

describe("Train entry navigation ordering", () => {
  it("the newest scoped action is the only one whose guard stays valid", async () => {
    const { train, openTrain } = wrapperRuntime();
    const first = openTrain({ mode: "smart", repertoireId: "r1" });
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

  it("an old entry settling cannot clear the newer pending route", async () => {
    const { appState, train, openTrain } = wrapperRuntime();
    const finish = [];
    train.openTrain.mockImplementation(() => new Promise((done) => finish.push(done)));
    const first = openTrain({ mode: "smart", repertoireId: "r1" });
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

  it("plain Train navigation centrally cancels a pending scoped route", () => {
    expect(source).toContain('if (name === "train" && !appState.trainEntering) { invalidateTrainEntries(); delete appState.trainPendingRoute; }');
  });

  it("scoped popstate entries use the retryable Train entry path", () => {
    expect(source).toContain("if (trainNeedsQueue) await retryTrainEntry");
  });
});
