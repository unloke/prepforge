// Build's opening explorer: when Lichess asks for a pause, the panel fetches
// again by itself once the pause is over, instead of waiting for a click.
import { describe, expect, it, vi } from "vitest";
import { html } from "./html.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compilePanel(deps) {
  const start = source.indexOf("async function refreshExplorerPanel(");
  const end = source.indexOf("\n}\n", start) + 2;
  const body = `let explorerSeq = 0, explorerDb = "lichess", explorerOpeningName = "";\n`
    + `${source.slice(start, end)}\nreturn { refreshExplorerPanel, bump: () => ++explorerSeq };`;
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

class ExplorerRateLimited extends Error {
  constructor(retryInMs) { super("cooling down"); this.retryInMs = retryInMs; }
}

function harness(fetchStats) {
  const rows = {
    dataset: {}, innerHTML: "",
    classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, querySelector: () => null,
  };
  const timers = [];
  const deps = {
    html,
    document: { getElementById: () => rows },
    explorerDrawerOpen: () => true,
    appState: { buildCurrentNodeId: "n", buildNodeById: new Map([["n", { fen: "fen-1" }]]) },
    paintInspectorScope: () => {},
    explorerEvalEngine: { sync: async () => {} },
    explorerModule: { ExplorerRateLimited },
    ensureExplorerClient: async () => {},
    explorerClient: { fetchStats },
    effectiveMaiaRating: () => 1500,
    renderExplorerRows: vi.fn(),
    showExplorerHint: (el, markup) => { el.innerHTML = String(markup); },
    openSettingsSection: async () => {},
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  return { rows, timers, deps, panel: compilePanel(deps) };
}

describe("explorer rate limit", () => {
  it("says it will retry, then fetches again after the pause", async () => {
    const fetchStats = vi.fn()
      .mockRejectedValueOnce(new ExplorerRateLimited(3000))
      .mockResolvedValueOnce({ moves: [] });
    const h = harness(fetchStats);
    await h.panel.refreshExplorerPanel();
    expect(h.rows.innerHTML).toContain("retrying in ~3s");
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBeGreaterThanOrEqual(3000);
    h.timers[0].fn();
    await vi.waitFor(() => expect(h.deps.renderExplorerRows).toHaveBeenCalled());
    expect(fetchStats).toHaveBeenCalledTimes(2);
  });

  it("does not retry a position the user has already left", async () => {
    const fetchStats = vi.fn().mockRejectedValueOnce(new ExplorerRateLimited(3000));
    const h = harness(fetchStats);
    await h.panel.refreshExplorerPanel();
    h.panel.bump(); // another refresh started since
    h.timers[0].fn();
    expect(fetchStats).toHaveBeenCalledTimes(1);
  });
});
