// Recent analyses: the three states the list can land in besides "some rows".
import { describe, expect, it, vi } from "vitest";
import { html } from "./html.js";
import { analysisHistoryResult } from "./analyze-orient.js";
import { appSource } from "./test-app-source.js";
import { asSlices } from "./state/as-slices.fixture.js";

const source = appSource();
function compileLoad(deps) {
  deps = { html, analysisHistoryResult, localDayOf: String, currentOwnerId: () => "owner", ...deps };
  const body = (marker) => { const start = source.indexOf(marker); return source.slice(start, source.indexOf("\n}\n", start) + 2); };
  return new Function(...Object.keys(deps), `let analysisHistorySeq = 0, historyFreshFor = null, historySaves = 0;
    ${body("export function refreshAnalysisHistoryIfOpen(").replace("export ", "")}
    const loadAnalysisHistory = ${body("async function loadAnalysisHistory(")};
    return Object.assign(loadAnalysisHistory, { refreshAnalysisHistoryIfOpen });`)(...Object.values(deps));
}

function hostElement() {
  const listeners = new Map();
  return {
    listeners,
    setAttribute() {},
    get innerHTML() { return this._html ?? ""; },
    set innerHTML(value) { this._html = String(value); },
    querySelector(selector) {
      if (!(this._html ?? "").includes(selector.replace(/^[.[]|]$/g, ""))) return null;
      return { addEventListener: (_type, fn) => listeners.set(selector, fn) };
    },
    querySelectorAll: () => [],
  };
}

describe("Recent analyses list states", () => {
  it("says so when there are no saved analyses", async () => {
    const host = hostElement();
    const load = compileLoad({ ...asSlices({ pendingAnalysisDeletes: new Set() }), document: { getElementById: () => host },
      api: async () => ({ analyses: [] }) });
    await load();
    expect(host.innerHTML).toContain("No saved analyses yet.");
  });

  it("keeps a row whose delete is still in its undo window out of a refresh", async () => {
    const host = hostElement();
    const load = compileLoad({ ...asSlices({ pendingAnalysisDeletes: new Set(["gone"]) }), document: { getElementById: () => host },
      api: async () => ({ analyses: [{ game_id: "gone", white: "A" }, { game_id: "kept", white: "B" }] }) });
    await load();
    expect(host.innerHTML).toContain('data-game-id="kept"');
    expect(host.innerHTML).not.toContain('data-game-id="gone"');
  });

  it("shows the empty state when every row is waiting to be deleted", async () => {
    const host = hostElement();
    const load = compileLoad({ ...asSlices({ pendingAnalysisDeletes: new Set(["gone"]) }), document: { getElementById: () => host },
      api: async () => ({ analyses: [{ game_id: "gone", white: "A" }] }) });
    await load();
    expect(host.innerHTML).toContain("No saved analyses yet.");
  });

  it("offers a retry when the first page fails", async () => {
    const host = hostElement();
    const api = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ analyses: [{ game_id: "one", white: "A" }] });
    const deps = { ...asSlices({ pendingAnalysisDeletes: new Set() }), document: { getElementById: () => host }, api };
    const load = compileLoad(deps);
    await load();
    expect(host.innerHTML).toContain("offline");
    const retry = host.listeners.get("[data-history-retry]");
    expect(retry).toBeTypeOf("function");
    retry();
    await vi.waitFor(() => expect(host.innerHTML).toContain('data-game-id="one"'));
  });

  it("reopening the drawer keeps the list it read, until a save lands", async () => {
    const host = hostElement(), drawer = { open: false };
    const api = vi.fn(async () => ({ analyses: [{ game_id: "one", white: "A" }] }));
    const load = compileLoad({ ...asSlices({ pendingAnalysisDeletes: new Set(), signedIn: true }), 
      document: { getElementById: (id) => (id === "history-drawer" ? drawer : host) }, api });
    await load({ ifStale: true });
    await load({ ifStale: true });
    expect(api).toHaveBeenCalledTimes(1);
    // A save while the drawer is closed: the next open reads the list again.
    load.refreshAnalysisHistoryIfOpen();
    await load({ ifStale: true });
    expect(api).toHaveBeenCalledTimes(2);
    // Entering Analyze (no ifStale) always reads it.
    await load();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("a first page that failed is read again on the next open", async () => {
    const host = hostElement();
    const api = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ analyses: [] });
    const load = compileLoad({ ...asSlices({ pendingAnalysisDeletes: new Set() }), document: { getElementById: () => host }, api });
    await load({ ifStale: true });
    await load({ ifStale: true });
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.innerHTML).toContain("No saved analyses yet.");
  });

  it("a read in flight when a save lands cannot mark the list fresh", async () => {
    const host = hostElement(), drawer = { open: true };
    let answer;
    const api = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
      .mockResolvedValue({ analyses: [{ game_id: "saved", white: "A" }] });
    const load = compileLoad({ ...asSlices({ pendingAnalysisDeletes: new Set(), signedIn: true }), 
      document: { getElementById: (id) => (id === "history-drawer" ? drawer : host) }, api });
    const first = load({ ifStale: true });
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    // The drawer closes mid-load, a save lands, then the older read answers
    // without the analysis just saved.
    drawer.open = false;
    load.refreshAnalysisHistoryIfOpen();
    answer({ analyses: [] });
    await first;
    drawer.open = true;
    await load({ ifStale: true });
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.innerHTML).toContain('data-game-id="saved"');
  });
});
