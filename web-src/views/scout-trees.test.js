import { describe, expect, it, vi } from "vitest";

import { lineCoverage, repertoireChildLookup } from "../scout.js";
import { loadScoutLookups } from "./scout-trees.js";

const tree = (first) => [
  { id: "r", parent_id: null, uci: null, depth: 0, is_enabled: true, is_mainline: true },
  { id: "a", parent_id: "r", uci: first, depth: 1, is_enabled: true, is_mainline: true },
];
const TREES = { repertoires: [
  { id: "w", name: "KP", color: "white", nodes: tree("e2e4") },
  { id: "b", name: "Sicilian", color: "black", nodes: tree("e2e4") },
] };

describe("Scout start-up trees", () => {
  it("reads every active tree in one request", async () => {
    const api = vi.fn(async () => TREES);
    const lookups = await loadScoutLookups({ api, repertoireChildLookup, color: "both" });
    expect(api.mock.calls.map(([url]) => url)).toEqual(["/api/scout/trees"]);
    expect(lookups.white.map((e) => e.rep)).toEqual([{ id: "w", name: "KP", color: "white" }]);
    expect(lineCoverage(lookups.black[0].lookup, ["e2e4", "c7c5"]).covered).toBe(1);
  });

  it("keeps only the colour you play against a one-colour scout", async () => {
    const api = vi.fn(async () => TREES);
    const lookups = await loadScoutLookups({ api, repertoireChildLookup, color: "white" });
    expect(lookups.white).toEqual([]);
    expect(lookups.black.map((e) => e.rep.id)).toEqual(["b"]);
  });

  it("reads every active tree, not only the first six, and skips inactive ones", async () => {
    const reps = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, color: "black", nodes: tree("e2e4") })),
      { id: "w0", name: "W0", color: "white", nodes: tree("e2e4") },
      { id: "off", name: "Off", color: "black", is_active: false, nodes: tree("e2e4") },
    ];
    const lookups = await loadScoutLookups({ api: vi.fn(async () => ({ repertoires: reps })), repertoireChildLookup, color: "both" });
    expect(lookups.black.map((e) => e.rep.id)).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
    expect(lookups.white.map((e) => e.rep.id)).toEqual(["w0"]);
  });

  // Review of #327: a failed read fell back to /api/repertoires plus one Build load per
  // tree, and dropped any tree whose load failed, so coverage ran on a partial set.
  it("lets a failed read fail, with no per-tree reads", async () => {
    const api = vi.fn(async (url) => {
      if (url === "/api/scout/trees") throw new Error("Server error");
      return { repertoires: [], nodes: [] };
    });
    await expect(loadScoutLookups({ api, repertoireChildLookup, color: "both" })).rejects.toThrow("Server error");
    expect(api.mock.calls.map(([url]) => url)).toEqual(["/api/scout/trees"]);
  });

  it("treats an answer without trees as a failure", async () => {
    const api = vi.fn(async () => ({ nodes: [] }));
    await expect(loadScoutLookups({ api, repertoireChildLookup, color: "both" })).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
  });
});
