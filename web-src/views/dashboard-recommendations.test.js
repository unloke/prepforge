import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// Characterization for the /api/dashboard recommendations rendering:
//  - the repertoires empty state renders the backend's personalized list
//    (already stored by loadDashboard) instead of a second hardcoded copy;
//  - every object recommendation carries a CTA button that routes one click to
//    the view it targets (services/dashboard_recommendations.py owns the copy
//    and the ordering — this side just renders and routes);
//  - priority actions (due review, weak spots) surface in the Today card when
//    the account already has repertoires, and never render twice.

function makeContainer() {
  return {
    innerHTML: "",
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
  };
}

function makeCtaButton(view) {
  const listeners = {};
  return {
    dataset: { recView: view },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    click: () => listeners.click && listeners.click(),
  };
}

describe("dashboard empty-state recommendations", () => {
  let elements;
  let container;
  let todayCard;
  let metrics;
  let api;
  let goToView;
  let view;

  beforeEach(() => {
    container = makeContainer();
    todayCard = {
      hidden: true,
      innerHTML: "",
      querySelectorAll: vi.fn(() => []),
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
    goToView = vi.fn();
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
      goToView,
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

  it("does not render next steps in the repertoires card when repertoires exist", async () => {
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 1, best: 3, trained_today: true },
          repertoires: 1,
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

  it("renders object recommendations with a CTA into the target view", async () => {
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 0, best: 0, trained_today: false },
          recommendations: [
            {
              id: "train-due",
              title: "5 review cards due now",
              detail: "Spaced repetition has cards ready today.",
              cta: { label: "Start due review", view: "train" },
            },
            {
              id: "create-repertoire",
              title: "Create or import your first repertoire",
              detail: "Build one from an opening you play.",
              cta: { label: "Open Build", view: "build" },
            },
          ],
        };
      }
      return { repertoires: [] };
    });
    await view.loadDashboard();
    expect(container.innerHTML).toContain("<b>5 review cards due now</b>");
    expect(container.innerHTML).toContain("data-testid=\"rec-cta-train-due\"");
    expect(container.innerHTML).toContain("data-rec-view=\"train\"");
    expect(container.innerHTML).toContain("data-testid=\"rec-cta-create-repertoire\"");
    expect(container.innerHTML).toContain("data-rec-view=\"build\"");
    // Order is the backend's (priority) order — preserved in the render.
    expect(container.innerHTML.indexOf("rec-cta-train-due")).toBeLessThan(
      container.innerHTML.indexOf("rec-cta-create-repertoire"),
    );
  });

  it("routes a CTA click to the recommendation's target view", async () => {
    const trainBtn = makeCtaButton("train");
    const buildBtn = makeCtaButton("build");
    container.querySelectorAll.mockImplementation((selector) =>
      selector === ".rec-cta" ? [trainBtn, buildBtn] : [],
    );
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 0, best: 0, trained_today: false },
          recommendations: [
            {
              id: "train-due",
              title: "2 review cards due now",
              detail: "Clear the queue.",
              cta: { label: "Start due review", view: "train" },
            },
            {
              id: "extend-repertoire",
              title: "Extend a repertoire branch",
              detail: "Widen your coverage.",
              cta: { label: "Open Build", view: "build" },
            },
          ],
        };
      }
      return { repertoires: [] };
    });
    await view.loadDashboard();

    trainBtn.click();
    expect(goToView).toHaveBeenCalledWith("train");
    buildBtn.click();
    expect(goToView).toHaveBeenCalledWith("build");
  });

  it("surfaces priority actions in the Today card when repertoires exist", async () => {
    api.mockImplementation(async (url) => {
      if (String(url).startsWith("/api/dashboard")) {
        return {
          streak: { current: 1, best: 3, trained_today: false },
          due_reviews: 5,
          repertoires: 2,
          recommendations: [
            {
              id: "train-due",
              title: "5 review cards due now",
              detail: "Clear the queue.",
              cta: { label: "Start due review", view: "train" },
            },
          ],
        };
      }
      return {
        repertoires: [
          { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
        ],
      };
    });
    await view.loadDashboard();
    expect(todayCard.hidden).toBe(false);
    expect(todayCard.innerHTML).toContain("dashboard-next-steps");
    expect(todayCard.innerHTML).toContain("data-testid=\"rec-cta-train-due\"");
    // …and not twice: the repertoires card shows the list, not the empty state.
    expect(container.innerHTML).not.toContain("dashboard-next-steps");
  });

  it("keeps the Today card free of next steps for a repertoire-less account", async () => {
    await view.loadDashboard(); // default mock: brand-new account, no repertoires
    expect(todayCard.innerHTML).not.toContain("dashboard-next-steps");
    // The onboarding list still lives in the repertoires empty state.
    expect(container.innerHTML).toContain("dashboard-next-steps");
  });
});
