import { describe, expect, it } from "vitest";
import { appSource } from "./test-app-source.js";
import { isSelectionEmpty, normalizeSelection } from "./views/shared/source-composer.js";

const source = appSource();

function makeReadSourceStore(storage) {
  const start = source.indexOf("function readSourceStore(");
  const end = source.indexOf("\n}\n", start) + 2;
  const body = source.slice(start, end);
  const factory = new Function("normalizeSelection", "localStorage", `${body}\nreturn readSourceStore;`);
  return factory(normalizeSelection, storage);
}

describe("Scout source default", () => {
  it("keeps Self for Games but starts Scout empty when nothing is stored", () => {
    const read = makeReadSourceStore({ getItem: () => null });
    // Games still defaults to Self (checking your own games is the point there).
    expect(read("prepforge.games_source")).toEqual({ linkedMode: "all", accountIds: [], external: [] });
    // Scout defaults to no source, so Start can never silently scout the user.
    const scout = read("prepforge.scout_source", { linkedMode: "none", accountIds: [], external: [] });
    expect(isSelectionEmpty(scout)).toBe(true);
  });

  it("still reads a stored Scout selection", () => {
    const read = makeReadSourceStore({
      getItem: () => JSON.stringify({ linkedMode: "none", external: ["DrNykterstein"] }),
    });
    expect(read("prepforge.scout_source", { linkedMode: "none", accountIds: [], external: [] })).toEqual({
      linkedMode: "none",
      accountIds: [],
      external: ["DrNykterstein"],
    });
  });

  it("wires scoutSelection through the empty default (no implicit Self)", () => {
    expect(source).toMatch(/SCOUT_SOURCE_DEFAULT = \{ linkedMode: "none", accountIds: \[\], external: \[\] \}/);
    expect(source).toMatch(/scoutSelection\(\)\s*\{\s*return readSourceStore\(SCOUT_SOURCE_KEY, SCOUT_SOURCE_DEFAULT\);/);
  });
});
