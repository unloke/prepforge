import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// Library "Get started" setup checklist (signed in):
//  - three steps — build a repertoire / link Lichess / finish a training
//    session — each ticked from state the app already has (dashboard counts,
//    linked Lichess identities), so no separate onboarding status exists;
//  - the card stays until EVERY step is done (linking Lichess no longer
//    disappears as soon as a repertoire exists), then hides;
//  - it carries setup only: due / weak training never renders here (the Today
//    strip owns it), even when the backend ships recommendations.

function makeContainer() {
  return {
    innerHTML: "",
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
}

describe("dashboard setup checklist", () => {
  let appState;
  let elements;
  let container;
  let todayCard;
  let steps;
  let api;
  let goToView;
  let view;

  const dashboardPayload = (extra = {}) => ({
    streak: { current: 0, best: 0, trained_today: false },
    due_reviews: 0,
    due_soon: 0,
    games: 0,
    repertoires: 0,
    training_sessions: 0,
    recommendations: [],
    ...extra,
  });
  const mockDashboard = (extra, repertoires = []) =>
    api.mockImplementation(async (url) =>
      String(url).startsWith("/api/dashboard") ? dashboardPayload(extra) : { repertoires },
    );

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
    appState = { signedIn: true, teams: [], pendingRepDeletes: new Set(), lichessAccounts: [] };
    view = createDashboardView({
      appState,
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

  it("shows all three setup steps for a brand-new account", async () => {
    await view.loadDashboard();
    expect(container.innerHTML).toContain('class="empty-state big"');
    expect(container.innerHTML).not.toContain("step-n");
    expect(steps.hidden).toBe(false);
    expect(steps.innerHTML).toContain("<h2>Get started</h2>");
    expect(steps.innerHTML).toContain("0 of 3 done");
    for (const id of ["repertoire", "lichess", "train"]) {
      expect(steps.innerHTML).toContain(`data-setup-step="${id}"`);
    }
    // One entry point per job: the repertoire step doesn't repeat Import PGN
    // (the empty state and the list header already carry it).
    expect(steps.innerHTML).not.toContain('data-lib-action="import"');
    // Training is locked until there is something to train.
    expect(steps.innerHTML).toMatch(/data-lib-action="train" disabled/);
  });

  it("keeps Link Lichess on the card after the first repertoire exists", async () => {
    mockDashboard({ repertoires: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    expect(steps.hidden).toBe(false);
    expect(steps.innerHTML).toContain("1 of 3 done");
    expect(steps.innerHTML).toMatch(/data-setup-step="repertoire"[^>]*>.*Done/s);
    expect(steps.innerHTML).toContain('data-lib-action="lichess"');
    expect(steps.innerHTML).not.toMatch(/data-lib-action="train" disabled/);
    expect(container.innerHTML).not.toContain("step-n");
  });

  it("ticks Link Lichess from the linked accounts and re-renders on refreshSetup", async () => {
    mockDashboard({ repertoires: 1 });
    await view.loadDashboard();
    expect(steps.innerHTML).toContain('data-lib-action="lichess"');
    appState.lichessAccounts = [{ id: "a1", username: "me", is_primary: true }];
    view.refreshSetup();
    expect(steps.innerHTML).toContain("2 of 3 done");
    expect(steps.innerHTML).not.toContain('data-lib-action="lichess"');
  });

  it("hides the card once every setup step is done", async () => {
    appState.lichessAccounts = [{ id: "a1", username: "me", is_primary: true }];
    mockDashboard({ repertoires: 2, training_sessions: 1 });
    await view.loadDashboard();
    expect(steps.hidden).toBe(true);
    expect(steps.innerHTML).toBe("");
  });

  it("does not repeat New repertoire on the checklist (the empty state has it)", async () => {
    await view.loadDashboard();
    expect(steps.innerHTML).not.toContain('data-lib-action="new"');
    expect(container.innerHTML).toContain('data-lib-action="new"');
  });

  it("offers a dismiss and stays hidden once dismissed", async () => {
    mockDashboard({ repertoires: 1 });
    await view.loadDashboard();
    expect(steps.innerHTML).toContain("data-setup-dismiss");
    const store = new Map([["prepforge.setup_dismissed", "1"]]);
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    try {
      await view.loadDashboard();
      expect(steps.hidden).toBe(true);
      expect(steps.innerHTML).toBe("");
    } finally {
      delete globalThis.localStorage;
    }
  });

  it("never renders training recommendations on the setup card", async () => {
    mockDashboard({
      repertoires: 2,
      due_reviews: 5,
      recommendations: [
        { id: "train-due", title: "5 review cards due now", detail: "", cta: { label: "Start due review", view: "train" } },
        { id: "review-weak", title: "Sharpen your weak spots", detail: "2 weak moves.", cta: { label: "Review weak moves", view: "train" } },
      ],
    });
    await view.loadDashboard();
    expect(steps.innerHTML).not.toContain("rec-cta");
    expect(steps.innerHTML).not.toContain("due now");
    expect(steps.innerHTML).not.toContain("weak spots");
    // The Today strip keeps the Train entry point.
    expect(todayCard.innerHTML).toContain("dashboard-train-now");
  });

  it("Today strip separates clear reviews from new moves still to learn (P1-4)", async () => {
    mockDashboard(
      { repertoires: 1, streak: { current: 2, best: 2, trained_today: true } },
      [
        { id: "rep-1", name: "anti caro", color: "black", is_active: true, health: { untrained: 41, due: 0, weak: 0, mastery_pct: 0 } },
        { id: "rep-2", name: "off", color: "white", is_active: false, health: { untrained: 9 } },
      ],
    );
    await view.loadDashboard();
    expect(todayCard.innerHTML).toContain("Reviews clear");
    expect(todayCard.innerHTML).toContain("41 new moves to learn");
    expect(todayCard.innerHTML).not.toContain("Queue is clear");
    expect(todayCard.innerHTML).toContain("Learn new moves");
  });

  it("Today strip does not call reviews clear while a weak spot waits (UX 2026-10-01 P1-1)", async () => {
    mockDashboard({ repertoires: 1, due_reviews: 0 }, [
      { id: "rep-1", name: "anti caro", color: "white", is_active: true, health: { untrained: 33, due: 0, weak: 1 } },
      { id: "rep-2", name: "off", color: "white", is_active: false, health: { untrained: 0, weak: 4 } },
    ]);
    await view.loadDashboard();
    expect(todayCard.innerHTML).not.toContain("Reviews clear");
    expect(todayCard.innerHTML).not.toContain("Queue is clear");
    expect(todayCard.innerHTML).toContain("<b>1 weak spot to review</b>");
    expect(todayCard.innerHTML).toContain("33 new moves to learn");
    expect(todayCard.innerHTML).not.toContain("Learn new moves");
  });

  it("Today strip only says the queue is clear when nothing is due or new", async () => {
    mockDashboard({ repertoires: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: { untrained: 0, due: 0 } },
    ]);
    await view.loadDashboard();
    expect(todayCard.innerHTML).toContain("Queue is clear");
    expect(todayCard.innerHTML).toMatch(/data-testid="dashboard-train-now">Train</);
  });

  it("due reviews stay the headline, with new moves as a secondary count", async () => {
    mockDashboard({ repertoires: 1, due_reviews: 3 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: { untrained: 5, due: 3 } },
    ]);
    await view.loadDashboard();
    expect(todayCard.innerHTML).toContain("<b>3 due now</b>");
    expect(todayCard.innerHTML).toContain("5 new moves to learn");
    expect(todayCard.innerHTML).toMatch(/data-testid="dashboard-train-now">Train</);
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

  it.each(["resolve", "reject"])("ignores an older listing's late %s after a mutation refresh", async (outcome) => {
    mockDashboard({ repertoires: 1 });
    await view.loadDashboard();
    let resolve, reject;
    const oldRequest = new Promise((yes, no) => { resolve = yes; reject = no; });
    const oldRep = { id: "old", name: "Old repertoire", color: "white", health: { weak: 4, untrained: 9 } };
    const newRep = { id: "new", name: "Current repertoire", color: "black", health: { weak: 1, untrained: 2 } };
    appState.teams = [{ id: "team" }];
    api.mockImplementationOnce(() => oldRequest).mockResolvedValue({ repertoires: [newRep] });
    const oldLoad = view.loadDashboardRepertoires();
    await view.loadDashboardRepertoires();
    if (outcome === "resolve") resolve({ repertoires: [oldRep] });
    else reject(new Error("Old load failed"));
    await oldLoad;
    expect(appState.repertoireList).toEqual([newRep]);
    expect(container.innerHTML).toContain("Current repertoire");
    expect(container.innerHTML).not.toContain("Old load failed");
    expect(todayCard.innerHTML).toContain("1 weak spot to review");
    expect(todayCard.innerHTML).toContain("2 new moves to learn");
  });

  it("does not restore owner data when a dashboard response lands after sign-out", async () => {
    let resolve;
    api.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const load = view.loadDashboard();
    appState.signedIn = false;
    view.renderSignedOut();
    resolve(dashboardPayload({ repertoires: 3, due_reviews: 8 }));
    await load;
    expect(container.innerHTML).toContain('data-testid="library-signed-out"');
    expect(todayCard.hidden).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
