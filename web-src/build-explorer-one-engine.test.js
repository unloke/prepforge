// A phone runs one Stockfish. The Explorer's row evals used to start a second
// worker at interactive priority: it took the only engine and kept it warm, so
// the engine's own lines sat on "Calculating…" for as long as the Explorer had
// rows. With one engine the rows read their evals from the engine's lines.
import { beforeEach, expect, it, vi } from "vitest";

const budget = { limit: 1 };
const createEngineProvider = vi.fn(() => ({ update: vi.fn(async () => ({ running: false, pvs: [] })), close: vi.fn() }));
const paintExplorerEvals = vi.fn();
const lines = { fen: "start", pvs: [{ pv_uci: ["e2e4"], score_cp: 30 }] };

vi.mock("./engine/compute-budget.js", () => ({ stockfishBudget: { snapshot: () => ({ limit: budget.limit }) } }));
vi.mock("./engine/stockfish-provider.js", () => ({ createEngineProvider, isBrowserEngineAvailable: () => true }));
vi.mock("./core/api.js", () => ({ activeViewName: () => "build", OUTBOX_TAB_ID: "t", api: vi.fn(), currentOwnerId: () => 1, setStatus: vi.fn(), setStatusError: vi.fn() }));
vi.mock("./core/prefs.js", () => ({ effectiveStockfishDepth: () => 16, pref: () => null }));
vi.mock("./core/engine.js", () => ({ EXPLORER_EVAL_MAX_LINES: 5, engineWantedIn: () => true, engineWidget: { isOpen: () => true, lastSnapshot: lines } }));
vi.mock("./core/hooks.js", () => ({ hooks: { build: { session: {}, paintExplorerEvals } } }));
vi.mock("./core/state.js", () => ({
  appState: { buildCurrentNodeId: "n1", buildNodeById: new Map([["n1", { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" }]]) },
  boards: {},
}));
vi.mock("./undo.js", () => ({ showUndoToast: vi.fn() }));
vi.mock("./build-live.js", () => ({ createBuildLive: () => ({}) }));

const row = { dataset: { uci: "e2e4" } };
const rows = {
  dataset: { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
  querySelectorAll: () => [row],
};
const drawer = { hidden: false };
const dock = { classList: { contains: () => false } };
vi.stubGlobal("document", {
  getElementById: (id) => ({ "explorer-rows": rows, "explorer-drawer": drawer, "build-inspector": dock })[id] || null,
});

const { explorerEvalEngine } = await import("./build-entry.js");

beforeEach(() => {
  createEngineProvider.mockClear();
  paintExplorerEvals.mockClear();
  explorerEvalEngine.stop();
});

it("starts no second engine on a one-engine device and paints the rows from the engine's lines", async () => {
  budget.limit = 1;
  await explorerEvalEngine.sync();
  expect(createEngineProvider).not.toHaveBeenCalled();
  expect(paintExplorerEvals).toHaveBeenLastCalledWith(lines, lines);
});

it("keeps the row-eval worker where the device runs two engines", async () => {
  budget.limit = 2;
  await explorerEvalEngine.sync();
  expect(createEngineProvider).toHaveBeenCalledTimes(1);
  expect(paintExplorerEvals.mock.calls.at(-1)[0]).not.toBe(lines);
});
