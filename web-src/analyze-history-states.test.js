// Recent analyses: the three states the list can land in besides "some rows".
import { describe, expect, it, vi } from "vitest";
import { html } from "./html.js";
import { analysisHistoryResult } from "./analyze-orient.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compileLoad(deps) {
  deps = { html, analysisHistoryResult, localDayOf: String, currentOwnerId: () => "owner", ...deps };
  const start = source.indexOf("async function loadAnalysisHistory(");
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `let analysisHistorySeq = 0;\nreturn (${source.slice(start, end)});`)(...Object.values(deps));
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
    const load = compileLoad({ appState: { pendingAnalysisDeletes: new Set() }, document: { getElementById: () => host },
      api: async () => ({ analyses: [] }) });
    await load();
    expect(host.innerHTML).toContain("No saved analyses yet.");
  });

  it("keeps a row whose delete is still in its undo window out of a refresh", async () => {
    const host = hostElement();
    const load = compileLoad({ appState: { pendingAnalysisDeletes: new Set(["gone"]) }, document: { getElementById: () => host },
      api: async () => ({ analyses: [{ game_id: "gone", white: "A" }, { game_id: "kept", white: "B" }] }) });
    await load();
    expect(host.innerHTML).toContain('data-game-id="kept"');
    expect(host.innerHTML).not.toContain('data-game-id="gone"');
  });

  it("shows the empty state when every row is waiting to be deleted", async () => {
    const host = hostElement();
    const load = compileLoad({ appState: { pendingAnalysisDeletes: new Set(["gone"]) }, document: { getElementById: () => host },
      api: async () => ({ analyses: [{ game_id: "gone", white: "A" }] }) });
    await load();
    expect(host.innerHTML).toContain("No saved analyses yet.");
  });

  it("offers a retry when the first page fails", async () => {
    const host = hostElement();
    const api = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ analyses: [{ game_id: "one", white: "A" }] });
    const deps = { appState: { pendingAnalysisDeletes: new Set() }, document: { getElementById: () => host }, api };
    const load = compileLoad({ ...deps, loadAnalysisHistory: () => load() });
    await load();
    expect(host.innerHTML).toContain("offline");
    const retry = host.listeners.get("[data-history-retry]");
    expect(retry).toBeTypeOf("function");
    retry();
    await vi.waitFor(() => expect(host.innerHTML).toContain('data-game-id="one"'));
  });
});
