import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// Characterization for the /api/dashboard recommendations rendering:
//  - the backend's personalized list (stored by loadDashboard) renders once, as
//    the numbered "Next steps" card under the repertoire table ("Get started"
//    for an account with no repertoires) — never inside the table itself;
//  - every object recommendation carries a CTA button that routes one click to
//    the view it targets (services/dashboard_recommendations.py owns the copy
//    and the ordering — this side just renders and routes).

function makeContainer() {
  return {
    innerHTML: "",
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
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
  let steps;
  let api;
  let goToView;
  let view;

  beforeEach(() => {
    container = makeContainer();
    todayCard = {
      hidden: true,
      innerHTML: "",
      querySelectorAll: vi.fn(() => []),
      querySelector: vi.fn(() => null),
      addEventListener: vi.fn(),
    };
    steps = {
      hidden: true,
      innerHTML: "",
      querySelectorAll: vi.fn(() => []),
      addEventListener: vi.fn(),
    };
    elements = new Map([
      ["dashboard-repertoires", container],
      ["dashboard-today", todayCard],
      ["dashboard-steps", steps],
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
    expect(container.innerHTML).toContain('class="empty-state big"');
    expect(container.innerHTML).not.toContain("step-n");
    expect(steps.hidden).toBe(false);
    expect(steps.innerHTML).toContain("<h2>Get started</h2>");
    expect(steps.innerHTML).toContain("<b>Build a repertoire in Build</b>");
    expect(steps.innerHTML).toContain("<b>Import your games in Replay</b>");
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
    expect(container.innerHTML).toContain('class="empty-state big"');
    expect(steps.hidden).toBe(true);
    expect(steps.innerHTML).toBe("");
  });

  it("titles the steps card Next steps and keeps the table free of them when repertoires exist", async () => {
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
    expect(container.innerHTML).not.toContain("step-n");
    expect(container.innerHTML).toContain("data-repertoire-id=\"rep-1\"");
    expect(steps.innerHTML).toContain("<h2>Next steps</h2>");
    expect(steps.innerHTML).toContain("<b>Build a repertoire in Build</b>");
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
    expect(steps.innerHTML).toContain("<b>5 review cards due now</b>");
    expect(steps.innerHTML).toContain("data-testid=\"rec-cta-train-due\"");
    expect(steps.innerHTML).toContain("data-rec-view=\"train\"");
    expect(steps.innerHTML).toContain("data-testid=\"rec-cta-create-repertoire\"");
    expect(steps.innerHTML).toContain("data-rec-view=\"build\"");
    // Order is the backend's (priority) order — preserved in the render.
    expect(steps.innerHTML.indexOf("rec-cta-train-due")).toBeLessThan(
      steps.innerHTML.indexOf("rec-cta-create-repertoire"),
    );
  });

  it("routes a CTA click to the recommendation's target view", async () => {
    const trainBtn = makeCtaButton("train");
    const buildBtn = makeCtaButton("build");
    steps.querySelectorAll.mockImplementation((selector) =>
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

  it("surfaces priority actions as numbered steps when repertoires exist", async () => {
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
    expect(steps.hidden).toBe(false);
    expect(steps.innerHTML).toContain("<h2>Next steps</h2>");
    expect(steps.innerHTML).toContain("data-testid=\"rec-cta-train-due\"");
    // …and not twice: the Today strip and the table carry no steps.
    expect(todayCard.innerHTML).not.toContain("rec-cta");
    expect(container.innerHTML).not.toContain("rec-cta");
  });

  it("renders state-driven actions compactly — no generic navigation, no prose", async () => {
    // Converged contract (services/dashboard_recommendations.py): the Next
    // steps card carries only state actions (due / weak) — the old generic rows
    // ("Analyze a game → Open Analyze", "Extend a repertoire branch → Open
    // Build") crowded the card and duplicated the top nav.
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
              detail: "",
              cta: { label: "Start due review", view: "train" },
            },
            {
              id: "review-weak",
              title: "Sharpen your weak spots",
              detail: "2 weak moves.",
              cta: { label: "Review weak moves", view: "train" },
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
    expect(steps.innerHTML).toContain("rec-cta-train-due");
    expect(steps.innerHTML).toContain("rec-cta-review-weak");
    expect(steps.innerHTML).not.toContain("Analyze a game");
    expect(steps.innerHTML).not.toContain("Extend a repertoire branch");
    // A state item without prose renders title-only — no empty detail paragraph.
    expect(steps.innerHTML).not.toContain('<p></p>');
  });

  it("keeps the Today strip free of steps and titles the card Get started for a repertoire-less account", async () => {
    await view.loadDashboard(); // default mock: brand-new account, no repertoires
    expect(todayCard.innerHTML).not.toContain("rec-cta");
    expect(todayCard.innerHTML).toContain("dashboard-train-now");
    expect(steps.innerHTML).toContain("Get started");
    expect(container.innerHTML).not.toContain("step-n");
  });

  it("renders the signed-out Library as the onboarding card without any API call", () => {
    view.renderSignedOut();
    expect(api).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain('data-testid="library-signed-out"');
    expect(container.innerHTML).toContain('data-lib-action="signin"');
    expect(todayCard.hidden).toBe(true);
    expect(steps.hidden).toBe(false);
    expect(steps.innerHTML).toContain("<h2>Get started</h2>");
    expect(steps.innerHTML.match(/class="step"/g)).toHaveLength(3);
  });
});
