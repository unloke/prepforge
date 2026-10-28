import { expect, it, vi } from "vitest";
import { openPgnInput } from "./analyze-pgn-open.js";
function harness(text = "1. e4 e5 *", loaded = true) {
  const close = vi.fn();
  const input = { value: text, setAttribute: vi.fn(), removeAttribute: vi.fn() }, error = { hidden: true, textContent: "" };
  const deps = { document: { getElementById: id => id === "pgn-input" ? input : error, querySelector: () => ({ click: close }) },
    invalidateAnalysisSource: () => 7, sourceIsCurrent: () => true, currentOwnerId: vi.fn(() => "u"),
    loadPgnIntoAnalyze: vi.fn(async (_text, { onInvalid }) => { if (!loaded) onInvalid("Invalid move: nonsense"); return loaded; }),
    orientAnalysisFromPgn: vi.fn() };
  return { ...deps, close, input, error, open: () => openPgnInput(deps) };
}
it("opens the pasted game without starting a full review, then dismisses its source sheet", async () => {
  const h = harness(); await h.open();
  expect(h.loadPgnIntoAnalyze).toHaveBeenCalledWith("1. e4 e5 *", { goToEnd: false, sourceSeq: 7, onInvalid: expect.any(Function) });
  expect(h.orientAnalysisFromPgn).toHaveBeenCalledWith("1. e4 e5 *");
  expect(h.close).toHaveBeenCalledOnce();
});
it("keeps invalid or empty input open for correction", async () => {
  const invalid = harness("1. e4 nonsense", false); await invalid.open();
  expect(invalid.error).toMatchObject({ hidden: false, textContent: "Invalid move: nonsense" });
  expect(invalid.input.setAttribute).toHaveBeenCalledWith("aria-invalid", "true");
  expect(invalid.close).not.toHaveBeenCalled(); expect(invalid.orientAnalysisFromPgn).not.toHaveBeenCalled();
  const empty = harness("   "); await empty.open();
  expect(empty.error).toMatchObject({ hidden: false, textContent: "Paste a PGN first." });
  expect(empty.loadPgnIntoAnalyze).not.toHaveBeenCalled(); expect(empty.close).not.toHaveBeenCalled();
});
it("clears an old validation error before a corrected import", async () => {
  const h = harness(); h.error.hidden = false; h.error.textContent = "Invalid move";
  await h.open(); expect(h.error.hidden).toBe(true);
  expect(h.input.removeAttribute).toHaveBeenCalledWith("aria-invalid");
});
it("does not dismiss another account's sheet when an old import finishes", async () => {
  const h = harness();
  h.loadPgnIntoAnalyze.mockImplementation(async () => { h.currentOwnerId.mockReturnValue("other"); return true; });
  await h.open(); expect(h.close).not.toHaveBeenCalled();
});
