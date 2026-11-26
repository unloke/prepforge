import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();

vi.mock("../scout.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createScoutClient: () => ({ streamGames }) };
});

import { createScoutView } from "./scout.js";

// Scout's row actions (Add to prep, Add all gaps, Analyze, keyboard) report
// what happened instead of failing silently.

function makeEl(id, props = {}) {
  return {
    id,
    value: "",
    textContent: "0",
    disabled: false,
    hidden: false,
    get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); },
    dataset: {},
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(),
    addEventListener: vi.fn(),
    ...props,
  };
}

const LINE = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"];
const SANS = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];

function game(i, score) {
  return { gameId: `g${i}`, color: "white", score, ucis: LINE, sans: SANS, datestamp: 1000 + i, speed: "blitz", rating: 1500 };
}

function handlerFor(el, event) {
  const call = el.addEventListener.mock.calls.find(([name]) => name === event);
  expect(call).toBeDefined();
  return call[1];
}

describe("Scout row actions", () => {
  let elements;
  let deps;
  let buildState;

  let lastView;
  const view_runScout = () => lastView.runScout();

  function makeView(overrides = {}) {
    deps = {
      setStatus: vi.fn(),
      switchView: vi.fn(),
      api: vi.fn(async (url) => (url === "/api/repertoires"
        ? { repertoires: [{ id: "rep-w", name: "Ruy", color: "white", is_active: true }] }
        : { nodes: [] })),
      showInputModal: vi.fn(async () => ({ repertoire: "rep-w" })),
      createRepertoirePrompt: vi.fn(),
      editRepertoire: vi.fn(async () => {}),
      boardAfterMove: vi.fn(async (fen, uci) => `${fen}:${uci}`),
      buildProvisionalNode: vi.fn((parent, uci, after) => ({ id: `tmp-${uci}`, parent_id: parent.id, uci, fen: after })),
      hardFlushBuild: vi.fn(async () => {}),
      selectBuildNode: vi.fn(async () => {}),
      resolveBuildId: (id) => id,
      setBuildSync: vi.fn(),
      notices: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() },
      parseFenBoard: vi.fn(() => ({})),
      pieceSvg: vi.fn(() => ""),
      getBuildState: () => buildState,
      getBuildNodeById: (id) => buildState.nodes.find((n) => n.id === id) || null,
      queueBuildAdd: vi.fn(),
      loadPgnIntoAnalyze: vi.fn(async () => true),
      scoutPickedUsernames: () => ["rival"],
      ...overrides,
    };
    const view = createScoutView(deps);
    view.bindControls();
    lastView = view;
    return view;
  }

  beforeEach(() => {
    streamGames.mockReset();
    streamGames.mockImplementation(async (_u, opts = {}) => {
      for (let i = 0; i < 8; i += 1) opts.onGame?.(game(i, i % 3 === 0 ? 1 : 0));
      return { accepted: 8, lastDatestamp: 1000 };
    });
    buildState = {
      repertoire_id: "rep-w",
      nodes: [
        { id: "root", depth: 0, parent_id: null, uci: null, fen: "start" },
        { id: "n-e4", depth: 1, parent_id: "root", uci: "e2e4", fen: "fen-e4" },
      ],
    };
    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };
    for (const id of ["scout-color", "scout-btn", "scout-reset-btn", "scout-live-count"]) {
      elements.set(id, makeEl(id, { value: "both" }));
    }
    elements.set("scout-results", makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0 }));
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it("says a line that is already in prep is already there", async () => {
    const view = makeView();
    await view.__testHandleAddToPrep({ ucis: ["e2e4"], sans: ["e4"] }, "black");
    expect(deps.queueBuildAdd).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith("Already in prep. Opened at e4.");
  });

  it("names the suggested reply it opened at", async () => {
    const view = makeView();
    await view.__testHandleAddToPrep({ ucis: ["e2e4"], sans: ["e4"], suggestedReply: { uci: "e7e5", san: "e5" } }, "white", { ownColor: true });
    expect(deps.queueBuildAdd).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Added line to prep. Opened at e5.");
  });

  it("reports a line it could not finish writing", async () => {
    const view = makeView({ boardAfterMove: vi.fn(async () => { throw new Error("illegal"); }) });
    await view.__testHandleAddToPrep({ ucis: ["e2e4", "e7e5"], sans: ["e4", "e5"] }, "black");
    expect(deps.setStatus).toHaveBeenLastCalledWith("Couldn't add the whole line to prep.", { severity: "error" });
  });

  it("ignores a second Add to prep while the first line is still being written", async () => {
    let releaseOpen;
    const view = makeView({
      editRepertoire: vi.fn(() => new Promise((resolve) => { releaseOpen = resolve; })),
    });
    const first = view.__testHandleAddToPrep({ ucis: ["e2e4"], sans: ["e4"] }, "black");
    await vi.waitFor(() => expect(releaseOpen).toBeDefined());
    await view.__testHandleAddToPrep({ ucis: ["e2e4"], sans: ["e4"] }, "black");
    releaseOpen();
    await first;
    expect(deps.showInputModal).toHaveBeenCalledTimes(1);
    expect(deps.editRepertoire).toHaveBeenCalledTimes(1);
  });

  it("saves the lines already queued when Add all gaps is stopped", async () => {
    let cancel;
    const notices = {
      isBusy: () => false,
      startJob: vi.fn((job) => { cancel = job.onCancel; }),
      updateJob: vi.fn(),
      completeJob: vi.fn(),
    };
    // Stop while the first line is being written.
    const view = makeView({ notices, queueBuildAdd: vi.fn(() => cancel()) });
    await view.__testHandlePrepareAll([
      { ucis: ["d2d4"], sans: ["d4"] },
      { ucis: ["c2c4"], sans: ["c4"] },
      { ucis: ["g1f3"], sans: ["Nf3"] },
    ], "black");
    expect(deps.queueBuildAdd).toHaveBeenCalledTimes(1);
    expect(deps.hardFlushBuild).toHaveBeenCalledTimes(1);
    expect(notices.completeJob).toHaveBeenCalledWith(expect.objectContaining({ title: "Stopped" }));
  });

  it("keeps a failed sync in the result when Add all gaps is stopped", async () => {
    let cancel;
    const notices = { isBusy: () => false, startJob: vi.fn((job) => { cancel = job.onCancel; }), updateJob: vi.fn(), completeJob: vi.fn() };
    const view = makeView({ notices, queueBuildAdd: vi.fn(() => cancel()), hardFlushBuild: vi.fn(async () => { throw new Error("Offline"); }) });
    await view.__testHandlePrepareAll([{ ucis: ["d2d4"], sans: ["d4"] }, { ucis: ["c2c4"], sans: ["c4"] }], "black");
    expect(notices.completeJob).toHaveBeenCalledWith({ title: "Not synced", message: "Added 1 line to prep · not synced yet: Offline" });
    expect(deps.setStatus).toHaveBeenLastCalledWith("Added 1 line to prep · not synced yet: Offline", { severity: "error" });
  });

  it("keeps a failed sync of the last line in the result", async () => {
    const view = makeView({ hardFlushBuild: vi.fn(async () => { throw new Error("Offline"); }) });
    await view.__testHandlePrepareAll([{ ucis: ["d2d4"], sans: ["d4"] }, { ucis: ["c2c4"], sans: ["c4"] }], "black");
    // The last line is queued on this device, not failed.
    expect(deps.notices.completeJob).toHaveBeenCalledWith({ title: "Not synced", message: "Added 2 lines to prep · not synced yet: Offline" });
    expect(deps.setStatus).toHaveBeenLastCalledWith("Added 2 lines to prep · not synced yet: Offline", { severity: "error" });
    expect(deps.switchView).not.toHaveBeenCalled();
  });

  it("keeps a failed sync visible after a single Add to prep", async () => {
    const view = makeView({ hardFlushBuild: vi.fn(async () => { throw new Error("Offline"); }) });
    await view.__testHandleAddToPrep({ ucis: ["e2e4", "e7e5"], sans: ["e4", "e5"] }, "black");
    expect(deps.setStatus).toHaveBeenLastCalledWith("Offline", { severity: "error" });
  });

  it("reports a line Analyze could not open instead of saying it loaded", async () => {
    const view = makeView({
      loadPgnIntoAnalyze: vi.fn(async (_pgn, { onInvalid }) => { onInvalid("bad"); return false; }),
    });
    await view.runScout();
    const results = elements.get("scout-results");
    expect(results.innerHTML).toContain('data-row-kind="prep" data-row-idx="0" data-color="white"');
    const target = {
      closest: (sel) => (sel === ".scout-action-analyze"
        ? { dataset: { color: "white", rowKind: "prep", rowIdx: "0" } }
        : null),
    };
    await handlerFor(results, "click")({ target });
    expect(deps.loadPgnIntoAnalyze).toHaveBeenCalledTimes(1);
    expect(deps.switchView).toHaveBeenCalledWith("analyze");
    expect(deps.setStatus).toHaveBeenLastCalledWith("Couldn't open this line in Analyze.", { severity: "error" });
  });

  it("makes a line's moves its control, beside the Add to prep button", async () => {
    makeView();
    await view_runScout();
    const html = elements.get("scout-results").innerHTML;
    const rows = html.match(/<div class="scout-line [^>]*>/g) || [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toMatch(/role=|tabindex=|aria-expanded=/);
    const toggles = html.match(/<span class="scout-line-moves scout-line-toggle" role="button" tabindex="0" aria-expanded="false">/g) || [];
    expect(toggles).toHaveLength(rows.length);
    // The toggle closes before the row's Add to prep button opens.
    const toggleAt = html.indexOf("scout-line-toggle");
    expect(html.indexOf("</span>", toggleAt)).toBeLessThan(html.indexOf("scout-action-add-prep", toggleAt));
  });

  it("leaves a real button inside a row to activate itself on Enter and Space", async () => {
    makeView();
    const keydown = handlerFor(elements.get("scout-results"), "keydown");
    for (const key of ["Enter", " "]) {
      const button = { matches: () => false, closest: () => ({}), click: vi.fn() };
      const event = { key, target: button, preventDefault: vi.fn() };
      keydown(event);
      expect(button.click).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();

      const row = { matches: (sel) => sel.includes(".scout-line-toggle"), closest: () => ({}), click: vi.fn() };
      const rowEvent = { key, target: row, preventDefault: vi.fn() };
      keydown(rowEvent);
      expect(row.click).toHaveBeenCalledTimes(1);
      expect(rowEvent.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  describe("repertoires read at Start", () => {
    const reps = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, color: "black", is_active: true })),
      { id: "w0", name: "W0", color: "white", is_active: true },
      { id: "off", name: "Off", color: "black", is_active: false },
    ];
    const loadsFor = async (scope) => {
      const api = vi.fn(async (url) => (url === "/api/repertoires" ? { repertoires: reps } : { nodes: [] }));
      elements.get("scout-color").value = scope;
      await makeView({ api }).runScout();
      return api.mock.calls.map(([url]) => url).filter((url) => url.startsWith("/api/build/load"))
        .map((url) => new URL(url, "http://x").searchParams.get("repertoire_id"));
    };

    it("reads every active repertoire, not only the first six", async () => {
      expect((await loadsFor("both")).sort()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6", "w0"]);
    });

    it("reads only the colour you play against a one-colour scout", async () => {
      // Scouting their White games: only your Black repertoires answer them.
      expect((await loadsFor("white")).sort()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
      expect(await loadsFor("black")).toEqual(["w0"]);
    });
  });
});
