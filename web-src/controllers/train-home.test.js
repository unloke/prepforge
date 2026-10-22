// Train Home: one loop (Home → Session → Result) for the Due queue, line
// rehearsal and practice games. Every entry sets its scope explicitly, so a
// one-repertoire queue is never served when "all repertoires" was asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, setup } from "./train-home.fixture.js";
import {
  createTrainHome, dueIn, dueMeta, dueStartState, outlookHtml, playBook, showTrainResult, trainScopeLabel, trainScreenOf,
} from "./train-home.js";
import { saveRun } from "../train-history.js";

let doc;
beforeEach(() => {
  doc = fakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => vi.unstubAllGlobals());

describe("which screen is up", () => {
  it("is Home with nothing running", () => {
    expect(trainScreenOf({ trainMode: "smart" })).toBe("home");
    expect(trainScreenOf({ trainMode: "play" })).toBe("home");
  });

  it("is the Session while a drill is starting or has a prompt", () => {
    expect(trainScreenOf({ trainMode: "smart", trainStarting: true })).toBe("session");
    expect(trainScreenOf({ trainMode: "smart", smart: { prompt: {} } })).toBe("session");
    expect(trainScreenOf({ trainMode: "all_lines", training: { prompt: {} } })).toBe("session");
  });

  it("is the Session for a live game and the Result once it ends", () => {
    expect(trainScreenOf({ trainMode: "play", playStarting: {} })).toBe("session");
    expect(trainScreenOf({ trainMode: "play", play: { active: true } })).toBe("session");
    expect(trainScreenOf({ trainMode: "play", play: { active: false } })).toBe("result");
  });

  it("shows a Result only for the mode that produced it", () => {
    expect(trainScreenOf({ trainMode: "smart", trainResult: { mode: "smart" } })).toBe("result");
    expect(trainScreenOf({ trainMode: "all_lines", trainResult: { mode: "smart" } })).toBe("home");
  });
});

describe("openTrain", () => {
  it("a repertoire's own Train serves that repertoire's queue and names it", async () => {
    const { appState, deps } = setup();
    await createTrainHome(deps).openTrain({ mode: "smart", repertoireId: "r1" });
    expect(appState.trainScope).toEqual({ repertoireId: "r1", label: "Italian" });
    expect(deps.switchView).toHaveBeenCalledWith("train");
    expect(deps.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: "r1", targetNodeIds: [] });
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("session");
    expect(doc.getElementById("train-scope-chip").textContent).toBe("Italian");
  });

  it("no repertoire means all of them, never the last scoped queue", async () => {
    const { appState, deps } = setup({ trainScope: { repertoireId: "r1", label: "Italian" } });
    await createTrainHome(deps).openTrain({ mode: "smart" });
    expect(appState.trainScope.repertoireId).toBeNull();
    expect(trainScopeLabel(appState)).toBe("All repertoires");
    expect(deps.startTraining).toHaveBeenCalledWith("smart", { fresh: false, repertoireId: null, targetNodeIds: [] });
  });

  it("picked targets always build a fresh queue", async () => {
    const { deps } = setup();
    await createTrainHome(deps).openTrain({ mode: "smart", repertoireId: "r1", targets: ["n1", "n2"] });
    expect(deps.startTraining).toHaveBeenCalledWith("smart", { fresh: true, repertoireId: "r1", targetNodeIds: ["n1", "n2"] });
  });

  it("a shared repertoire can be rehearsed like an owned one", async () => {
    const { appState, deps } = setup();
    await createTrainHome(deps).openTrain({ mode: "all_lines", repertoireId: "s1" });
    expect(appState.trainingRepertoireId).toBe("s1");
    expect(deps.startTraining).toHaveBeenCalledWith("all_lines", expect.objectContaining({ repertoireId: "s1" }));
  });

  it("a live game is only left after the player agrees", async () => {
    const { appState, deps } = setup({ play: { active: true, history: ["e2e4"] }, trainMode: "play" });
    deps.confirmAbandonGame.mockResolvedValueOnce(false);
    await createTrainHome(deps).openTrain({ mode: "smart" });
    expect(deps.startTraining).not.toHaveBeenCalled();
    expect(appState.play).toEqual({ active: true, history: ["e2e4"] });
  });

  it("Play starts a game without touching the drill endpoints", async () => {
    const { deps } = setup();
    await createTrainHome(deps).openTrain({ mode: "play" });
    expect(deps.startPlaySessionTracked).toHaveBeenCalled();
    expect(deps.startTraining).not.toHaveBeenCalled();
  });
});

describe("‹ Train", () => {
  it("drops the live drill and goes Home, where the preview is fetched again", async () => {
    const { appState, deps } = setup({ currentView: "train", trainMode: "smart", smart: { prompt: {} } });
    await createTrainHome(deps).leaveToHome();
    expect(appState.smart).toBeNull();
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("home");
    expect(deps.resetTrainBoardIdle).toHaveBeenCalled();
    await vi.waitFor(() => expect(deps.api).toHaveBeenCalledWith(expect.stringContaining("/api/train/smart/summary?mixed=true&preview=true")));
  });

  it("keeps a live game when the player says no", async () => {
    const play = { active: true, history: ["e2e4"] };
    const { appState, deps } = setup({ currentView: "train", trainMode: "play", play });
    deps.confirmAbandonGame.mockResolvedValueOnce(false);
    await createTrainHome(deps).leaveToHome();
    expect(appState.play).toBe(play);
  });
});

describe("the Due row", () => {
  it("names the action that fits the account", () => {
    expect(dueStartState(null, { signedIn: false, hasRepertoire: false })).toEqual({ label: "Sign in to train", action: "signin" });
    expect(dueStartState(null, { signedIn: true, hasRepertoire: false })).toEqual({ label: "Open Library", action: "library" });
    expect(dueStartState({ cards: 0 }, { signedIn: true, hasRepertoire: true })).toEqual({ label: "Open Repertoire", action: "build" });
    expect(dueStartState({ cards: 5 }, { signedIn: true, hasRepertoire: true })).toEqual({ label: "Start", action: "start" });
  });

  it("says Resume with what is left only for an unfinished queue of this scope", () => {
    expect(dueStartState({ cards: 5, resumed: true, left: 3 }, { signedIn: true, hasRepertoire: true }).label).toBe("Resume · 3 cards left");
    expect(dueStartState({ cards: 5, resumed: true, left: 1 }, { signedIn: true, hasRepertoire: true }).label).toBe("Resume · 1 card left");
  });

  it("lists only the card kinds that are there", () => {
    expect(dueMeta({ weak: 1, due: 0, new: 2, polish: 0 })).toBe("1 weak · 2 new");
    expect(dueMeta({ weak: 0, due: 0, new: 0 })).toBe("Nothing due");
    expect(dueMeta(null)).toBe("");
  });

  it("the outlook is three numbers with their words, no caption", () => {
    const out = String(outlookHtml({ now: 1, today: 4, week: 9 }));
    expect(out.match(/train-outlook-cell/g)).toHaveLength(3);
    expect(out).toContain("<b>4</b><span>today</span>");
    expect(String(outlookHtml(null))).toBe("");
  });

  it("nothing due is one quiet line naming the next review, not three zeros", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    const quiet = String(outlookHtml({ now: 0, today: 0, week: 0, next: "2026-10-31T12:00:00Z" }, now));
    expect(quiet).not.toContain("train-outlook-cell");
    expect(quiet).toContain("Nothing due · next in 9 days");
    expect(String(outlookHtml({ now: 0, today: 0, week: 0, next: null }, now))).toBe("");
    expect(dueIn("2026-10-22T12:40:00Z", now)).toBe("in 40 min");
    expect(dueIn("2026-10-23T11:00:00Z", now)).toBe("in 23 h");
    expect(dueIn("2026-10-23T13:00:00Z", now)).toBe("tomorrow");
  });
});

describe("the Result", () => {
  it("Recent lists the runs before this one, never the run on the card", () => {
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    });
    setup();
    const run = (id, at) => ({ id, mode: "smart", blitz: false, repertoires: ["Italian"], startedAt: at, finishedAt: at, cards: 4, correct: 3, mistakes: 1, skipped: 0, learned: 0 });
    saveRun("u1", run("old", "2026-10-21T10:00:00Z"));
    saveRun("u1", run("just-now", "2026-10-22T10:00:00Z"));
    showTrainResult({ mode: "smart", title: "Queue complete", cells: [], runId: "just-now" });
    const recent = doc.getElementById("train-recent");
    expect(recent.hidden).toBe(false);
    expect(String(recent.innerHTML).match(/train-recent-row/g)).toHaveLength(1);
  });
});

describe("the practice opponent", () => {
  it("falls back to Maia when the picked book cannot play for this account", () => {
    const { appState } = setup({ playBook: "explorer" });
    expect(playBook()).toBe("maia");
    appState.lichessUsername = "me";
    expect(playBook()).toBe("explorer");
  });
});
