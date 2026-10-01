import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePgn } from "./analyze-pgn.js";
import { createAnalyzeView } from "./views/analyze.js";
import { parseWorkspaceLocation } from "./workspace-url.js";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
function body(marker) {
  const start = source.indexOf(marker);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
function harness(realBoard = false) {
  const pending = deferred();
  const chunk = deferred();
  const view = { renderAnalysis: vi.fn(), renderAnalysisTree: vi.fn(), renderEvalChart: vi.fn(),
    renderClassificationBars: vi.fn(), buildAnalysisTree: () => ({ root: parsePgn("1. e4").root }) };
  const input = { value: "1. d4", addEventListener: vi.fn() };
  const appState = { analysis: null, analysisVarNodes: new Map() };
  const realView = createAnalyzeView({ appState, START_FEN, escapeHtml: String });
  view.serializeAnalysisPgn = realView.serializeAnalysisPgn;
  view.adaptParsedTree = realView.adaptParsedTree;
  const doc = { getElementById: () => input, activeElement: null };
  const deps = {
    appState, document: doc, START_FEN, parsePgn,
    api: () => pending.promise, ensureAnalyzeView: vi.fn(async () => view),
    hideAnalysisHandoff: vi.fn(), resetAnalysisVariations: vi.fn(), showAnalysisPly: vi.fn(async () => {}),
    revealAnalysisResults: vi.fn(), syncViewHeads: vi.fn(), setStatus: vi.fn(), setStatusError: vi.fn(),
    orientAnalysisForSelf: vi.fn(), orientAnalysisFromPgn: vi.fn(),
    isBrowserEngineAvailable: () => true, jobToast: { isBusy: () => false }, requireSignIn: () => true,
    postJson: vi.fn(async () => { throw new Error("stop before engine"); }), engineLifecycleMark: vi.fn(),
    isAuthError: () => false, hideAnalysisResults: vi.fn(), loadCheckpoint: () => null, currentOwnerId: () => "owner",
    evalMapFrom: () => new Map(), clearCheckpoint: vi.fn(), hideAnalysisRetrySave: vi.fn(),
    refreshAnalysisHistoryIfOpen: vi.fn(), updateAnalysisHandoff: vi.fn(async () => {}), showAnalysisRetrySave: vi.fn(),
    boardInfo: vi.fn(async () => ({ legal_moves: [] })), boards: { analysis: { setPosition: vi.fn(), setMoveBadge: vi.fn() } },
    highlightCurrentMove: vi.fn(), classBadgeSymbol: () => "", engineWidget: null, syncWorkspaceUrl: vi.fn(),
  };
  deps.jobToast.failJob = vi.fn();
  const helper = body("function invalidateAnalysisSource(");
  const inputStart = source.indexOf('pgnInput.addEventListener("input",');
  const inputBinding = source.slice(inputStart, source.indexOf("\n    });", inputStart) + 8);
  const functions = [...(realBoard ? ["async function showAnalysisPly("] : []), "async function recallAnalysis(", "async function renderAnalysis(",
    "async function syncPgnFromTree(",
    "async function loadPgnIntoAnalyze(", "async function runAnalysis(", "async function retryAnalyzeSave("].map(body).join("\n");
  const actions = new Function(...Object.keys(deps), "pgnInput", `
    let analysisRecallSeq = 0, analyzePgnInputTimer = null, analyzePgnWriting = false;
    let lastOrientedPgnPlayers = "";
    ${helper}\n${functions}\n${inputBinding}
    return { recallAnalysis, loadPgnIntoAnalyze, runAnalysis, renderAnalysis, syncPgnFromTree, retryAnalyzeSave };
  `)(...Object.values(deps), input);
  return { ...actions, pending, chunk, view, input, appState, deps, doc,
    edit: () => input.addEventListener.mock.calls[0][1]() };
}
const saved = (id) => ({ game_id: id, moves: [{ ply: 1, san: "e4", uci: "e2e4", move_number: 1, side: "white", fen_before: START_FEN }], eval_graph: [] });
afterEach(() => vi.useRealTimers());

describe("Recall source ownership", () => {
  it.each(["paste", "analyze"])("a new %s supersedes a pending recall", async (action) => {
    vi.useFakeTimers();
    const h = harness();
    const recall = h.recallAnalysis("old");
    h.input.value = "1. e4";
    if (action === "paste") h.edit();
    else await h.runAnalysis();
    const current = h.appState.analysis;
    h.pending.resolve(saved("old"));
    await recall;
    expect(h.appState.analysis).toBe(current);
    expect(h.input.value).toBe("1. e4");
  });

  it("recall cancels the previous PGN edit's debounce instead of dropping classifications", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.edit();
    const payload = saved("recalled");
    h.pending.resolve(payload);
    await h.recallAnalysis("recalled");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.appState.analysis).toBe(payload);
  });

  it("does not commit a recall after a new paste while its view chunk loads", async () => {
    const h = harness();
    h.deps.ensureAnalyzeView.mockReturnValue(h.chunk.promise);
    h.pending.resolve(saved("old"));
    const recall = h.recallAnalysis("old");
    await vi.waitFor(() => expect(h.deps.ensureAnalyzeView).toHaveBeenCalled());
    h.input.value = "1. d4";
    const pasted = h.loadPgnIntoAnalyze(h.input.value);
    h.chunk.resolve(h.view);
    await Promise.all([recall, pasted]);
    expect(h.appState.analysis.game_id).toBeUndefined();
    expect(h.view.renderAnalysis).not.toHaveBeenCalled();
    expect(h.deps.setStatus).not.toHaveBeenCalledWith(expect.stringContaining("Recalled"));
    expect(h.input.value).toBe("1. d4");
  });

  it("a slow FEN-only paste cannot repaint a later recalled game's board", async () => {
    const h = harness(true);
    const info = deferred();
    h.deps.boardInfo.mockReturnValueOnce(info.promise);
    const loaded = h.loadPgnIntoAnalyze('[FEN "8/8/8/8/8/8/4K3/7k w - - 0 25"]');
    await vi.waitFor(() => expect(h.deps.boardInfo).toHaveBeenCalled());
    h.pending.resolve(saved("recalled"));
    await h.recallAnalysis("recalled");
    info.resolve({ legal_moves: [] });
    await loaded;
    expect(h.deps.boards.analysis.setPosition).toHaveBeenCalledTimes(1);
    expect(h.appState.analysisBoardFen).toBe(START_FEN);
  });

  it("orients a recalled game using the history row's players", async () => {
    const h = harness();
    h.pending.resolve(saved("black-self"));
    await h.recallAnalysis("black-self", { white: "Opponent", black: "Self" });
    expect(h.deps.orientAnalysisForSelf).toHaveBeenCalledWith("Opponent", "Self");
  });

  it.each(["recall-before-retry", "paste-during-retry"])("Retry save respects source order (%s)", async (order) => {
    const h = harness();
    const save = deferred();
    h.deps.postJson.mockReturnValue(save.promise);
    h.appState.analysisUnsavedCheckpoint = { gameId: "retry", pgn: "1. e4", positions: [] };
    const recall = order === "recall-before-retry" ? h.recallAnalysis("old") : null;
    const retry = h.retryAnalyzeSave();
    if (order === "paste-during-retry") {
      h.input.value = "1. d4";
      await h.loadPgnIntoAnalyze(h.input.value);
    }
    save.resolve(saved("retry"));
    await retry;
    if (recall) {
      h.pending.resolve(saved("old"));
      await recall;
      expect(h.appState.analysis.game_id).toBe("retry");
      expect(h.input.value).toBe("1. e4");
    } else {
      expect(h.appState.analysis.game_id).toBeUndefined();
      expect(h.input.value).toBe("1. d4");
    }
    expect(h.deps.clearCheckpoint).toHaveBeenCalledWith("retry", "owner");
  });

  it("recalled PGN retains names, result and its nonstandard starting position", async () => {
    const h = harness();
    const pgn = '[SetUp "1"]\n[FEN "8/8/8/8/8/8/4K3/7k w - - 0 25"]\n\n25. Kf3';
    const parsed = parsePgn(pgn);
    expect(parsed.ok).toBe(true);
    const move = parsed.root.children[0];
    h.pending.resolve({ game_id: "fen", moves: [{ ply: 1, san: move.san, move_number: move.moveNumber, side: move.side,
      fen_before: move.fenBefore, fen_after: move.fenAfter }], eval_graph: [] });
    await h.recallAnalysis("fen", { white: "Me", black: "Other", result: "1/2-1/2" });
    const recalled = parsePgn(h.input.value);
    expect(recalled.ok).toBe(true);
    expect(recalled.headers).toMatchObject({ White: "Me", Black: "Other", Result: "1/2-1/2", SetUp: "1", FEN: move.fenBefore });
    expect(recalled.root.children[0].fenBefore).toBe(move.fenBefore);
  });
});

describe("Boot route lifecycle", () => {
  it("a repertoire command picked during boot counts as navigation despite deferred URL sync", async () => {
    const appState = { currentView: "dashboard", signedIn: true };
    const deps = { appState, document: { getElementById: () => null }, boards: {}, takeBuildPreview: vi.fn(),
      hardFlushBuild: async () => {}, api: async () => ({ repertoire_id: "picked", nodes: [] }), hydrateBuild: vi.fn(),
      loadReturnState: () => null, syncWorkspaceUrl: vi.fn(), updateBuildReadOnlyUi: vi.fn(), setStatusError: vi.fn(),
      window: { location: { href: "http://x/#/dashboard" } }, parseWorkspaceLocation };
    const start = source.indexOf("function switchView(");
    const navigation = source.slice(start, source.indexOf("  if (appState.currentView", start));
    const actions = new Function(...Object.keys(deps), `
      let navigatedDuringBoot = false, workspaceUrlReady = false, workspaceNavigationSeq = 0, buildLoadSeq = 0;
      ${navigation}\nappState.currentView = name; }
      ${body("function setBuildLoading(")}
      ${body("async function editRepertoire(")}
      ${body("async function restoreWorkspaceLocation(")}
      return { restoreWorkspaceLocation, editRepertoire };
    `)(...Object.values(deps));
    await Promise.all([actions.editRepertoire("picked"), actions.restoreWorkspaceLocation()]);
    expect(appState.currentView).toBe("build");
  });

  it("a page picked while the URL repertoire loads supersedes that restore", async () => {
    const rep = deferred();
    const appState = { currentView: "dashboard", signedIn: true };
    const deps = { appState, api: () => rep.promise, hydrateBuild: vi.fn(), loadReturnState: () => null,
      syncWorkspaceUrl: vi.fn(), window: { location: { href: "http://x/#/build?rep=old" } }, parseWorkspaceLocation };
    const start = source.indexOf("function switchView(");
    const navigation = source.slice(start, source.indexOf("  if (appState.currentView", start));
    const actions = new Function(...Object.keys(deps), `
      let navigatedDuringBoot = false, workspaceUrlReady = true, workspaceNavigationSeq = 0;
      ${navigation}\nappState.currentView = name; }
      ${body("async function restoreWorkspaceLocation(")}
      return { restoreWorkspaceLocation, switchView };
    `)(...Object.values(deps));
    const restore = actions.restoreWorkspaceLocation();
    actions.switchView("teams");
    rep.resolve({ repertoire_id: "old" });
    await restore;
    expect(appState.currentView).toBe("teams");
    expect(deps.hydrateBuild).not.toHaveBeenCalled();
  });

  it.each([true, false])("Train picked during boot auto-starts only with a session (%s)", async (signedIn) => {
    const appState = { currentView: "train", signedIn, trainMode: "smart" };
    const deps = { appState, switchView: vi.fn(), syncWorkspaceUrl: vi.fn(), startTraining: vi.fn(),
      window: { location: { href: "http://x/#/dashboard" } }, parseWorkspaceLocation };
    const restore = new Function(...Object.keys(deps), `let navigatedDuringBoot = true;
      return (${body("async function restoreWorkspaceLocation(")});`)(...Object.values(deps));
    await restore();
    expect(deps.startTraining).toHaveBeenCalledTimes(signedIn ? 1 : 0);
    if (signedIn) expect(deps.startTraining).toHaveBeenCalledWith("smart", { fresh: false });
  });
});

describe("Build friction audit visibility", () => {
  it.each([false, true])("reports an actual visible New repertoire entry (%s)", async (visibleEmptyAction) => {
    const script = readFileSync(new URL("../scripts/build-friction-audit.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const start = script.indexOf("async function snapshotBuildEmpty(");
    const end = script.indexOf("\n  }\n", start) + 4;
    const hiddenHeader = { getClientRects: () => [] };
    const emptyAction = { getClientRects: () => visibleEmptyAction ? [{}] : [] };
    const document = { getElementById: () => null,
      querySelector: (sel) => sel.includes("dashboard-new-rep") ? hiddenHeader : null,
      querySelectorAll: () => [hiddenHeader, emptyAction] };
    const snapshot = new Function("document", `return (${script.slice(start, end)});`)(document);
    const result = await snapshot({ evaluate: (fn) => fn() });
    expect(result.dashboardNewRep).toBe(visibleEmptyAction);
  });
});
