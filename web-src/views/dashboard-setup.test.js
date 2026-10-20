import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardView } from "./dashboard.js";

// Library "Get started" setup checklist (signed in):
//  - three steps — build a repertoire / link Lichess / finish a training
//    session — each ticked from state the app already has (dashboard counts,
//    linked Lichess identities), so no separate onboarding status exists;
//  - the card stays until EVERY step is done (linking Lichess no longer
//    disappears as soon as a repertoire exists), then hides;
//  - it carries setup only: due / weak training never renders here (the Today
//    strip owns it).

function makeContainer() {
  return {
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
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
      get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
      querySelectorAll: vi.fn(() => []),
      querySelector: vi.fn(() => null),
      addEventListener: vi.fn(),
    };
    steps = {
      hidden: true,
      get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
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
    expect(String(container.innerHTML)).toContain('class="empty-state big"');
    expect(String(container.innerHTML)).not.toContain("step-n");
    expect(steps.hidden).toBe(false);
    expect(String(steps.innerHTML)).toContain("<h2>Next steps</h2>");
    expect(String(steps.innerHTML)).toContain("0 of 3 done");
    for (const id of ["repertoire", "lichess", "train"]) {
      expect(String(steps.innerHTML)).toContain(`data-setup-step="${id}"`);
    }
    // One entry point per job: the repertoire step doesn't repeat Import PGN
    // (the empty state and the list header already carry it).
    expect(String(steps.innerHTML)).not.toContain('data-lib-action="import"');
    // Training waits for a repertoire, so the step names what is missing
    // instead of carrying a button that cannot apply.
    expect(String(steps.innerHTML)).not.toContain('data-lib-action="train"');
    expect(String(steps.innerHTML)).toMatch(/data-setup-step="train"[^]*?Add a repertoire first/);
  });

  it("a done step never carries a locked/blocked explanation (round 2, symptom 1)", async () => {
    // The account once trained (8 sessions) but has no repertoire now: the step
    // rendered "Done" and "Unlocks once you have a repertoire." together. Steps
    // keep no standing detail copy at all — the disabled Train says why.
    mockDashboard({ repertoires: 0, training_sessions: 8 });
    await view.loadDashboard();
    expect(String(steps.innerHTML)).toMatch(/data-setup-step="train"[^]*?Done/);
    expect(String(steps.innerHTML)).not.toContain("Unlocks once");
    expect(String(steps.innerHTML)).not.toMatch(/<div class="step-text"><b>[^<]+<\/b><p>/);
    // The open repertoire step is where the lock is named.
    expect(String(steps.innerHTML)).not.toMatch(/data-lib-action="train"/);
    expect(String(container.innerHTML)).toContain("No repertoires yet.");
  });

  it("keeps Link Lichess on the card after the first repertoire exists", async () => {
    mockDashboard({ repertoires: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    expect(steps.hidden).toBe(false);
    expect(String(steps.innerHTML)).toContain("1 of 3 done");
    expect(String(steps.innerHTML)).toMatch(/data-setup-step="repertoire"[^>]*>.*Done/s);
    expect(String(steps.innerHTML)).toContain('data-lib-action="lichess"');
    expect(String(steps.innerHTML)).toContain('data-lib-action="train"');
    expect(String(steps.innerHTML)).not.toMatch(/data-lib-action="train" disabled/);
    expect(String(container.innerHTML)).not.toContain("step-n");
  });

  it("the setup checklist marks its steps, it does not number them", async () => {
    // The mark column carried a tick for a finished step and a number for the
    // open one, so one list read as two. A phone shows no number at all.
    mockDashboard({ repertoires: 1 }, [{ id: "rep-1", name: "e4", color: "white", is_active: true, health: null }]);
    await view.loadDashboard();
    expect(String(steps.innerHTML)).not.toMatch(/class="step-n"[^>]*>[^<]*\d/);
  });

  it("ticks Link Lichess from the linked accounts and re-renders on refreshSetup", async () => {
    mockDashboard({ repertoires: 1 }, [{ id: "rep-1", name: "e4", color: "white", is_active: true, health: null }]);
    await view.loadDashboard();
    expect(String(steps.innerHTML)).toContain('data-lib-action="lichess"');
    appState.lichessAccounts = [{ id: "a1", username: "me", is_primary: true }];
    view.refreshSetup();
    expect(String(steps.innerHTML)).toContain("2 of 3 done");
    expect(String(steps.innerHTML)).not.toContain('data-lib-action="lichess"');
  });

  it("hides the card once every setup step is done", async () => {
    appState.lichessAccounts = [{ id: "a1", username: "me", is_primary: true }];
    mockDashboard({ repertoires: 2, training_sessions: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
      { id: "rep-2", name: "d4", color: "white", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    expect(steps.hidden).toBe(true);
    expect(String(steps.innerHTML)).toBe("");
  });

  it("counts saved analyses, not Lichess games", async () => {
    mockDashboard({ games: 3 });
    await view.loadDashboard();
    const counts = String(todayCard.innerHTML);
    expect(counts).toContain("<b>3</b> analyses");
    expect(counts).not.toContain("<b>3</b> games");
    expect(counts).toContain('title="Saved analyses, repertoires and training sessions"');
  });

  it("follows the repertoire listing, not the earlier dashboard read", async () => {
    // The dashboard was read before the first import; the listing refresh
    // after it already has the new repertoire.
    mockDashboard({ repertoires: 0 }, [{ id: "rep-1", name: "e4", color: "white", is_active: true, health: null }]);
    await view.loadDashboard();
    expect(String(steps.innerHTML)).toContain("1 of 3 done");
    expect(String(steps.innerHTML)).toContain('data-lib-action="train"');
    expect(String(steps.innerHTML)).not.toMatch(/data-lib-action="train" disabled/);
  });

  it("lists received shares beside own repertoires", async () => {
    api.mockImplementation(async (url) =>
      String(url).startsWith("/api/dashboard")
        ? dashboardPayload({ repertoires: 1 })
        : { repertoires: [{ id: "rep-1", name: "e4", color: "white", is_active: true, health: null }], shared: [{ id: "team-1", name: "Coach Sicilian", color: "black" }] },
    );
    await view.loadDashboard();
    const listing = String(container.innerHTML);
    expect(listing).toContain('data-repertoire-id="rep-1"');
    expect(listing).toContain('data-repertoire-id="team-1"');
    expect(listing).toMatch(/data-repertoire-id="team-1" data-shared="1"/);
  });

  it("does not repeat New repertoire on the checklist (the empty state has it)", async () => {
    await view.loadDashboard();
    expect(String(steps.innerHTML)).not.toContain('data-lib-action="new"');
    expect(String(container.innerHTML)).toContain('data-lib-action="new"');
  });

  it("offers a dismiss and stays hidden once dismissed", async () => {
    mockDashboard({ repertoires: 1 });
    await view.loadDashboard();
    expect(String(steps.innerHTML)).toContain("data-setup-dismiss");
    const store = new Map([["prepforge.setup_dismissed", "1"]]);
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    try {
      await view.loadDashboard();
      expect(steps.hidden).toBe(true);
      expect(String(steps.innerHTML)).toBe("");
    } finally {
      delete globalThis.localStorage;
    }
  });

  it("keeps due training off the setup card", async () => {
    mockDashboard({ repertoires: 2, due_reviews: 5 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
      { id: "rep-2", name: "d4", color: "white", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    expect(String(steps.innerHTML)).not.toContain("due");
    // The Today strip keeps the Train entry point.
    expect(String(todayCard.innerHTML)).toContain("dashboard-train-now");
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
    expect(String(todayCard.innerHTML)).toContain("Reviews clear");
    expect(String(todayCard.innerHTML)).toContain("41 new moves to learn");
    expect(String(todayCard.innerHTML)).not.toContain("Queue is clear");
    expect(String(todayCard.innerHTML)).toContain("Learn new moves");
  });

  it("Today strip does not call reviews clear while a weak spot waits (UX 2026-10-01 P1-1)", async () => {
    mockDashboard({ repertoires: 1, due_reviews: 0 }, [
      { id: "rep-1", name: "anti caro", color: "white", is_active: true, health: { untrained: 33, due: 0, weak: 1 } },
      { id: "rep-2", name: "off", color: "white", is_active: false, health: { untrained: 0, weak: 4 } },
    ]);
    await view.loadDashboard();
    expect(String(todayCard.innerHTML)).not.toContain("Reviews clear");
    expect(String(todayCard.innerHTML)).not.toContain("Queue is clear");
    expect(String(todayCard.innerHTML)).toContain("<b>1 weak spot to review</b>");
    expect(String(todayCard.innerHTML)).toContain("33 new moves to learn");
    expect(String(todayCard.innerHTML)).not.toContain("Learn new moves");
  });

  it("first run: the Today primary action is New repertoire, not a Train that cannot start (round 2, symptom 2)", async () => {
    mockDashboard({ repertoires: 0, training_sessions: 0 });
    await view.loadDashboard();
    const today = String(todayCard.innerHTML);
    expect(today).toContain("No repertoire to train yet");
    expect(today).not.toContain("Queue is clear");
    expect(today).toContain('data-lib-action="new"');
    expect(today).not.toContain("dashboard-train-now");
  });

  it("the Today primary action follows the repertoire count, not the training history", async () => {
    // The account trained before and has no repertoire now: Train can only
    // answer "nothing to train", so the strip offers the first repertoire.
    mockDashboard({ repertoires: 0, training_sessions: 8 });
    await view.loadDashboard();
    const today = String(todayCard.innerHTML);
    expect(today).toContain('data-lib-action="new"');
    expect(today).not.toContain("dashboard-train-now");
    expect(today).toContain("No repertoire to train yet");
    expect(today).not.toContain("Queue is clear");
  });

  it("keeps Train once the account has a repertoire", async () => {
    mockDashboard({ repertoires: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: false, health: { untrained: 0, due: 0 } },
    ]);
    await view.loadDashboard();
    expect(String(todayCard.innerHTML)).toContain("dashboard-train-now");
  });

  it("turns the first-run action into Train when a created repertoire reaches an early listing", async () => {
    // The listing refresh can land before /api/dashboard; the strip must not
    // keep offering New repertoire after the first one exists.
    api.mockImplementation(async (url) => (String(url).startsWith("/api/dashboard")
      ? dashboardPayload({ repertoires: 1 })
      : { repertoires: [{ id: "rep-1", name: "e4", color: "white", is_active: true, health: null }] }));
    let release;
    const dashboardRead = new Promise((resolve) => { release = resolve; });
    api.mockImplementationOnce(() => dashboardRead);
    const load = view.loadDashboard();
    await vi.waitFor(() => expect(String(todayCard.innerHTML)).toBe(""));
    release(dashboardPayload({ repertoires: 1 }));
    await load;
    expect(String(todayCard.innerHTML)).toContain("dashboard-train-now");
    expect(String(todayCard.innerHTML)).not.toContain('data-lib-action="new"');
  });

  it("the Today strip counts an unopened repertoire's moves as unknown, not zero", async () => {
    // The coverage badge is written the first time a repertoire is opened or
    // trained. Until then the listing knows nothing about it, so the strip
    // must not claim a clear queue beside a row that says "no moves trained
    // yet" - the queue holds that repertoire's whole tree.
    mockDashboard({ repertoires: 1, due_reviews: 0, due_soon: 0 }, [
      { id: "rep-1", name: "imported", color: "black", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    const today = String(todayCard.innerHTML);
    expect(today).toContain("1 repertoire not opened yet");
    expect(today).not.toContain("Queue is clear");
    // There is a repertoire to train, so Train stays the action.
    expect(today).toContain("dashboard-train-now");
  });

  it("an unopened repertoire does not hide the moves of the other ones", async () => {
    mockDashboard({ repertoires: 2, due_reviews: 0, due_soon: 0 }, [
      { id: "rep-1", name: "known", color: "white", is_active: true, health: { untrained: 7, due: 0, weak: 0 } },
      { id: "rep-2", name: "imported", color: "black", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    const today = String(todayCard.innerHTML);
    expect(today).toContain("1 repertoire not opened yet");
    expect(today).toContain("7 new moves to learn");
    expect(today).not.toContain("Queue is clear");
  });

  it("a disabled repertoire is not counted as an unopened one", async () => {
    mockDashboard({ repertoires: 1, due_reviews: 0, due_soon: 0 }, [
      { id: "rep-1", name: "off", color: "white", is_active: false, health: null },
    ]);
    await view.loadDashboard();
    const today = String(todayCard.innerHTML);
    expect(today).not.toContain("not opened yet");
    expect(today).toContain("Queue is clear");
  });

  it("Today strip only says the queue is clear when nothing is due or new", async () => {
    mockDashboard({ repertoires: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: { untrained: 0, due: 0 } },
    ]);
    await view.loadDashboard();
    expect(String(todayCard.innerHTML)).toContain("Queue is clear");
    expect(String(todayCard.innerHTML)).toMatch(/data-testid="dashboard-train-now">Train</);
  });

  it("due reviews stay the headline, with new moves as a secondary count", async () => {
    mockDashboard({ repertoires: 1, due_reviews: 3 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: { untrained: 5, due: 3 } },
    ]);
    await view.loadDashboard();
    expect(String(todayCard.innerHTML)).toContain("<b>3 due now</b>");
    expect(String(todayCard.innerHTML)).toContain("5 new moves to learn");
    expect(String(todayCard.innerHTML)).toMatch(/data-testid="dashboard-train-now">Train</);
  });

  it("counts repertoires from the listing, so create and delete reach the Today counts", async () => {
    const rep = (id) => ({ id, name: id, color: "white", is_active: true, health: null });
    mockDashboard({ repertoires: 2 }, [rep("rep-1"), rep("rep-2")]);
    await view.loadDashboard();
    expect(String(todayCard.innerHTML)).toContain("<b>2</b> repertoires");

    // Create / import / delete end in a listing refresh and never re-read
    // /api/dashboard, so the count has to come from that listing.
    api.mockResolvedValue({ repertoires: [rep("rep-1"), rep("rep-2"), rep("rep-3")] });
    await view.loadDashboardRepertoires();
    expect(String(todayCard.innerHTML)).toContain("<b>3</b> repertoires");

    api.mockResolvedValue({ repertoires: [] });
    await view.loadDashboardRepertoires();
    expect(String(todayCard.innerHTML)).toContain("<b>0</b> repertoires");
  });

  it("uses singular labels when a lifetime count is one", async () => {
    mockDashboard({ games: 1, training_sessions: 1 }, [
      { id: "rep-1", name: "e4", color: "white", is_active: true, health: null },
    ]);
    await view.loadDashboard();
    const counts = String(todayCard.innerHTML);
    expect(counts).toContain("<b>1</b> analysis");
    expect(counts).toContain("<b>1</b> repertoire");
    expect(counts).toContain("<b>1</b> session");
    expect(counts).not.toContain("<b>1</b> analyses");
    expect(counts).not.toContain("<b>1</b> repertoires");
    expect(counts).not.toContain("<b>1</b> sessions");
  });

  it("renders the signed-out Library as the onboarding card without any API call", () => {
    view.renderSignedOut();
    expect(api).not.toHaveBeenCalled();
    expect(String(container.innerHTML)).toContain('data-testid="library-signed-out"');
    expect(String(container.innerHTML)).toContain('data-lib-action="signin"');
    expect(todayCard.hidden).toBe(true);
    expect(steps.hidden).toBe(false);
    expect(String(steps.innerHTML)).toContain("<h2>Next steps</h2>");
    // One Sign in on the page: the empty state has it, the checklist doesn't repeat it.
    expect(steps.innerHTML.match(/class="step"/g)).toHaveLength(2);
    expect(String(steps.innerHTML)).not.toContain('data-lib-action="signin"');
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
    expect(String(container.innerHTML)).toContain("Current repertoire");
    expect(String(container.innerHTML)).not.toContain("Old load failed");
    expect(String(todayCard.innerHTML)).toContain("1 weak spot to review");
    expect(String(todayCard.innerHTML)).toContain("2 new moves to learn");
  });

  it("does not restore owner data when a dashboard response lands after sign-out", async () => {
    let resolve;
    api.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const load = view.loadDashboard();
    appState.signedIn = false;
    view.renderSignedOut();
    resolve(dashboardPayload({ repertoires: 3, due_reviews: 8 }));
    await load;
    expect(String(container.innerHTML)).toContain('data-testid="library-signed-out"');
    expect(todayCard.hidden).toBe(true);
    expect(api).toHaveBeenCalledTimes(3);
  });
});
