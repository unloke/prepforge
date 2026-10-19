import { expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { parseWorkspaceLocation } from "./workspace-url.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
const restore = source.slice(source.indexOf("async function restoreWorkspaceLocation()"), source.indexOf("\nfunction setReplaySection("));

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
