import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearHandoffJourney,
  clearHandoffs,
  clearReturnState,
  createHandoff,
  handoffJourney,
  handoffKey,
  loadReturnState,
  pendingHandoffs,
  rememberHandoff,
  saveReturnState,
  takeHandoff,
} from "./handoff-context.js";

// F-06 handoff plumbing: a handoff records the source game/line, the ply and
// anchor FEN of the task, the side, the target repertoire and the trigger
// reason. Identity is the WHOLE tuple (white/black, transposed lines and
// different root FENs must never interleave), a repeated click reuses one
// record, and createdAt→takenAt makes the mistake→first-practice time
// measurable. Return state keeps the source page's selection across reloads.

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const base = {
  source: "analyze",
  reason: "practice-missed-move",
  gameId: "g1",
  lineUcis: ["e2e4", "e7e5", "g1f3"],
  ply: 3,
  anchorFen: "start-fen",
  rootFen: "root-fen",
  side: "white",
  repertoireId: 7,
};

describe("handoff identity (handoffKey / createHandoff)", () => {
  it("keys on the whole tuple: side, root, anchor, line, reason and game", () => {
    const key = handoffKey(base);
    const variants = [
      { ...base, side: "black" },
      { ...base, rootFen: "other-root" },
      { ...base, anchorFen: "other-anchor" },
      { ...base, lineUcis: ["e2e4", "e7e5", "b1c3"] },
      { ...base, reason: "build-reply" },
      { ...base, gameId: "g2" },
    ];
    for (const variant of variants) {
      expect(handoffKey(variant)).not.toBe(key);
    }
    // …and a plain re-click with the same tuple is the same key.
    expect(handoffKey({ ...base })).toBe(key);
  });

  it("normalizes records and derives key, timestamps and click count", () => {
    const record = createHandoff({ ...base, side: "black", bogus: "dropped" });
    expect(record.source).toBe("analyze");
    expect(record.reason).toBe("practice-missed-move");
    expect(record.lineUcis).toEqual(base.lineUcis);
    expect(record.side).toBe("black");
    expect(record.key).toBe(handoffKey({ ...base, side: "black" }));
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.takenAt).toBeNull();
    expect(record.clicks).toBe(1);
    expect(record.bogus).toBeUndefined();
  });

  it("coerces odd side values to null and stringifies game ids", () => {
    const record = createHandoff({ ...base, side: "green", gameId: 42 });
    expect(record.side).toBeNull();
    expect(record.gameId).toBe("42");
  });
});

describe("rememberHandoff / takeHandoff", () => {
  beforeEach(() => {
    clearHandoffs();
    clearHandoffJourney();
  });

  it("dedupes repeated clicks on the same target into one record", () => {
    const first = rememberHandoff(base);
    const second = rememberHandoff(base);
    expect(second).toBe(first);
    expect(pendingHandoffs()).toHaveLength(1);
    expect(first.clicks).toBe(2);
  });

  it("keeps white/black, transpositions and different roots apart", () => {
    rememberHandoff({ ...base, side: "white" });
    rememberHandoff({ ...base, side: "black" });
    rememberHandoff({ ...base, rootFen: "transposed-root" });
    expect(pendingHandoffs()).toHaveLength(3);
    // The transposed line is same-side (white) but a different root — it must
    // never merge with the main one, so white sees two distinct tasks.
    expect(pendingHandoffs({ side: "white" })).toHaveLength(2);
    expect(pendingHandoffs({ side: "black" })).toHaveLength(1);
  });

  it("takeHandoff stamps takenAt and keeps the journey measurable", () => {
    const record = rememberHandoff(base);
    const taken = takeHandoff({ reason: "practice-missed-move" });
    expect(taken).toBe(record);
    expect(taken.takenAt).toBeGreaterThanOrEqual(taken.createdAt);
    expect(pendingHandoffs()).toHaveLength(0);
    expect(handoffJourney()).toEqual([record]);
  });

  it("takeHandoff matches on key / game / side and returns null when empty", () => {
    rememberHandoff({ ...base, side: "white" });
    rememberHandoff({ ...base, side: "black" });
    expect(takeHandoff({ side: "black" }).side).toBe("black");
    expect(takeHandoff({ gameId: "g1" }).side).toBe("white");
    expect(takeHandoff({ gameId: "g1" })).toBeNull();
    expect(takeHandoff({ key: "nope" })).toBeNull();
  });

  it("caps the settled journey log at 50, dropping the oldest", () => {
    for (let i = 0; i < 55; i += 1) {
      rememberHandoff({ ...base, lineUcis: [`move-${i}`] });
      takeHandoff({ key: handoffKey({ ...base, lineUcis: [`move-${i}`] }) });
    }
    const journey = handoffJourney();
    expect(journey).toHaveLength(50);
    expect(journey[0].lineUcis).toEqual(["move-5"]);
    expect(journey.at(-1).lineUcis).toEqual(["move-54"]);
  });

  it("clearHandoffs drops pending work without erasing the journey", () => {
    rememberHandoff(base);
    takeHandoff({});
    rememberHandoff({ ...base, lineUcis: ["later"] });
    clearHandoffs();
    expect(pendingHandoffs()).toHaveLength(0);
    expect(handoffJourney()).toHaveLength(1);
    clearHandoffJourney();
    expect(handoffJourney()).toHaveLength(0);
  });
});

describe("return state (source page selection + filters)", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", fakeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a view's selection across a reload", () => {
    expect(saveReturnState("replay", { filter: "r-loss", openIndex: 3 })).toBe(true);
    expect(loadReturnState("replay")).toEqual({ filter: "r-loss", openIndex: 3 });
  });

  it("keeps views isolated and returns null when nothing is saved", () => {
    saveReturnState("replay", { filter: "r-win" });
    expect(loadReturnState("scout")).toBeNull();
    clearReturnState("replay");
    expect(loadReturnState("replay")).toBeNull();
  });

  it("survives corrupt payloads and blocked storage", () => {
    sessionStorage.setItem("prepforge.return_state.v1.replay", "{not json");
    expect(loadReturnState("replay")).toBeNull();
    sessionStorage.setItem("prepforge.return_state.v1.replay", '"scalar"');
    expect(loadReturnState("replay")).toBeNull();
    expect(saveReturnState("replay", { ok: true })).toBe(true);
  });

  it("degrades quietly when sessionStorage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(saveReturnState("replay", { ok: true })).toBe(false);
    expect(loadReturnState("replay")).toBeNull();
    expect(() => clearReturnState("replay")).not.toThrow();
  });
});
