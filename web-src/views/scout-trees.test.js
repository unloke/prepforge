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

  it("falls back to each Build payload when the server has no trees read", async () => {
    const api = vi.fn(async (url) => {
      if (url === "/api/scout/trees") throw new Error("Not Found");
      if (url === "/api/repertoires") return { repertoires: [
        { id: "w", name: "KP", color: "white", is_active: true },
        { id: "off", name: "Old", color: "white", is_active: false },
      ] };
      if (url.includes("repertoire_id=w")) return { nodes: tree("d2d4") };
      throw new Error("unexpected");
    });
    const lookups = await loadScoutLookups({ api, repertoireChildLookup, color: "both" });
    expect(api.mock.calls.map(([url]) => url)).toEqual(
      ["/api/scout/trees", "/api/repertoires", "/api/build/load?repertoire_id=w"]);
    expect(lineCoverage(lookups.white[0].lookup, ["d2d4"]).covered).toBe(1);
  });
});
