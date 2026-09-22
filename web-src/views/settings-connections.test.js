import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsView } from "./settings.js";

function makeSettingsView(overrides = {}) {
  const elements = {};
  const listeners = {};
  const listChildren = [];
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: vi.fn(),
  };
  elements["settings-lichess-accounts"] = {
    innerHTML: "",
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  elements["settings-link-lichess"] = { addEventListener: vi.fn() };
  const appState = { lichessUsername: null, lichessAccounts: [], ...(overrides.appState || {}) };
  const view = createSettingsView({
    appState,
    setStatus: vi.fn(),
    saveSettings: vi.fn(),
    loadSettings: vi.fn(),
    pref: () => "system",
    setPref: vi.fn(),
    effectiveMaiaRating: () => 1500,
    maiaFallbackRating: 1500,
    getSharedMaia3Provider: () => ({ state: "ready", info: {} }),
    disposeSharedMaia3Provider: vi.fn(),
    showConfirmModal: vi.fn().mockResolvedValue(true),
    startFen: "startpos",
    api: async () => overrides.apiResponse ?? { linked: false, username: null, accounts: [] },
    postJson: async () => ({}),
    startLichessOAuth: vi.fn(),
    onAccountsChanged: vi.fn(),
    ...(overrides.view || {}),
  });
  view.bind();
  return { appState, elements, listChildren, listeners, view };
}

describe("settings connections", () => {
  beforeEach(() => {
    delete globalThis.document;
  });

  it("renders linked accounts with the primary marked", async () => {
    const { elements, view } = makeSettingsView({
      apiResponse: {
        linked: true,
        username: "account_a",
        accounts: [
          { id: "a", username: "account_a", is_primary: true },
          { id: "b", username: "account_b", is_primary: false },
        ],
      },
    });

    await view.refreshConnections();

    const html = elements["settings-lichess-accounts"].innerHTML;
    expect(html).toContain("account_a");
    expect(html).toContain('class="conn-primary">Primary</span>');
    expect(html).not.toContain("account_a — Primary");
    expect(html).toContain("account_b");
    expect(html).toContain('data-account-id="b"');
    expect(html).toContain('data-conn-action="menu"');
    expect(html).toContain('aria-label="Account actions for account_b"');
    expect(html.match(/data-conn-action="primary"/g) || []).toHaveLength(1);
    expect(html).toContain('data-conn-action="unlink"');
  });

  it("sets a new primary through the API and refreshes", async () => {
    const postJson = vi.fn().mockResolvedValue({});
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        linked: true,
        username: "account_a",
        accounts: [
          { id: "a", username: "account_a", is_primary: true },
          { id: "b", username: "account_b", is_primary: false },
        ],
      })
      .mockResolvedValue({
        linked: true,
        username: "account_b",
        accounts: [
          { id: "a", username: "account_a", is_primary: false },
          { id: "b", username: "account_b", is_primary: true },
        ],
      });
    const setStatus = vi.fn();
    const onAccountsChanged = vi.fn();
    const showConfirmModal = vi.fn().mockResolvedValue(true);
    const { appState, elements, listeners, view } = makeSettingsView({
      view: { api, postJson, setStatus, onAccountsChanged, showConfirmModal },
    });

    await view.refreshConnections();
    expect(appState.lichessUsername).toBe("account_a");

    listeners.click({
      target: {
        closest(selector) {
          if (selector === "[data-conn-action]") return { dataset: { connAction: "primary" } };
          if (selector === "[data-account-id]")
            return {
              dataset: { accountId: "b" },
              querySelector: () => null,
            };
          return null;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postJson).toHaveBeenCalledWith("/api/lichess/primary", { account_id: "b" });
    expect(appState.lichessUsername).toBe("account_b");
    expect(onAccountsChanged).toHaveBeenCalled();
    const html = elements["settings-lichess-accounts"].innerHTML;
    expect(html).toContain("account_b");
    expect(html).toContain('class="conn-primary">Primary</span>');
    expect(html).not.toContain("account_b — Primary");
  });

  it("unlinks through the CSRF-aware api DELETE path", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        linked: true,
        username: "account_a",
        accounts: [{ id: "a", username: "account_a", is_primary: true }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValue({ linked: false, username: null, accounts: [] });
    const { listeners, view } = makeSettingsView({ view: { api } });
    await view.refreshConnections();

    listeners.click({
      target: {
        closest(selector) {
          if (selector === "[data-conn-action]") return { dataset: { connAction: "unlink" } };
          if (selector === "[data-account-id]") return { dataset: { accountId: "a" } };
          return null;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api).toHaveBeenCalledWith("/api/lichess/a", { method: "DELETE" });
  });
});
