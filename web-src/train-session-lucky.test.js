import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  beginLuckyDiscovery,
  cancelLuckyDiscovery,
  finishLuckyDiscovery,
  luckyDiscoveryCurrent,
} from "./train-lucky-control.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function luckyEntry(appState, refreshAuthStatus, openAuthModal) {
  const source = readFileSync(new URL("./controllers/train-session.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("async function onFeelingLucky");
  const end = source.indexOf("\nexport async function takebackPlaySession", start);
  const body = source.slice(start, end);
  return new Function(
    "appState",
    "refreshAuthStatus",
    "openAuthModal",
    "beginLuckyDiscovery",
    "finishLuckyDiscovery",
    "luckyDiscoveryCurrent",
    `${body}; return { onFeelingLucky };`,
  )(appState, refreshAuthStatus, openAuthModal, beginLuckyDiscovery, finishLuckyDiscovery, luckyDiscoveryCurrent);
}

describe("Random discovery auth ownership", () => {
  it("takes ownership before the auth await, so navigation cancels a late guest prompt", async () => {
    const appState = { accountUsername: null, playStartToken: 0 };
    const auth = deferred();
    const openAuthModal = vi.fn();
    const { onFeelingLucky } = luckyEntry(appState, vi.fn(() => auth.promise), openAuthModal);

    const pending = onFeelingLucky();
    expect(appState.luckyRun).not.toBeNull();
    expect(appState.luckyBusy).toBe(true);

    cancelLuckyDiscovery(appState);
    auth.resolve();
    await pending;

    expect(openAuthModal).not.toHaveBeenCalled();
    expect(appState.luckyBusy).toBe(false);
  });

  it("a guest who stays on Train still gets the sign-in prompt", async () => {
    const appState = { accountUsername: null, playStartToken: 0 };
    const auth = deferred();
    const openAuthModal = vi.fn();
    const { onFeelingLucky } = luckyEntry(appState, vi.fn(() => auth.promise), openAuthModal);

    const pending = onFeelingLucky();
    auth.resolve();
    await pending;

    expect(openAuthModal).toHaveBeenCalledWith("login", { notice: "Sign in first, then try a random position." });
    expect(appState.luckyBusy).toBe(false);
    expect(appState.luckyRun).toBeNull();
  });
});
