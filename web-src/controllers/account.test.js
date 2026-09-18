import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountController } from "./account.js";

function makeController({ api = vi.fn(), postJson = vi.fn() } = {}) {
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
  });
  return { appState, controller, setStatus };
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
      signed_in: true,
      username: "alice",
      user_id: "user-1",
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
});
