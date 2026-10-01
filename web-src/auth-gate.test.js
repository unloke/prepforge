import { describe, expect, it } from "vitest";
import {
  AUTH_REQUIRED_MESSAGE,
  PENDING_ACTION_KEY,
  PENDING_ACTION_TTL_MS,
  PENDING_ACTIONS,
  clearPendingAction,
  isAuthError,
  isAuthRequiredMessage,
  isPendingActionId,
  isSafeRoute,
  isSessionAuthFailure,
  markAuthReturn,
  restoredAuthHref,
  savePendingAction,
  stripSignedInParam,
  takeAuthReturn,
  takePendingAction,
} from "./auth-gate.js";
import { shouldClearStatusOnNavigate } from "./status-pill.js";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
  };
}

describe("pending action allowlist", () => {
  it("covers every account-only entry point", () => {
    for (const id of [
      "new-repertoire",
      "import-pgn",
      "new-team",
      "analyze-game",
      "train",
      "games-check",
      "scout-start",
      "lichess-link",
      "my-last-game",
    ]) {
      expect(isPendingActionId(id)).toBe(true);
    }
    expect(PENDING_ACTIONS).toHaveLength(9);
  });

  it("rejects unknown ids and non-strings", () => {
    const storage = memoryStorage();
    expect(savePendingAction("eval:alert(1)", { storage })).toBe(false);
    expect(savePendingAction("__proto__", { storage })).toBe(false);
    expect(savePendingAction(null, { storage })).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it("round-trips once, with a safe in-app route", () => {
    const storage = memoryStorage();
    expect(savePendingAction("new-repertoire", { storage, route: "#/build?rep=r1", now: 1000 })).toBe(true);
    expect(takePendingAction({ storage, now: 2000 })).toEqual({ id: "new-repertoire", route: "#/build?rep=r1" });
    expect(takePendingAction({ storage, now: 2000 })).toBeNull();
  });

  it("drops unsafe routes but keeps the action", () => {
    const storage = memoryStorage();
    savePendingAction("train", { storage, route: "javascript:alert(1)", now: 0 });
    expect(takePendingAction({ storage, now: 1 })).toEqual({ id: "train", route: null });
    expect(isSafeRoute("#/teams")).toBe(true);
    expect(isSafeRoute("https://evil.example/#/x")).toBe(false);
    expect(isSafeRoute("#/x<script>")).toBe(false);
  });

  it("ignores tampered or expired records", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_ACTION_KEY, JSON.stringify({ id: "delete-account", at: 0 }));
    expect(takePendingAction({ storage, now: 1 })).toBeNull();
    storage.setItem(PENDING_ACTION_KEY, "not json");
    expect(takePendingAction({ storage, now: 1 })).toBeNull();
    savePendingAction("new-team", { storage, now: 0 });
    expect(takePendingAction({ storage, now: PENDING_ACTION_TTL_MS + 1 })).toBeNull();
  });

  it("clears on dismissal", () => {
    const storage = memoryStorage();
    savePendingAction("games-check", { storage });
    clearPendingAction({ storage });
    expect(takePendingAction({ storage })).toBeNull();
  });
});

describe("sign-in return URL", () => {
  it("strips ?signed_in=1 and keeps everything else", () => {
    expect(stripSignedInParam("https://x.test/?signed_in=1")).toBe("/");
    expect(stripSignedInParam("https://x.test/?signed_in=1&join=abc#/teams")).toBe("/?join=abc#/teams");
    expect(stripSignedInParam("https://x.test/#/train")).toBeNull();
  });

  it("remembers the route and invite code across the Google redirect", () => {
    const storage = memoryStorage();
    markAuthReturn({ storage, now: 0, href: "https://x.test/?join=TEAM_1#/teams" });
    const back = takeAuthReturn({ storage, now: 10 });
    expect(back).toEqual({ route: "#/teams", join: "TEAM_1" });
    expect(takeAuthReturn({ storage, now: 10 })).toBeNull();
    expect(restoredAuthHref("https://x.test/", back)).toBe("/?join=TEAM_1#/teams");
  });

  it("never overrides a route the landing URL already has", () => {
    expect(restoredAuthHref("https://x.test/#/analyze", { route: "#/teams", join: null })).toBeNull();
    expect(restoredAuthHref("https://x.test/", null)).toBeNull();
  });
});

describe("401 handling", () => {
  it("rewrites only the session failure, not a wrong password", () => {
    expect(isSessionAuthFailure(401, "not authenticated")).toBe(true);
    expect(isSessionAuthFailure(401, "invalid email or password")).toBe(false);
    expect(isSessionAuthFailure(403, "not authenticated")).toBe(false);
    expect(isAuthRequiredMessage(AUTH_REQUIRED_MESSAGE)).toBe(true);
    expect(isAuthRequiredMessage(`Couldn't join: ${AUTH_REQUIRED_MESSAGE}`)).toBe(true);
    expect(isAuthRequiredMessage("Sign in to start training")).toBe(false);
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 500 })).toBe(false);
  });
});

describe("status pill navigation", () => {
  it("clears an older error but keeps one raised by the navigating action", () => {
    expect(shouldClearStatusOnNavigate(1000, 5000, 400)).toBe(true);
    expect(shouldClearStatusOnNavigate(4900, 5000, 400)).toBe(false);
    expect(shouldClearStatusOnNavigate(0, 5000, 400)).toBe(true);
  });
});
