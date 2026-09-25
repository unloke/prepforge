import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// Characterization for the empty-state next-steps list: when the account has no
// repertoires, the card must render the backend's /api/dashboard recommendations
// (already stored by loadDashboard) instead of a second hardcoded frontend copy.

function makeContainer() {
  return {
    innerHTML: "",
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
  };
}

describe("dashboard empty-state recommendations", () => {
  let elements;
  let container;
  let todayCard;
  let metrics;
  let api;
  let view;

  beforeEach(() => {
    container = makeContainer();
    todayCard = {
      hidden: true,
      innerHTML: "",
      addEventListener: vi.fn(),
    };
    metrics = { innerHTML: "", querySelector: vi.fn(() => null) };
    elements = new Map([
      ["dashboard-repertoires", container],
      ["dashboard-today", todayCard],
      ["dashboard-metrics", metrics],
    ]);
    globalThis.document = {
      // "dashboard-train-now" only exists after renderDashboardToday writes the
      // card innerHTML — simulate that dynamic lookup with a permissive stub.
      getElementById: (id) => elements.get(id) || (id === "dashboard-train-now" ? { addEventListener: vi.fn() } : null),
      querySelector: () => null,
    };

    api = vi.fn(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 0, best: 0, trained_today: false },
          due_reviews: 0,
          due_soon: 0,
          games: 0,
          repertoires: 0,
          training_sessions: 0,
          recommendations: ["Build a repertoire in Build", "Import your games in Replay"],
        };
      }
      return { repertoires: [] };
    });

    const noop = vi.fn();
    view = createDashboardView({
      appState: { signedIn: true, teams: [], pendingRepDeletes: new Set() },
      api,
      postJson: noop,
      escapeHtml: (s) => s,
      setStatus: noop,
      localDateString: () => "2026-09-25",
      goToSmartTraining: noop,
      editRepertoire: noop,
      openRepertoireContextMenu: noop,
      createRepertoirePrompt: noop,
      hydrateBuild: noop,
      showInputModal: noop,
      promptImportRepertoireFromPgn: noop,
      requireSignIn: noop,
    });
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it("renders the stored /api/dashboard recommendations in the empty state", async () => {
    await view.loadDashboard();
    expect(container.innerHTML).toContain('class="empty-state"');
    expect(container.innerHTML).toContain('<ul class="dashboard-next-steps">');
    expect(container.innerHTML).toContain("<li>Build a repertoire in Build</li>");
    expect(container.innerHTML).toContain("<li>Import your games in Replay</li>");
  });

  it("omits the next-steps list when the payload carries no recommendations", async () => {
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 0, best: 0, trained_today: false },
          recommendations: [],
        };
      }
      return { repertoires: [] };
    });
    await view.loadDashboard();
    expect(container.innerHTML).toContain('class="empty-state"');
    expect(container.innerHTML).not.toContain("dashboard-next-steps");
  });

  it("does not render next steps when repertoires exist", async () => {
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 1, best: 3, trained_today: true },
          recommendations: ["Build a repertoire in Build"],
        };
      }
      return {
        repertoires: [
          { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
        ],
      };
    });
    await view.loadDashboard();
    expect(container.innerHTML).not.toContain("empty-state");
    expect(container.innerHTML).not.toContain("dashboard-next-steps");
    expect(container.innerHTML).toContain("data-repertoire-id=\"rep-1\"");
  });
});
