// Session expiry: a signed-in user whose session ended sees the sign-in
// dialog. Closing it used to leave the account menu and the account's Library
// on screen. Now the server is asked, the pending work goes to the durable
// outbox, and the page reloads into the signed-out shell. A guest closing the
// same dialog, a session the server still knows, and an outbox write that
// failed all leave the page alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountController } from "./account.js";

function makeController({ api = vi.fn(), onReload = vi.fn(), beforeSessionEnd = null, onOwnerChanged = vi.fn() } = {}) {
  const appState = { signedIn: false, accountUsername: null, accountUserId: null, authProviders: null, lichessUsername: null };
  const setStatus = vi.fn();
  const controller = createAccountController({
    appState, api, postJson: vi.fn(), setStatus, showConfirmModal: vi.fn(), refreshAutoMaiaRating: vi.fn(),
    onReload, beforeSessionEnd, onOwnerChanged,
  });
  return { appState, controller, setStatus, onReload, onOwnerChanged };
}

describe("session ended", () => {
  let overlays;
  beforeEach(() => {
    overlays = [];
    globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalThis.window = { location: { hash: "#/dashboard", href: "https://x.test/#/dashboard" } };
    globalThis.document = {
      getElementById: () => null,
      querySelector: (sel) => (sel === "dialog.auth-modal" ? overlays.find((o) => !o.removed) || null : null),
      createElement: () => {
        const overlay = {
          className: "", dataset: {}, removed: false, listeners: {},
          get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
          addEventListener(name, fn) { this.listeners[name] = fn; },
          setAttribute() {},
          showPopover() {},
          hidePopover() {},
          contains: () => false,
          querySelector: () => null,
          remove() { this.removed = true; },
        };
        overlays.push(overlay);
        return overlay;
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
  afterEach(() => {
    delete globalThis.sessionStorage;
    delete globalThis.window;
    delete globalThis.document;
  });

  const unauthorized = () => Object.assign(new Error("Sign in"), { status: 401 });

  it("dismissing the session-ended sign-in keeps the outbox, then reloads signed out", async () => {
    const order = [];
    const api = vi.fn().mockImplementation(async () => { order.push("me"); throw unauthorized(); });
    const beforeSessionEnd = vi.fn().mockImplementation(async () => { order.push("outbox"); return true; });
    const onReload = vi.fn(() => order.push("reload"));
    const { appState, controller, onOwnerChanged } = makeController({ api, beforeSessionEnd, onReload });
    Object.assign(appState, { signedIn: true, accountUserId: "u1", ownerGeneration: 3 });
    controller.handleAuthRequired();
    expect(String(overlays[0].innerHTML)).toContain("Your session has ended");
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith("/api/auth/me");
    expect(order).toEqual(["me", "outbox", "reload"]);
    expect(appState).toMatchObject({ signedIn: false, accountUserId: null, ownerGeneration: 4 });
    expect(onOwnerChanged).toHaveBeenCalledTimes(1);
  });

  it("stays signed in when the server still knows the session", async () => {
    const api = vi.fn().mockResolvedValue({ id: "u1" });
    const beforeSessionEnd = vi.fn();
    const { appState, controller, onReload } = makeController({ api, beforeSessionEnd });
    appState.signedIn = true;
    controller.handleAuthRequired();
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/auth/me"));
    await Promise.resolve();
    expect(beforeSessionEnd).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(appState.signedIn).toBe(true);
  });

  it("does not reload away work the outbox could not keep", async () => {
    const api = vi.fn().mockRejectedValue(unauthorized());
    const beforeSessionEnd = vi.fn().mockResolvedValue(false);
    const { appState, controller, onReload, setStatus } = makeController({ api, beforeSessionEnd });
    appState.signedIn = true;
    controller.handleAuthRequired();
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith(expect.stringContaining("could not be kept"), { severity: "error" }));
    expect(onReload).not.toHaveBeenCalled();
    expect(appState.signedIn).toBe(true);
  });

  it("a guest closing the sign-in is not a session end", async () => {
    const api = vi.fn();
    const { controller, onReload } = makeController({ api });
    controller.handleAuthRequired();
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    await Promise.resolve();
    expect(api).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });
});
