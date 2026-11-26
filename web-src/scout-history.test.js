import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import {
  SCOUT_HISTORY_LIMIT, clearScoutRuns, compactScoutGame, deleteScoutRun, listScoutRuns, loadScoutRun,
  restoreScoutGame, saveScoutRun, scoutHistoryKey,
} from "./scout-history.js";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const game = (id, datestamp = 1000) => ({
  gameId: id, color: "white", score: 1, status: "mate", ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"],
  openingUcis: ["e2e4", "e7e5"], openingSans: ["e4", "e5"], openingEndPly: 2, totalPly: 3,
  rating: 1800, opponentRating: 1700, datestamp, speed: "blitz", timeControl: { baseSeconds: 180, incrementSeconds: 2 },
  clockAfterPly: [180, 179, 175], nextOwnThinkSeconds: [1, 4], scoutUsername: "Rival", sourceAccount: "Rival",
});

const run = (key, savedAt, games = [game("g1")]) => ({
  key, usernames: ["Rival"], label: "Rival", color: "both", savedAt, gameCount: games.length,
  games: games.map(compactScoutGame), sources: { Rival: { oldest: 1000, newest: 1000, exhausted: false, full: true } },
});

describe("scout history store", () => {
  it("keys a source set and colour, whatever the order and case of the names", () => {
    expect(scoutHistoryKey(["B", "a"], "white")).toBe(scoutHistoryKey(["A", "b", "a"], "white"));
    expect(scoutHistoryKey(["a"], "white")).not.toBe(scoutHistoryKey(["a"], "black"));
  });

  it("saves, lists newest first, loads and overwrites the same key", async () => {
    expect(await saveScoutRun("u1", run("a|both", 1))).toBe(true);
    expect(await saveScoutRun("u1", run("b|both", 2))).toBe(true);
    expect((await listScoutRuns("u1")).map((e) => e.key)).toEqual(["b|both", "a|both"]);
    // The list holds no games; the run does.
    expect((await listScoutRuns("u1"))[0].games).toBeUndefined();
    await saveScoutRun("u1", run("a|both", 3, [game("g1"), game("g2")]));
    const list = await listScoutRuns("u1");
    expect(list.map((e) => [e.key, e.gameCount])).toEqual([["a|both", 2], ["b|both", 1]]);
    expect((await loadScoutRun("u1", "a|both")).games.map((g) => g.gameId)).toEqual(["g1", "g2"]);
  });

  it("keeps the newest ten and evicts the oldest", async () => {
    for (let i = 0; i < SCOUT_HISTORY_LIMIT + 2; i += 1) await saveScoutRun("u1", run(`k${i}|both`, 100 + i));
    const keys = (await listScoutRuns("u1")).map((e) => e.key);
    expect(keys).toHaveLength(SCOUT_HISTORY_LIMIT);
    expect(keys).not.toContain("k0|both");
    expect(keys).not.toContain("k1|both");
    expect(await loadScoutRun("u1", "k0|both")).toBeNull();
    expect(await loadScoutRun("u1", "k11|both")).not.toBeNull();
  });

  it("deletes one run and clears one account's runs, leaving other accounts alone", async () => {
    await saveScoutRun("u1", run("a|both", 1));
    await saveScoutRun("u1", run("b|both", 2));
    await saveScoutRun("u2", run("a|both", 3));
    expect(await deleteScoutRun("u1", "a|both")).toBe(true);
    expect((await listScoutRuns("u1")).map((e) => e.key)).toEqual(["b|both"]);
    expect(await clearScoutRuns("u1")).toBe(true);
    expect(await listScoutRuns("u1")).toEqual([]);
    expect((await listScoutRuns("u2")).map((e) => e.key)).toEqual(["a|both"]);
    expect(await loadScoutRun("u2", "a|both")).not.toBeNull();
  });

  it("fails soft when IndexedDB is missing or a write throws", async () => {
    await saveScoutRun("u1", run("a|both", 1));
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    expect(await saveScoutRun("u1", run("b|both", 2))).toBe(false);
    vi.restoreAllMocks();
    expect((await listScoutRuns("u1")).map((e) => e.key)).toEqual(["a|both"]);

    vi.stubGlobal("indexedDB", undefined);
    expect(await saveScoutRun("u1", run("a|both", 1))).toBe(false);
    expect(await listScoutRuns("u1")).toEqual([]);
    expect(await loadScoutRun("u1", "a|both")).toBeNull();
    expect(await deleteScoutRun("u1", "a|both")).toBe(false);
    expect(await clearScoutRuns("u1")).toBe(false);
  });

  it("a stored game comes back with every field Scout reads", () => {
    const back = restoreScoutGame(structuredClone(compactScoutGame(game("g1"))));
    const { opponentRating: _r, nextOwnThinkSeconds: _n, ...read } = game("g1");
    expect(back).toEqual(read);
  });
});
