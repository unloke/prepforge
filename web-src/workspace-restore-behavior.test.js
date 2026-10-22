import { expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { parseWorkspaceLocation, trainQueueRepertoireId } from "./workspace-url.js";
import { appSource } from "./test-app-source.js";
import { parsePgn } from "./analyze-pgn.js";

const source = appSource();
const restore = source.slice(source.indexOf("async function restoreWorkspaceLocation()"), source.indexOf("\nfunction setReplaySection("));
const popstate = source.slice(source.indexOf("async function handleWorkspacePopstate()"), source.indexOf("\nfunction setReplaySection("));
// The Analyze restore rule lives in its own module now (controllers/analyze-restore.js);
// the same factory source runs here, so the boot path is still the real one.
const restoreFactory = source
  .slice(source.indexOf("export function createAnalyzeRestore("),
    source.indexOf("\n}\n", source.indexOf("export function createAnalyzeRestore(")) + 2)
  .replace("export ", "");

function runtime(extra = {}) {
  const context = {
    navigatedDuringBoot: false, workspaceNavigationSeq: 0,
    appState: { signedIn: true, currentView: "dashboard" },
    window: { location: { href: "http://local/#/analyze" } },
    parseWorkspaceLocation, loadReturnState: () => null,
    switchView: vi.fn(), syncWorkspaceUrl: vi.fn(), openTrain: vi.fn(async () => {}),
    api: vi.fn(), hydrateBuild: vi.fn(), showAnalysisPly: vi.fn(), ...extra,
  };
  context.ANALYSIS_ROOT_PATH = "root";
  context.parsePgn = parsePgn;
  runInNewContext(`${restore}\n${restoreFactory}\n`
    + "globalThis.__makeRestore = createAnalyzeRestore;\nglobalThis.run = restoreWorkspaceLocation;", context);
  Object.assign(context, context.__makeRestore({
    appState: context.appState, loadReturnState: context.loadReturnState,
    loadPgnIntoAnalyze: context.loadPgnIntoAnalyze, showAnalysisPly: context.showAnalysisPly,
    selectAnalysisNodePath: context.selectAnalysisNodePath || (async () => false),
    setStatus: context.setStatus || vi.fn(),
    recallAnalysis: context.recallAnalysis || vi.fn(async () => false),
    rebuildAnalysisVariations: context.rebuildAnalysisVariations || vi.fn(async () => true),
  }));
  return context;
}

it("restores the requested URL view", async () => {
  const ctx = runtime();
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("analyze", { fromUrl: true });
});

it("keeps a user's navigation during boot and re-enters that page without starting anything", async () => {
  const ctx = runtime({ navigatedDuringBoot: true, appState: { signedIn: true, currentView: "train", trainMode: "smart" } });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train");
  expect(ctx.openTrain).not.toHaveBeenCalled();
});

it("opens the Due queue of the repertoire the URL names", async () => {
  const ctx = runtime({
    window: { location: { href: "http://local/#/train?rep=r2" } },
    appState: { signedIn: true, currentView: "dashboard", trainMode: "smart" },
  });
  await ctx.run();
  expect(ctx.openTrain).toHaveBeenCalledWith({ mode: "smart", repertoireId: "r2" });
});

it("#/train is Train Home: nothing starts by itself", async () => {
  const ctx = runtime({
    window: { location: { href: "http://local/#/train" } },
    appState: { signedIn: true, currentView: "dashboard", trainMode: "smart" },
  });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train", { fromUrl: true });
  expect(ctx.openTrain).not.toHaveBeenCalled();
});

it("a guest's Train link only opens Train", async () => {
  const ctx = runtime({
    window: { location: { href: "http://local/#/train?rep=r2" } },
    appState: { signedIn: false, currentView: "dashboard" },
  });
  await ctx.run();
  expect(ctx.openTrain).not.toHaveBeenCalled();
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
    trainQueueRepertoireId,
    switchView: vi.fn(),
    openTrain: vi.fn(async () => {}),
    // The Analyze branch compares the current position's stable path.
    selectedNodePath: () => null,
    showAnalysisPly: vi.fn(),
    restoreAnalysisNodePath: vi.fn(async () => {}),
    ...extra,
  };
  runInNewContext(`${popstate}\nglobalThis.run = handleWorkspacePopstate;`, context);
  return context;
}

it("rebuilds Train's queue for an in-page ?rep change", async () => {
  const ctx = popstateRuntime();
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train", { fromUrl: true });
  expect(ctx.openTrain).toHaveBeenCalledTimes(1);
  expect(ctx.openTrain).toHaveBeenCalledWith({ mode: "smart", repertoireId: "r2" });
});

it("keeps the live queue when the popstate names the repertoire it drills", async () => {
  const ctx = popstateRuntime({
    appState: { signedIn: true, currentView: "analyze", trainMode: "smart", smart: { mixed: false, repertoireId: "r2" } },
  });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train", { fromUrl: true });
  expect(ctx.openTrain).not.toHaveBeenCalled();
});

it("does not start a session on a non-Train popstate", async () => {
  const ctx = popstateRuntime({
    window: { location: { href: "http://local/#/analyze" } },
  });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("analyze", { fromUrl: true });
  expect(ctx.openTrain).not.toHaveBeenCalled();
});

it("does not start Train from a popstate while signed out", async () => {
  const ctx = popstateRuntime({
    appState: { signedIn: false, currentView: "train", trainMode: "smart" },
  });
  await ctx.run();
  expect(ctx.switchView).toHaveBeenCalledWith("train", { fromUrl: true });
  expect(ctx.openTrain).not.toHaveBeenCalled();
});

it("keeps replay section restoration on popstate", async () => {
  const ctx = popstateRuntime({
    appState: { signedIn: true, currentView: "replay", replaySection: "games" },
    window: { location: { href: "http://local/#/scout" } },
  });
  await ctx.run();
  expect(ctx.appState.replaySection).toBe("scout");
  expect(ctx.switchView).toHaveBeenCalledWith("replay", { fromUrl: true });
  expect(ctx.openTrain).not.toHaveBeenCalled();
});

// ---- Analyze: the loaded game survives a reload -------------------------------

it("puts the reloaded game's board back on the move the session saved", async () => {
  // The PGN box alone can come back from the browser's form restore; the game it
  // holds is only really loaded when loadPgnIntoAnalyze runs and the saved ply lands.
  const ctx = runtime({
    loadReturnState: () => ({ pgn: "1. e4 e5 2. Nf3", ply: 3 }),
    loadPgnIntoAnalyze: vi.fn(async () => true),
  });
  ctx.document = { getElementById: () => ({ value: "" }) };
  await ctx.run();
  expect(ctx.loadPgnIntoAnalyze).toHaveBeenCalledWith("1. e4 e5 2. Nf3", { goToEnd: false, quiet: true });
  expect(ctx.showAnalysisPly).toHaveBeenCalledWith(3);
});

it("lets the URL's ply win over the saved ply for an Analyze link", async () => {
  const ctx = runtime({
    window: { location: { href: "http://local/#/analyze?ply=2" } },
    loadReturnState: () => ({ pgn: "1. e4 e5 2. Nf3", ply: 3 }),
    loadPgnIntoAnalyze: vi.fn(async () => true),
  });
  ctx.document = { getElementById: () => ({ value: "" }) };
  await ctx.run();
  expect(ctx.showAnalysisPly).toHaveBeenCalledWith(2);
});

it("shows nothing extra when no game was loaded", async () => {
  const ctx = runtime({ loadReturnState: () => null, loadPgnIntoAnalyze: vi.fn() });
  await ctx.run();
  expect(ctx.loadPgnIntoAnalyze).not.toHaveBeenCalled();
  expect(ctx.showAnalysisPly).not.toHaveBeenCalled();
});

it("recalls a saved review by id so its grades come back, with the session's branches", async () => {
  const pgn = '[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 (1... c5) 2. Nf3 1-0';
  const input = { value: "" };
  const ctx = runtime({
    window: { location: { href: "http://local/#/analyze?ply=3" } },
    loadReturnState: () => ({ pgn, ply: 3, gameId: "g1" }),
    loadPgnIntoAnalyze: vi.fn(async () => true),
    recallAnalysis: vi.fn(async () => true),
    rebuildAnalysisVariations: vi.fn(async () => true),
  });
  ctx.document = { getElementById: () => input };
  await ctx.run();
  expect(ctx.recallAnalysis).toHaveBeenCalledWith("g1", { white: "Alice", black: "Bob", result: "1-0" }, { quiet: true });
  expect(ctx.rebuildAnalysisVariations).toHaveBeenCalledWith(pgn);
  expect(ctx.loadPgnIntoAnalyze).not.toHaveBeenCalled();
  expect(input.value).toBe(pgn);
  expect(ctx.showAnalysisPly).toHaveBeenCalledWith(3);
});

it("falls back to the bare PGN when the saved review is gone", async () => {
  const ctx = runtime({
    loadReturnState: () => ({ pgn: "1. e4 e5", ply: 0, gameId: "gone" }),
    loadPgnIntoAnalyze: vi.fn(async () => true),
    recallAnalysis: vi.fn(async () => false),
  });
  ctx.document = { getElementById: () => ({ value: "" }) };
  await ctx.run();
  expect(ctx.loadPgnIntoAnalyze).toHaveBeenCalledWith("1. e4 e5", { goToEnd: false, quiet: true });
});
