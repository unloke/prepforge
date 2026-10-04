import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// Library load failures (/api/dashboard or /api/repertoires) share one
// composition: the empty layout (is-empty + is-error on .lib-list, no filter
// chips / column header / row hint), an explicit role=alert error card with a
// Retry, no Today strip or steps — and the error is reported through
// setStatusError and never overwritten by a trailing "Ready".

function classList() {
  const set = new Set();
  return {
    set,
    toggle: (name, on) => (on ? set.add(name) : set.delete(name)),
    contains: (name) => set.has(name),
  };
}

function makeEl(extra = {}) {
  return {
    hidden: false,
    innerHTML: "",
    textContent: "",
    querySelectorAll: vi.fn(() => []),
    querySelector: vi.fn(() => null),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    ...extra,
  };
}

const DASHBOARD = {
  streak: { current: 1, best: 2, trained_today: false },
  due_reviews: 0,
  due_soon: 0,
  repertoires: 1,
  recommendations: [],
};
const REPS = {
  repertoires: [{ id: "rep-1", name: "e4", color: "white", is_active: true, health: null }],
};

describe("Library error state", () => {
  let container;
  let card;
  let today;
  let steps;
  let cols;
  let count;
  let statuses;
  let refreshStatus;
  let api;
  let view;

  function build(apiImpl) {
    api = vi.fn(apiImpl);
    statuses = [];
    view = createDashboardView({
      appState: { signedIn: true, teams: [{ id: "t" }], pendingRepDeletes: new Set() },
      api,
      postJson: vi.fn(),
      escapeHtml: (s) => s,
      setStatus: (m) => statuses.push(["status", m]),
      setStatusError: (m) => statuses.push(["error", m]),
      localDateString: () => "2026-09-29",
      goToSmartTraining: vi.fn(),
      editRepertoire: vi.fn(),
      openRepertoireContextMenu: vi.fn(),
      createRepertoirePrompt: vi.fn(),
      hydrateBuild: vi.fn(),
      showInputModal: vi.fn(),
      promptImportRepertoireFromPgn: vi.fn(),
      requireSignIn: vi.fn(),
      goToView: vi.fn(),
    });
  }

  beforeEach(() => {
    container = makeEl({ closest: () => null });
    refreshStatus = makeEl({ hidden: true });
    card = makeEl({ classList: classList() });
    today = makeEl({ hidden: false, innerHTML: "<b>stale</b>" });
    steps = makeEl({ hidden: false, innerHTML: "<b>stale</b>" });
    cols = makeEl({ hidden: false });
    count = makeEl({ hidden: false, textContent: "3" });
    const els = new Map([
      ["dashboard-repertoires", container],
      ["library-refresh-status", refreshStatus],
      ["dashboard-today", today],
      ["dashboard-steps", steps],
      ["lib-cols", cols],
      ["dashboard-rep-count", count],
    ]);
    globalThis.document = {
      getElementById: (id) => els.get(id) || (id === "dashboard-train-now" ? makeEl() : null),
      querySelector: (sel) => (sel === "#view-dashboard .lib-list" ? card : null),
      querySelectorAll: () => [],
    };
  });

  afterEach(() => {
    delete globalThis.document;
  });

  function expectErrorComposition(message) {
    expect(container.innerHTML).toContain('data-testid="library-list-error"');
    expect(container.innerHTML).toContain('role="alert"');
    expect(container.innerHTML).toContain(message);
    expect(container.innerHTML).toContain('data-lib-action="retry-list"');
    expect(container.innerHTML).not.toContain("lib-row");
    expect(card.classList.contains("is-empty")).toBe(true);
    expect(card.classList.contains("is-error")).toBe(true);
    expect(cols.hidden).toBe(true);
    expect(count.hidden).toBe(true);

  }

  it("/api/dashboard failure renders the error card and never reports Ready", async () => {
    build(async (url) => {
      if (String(url).startsWith("/api/dashboard")) throw new Error("dashboard 500");
      return REPS;
    });
    await expect(view.loadDashboard()).rejects.toThrow("dashboard 500");
    expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
    expect(today.innerHTML).toContain("dashboard 500");
    expect(api).toHaveBeenCalledWith("/api/repertoires");
    expect(statuses).not.toContainEqual(["status", "Ready"]);
  });

  it("/api/repertoires failure renders the same card and never reports Ready", async () => {
    build(async (url) => {
      if (String(url).startsWith("/api/dashboard")) return DASHBOARD;
      throw new Error("repertoires 502");
    });
    await expect(view.loadDashboard()).rejects.toThrow("repertoires 502");
    expectErrorComposition("repertoires 502");
    expect(statuses).not.toContainEqual(["status", "Ready"]);
  });

  it("the first-load spinner state (is-loading from index.html) clears on success and on failure", async () => {
    build(async (url) => {
      if (String(url).startsWith("/api/dashboard")) return DASHBOARD;
      return REPS;
    });
    card.classList.set.add("is-loading");
    await view.loadDashboard();
    expect(card.classList.contains("is-loading")).toBe(false);
    build(async () => {
      throw new Error("dashboard 500");
    });
    card.classList.set.add("is-loading");
    await expect(view.loadDashboard()).rejects.toThrow();
    expect(card.classList.contains("is-loading")).toBe(false);
  });

  it("a later successful load clears is-error and reports Ready", async () => {
    let fail = true;
    build(async (url) => {
      if (String(url).startsWith("/api/dashboard")) return DASHBOARD;
      if (fail) throw new Error("repertoires 502");
      return REPS;
    });
    await expect(view.loadDashboard()).rejects.toThrow();
    fail = false;
    await view.loadDashboard();
    expect(card.classList.contains("is-error")).toBe(false);
    expect(card.classList.contains("is-empty")).toBe(false);
    expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
    expect(statuses.at(-1)).toEqual(["status", "Ready"]);
  });

  it("the Retry button reruns the load and surfaces a repeated failure as an error", async () => {
    build(async () => { throw new Error("still down"); });
    view.bind();
    await expect(view.loadDashboard()).rejects.toThrow();
    const onClick = container.addEventListener.mock.calls.find(([t]) => t === "click")[1];
    const retryBtn = { dataset: { libAction: "retry-list" } };
    onClick({ target: { closest: () => retryBtn } });
    await vi.waitFor(() => expect(statuses).toContainEqual(["error", "still down"]));
    expect(api.mock.calls.filter(([u]) => String(u).startsWith("/api/dashboard"))).toHaveLength(1);
  });
  // Background refresh (loadDashboardRepertoires after CRUD elsewhere) keeps
  // the page composition: only the list shows a scoped error + Retry.
  describe("background refresh failure", () => {
    it("keeps Today / Get started and shows a scoped list error + status error", async () => {
      let failList = false;
      build(async (url) => {
        if (String(url).startsWith("/api/dashboard")) return { ...DASHBOARD, repertoires: 0 };
        if (failList) throw new Error("refresh 503");
        return REPS;
      });
      await view.loadDashboard();
      const todayHtml = today.innerHTML;
      const stepsHtml = steps.innerHTML;
      expect(steps.hidden).toBe(false);
      expect(stepsHtml).not.toBe("");

      failList = true;
      await expect(view.loadDashboardRepertoires()).resolves.toBe(false);
      expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
      expect(refreshStatus.hidden).toBe(false);
      expect(refreshStatus.innerHTML).toContain("refresh 503");
      expect(refreshStatus.innerHTML).toContain("Retry");
      expect(card.classList.contains("is-error")).toBe(false);
      expect(cols.hidden).toBe(false);
      expect(today.hidden).toBe(false);
      expect(today.innerHTML).toBe(todayHtml);
      expect(steps.hidden).toBe(false);
      expect(steps.innerHTML).toBe(stepsHtml);
      expect(statuses.at(-1)).toEqual(["error", "refresh 503"]);
    });

    it("the next successful refresh restores the list without touching Today / steps", async () => {
      let failList = false;
      build(async (url) => {
        if (String(url).startsWith("/api/dashboard")) return { ...DASHBOARD, repertoires: 0 };
        if (failList) throw new Error("refresh 503");
        return REPS;
      });
      await view.loadDashboard();
      const stepsHtml = steps.innerHTML;
      failList = true;
      await view.loadDashboardRepertoires();
      failList = false;
      await expect(view.loadDashboardRepertoires()).resolves.toBe(true);
      expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
      expect(container.innerHTML).not.toContain("library-list-error");
      expect(card.classList.contains("is-error")).toBe(false);
      expect(card.classList.contains("is-empty")).toBe(false);
      expect(cols.hidden).toBe(false);
      expect(today.hidden).toBe(false);
      expect(steps.hidden).toBe(false);
      expect(steps.innerHTML).toBe(stepsHtml);
    });

    it("the scoped Retry reloads only the listing and reports Ready on success", async () => {
      let failList = true;
      build(async (url) => {
        if (String(url).startsWith("/api/dashboard")) return DASHBOARD;
        if (failList) throw new Error("refresh 503");
        return REPS;
      });
      view.bind();
      await view.loadDashboardRepertoires();
      failList = false;
      const onClick = container.addEventListener.mock.calls.find(([t]) => t === "click")[1];
      const retryBtn = { dataset: { libAction: "retry-list" } };
      onClick({ target: { closest: () => retryBtn } });
      await vi.waitFor(() => expect(statuses.at(-1)).toEqual(["status", "Ready"]));
      expect(container.innerHTML).toContain('data-repertoire-id="rep-1"');
      expect(api.mock.calls.some(([u]) => String(u).startsWith("/api/dashboard"))).toBe(false);
      expect(today.hidden).toBe(false);
    });

    it("a full-load /api/repertoires failure still uses the full error composition", async () => {
      build(async (url) => {
        if (String(url).startsWith("/api/dashboard")) return DASHBOARD;
        throw new Error("repertoires 502");
      });
      await expect(view.loadDashboard()).rejects.toThrow("repertoires 502");
      expectErrorComposition("repertoires 502");
    });
  });
});
