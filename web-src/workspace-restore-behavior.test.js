import { expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { parseWorkspaceLocation } from "./workspace-url.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
const restore = source.slice(source.indexOf("async function restoreWorkspaceLocation()"), source.indexOf("\nfunction setReplaySection("));
const popstate = source.slice(source.indexOf("async function handleWorkspacePopstate()"), source.indexOf("\nfunction setReplaySection("));

function runtime(extra = {}) {
  const context = {
    navigatedDuringBoot: false, workspaceNavigationSeq: 0,
    appState: { signedIn: true, currentView: "dashboard" },
    window: { location: { href: "http://local/#/analyze" } },
    parseWorkspaceLocation, loadReturnState: () => null,
    switchView: vi.fn(), syncWorkspaceUrl: vi.fn(), startTraining: vi.fn(),
    api: vi.fn(), hydrateBuild: vi.fn(), showAnalysisPly: vi.fn(), ...extra,
  };
  runInNewContext(`${restore}\nglobalThis.run = restoreWorkspaceLocation;`, context);
  return context;
}

it("restores the requested URL view", async () => {
  const ctx = runtime();
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("analyze", { fromUrl: true });
});

it("keeps a user's navigation during boot and resumes training on that page", async () => {
  const ctx = runtime({ navigatedDuringBoot: true, appState: { signedIn: true, currentView: "train", trainMode: "smart" } });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train");
  expect(ctx.startTraining).toHaveBeenCalledWith("smart", { fresh: false });
});

it("starts Train with the repertoire the URL names", async () => {
  const ctx = runtime({
    window: { location: { href: "http://local/#/train?rep=r2" } },
    appState: { signedIn: true, currentView: "dashboard", trainMode: "smart" },
  });
  await ctx.run();
  expect(ctx.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: "r2" });
});

it("starts Train mixed when the URL names no repertoire", async () => {
  const ctx = runtime({
    window: { location: { href: "http://local/#/train" } },
    appState: { signedIn: true, currentView: "dashboard", trainMode: "smart" },
  });
  await ctx.run();
  expect(ctx.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: null });
});

it("does not navigate after a newer navigation supersedes a pending load", async () => {
  const ctx = runtime({ window: { location: { href: "http://local/#/build?rep=r" } } });
  ctx.api.mockImplementation(async () => { ctx.workspaceNavigationSeq++; return {}; });
  await ctx.run();
  expect(ctx.switchView).not.toHaveBeenCalled();
});

function popstateRuntime(extra = {}) {
  const context = {
    appState: { signedIn: true, currentView: "train", trainMode: "smart" },
    window: { location: { href: "http://local/#/train?rep=r2" } },
    parseWorkspaceLocation,
    switchView: vi.fn(),
    startTraining: vi.fn(async () => {}),
    ...extra,
  };
  runInNewContext(`${popstate}\nglobalThis.run = handleWorkspacePopstate;`, context);
  return context;
}

it("rebuilds Train's queue for an in-page ?rep change", async () => {
  const ctx = popstateRuntime();
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train", { fromUrl: true });
  expect(ctx.startTraining).toHaveBeenCalledTimes(1);
  expect(ctx.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: "r2" });
});

it("does not start a session on a non-Train popstate", async () => {
  const ctx = popstateRuntime({
    window: { location: { href: "http://local/#/analyze" } },
  });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("analyze", { fromUrl: true });
  expect(ctx.startTraining).not.toHaveBeenCalled();
});

it("does not start Train from a popstate while signed out", async () => {
  const ctx = popstateRuntime({
    appState: { signedIn: false, currentView: "train", trainMode: "smart" },
  });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train", { fromUrl: true });
  expect(ctx.startTraining).not.toHaveBeenCalled();
});

it("keeps replay section restoration on popstate", async () => {
  const ctx = popstateRuntime({
    appState: { signedIn: true, currentView: "replay", replaySection: "games" },
    window: { location: { href: "http://local/#/scout" } },
  });
  await ctx.run();
  expect(ctx.appState.replaySection).toBe("scout");
  expect(ctx.switchView).toHaveBeenCalledWith("replay", { fromUrl: true });
  expect(ctx.startTraining).not.toHaveBeenCalled();
});
