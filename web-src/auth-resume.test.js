import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { savePendingAction, takePendingAction, isPendingActionId } from "./auth-gate.js";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function harness() {
  const input = { value: "demo PGN" }, drawer = { open: false };
  const runAnalysis = vi.fn(() => Promise.resolve());
  const deps = {
    document: { getElementById: (id) => id === "pgn-input" ? input : drawer },
    switchView: vi.fn(), runAnalysis, setStatus: vi.fn(), setStatusError: vi.fn(),
    appState: { signedIn: true }, isPendingActionId, noteKeptGuestSources: vi.fn(),
    window: { location: { href: "http://x/#/analyze" } },
    parseWorkspaceLocation: () => ({ ply: null }), showAnalysisPly: vi.fn(),
  };
  const start = source.indexOf("const PENDING_ACTION_HANDLERS = {");
  const end = source.indexOf("\n};", start) + 3;
  const resumeStart = source.indexOf("async function resumeAfterSignIn(");
  const resumeEnd = source.indexOf("\n}\n", resumeStart) + 2;
  const resume = new Function(...Object.keys(deps),
    `${source.slice(start, end)}\n${source.slice(resumeStart, resumeEnd)}; return resumeAfterSignIn;`)(...Object.values(deps));
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  return { input, drawer, runAnalysis, resume, storage, deps };
}

describe("Analyze pending action integration", () => {
  for (const returned of [false, true]) {
    it(`resumes the saved PGN once after ${returned ? "OAuth" : "password sign-in"}`, async () => {
      const h = harness();
      savePendingAction("analyze-game", {
        storage: h.storage, route: "#/analyze", data: { pgn: "1. d4 d5 *", mode: "multi", selectIndex: 2 },
      });
      await h.resume({ pending: takePendingAction({ storage: h.storage }), returned });
      expect(h.input.value).toBe("1. d4 d5 *");
      expect(h.runAnalysis).toHaveBeenCalledWith({ mode: "multi", selectIndex: 2 });
      await h.resume({ pending: takePendingAction({ storage: h.storage }), returned });
      expect(h.runAnalysis).toHaveBeenCalledTimes(1);
    });
  }
  it("asks for the source when an old record has no PGN, clearing the demo", async () => {
    const h = harness();
    await h.resume({ pending: { id: "analyze-game", route: "/#/analyze" } });
    expect(h.input.value).toBe("");
    expect(h.drawer.open).toBe(true);
    expect(h.runAnalysis).not.toHaveBeenCalled();
    expect(h.deps.setStatus).toHaveBeenCalledWith("Signed in — paste your PGN to run the full-game review.");
  });
});
