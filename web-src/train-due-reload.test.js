import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { formatWorkspaceHash, parseWorkspaceLocation, trainQueueRepertoireId, workspaceLocationFromState } from "./workspace-url.js";

const source = appSource();
function runtime(hash, { signedIn = true, smart = null } = {}) {
  const deps = {
    window: { location: { href: `http://local/${hash}` } },
    appState: { signedIn, currentView: "train", smart },
    parseWorkspaceLocation, trainQueueRepertoireId, loadReturnState: () => null,
    switchView: vi.fn(), openTrain: vi.fn(async () => {}),
  };
  const compile = marker => {
    const start = source.indexOf(marker);
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    return new Function(...Object.keys(deps), `let navigatedDuringBoot = false, workspaceNavigationSeq = 0; return (${body});`)(...Object.values(deps));
  };
  return { ...deps, restore: compile("async function restoreWorkspaceLocation("), popstate: compile("async function handleWorkspacePopstate(") };
}

describe("all-repertoire Due reload", () => {
  it("encodes the active mixed queue and restores it on reload without a repertoire id", async () => {
    const hash = formatWorkspaceHash(workspaceLocationFromState({ currentView: "train", smart: { mixed: true } }));
    expect(hash).toBe("#/train?mode=smart");
    const h = runtime(hash);
    await h.restore();
    expect(h.openTrain).toHaveBeenCalledWith({ mode: "smart", repertoireId: null });
  });

  it.each(["#/train", "#/train?mode=invalid"])("keeps Home and unknown modes idle (%s)", async hash => {
    const h = runtime(hash);
    await h.restore();
    expect(h.openTrain).not.toHaveBeenCalled();
  });

  it("does not mark Home, finished queues, scoped queues or other pages as an active mixed queue", () => {
    for (const state of [
      { currentView: "train" },
      { currentView: "train", smart: { mixed: true }, trainResult: { mode: "smart" } },
      { currentView: "dashboard", smart: { mixed: true } },
    ]) expect(formatWorkspaceHash(workspaceLocationFromState(state))).not.toContain("mode=");
    expect(formatWorkspaceHash(workspaceLocationFromState({ currentView: "train", smart: { mixed: false, repertoireId: "r" } }))).toBe("#/train?rep=r");
  });

  it("opens a mixed queue on Forward, but preserves an already active mixed queue", async () => {
    const h = runtime("#/train?mode=smart");
    await h.popstate();
    expect(h.openTrain).toHaveBeenCalledWith({ mode: "smart", repertoireId: null });
    h.appState.smart = { mixed: true };
    h.openTrain.mockClear();
    await h.popstate();
    expect(h.openTrain).not.toHaveBeenCalled();
  });

  it("a signed-out reload cannot start a mixed queue", async () => {
    const h = runtime("#/train?mode=smart", { signedIn: false });
    await h.restore();
    await h.popstate();
    expect(h.openTrain).not.toHaveBeenCalled();
  });
});
