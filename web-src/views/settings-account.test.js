import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountSection } from "./settings-account.js";

function setup({ appState, billing = null, api } = {}) {
  const body = { innerHTML: "", addEventListener: vi.fn() };
  globalThis.document = {
    getElementById: (id) => (id === "settings-account-body" ? body : null),
  };
  const download = vi.fn();
  const navigate = vi.fn();
  const calls = [];
  const section = createAccountSection({
    appState,
    api:
      api ||
      (async (path) => {
        calls.push(path);
        if (path === "/api/billing/status") return billing;
        if (path === "/api/account/export") return new Blob(['{"account":{"id":"u1"}}'], {type:"application/json"});
        return {};
      }),
    postJson: async (path) => {
      calls.push(path);
      return { url: "https://billing.example/session" };
    },
    setStatus: vi.fn(),
    showConfirmModal: vi.fn(),
    download,
    navigate,
  });
  return { section, body, download, navigate, calls };
}

afterEach(() => {
  delete globalThis.document;
});

function nodeStub() {
  return {
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    name: "",
    focus: vi.fn(),
    select: vi.fn(),
    addEventListener: vi.fn(),
  };
}
describe("Settings → Account", () => {
  it("offers sign-in to a guest and never asks the server for billing", async () => {
    const { section, body, calls } = setup({ appState: { signedIn: false } });
    await section.refresh();
    expect(body.innerHTML).toContain('data-acct="signin"');
    expect(body.innerHTML).toContain('data-acct="register"');
    expect(body.innerHTML).not.toContain('data-acct="delete"');
    expect(calls).toEqual([]);
  });

  it("shows profile, plan, export and delete for a password account", async () => {
    const { section, body } = setup({
      appState: {
        signedIn: true,
        account: { email: "a@b.com", displayName: "", plan: "free", hasPassword: true },
      },
      billing: { plan: "free", billing_enabled: true, price_configured: true },
    });
    await section.refresh();
    expect(body.innerHTML).toContain("a@b.com");
    expect(body.innerHTML).toContain('data-acct="password"');
    expect(body.innerHTML).toContain('data-acct="upgrade"');
    expect(body.innerHTML).not.toContain('data-acct="portal"');
    expect(body.innerHTML).toContain('data-acct="export"');
    expect(body.innerHTML).toContain('data-acct="delete"');
  });

  it("hides Change password for a Google-only account and billing buttons when billing is off", async () => {
    const { section, body } = setup({
      appState: {
        signedIn: true,
        account: { email: "g@b.com", displayName: "G", plan: "free", hasPassword: false },
      },
      billing: { plan: "free", billing_enabled: false, price_configured: false },
    });
    await section.refresh();
    expect(body.innerHTML).toContain("Google");
    expect(body.innerHTML).not.toContain('data-acct="password"');
    expect(body.innerHTML).not.toContain('data-acct="upgrade"');
  });

  it("offers Manage subscription to a Pro account and opens the portal", async () => {
    const { section, body, navigate, calls } = setup({
      appState: { signedIn: true, account: { email: "p@b.com", plan: "pro", hasPassword: true } },
      billing: { plan: "pro", billing_enabled: true, price_configured: true },
    });
    await section.refresh();
    expect(body.innerHTML).toContain('data-acct="portal"');
    await section.actions.portal();
    expect(calls).toContain("/api/billing/portal");
    expect(navigate).toHaveBeenCalledWith("https://billing.example/session");
  });

  it("escapes the email and display name", async () => {
    const { section, body } = setup({
      appState: {
        signedIn: true,
        account: { email: "<x>@b.com", displayName: "<img>", plan: "free", hasPassword: true },
      },
    });
    await section.refresh();
    expect(body.innerHTML).not.toContain("<img>");
    expect(body.innerHTML).toContain("&lt;img&gt;");
  });

  it("downloads the export bundle as a dated JSON file", async () => {
    const { section, download } = setup({
      appState: { signedIn: true, account: { email: "a@b.com", hasPassword: true } },
    });
    await section.actions.export();
    expect(download).toHaveBeenCalledTimes(1);
    const [data, name] = download.mock.calls[0];
    expect(data).toBeInstanceOf(Blob);
    expect(await data.text()).toBe('{"account":{"id":"u1"}}');
    expect(name).toMatch(/^prepforge-export-\d{4}-\d{2}-\d{2}\.json$/);
  });

  // The API caps passwords at 200 chars (ChangePasswordRequest). Without the
  // matching maxlength, a long passphrase passed client validation and came back
  // as a bare "Request failed (422)" that names no field.
  it("caps the password inputs at the API's 200-character limit", async () => {
    const created = [];
    const overlay = {
      className: "",
      innerHTML: "",
      querySelector: vi.fn(() => nodeStub()),
      querySelectorAll: vi.fn(() => []),
      addEventListener: vi.fn(),
      remove: vi.fn(),
    };
    globalThis.document = {
      getElementById: () => null,
      createElement: () => {
        created.push(overlay);
        return overlay;
      },
      body: { appendChild: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const section = createAccountSection({
      appState: { signedIn: true, account: { email: "a@b.com", hasPassword: true } },
      api: async () => ({}),
      postJson: async () => ({}),
      setStatus: vi.fn(),
      showConfirmModal: vi.fn(),
    });
    section.actions.password();
    await Promise.resolve();
    const html = created.map((o) => o.innerHTML).join("");
    expect(html).toContain('maxlength="200"');
    // All three password inputs are capped, not just one.
    expect(html.match(/maxlength="200"/g)).toHaveLength(3);
  });
});
