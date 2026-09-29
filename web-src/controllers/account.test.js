import { beforeEach, describe, expect, it, vi } from "vitest";
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
