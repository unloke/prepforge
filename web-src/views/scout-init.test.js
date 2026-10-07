import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamGames = vi.fn();

vi.mock("../scout.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createScoutClient: () => ({ streamGames, fetchGames: vi.fn() }),
  };
});

import { createScoutView } from "./scout.js";

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

describe("scout view initialization reentrancy", () => {
  let elements;
  let api;
  let setStatus;
  let view;
  let pickedUsernames;
  let setPickedUsernames;

  beforeEach(() => {
    streamGames.mockReset();
    streamGames.mockImplementation(async (username, opts = {}) => {
      opts.onGame?.({
        gameId: "live1",
        color: "white",
        score: 1,
        ucis: ["e2e4"],
        sans: ["e4"],
        datestamp: 1000,
        speed: "blitz",
        rating: 1500,
      });
      return { accepted: 1, lastDatestamp: 1000 };
    });

    elements = new Map();
    const card = { classList: { toggle: vi.fn() } };
    globalThis.document = {
      getElementById: (id) => elements.get(id) || null,
      querySelector: (sel) => (sel === ".replay-card-scout" ? card : null),
    };

    elements.set("scout-color", makeEl("scout-color", { value: "both" }));
    elements.set("scout-btn", makeEl("scout-btn"));
    elements.set("scout-reset-btn", makeEl("scout-reset-btn"));
    elements.set("scout-live-count", makeEl("scout-live-count"));
    elements.set(
      "scout-results",
      makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0 }),
    );
    elements.set("scout-profile", makeEl("scout-profile", { hidden: true }));

    api = vi.fn(async (url) => {
      if (url === "/api/repertoires") return { repertoires: [] };
      return { nodes: [{ id: "root", depth: 0, parent_id: null, uci: null }] };
    });

    setStatus = vi.fn();
    pickedUsernames = ["rival"];
    setPickedUsernames = (names) => {
      pickedUsernames = names;
    };
    view = createScoutView({
      setStatus,
      switchView: vi.fn(),
      api,
      showInputModal: vi.fn(),
      createRepertoirePrompt: vi.fn(),
      editRepertoire: vi.fn(),
      boardAfterMove: vi.fn(),
      buildProvisionalNode: vi.fn(),
      hardFlushBuild: vi.fn(),
      selectBuildNode: vi.fn(),
      resolveBuildId: vi.fn(),
      setBuildSync: vi.fn(),
      jobToast: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() },
      parseFenBoard: vi.fn(() => ({})),
      pieceSvg: vi.fn(() => ""),
      getBuildState: vi.fn(),
      getBuildNodeById: vi.fn(),
      setBuildPending: vi.fn(),
      pushBuildNode: vi.fn(),
      scoutPickedUsernames: () => pickedUsernames,
    });
    view.bindControls();
    view.__setPickedUsernames = setPickedUsernames;
  });

  afterEach(async () => {
    const resetHandler = elements.get("scout-reset-btn")?.addEventListener?.mock?.calls?.[0]?.[1];
    if (resetHandler) resetHandler();
    await new Promise((r) => setTimeout(r, 450));
    delete globalThis.document;
  });

  it("ignores a second Start while initialization is in progress", async () => {
    let repsResolve;
    const repsGate = new Promise((resolve) => {
      repsResolve = resolve;
    });
    api.mockImplementation(async (url) => {
      if (url === "/api/repertoires") return repsGate;
      return { nodes: [{ id: "root", depth: 0, parent_id: null, uci: null }] };
    });

    const first = view.runScout();
    await Promise.resolve();
    await view.runScout();
    repsResolve({ repertoires: [] });
    await first;
    expect(api).toHaveBeenCalledTimes(1);
    expect(streamGames).toHaveBeenCalledTimes(1);
  });

  it("allows Start immediately after Reset without reusing the prior session", async () => {
    await view.runScout();
    expect(streamGames).toHaveBeenCalledTimes(1);
    streamGames.mockClear();

    elements.get("scout-reset-btn").addEventListener.mock.calls[0][1]();
    view.__setPickedUsernames(["fresh"]);
    await view.runScout();

    expect(streamGames).toHaveBeenCalledTimes(1);
    expect(streamGames.mock.calls[0][0]).toBe("fresh");
  });

  it("shows an error and re-enables Start when repertoire load fails", async () => {
    api.mockImplementation(async (url) => {
      if (url === "/api/repertoires") throw new Error("repertoire service down");
      return { nodes: [] };
    });

    await expect(view.runScout()).resolves.toBeUndefined();
    expect(String(elements.get("scout-results").innerHTML)).toContain("scout-error");
    expect(String(elements.get("scout-results").innerHTML)).toContain("repertoire service down");
    expect(elements.get("scout-profile").hidden).toBe(true);
    expect(elements.get("scout-btn").disabled).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("repertoire service down");
    expect(streamGames).not.toHaveBeenCalled();
  });

  it("repaints the existing report when Replay is shown after the results DOM was emptied", async () => {
    await view.runScout();
    const results = elements.get("scout-results");
    expect(String(results.innerHTML)).toContain("scout-section");

    results.innerHTML = "";
    view.onShow();

    expect(String(results.innerHTML)).toContain("scout-section");
    expect(elements.get("scout-live-count").textContent).toBe("1");
  });

  it("discards the report when its sources change (UX 2026-10-01 P2-11)", async () => {
    await view.runScout();
    const results = elements.get("scout-results");
    expect(String(results.innerHTML)).toContain("scout-section");

    view.discardReport();
    expect(String(results.innerHTML)).toBe("");
    // Showing the page again must not repaint the old sources' report.
    view.onShow();
    expect(String(results.innerHTML)).not.toContain("scout-section");
    expect(elements.get("scout-btn").disabled).toBe(false);
  });

  it("loads older batches from each source's own cursor", async () => {
    view.__setPickedUsernames(["recent", "older"]);
    streamGames.mockImplementation(async (username, opts) => {
      const stamp = username === "recent" ? 9000 : 1000;
      opts.onGame({ gameId: username, color: "white", score: 1,
        ucis: ["e2e4"], sans: ["e4"], datestamp: stamp, speed: "blitz" });
      return { accepted: 1, received: 500, lastDatestamp: stamp };
    });
    await view.runScout();
    await view.runScout();
    expect(streamGames.mock.calls[2][1].until).toBe(9000);
    expect(streamGames.mock.calls[3][1].until).toBe(1000);
    // A full duplicate page still offers older history.
    expect(elements.get("scout-btn").textContent).toBe("Load older");
  });

  it("discards the old report's source warnings and retry action", async () => {
    await view.runScout();
    const warning = makeEl("scout-source-warnings", {
      get innerHTML() { return this._html ?? "Old rival failed · Retry failed sources"; }, set innerHTML(value) { this._html = String(value); },
      remove: () => elements.delete("scout-source-warnings"),
    });
    elements.set(warning.id, warning);

    view.discardReport();

    expect(document.getElementById("scout-source-warnings")).toBeNull();
    expect(elements.get("scout-live-count").textContent).toBe("0");
  });

  it("invalidates a report when Self resolves to different linked accounts on return", async () => {
    await view.runScout();
    view.__setPickedUsernames(["rival", "newly-linked"]);
    view.onShow();
    expect(String(elements.get("scout-results").innerHTML)).not.toContain("scout-section");
    expect(elements.get("scout-live-count").textContent).toBe("0");
    expect(elements.get("scout-btn").dataset.scoutAction).toBe("start");
  });

  it("does not finish initializing a report under sources changed during the load", async () => {
    let resolve;
    api.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const load = view.runScout();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    view.__setPickedUsernames(["newly-linked"]);
    view.onShow();
    resolve({ repertoires: [] });
    await load;
    expect(streamGames).not.toHaveBeenCalled();
    expect(String(elements.get("scout-results").innerHTML)).toBe("");
    expect(elements.get("scout-btn").disabled).toBe(false);
  });

  it("rebinds Scout delegated events when Replay DOM nodes are replaced", async () => {
    const oldProfile = elements.get("scout-profile");
    const oldResults = elements.get("scout-results");
    expect(oldProfile.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    expect(oldResults.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));

    const nextProfile = makeEl("scout-profile", { hidden: true });
    const nextResults = makeEl("scout-results", { querySelectorAll: () => [], scrollTop: 0 });
    elements.set("scout-profile", nextProfile);
    elements.set("scout-results", nextResults);

    view.onShow();

    expect(nextProfile.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    expect(nextResults.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    expect(nextResults.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("ignores a late streamGames completion after Reset then immediate Start", async () => {
    let releaseStaleStream;
    const staleStreamGate = new Promise((resolve) => {
      releaseStaleStream = resolve;
    });
    let streamCalls = 0;
    let staleOnGameCalled = false;
    let freshAccepted = null;
    streamGames.mockImplementation(async (username, opts = {}) => {
      const { onGame, signal } = opts;
      streamCalls += 1;
      if (streamCalls === 1) {
        await staleStreamGate;
        if (signal?.aborted) return { accepted: 0, lastDatestamp: null };
        staleOnGameCalled = true;
        onGame?.({
          gameId: "stale1",
          color: "white",
          score: 1,
          ucis: ["e2e4"],
          sans: ["e4"],
          datestamp: 1000,
          speed: "blitz",
          rating: 1500,
        });
        return { accepted: 1, lastDatestamp: 1000 };
      }
      expect(username).toBe("fresh");
      freshAccepted = onGame?.({
        gameId: "fresh1",
        color: "white",
        score: 1,
        ucis: ["d2d4"],
        sans: ["d4"],
        datestamp: 2000,
        speed: "blitz",
        rating: 1500,
      });
      return { accepted: 1, lastDatestamp: 2000 };
    });

    const staleRun = view.runScout();
    for (let i = 0; i < 30 && streamCalls === 0; i += 1) {
      await Promise.resolve();
    }
    expect(streamCalls).toBe(1);

    elements.get("scout-reset-btn").addEventListener.mock.calls[0][1]();
    view.__setPickedUsernames(["fresh"]);
    const freshRun = view.runScout();
    for (let i = 0; i < 30 && streamCalls < 2; i += 1) {
      await Promise.resolve();
    }
    expect(streamCalls).toBe(2);

    await freshRun;
    expect(streamGames.mock.calls[1][0]).toBe("fresh");
    expect(freshAccepted).toBe(true);
    expect(staleOnGameCalled).toBe(false);
    expect(elements.get("scout-live-count").textContent).toBe("1");

    releaseStaleStream();
    await staleRun;
    expect(staleOnGameCalled).toBe(false);
    expect(elements.get("scout-live-count").textContent).toBe("1");
  });
});
