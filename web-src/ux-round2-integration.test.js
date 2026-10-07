import { describe, expect, it, vi } from "vitest";
import { selectionChips } from "./views/shared/source-composer.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps, prelude = "") {
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `${prelude}\nreturn (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Recent analyses refresh ordering", () => {
  it.each(["success", "failure"])("an older %s cannot overwrite the post-save list", async (outcome) => {
    const old = deferred();
    const fresh = deferred();
    const host = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
    const deps = { appState: {}, currentOwnerId: () => "owner", document: { getElementById: () => host }, escapeHtml: String, localDayOf: (iso) => String(iso || "").slice(0, 10),
      api: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) };
    const load = compile("async function loadAnalysisHistory(", deps, "let analysisHistorySeq = 0;");
    const first = load();
    const second = load();
    fresh.resolve({ analyses: [{ game_id: "new", white: "Me", black: "Opp" }] });
    await second;
    if (outcome === "success") old.resolve({ analyses: [] });
    else old.reject(new Error("old network failure"));
    await first;
    expect(host.innerHTML).toContain('data-game-id="new"');
  });
});

describe("Recall from Recent analyses", () => {
  function recallHarness(api) {
    const appState = { analysis: null };
    const pgn = { value: "x" };
    const deps = {
      appState, api, document: { getElementById: () => pgn },
      hideAnalysisHandoff: vi.fn(), resetAnalysisVariations: vi.fn(), showAnalysisPly: vi.fn(),
      renderAnalysis: vi.fn(async () => {}), revealAnalysisResults: vi.fn(),
      syncPgnFromTree: vi.fn(async () => {}), setStatus: vi.fn(), setStatusError: vi.fn(),
      orientAnalysisForSelf: vi.fn(), syncViewHeads: vi.fn(),
    };
    deps.ensureAnalyzeView = vi.fn(async () => ({ renderAnalysis: deps.renderAnalysis }));
    const start = source.indexOf("function invalidateAnalysisSource(");
    const helper = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const recall = compile("async function recallAnalysis(", deps,
      `let analysisRecallSeq = 0, analyzePgnInputTimer = null, lastOrientedPgnPlayers = "";\n${helper}`);
    return { appState, deps, pgn, recall };
  }

  it("keeps the history row's player names, so the head is not 'Analysis board'", async () => {
    const api = vi.fn(async () => ({ game_id: "g1", moves: ["e4"] }));
    const { appState, deps, pgn, recall } = recallHarness(api);
    let boxAtRender = null;
    deps.renderAnalysis.mockImplementation(async () => { boxAtRender = pgn.value; });
    await recall("g1", { game_id: "g1", white: "Me", black: "Opp", result: "1-0" });
    expect(appState.analysis).toMatchObject({ white: "Me", black: "Opp", result: "1-0" });
    // A leftover PGN's tags outrank these names in the head, so the box is
    // emptied before the render reads it.
    expect(boxAtRender).toBe("");
  });

  it("a slower earlier recall cannot replace the game picked last", async () => {
    const old = deferred();
    const fresh = deferred();
    const api = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { appState, deps, recall } = recallHarness(api);
    const first = recall("old", { white: "A", black: "B" });
    const second = recall("new", { white: "Me", black: "Opp" });
    fresh.resolve({ game_id: "new", moves: ["e4"] });
    await second;
    old.resolve({ game_id: "old", moves: ["d4"] });
    await first;
    expect(appState.analysis.game_id).toBe("new");
    expect(deps.renderAnalysis).toHaveBeenCalledTimes(1);
  });
});

describe("Library initial chunk failure", () => {
  it("replaces the spinner with an actionable error and can retry as a guest", async () => {
    const classes = new Set(["is-loading"]);
    const retry = { addEventListener: vi.fn() };
    const host = { innerHTML: "spinner", querySelector: () => retry };
    const card = { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } };
    const view = { renderSignedOut: vi.fn(), loadDashboard: vi.fn() };
    const ensureDashboardView = vi.fn().mockRejectedValueOnce(new Error("chunk missing")).mockResolvedValue(view);
    const deps = { appState: { signedIn: false }, ensureDashboardView, setStatusError: vi.fn(),
      escapeHtml: String, document: { getElementById: () => host, querySelector: () => card } };
    const load = compile("async function loadDashboard(", deps);
    await load();
    expect(classes.has("is-loading")).toBe(false);
    expect(host.innerHTML).toMatch(/Could not load your library/);
    expect(retry.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    await retry.addEventListener.mock.calls[0][1]();
    expect(view.renderSignedOut).toHaveBeenCalled();
    expect(view.loadDashboard).not.toHaveBeenCalled();
  });
});

describe("Games link chip respects explicit Self selection", () => {
  it.each([
    ["all", [], "data-games-link"],
    ["none", [], "No sources"],
    ["subset", [], "No sources"],
    ["subset", ["unlinked-id"], "No sources"],
  ])("%s with %j and no linked accounts", (linkedMode, accountIds, expected) => {
    const tray = { innerHTML: "" };
    const paint = compile("function paintGamesSource(", {
      appState: { signedIn: true }, document: { getElementById: () => tray }, selectionChips, escapeHtml: String,
      lichessAccounts: () => [], gamesSourceSelection: () => ({ linkedMode, accountIds, external: [] }),
    });
    paint();
    expect(tray.innerHTML).toContain(expected);
    expect(tray.innerHTML).not.toContain("Self · all linked");
  });
  it("external usernames stay usable without linking", () => {
    const tray = { innerHTML: "" };
    compile("function paintGamesSource(", {
      appState: { signedIn: true }, document: { getElementById: () => tray }, selectionChips, escapeHtml: String,
      lichessAccounts: () => [], gamesSourceSelection: () => ({ linkedMode: "all", external: ["Foe"] }),
    })();
    expect(tray.innerHTML).toContain("Foe");
    expect(tray.innerHTML).not.toContain("data-games-link");
  });
});

describe("Navigation during boot", () => {
  it("restoreWorkspaceLocation keeps a page picked mid-boot instead of the load URL", async () => {
    const appState = { currentView: "replay", signedIn: true };
    const deps = {
      appState, switchView: vi.fn(), syncWorkspaceUrl: vi.fn(),
      parseWorkspaceLocation: vi.fn(() => ({ view: "dashboard" })), loadReturnState: vi.fn(),
      window: { location: { href: "http://x/#/dashboard" } },
    };
    const restore = compile("async function restoreWorkspaceLocation(", deps, "let navigatedDuringBoot = true;");
    await restore();
    expect(deps.parseWorkspaceLocation).not.toHaveBeenCalled();
    // Re-entered with the real session (it may have painted signed-out mid-boot).
    expect(deps.switchView).toHaveBeenCalledWith("replay");
    expect(deps.switchView).not.toHaveBeenCalledWith("dashboard", expect.anything());
  });

  it("without a boot-time click the URL route is restored as before", async () => {
    const appState = { currentView: "dashboard", signedIn: false };
    const deps = {
      appState, switchView: vi.fn(), syncWorkspaceUrl: vi.fn(),
      parseWorkspaceLocation: vi.fn(() => ({ view: "teams" })), loadReturnState: vi.fn(),
      window: { location: { href: "http://x/#/teams" } },
    };
    const restore = compile("async function restoreWorkspaceLocation(", deps, "let navigatedDuringBoot = false, workspaceNavigationSeq = 0;");
    await restore();
    expect(deps.switchView).toHaveBeenCalledWith("teams", { fromUrl: true });
  });

  it("switchView marks only non-URL navigation before the workspace URL is ready", () => {
    const start = source.indexOf("function switchView(");
    const body = source.slice(start, source.indexOf("\n", start + 60));
    expect(source.slice(start, start + 200)).toMatch(/if \(!fromUrl && !workspaceUrlReady\) navigatedDuringBoot = true;/);
    expect(body).toContain("fromUrl");
  });
});
