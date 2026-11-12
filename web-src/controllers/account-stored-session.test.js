import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountController } from "./account.js";

// A reload opens on the last session the server confirmed and checks it in the
// background: on a sleeping server the check took up to a minute, and the whole
// workspace waited behind "Loading your workspace…".
let store;
beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.document = { getElementById: () => null, querySelector: () => null, body: { classList: { toggle: () => {} } } };
  globalThis.window = { location: { reload: vi.fn() } };
});
afterEach(() => {
  vi.useRealTimers();
  delete globalThis.localStorage;
  delete globalThis.document;
  delete globalThis.window;
});

const make = (api) => {
  const appState = { signedIn: false, accountUsername: null, accountUserId: null, lichessUsername: null };
  const onOwnerChanged = vi.fn();
  const controller = createAccountController({
    appState, api, postJson: vi.fn(), setStatus: vi.fn(), showConfirmModal: vi.fn(),
    refreshAutoMaiaRating: vi.fn(), onOwnerChanged,
  });
  return { appState, controller, onOwnerChanged };
};

it("remembers a confirmed session and opens on it before the server answers", async () => {
  const first = make(vi.fn().mockResolvedValue({ id: "u1", display_name: "Ann", plan: "pro" }));
  await first.controller.refreshAuthStatus();
  const next = make(vi.fn());
  expect(next.controller.useStoredSession()).toBe(true);
  expect(next.appState).toMatchObject({ authKnown: true, signedIn: true, accountUserId: "u1", accountUsername: "Ann" });
  expect(next.appState.account.plan).toBe("pro");
});

it("without a remembered session the boot waits for the server", () => {
  expect(make(vi.fn()).controller.useStoredSession()).toBe(false);
});

it("keeps asking while the server sleeps, then keeps the same session without a reset", async () => {
  vi.useFakeTimers();
  store.set("prepforge.session", JSON.stringify({ id: "u1", display_name: "Ann" }));
  const api = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Bad gateway"), { status: 502 }))
    .mockResolvedValueOnce({ id: "u1", display_name: "Ann B" });
  const { appState, controller, onOwnerChanged } = make(api);
  controller.useStoredSession();
  await controller.refreshAuthStatus();
  await vi.runOnlyPendingTimersAsync();
  expect(api).toHaveBeenCalledTimes(2);
  expect(appState.accountUsername).toBe("Ann B");
  expect(onOwnerChanged).not.toHaveBeenCalled();
  expect(window.location.reload).not.toHaveBeenCalled();
});

it("a remembered session the server no longer holds is forgotten and the app starts over", async () => {
  store.set("prepforge.session", JSON.stringify({ id: "u1" }));
  const { controller } = make(vi.fn().mockRejectedValue(Object.assign(new Error("no"), { status: 401 })));
  controller.useStoredSession();
  await controller.refreshAuthStatus();
  expect(store.has("prepforge.session")).toBe(false);
  expect(window.location.reload).toHaveBeenCalledOnce();
});
