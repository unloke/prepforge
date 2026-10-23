import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The engine widget facade in core/engine.js. The widget chunk is replaced with
// a controllable import so the test can hold it in flight; everything else the
// facade reads is bound as a free variable.
const source = readFileSync(new URL("./core/engine.js", import.meta.url), "utf8");
const facadeSource = source
  .slice(source.indexOf("let loadedEngineWidget ="), source.indexOf("// Draw the engine's top move"))
  .replace('import("../controllers/engine-widget.js")', "importWidget()")
  .replace(/^export /gm, "");

function harness() {
  let resolveImport, rejectImport;
  const pending = new Promise((resolve, reject) => { resolveImport = resolve; rejectImport = reject; });
  let view = "analyze", wanted = true;
  const widget = {
    openForCurrent: vi.fn(), close: vi.fn(),
    isOpen: () => true,
    onBoardChanged: vi.fn(), onDepthSettingChanged: vi.fn(), lastSnapshot: { fen: "current" },
  };
  const createEngineWidget = vi.fn(() => widget);
  const hooks = { analyzeSession: null };
  const deps = {
    importWidget: vi.fn(() => pending), activeViewName: () => view,
    engineWantedIn: () => wanted,
    effectiveStockfishDepth: vi.fn(), createSharedEvaluationProvider: vi.fn(), appState: {},
    boards: {}, START_FEN: "start", setEngineBestArrow: vi.fn(), setStatusError: vi.fn(),
    setEngineOn: vi.fn(), activeBoardController: vi.fn(), explorerEvalEngine: {}, hooks,
    pref: () => wanted, setPref: vi.fn(),
    analysisStore: vi.fn(),
  };
  const facade = new Function(...Object.keys(deps), `${facadeSource}
    return { engineWidget, setSession(value) { hooks.analyzeSession = value ? () => value : null; } };`)(...Object.values(deps));
  return {
    ...facade, widget, deps, createEngineWidget, rejectImport,
    resolveImport: () => resolveImport({ createEngineWidget }),
    setView: (value) => { view = value; }, setWanted: (value) => { wanted = value; },
  };
}

describe("lazy engine widget", () => {
  it("answers synchronous calls without importing and keeps the depth promise contract", async () => {
    const h = harness(), engine = h.engineWidget;
    expect(engine.isOpen()).toBe(false);
    expect(engine.lastSnapshot).toBeNull();
    engine.onBoardChanged();
    engine.close();
    await expect(engine.onDepthSettingChanged()).resolves.toBeUndefined();
    expect(h.deps.importWidget).not.toHaveBeenCalled();
  });

  it("imports and injects once, opens only the latest request, and reads Analyze live", async () => {
    const h = harness();
    const first = h.engineWidget.openForCurrent();
    const second = h.engineWidget.openForCurrent();
    h.resolveImport();
    await Promise.all([first, second]);
    expect(h.deps.importWidget).toHaveBeenCalledOnce();
    expect(h.createEngineWidget).toHaveBeenCalledOnce();
    expect(h.widget.openForCurrent).toHaveBeenCalledOnce();
    const injected = h.createEngineWidget.mock.calls[0][0];
    expect(injected.getAnalyzeSession()).toBeNull();
    const session = { positionCoach: {} };
    h.setSession(session);
    expect(injected.getAnalyzeSession()).toBe(session);
    expect(h.engineWidget.isOpen()).toBe(true);
    expect(h.engineWidget.lastSnapshot).toBe(h.widget.lastSnapshot);
    h.engineWidget.onBoardChanged();
    await h.engineWidget.onDepthSettingChanged();
    expect(h.widget.onBoardChanged).toHaveBeenCalledOnce();
    expect(h.widget.onDepthSettingChanged).toHaveBeenCalledOnce();
  });

  it.each(["close", "view", "preference", "leave-and-return"])("does not open after %s changes during import", async (kind) => {
    const h = harness();
    const opening = h.engineWidget.openForCurrent();
    if (kind === "close") h.engineWidget.close();
    if (kind === "view") h.setView("build");
    if (kind === "preference") h.setWanted(false);
    if (kind === "leave-and-return") {
      // Leaving a view without the engine closes it (syncEngineForView), which
      // supersedes the open still in flight; coming back asks again.
      h.engineWidget.close();
      h.setView("build");
      h.setView("analyze");
    }
    h.resolveImport();
    await opening;
    expect(h.widget.openForCurrent).not.toHaveBeenCalled();
    h.setWanted(true);
    await h.engineWidget.openForCurrent();
    expect(h.widget.openForCurrent).toHaveBeenCalledOnce();
  });

  it("allows another import attempt after failure", async () => {
    const h = harness();
    const opening = h.engineWidget.openForCurrent();
    h.rejectImport(new Error("offline"));
    await opening;
    expect(h.deps.setStatusError).toHaveBeenCalledOnce();
    h.deps.importWidget.mockResolvedValue({ createEngineWidget: h.createEngineWidget });
    await h.engineWidget.openForCurrent();
    expect(h.deps.importWidget).toHaveBeenCalledTimes(2);
    expect(h.widget.openForCurrent).toHaveBeenCalledOnce();
  });
});
