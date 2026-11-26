import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("./core/api.js", () => ({
  api: (...args) => api(...args), currentOwnerId: () => "owner", postJson: vi.fn(), setStatus: vi.fn(), setStatusError: vi.fn(),
}));

const { ensureBookLoaded, getBookReps, invalidateBook } = await import("./analyze-book-state.js");
const { appState } = await import("./core/state.js");

const tree = (id, moves) => ({
  repertoire_id: id, name: `${id} prep`, color: "white",
  nodes: [{ id: `${id}-root`, parent_id: null }, ...moves.map(([nid, uci]) => ({ id: nid, parent_id: `${id}-root`, san: uci, uci }))],
});

// The slim book read: one request for every active tree.
function serve(trees) {
  api.mockImplementation(async (path) => {
    if (path !== "/api/analyze/book") throw new Error(`unexpected ${path}`);
    return { repertoires: Object.values(trees).map((t) => ({ id: t.repertoire_id, name: t.name, color: t.color, nodes: t.nodes })) };
  });
}

describe("Analyze's book after a Build hydrate", () => {
  beforeEach(() => {
    appState.pendingRepDeletes = new Set();
    invalidateBook();
    api.mockReset();
  });

  it("swaps in the hydrated repertoire's tree without refetching the others", async () => {
    serve({ a: tree("a", [["a1", "e2e4"]]), b: tree("b", [["b1", "d2d4"]]) });
    await ensureBookLoaded();
    expect(api).toHaveBeenCalledTimes(1);
    const [, before] = getBookReps();
    invalidateBook(tree("a", [["a1", "e2e4"], ["a2", "c2c4"]]));
    await ensureBookLoaded();
    expect(api).toHaveBeenCalledTimes(1);
    const [a, b] = getBookReps();
    expect([...a.children.keys()]).toEqual(["a-root|e2e4", "a-root|c2c4"]);
    expect(b).toBe(before);
  });

  it("drops the copy for a repertoire the book does not hold, or with no argument", async () => {
    serve({ a: tree("a", [["a1", "e2e4"]]) });
    await ensureBookLoaded();
    invalidateBook(tree("new", [["n1", "g1f3"]]));
    expect(getBookReps()).toEqual([]);
    await ensureBookLoaded();
    expect(api).toHaveBeenCalledTimes(2);
    invalidateBook();
    expect(getBookReps()).toEqual([]);
  });

  it("leaves a book that was never loaded to load on the next Analyze look", async () => {
    serve({ a: tree("a", [["a1", "e2e4"]]) });
    invalidateBook(tree("a", [["a1", "e2e4"]]));
    expect(getBookReps()).toEqual([]);
    await ensureBookLoaded();
    expect(api).toHaveBeenCalledTimes(1);
    expect(getBookReps()).toHaveLength(1);
  });
});
