import { describe, expect, it, vi } from "vitest";

import { createAnalyzeView } from "./views/analyze-loader.js";

// The Analyze view chunk is created once and shared. Two things here are easy
// to get wrong and silent when wrong: the factory must bind its deps (a
// destructuring bug left loadAnalyzeSession undefined, and every Analyze run
// died with "… is not a function" only in the browser), and the view is built
// with the session's handlers.
describe("analyze view loader", () => {
  it("binds the session loader and its handlers from the factory", async () => {
    const loadSession = vi.fn(async () => ({}));
    const api = createAnalyzeView({ loadSession, showPly: vi.fn(), selectNode: vi.fn(), reveal: vi.fn() });
    expect(api.analyzeView).toBe(null);
    await api.preloadAnalyzeView();
    // Called with no arguments: the loader takes none and caches its own promise.
    expect(loadSession).toHaveBeenCalledOnce();
  });
});
