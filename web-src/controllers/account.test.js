import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountController } from "./account.js";

function makeController({ api = vi.fn(), postJson = vi.fn(), onOpenSettings = vi.fn() } = {}) {
  const appState = {
    signedIn: false,
    accountUsername: null,
    accountUserId: null,
    authProviders: null,
    lichessUsername: null,
  };
  const setStatus = vi.fn();
  const controller = createAccountController({
    appState,
    api,
    postJson,
    setStatus,
    escapeHtml: (value) => String(value),
    showConfirmModal: vi.fn(),
    refreshAutoMaiaRating: vi.fn(),
    onOpenSettings,
  });
  return { appState, controller, setStatus, onOpenSettings };
}

describe("account controller", () => {
  beforeEach(() => {
    globalThis.document = { getElementById: () => null };
    globalThis.localStorage = {
      values: new Map(),
      getItem(key) {
        return this.values.get(key) ?? null;
      },
      setItem(key, value) {
        this.values.set(key, String(value));
      },
      removeItem(key) {
        this.values.delete(key);
      },
    };
  });

  it("falls back to password auth when provider discovery fails", async () => {
    const api = vi.fn().mockRejectedValue(new Error("offline"));
    const { appState, controller } = makeController({ api });

    await controller.refreshAuthProviders();

    expect(appState.authProviders).toEqual({ google: false, password: true });
    expect(api).toHaveBeenCalledWith("/api/auth/providers");
  });

  it("maps server auth status into the shared app session state", async () => {
    const api = vi.fn().mockResolvedValue({
      id: "user-1",
      display_name: "alice",
    });
    const { appState, controller } = makeController({ api });

    await controller.refreshAuthStatus();

    expect(appState).toMatchObject({
      signedIn: true,
      accountUsername: "alice",
      accountUserId: "user-1",
    });
  });

  it("persists and clears the linked Lichess username", () => {
    const { appState, controller } = makeController();

    controller.setLichessUsername("  Player  ");
    expect(appState.lichessUsername).toBe("Player");
    expect(controller.getStoredLichessUsername()).toBe("Player");

    controller.setLichessUsername("");
    expect(appState.lichessUsername).toBeNull();
    expect(controller.getStoredLichessUsername()).toBeNull();
  });

  it("only opens Settings from an explicit menu action, never from hydration", async () => {
    // S1 startup invariant: delayed signed-in hydration (auth/Lichess) must
    // not self-navigate — Settings opens only via the account-menu action.
    const api = vi.fn().mockResolvedValue({
      id: "user-1",
      display_name: "alice",
    });
    const { appState, controller, onOpenSettings } = makeController({ api });

    await controller.refreshAuthStatus();
    await controller.refreshAuthStatus();

    const lichessApi = vi.fn().mockResolvedValue({
      linked: true,
      username: "alice",
      accounts: [{ id: "a", username: "alice", is_primary: true }],
    });
    const { controller: lichessController } = makeController({ api: lichessApi });
    await lichessController.refreshLichessStatus();

    expect(appState.signedIn).toBe(true);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });
});

// Unified sign-in gate: the reason shows inside the modal, the interrupted
// action is remembered (allowlisted), and closing the modal forgets it.
describe("sign-in gate", () => {
  let overlays;
  let docListeners;
  let session;
  beforeEach(() => {
    overlays = [];
    docListeners = {};
    session = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k),
    };
    globalThis.window = {
      location: { hash: "#/dashboard", href: "https://x.test/#/dashboard", assign: vi.fn() },
      open: vi.fn(),
    };
    globalThis.document = {
      getElementById: () => null,
      querySelector: (sel) => (sel === ".modal-overlay.auth-overlay" ? overlays.find((o) => !o.removed) || null : null),
      createElement: () => {
        const listeners = {};
        const overlay = {
          className: "",
          dataset: {},
          innerHTML: "",
          removed: false,
          listeners,
          addEventListener: (name, fn) => {
            listeners[name] = fn;
          },
          querySelector: () => null,
          remove() {
            this.removed = true;
          },
        };
        overlays.push(overlay);
        return overlay;
      },
      body: { appendChild: () => {} },
      addEventListener: (name, fn) => {
        docListeners[name] = fn;
      },
      removeEventListener: (name) => {
        delete docListeners[name];
      },
    };
  });
  afterEach(() => {
    delete globalThis.sessionStorage;
    delete globalThis.window;
  });

  it("returns true without a modal when signed in", () => {
    const { appState, controller } = makeController();
    appState.signedIn = true;
    expect(controller.requireSignIn("Sign in to start training", "train")).toBe(true);
    expect(overlays).toHaveLength(0);
  });

  it("opens the modal with the reason, a close button and labelled inputs", () => {
    const { controller, setStatus } = makeController();
    expect(controller.requireSignIn("Sign in to create a repertoire", "new-repertoire")).toBe(false);
    const html = overlays[0].innerHTML;
    expect(html).toContain("Sign in to create a repertoire");
    expect(html).toContain('data-action="close"');
    expect(html).toContain('for="auth-email"');
    expect(html).toContain('id="auth-email"');
    expect(html).toContain('for="auth-password"');
    expect(html).toContain("auth-switch");
    // The reason lives in the modal, not a toast hidden behind the backdrop.
    expect(setStatus).not.toHaveBeenCalled();
    expect(JSON.parse(session.get("prepforge.pending_action"))).toMatchObject({
      id: "new-repertoire",
      route: "#/dashboard",
    });
  });

  it("forgets the pending action when the user closes the modal", () => {
    const { controller } = makeController();
    controller.requireSignIn("Sign in to create a team", "new-team");
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    expect(overlays[0].removed).toBe(true);
    expect(session.has("prepforge.pending_action")).toBe(false);
    expect(docListeners.keydown).toBeUndefined();
  });

  it("keeps the pending action across the Google redirect", () => {
    const { controller } = makeController();
    controller.requireSignIn("Sign in to start training", "train");
    overlays[0].listeners.click({ target: { dataset: { action: "google" } } });
    expect(window.location.assign).toHaveBeenCalledWith("/api/auth/google/login");
    expect(session.has("prepforge.pending_action")).toBe(true);
    expect(session.has("prepforge.auth_return")).toBe(true);
  });

  it("passes the original Analyze source through the gate and Google redirect", () => {
    const { controller } = makeController();
    const data = { pgn: "1. d4 d5 *", mode: "single", selectIndex: 0 };
    controller.requireSignIn("Sign in to review", "analyze-game", data);
    overlays[0].listeners.click({ target: { dataset: { action: "google" } } });
    expect(JSON.parse(session.get("prepforge.pending_action")).data).toEqual(data);
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    expect(session.has("prepforge.pending_action")).toBe(false);
  });

  it("does not store an unknown action id", () => {
    const { controller } = makeController();
    controller.requireSignIn("Sign in", "rm -rf");
    expect(session.has("prepforge.pending_action")).toBe(false);
  });

  it("gates Lichess linking for a guest instead of opening the 401 popup", () => {
    const { controller } = makeController();
    expect(controller.startLichessOAuth()).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
    expect(overlays[0].innerHTML).toContain("Sign in to link your Lichess account");
  });

  it("turns a 401 into the sign-in modal, but backs off right after a dismissal", () => {
    const { controller, setStatus } = makeController();
    controller.handleAuthRequired();
    expect(overlays).toHaveLength(1);
    // Already open: no second modal.
    controller.handleAuthRequired();
    expect(overlays).toHaveLength(1);
    overlays[0].listeners.click({ target: { dataset: { action: "close" } } });
    controller.handleAuthRequired();
    expect(overlays).toHaveLength(1);
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining("Sign in"), { severity: "warning" });
  });
});

// M2: the account menu opened from the mobile More sheet takes focus, marks
// its trigger expanded, and hands focus back to that trigger on Escape-close.
describe("account menu focus", () => {
  function el(id, { visible = true } = {}) {
    const attrs = new Map();
    return {
      id,
      hidden: false,
      innerHTML: "",
      textContent: "",
      title: "",
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      hasAttribute: (k) => attrs.has(k),
      getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 100 }),
      getClientRects: () => (visible ? [{}] : []),
      focus: vi.fn(),
    };
  }

  let els;
  let menu;
  let firstItem;
  beforeEach(() => {
    firstItem = { focus: vi.fn(), addEventListener: vi.fn(), dataset: {} };
    menu = el("account-menu");
    menu.hidden = true;
    menu.querySelector = () => firstItem;
    menu.querySelectorAll = () => [firstItem];
    els = new Map(
      ["account-chip", "account-label", "sheet-account", "sheet-account-label"].map((id) => [id, el(id)]),
    );
    els.set("account-menu", menu);
    globalThis.document = { getElementById: (id) => els.get(id) || null };
    globalThis.window = { innerWidth: 390, innerHeight: 844 };
  });

  it("gives the sheet account item menu popup semantics only when signed in", () => {
    const { appState, controller } = makeController();
    const item = els.get("sheet-account");
    controller.renderAccountChip();
    expect(item.getAttribute("aria-haspopup")).toBe(null);
    appState.signedIn = true;
    appState.accountUsername = "alice";
    controller.renderAccountChip();
    expect(item.getAttribute("aria-haspopup")).toBe("menu");
    expect(item.getAttribute("aria-expanded")).toBe("false");
  });

  it("moves focus into the menu and restores it to the sheet trigger on Escape-close", () => {
    const { appState, controller } = makeController();
    appState.signedIn = true;
    const item = els.get("sheet-account");
    controller.onAccountChipClick(null, { trigger: item });
    expect(menu.hidden).toBe(false);
    expect(firstItem.focus).toHaveBeenCalled();
    expect(item.getAttribute("aria-expanded")).toBe("true");
    expect(controller.isAccountMenuOpen()).toBe(true);

    controller.closeAccountMenu({ restoreFocus: true });
    expect(menu.hidden).toBe(true);
    expect(item.getAttribute("aria-expanded")).toBe("false");
    expect(item.focus).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus on an outside-click close or when the trigger is gone", () => {
    const { appState, controller } = makeController();
    appState.signedIn = true;
    const item = els.get("sheet-account");
    controller.onAccountChipClick(null, { trigger: item });
    controller.closeAccountMenu();
    expect(item.focus).not.toHaveBeenCalled();

    const hiddenItem = el("sheet-account", { visible: false });
    els.set("sheet-account", hiddenItem);
    controller.onAccountChipClick(null, { trigger: hiddenItem });
    controller.closeAccountMenu({ restoreFocus: true });
    expect(hiddenItem.focus).not.toHaveBeenCalled();
    expect(hiddenItem.getAttribute("aria-expanded")).toBe("false");
  });
});

// L2: the desktop rail expands on hover/focus and collapses once the pointer
// or focus moves into the menu; the menu re-anchors on every rail resize so it
// never hangs at the expanded (204px) rail edge.
describe("account menu follows the rail", () => {
  let observers;
  let chipRight;
  let menu;
  let chip;
  let rail;
  beforeEach(() => {
    observers = [];
    globalThis.ResizeObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.targets = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(t) { this.targets.push(t); }
      disconnect() { this.disconnected = true; }
    };
    chipRight = 196;
    rail = { id: "rail" };
    const attrs = new Map();
    chip = {
      id: "account-chip",
      hidden: false,
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      getBoundingClientRect: () => ({ left: 8, right: chipRight, top: 840, bottom: 876, width: chipRight - 8, height: 36 }),
      getClientRects: () => [{}],
      closest: (sel) => (sel === ".rail" ? rail : null),
      focus: vi.fn(),
    };
    const firstItem = { focus: vi.fn(), addEventListener: vi.fn(), dataset: {} };
    menu = {
      id: "account-menu",
      hidden: true,
      innerHTML: "",
      style: {},
      getBoundingClientRect: () => ({ width: 200, height: 160 }),
      querySelector: () => firstItem,
      querySelectorAll: () => [firstItem],
    };
    const els = new Map([["account-chip", chip], ["account-menu", menu]]);
    globalThis.document = { getElementById: (id) => els.get(id) || null };
    globalThis.window = { innerWidth: 1440, innerHeight: 900 };
  });
  afterEach(() => {
    delete globalThis.ResizeObserver;
  });

  it("re-anchors beside the collapsed rail and stops observing on close", () => {
    const { appState, controller } = makeController();
    appState.signedIn = true;
    controller.onAccountChipClick();
    expect(menu.style.left).toBe("204px");
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual([rail]);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // Rail collapses to its 60px track: chip right edge 52 → menu at 60.
    chipRight = 52;
    observers[0].cb();
    expect(menu.style.left).toBe("60px");
    expect(menu.style.top).toBe(`${876 - 160}px`);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    controller.closeAccountMenu();
    expect(observers[0].disconnected).toBe(true);
    chipRight = 196;
    observers[0].cb();
    expect(menu.style.left).toBe("60px");
  });

  it("does not observe anything for a trigger outside the rail (mobile sheet)", () => {
    const { appState, controller } = makeController();
    appState.signedIn = true;
    const sheetItem = { ...chip, closest: () => null, getBoundingClientRect: () => ({ width: 0 }) };
    controller.onAccountChipClick(sheetItem, { trigger: chip });
    expect(observers).toHaveLength(0);
  });
});
