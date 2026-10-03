import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { advanceBuildRevision, queuedBuildRevision, withBuildRevision } from "./build-revision.js";

it("every Build mutation sends the loaded revision and preserves an old queue's revision", () => {
  const build = { repertoire_id: "r", revision: 8 };
  for (const path of ["rename", "add-move", "add-moves", "delete-nodes", "generate/apply-plan", "action", "annotations"]) {
    expect(withBuildRevision(`/api/build/${path}`, { repertoire_id: "r" }, build).base_revision).toBe(8);
    expect(withBuildRevision(`/api/build/${path}`, { repertoire_id: "r", base_revision: 3 }, build).base_revision).toBe(3);
  }
  expect(withBuildRevision("/api/build/export", { repertoire_id: "r" }, build)).not.toHaveProperty("base_revision");
});

it("only edits based on our acknowledged version advance after our own save", () => {
  const build = { repertoire_id: "r", revision: 8 };
  const entries = [{ repertoire_id: "r", base_revision: 8 }, { repertoire_id: "r", base_revision: 3 }, { repertoire_id: "other", base_revision: 8 }];
  advanceBuildRevision(build, { revision: 9 }, entries);
  expect(entries.map((op) => op.base_revision)).toEqual([9, 3, 8]);
  expect(queuedBuildRevision(entries.slice(0, 2), build)).toBe(3);
  advanceBuildRevision(build, { revision: 7 }, entries);
  expect(build.revision).toBe(9);
});

it("gap completion saves against the repertoire and revision used for computation", async () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function completeOneGap("), source.indexOf("// ----- Opponent scouting", source.indexOf("async function completeOneGap(")));
  const appState = { build: { repertoire_id: "r", revision: 4, color: "white" }, buildCurrentNodeId: "root" };
  const deps = {
    appState, captureBuildContext: () => { const id = appState.build.repertoire_id; return () => appState.build.repertoire_id === id; }, selectBuildNode: async () => {},
    onBuildBoardMove: async () => { appState.buildCurrentNodeId = "anchor"; },
    hardFlushBuild: async () => {}, resolveBuildId: (id) => id,
    _buildGenReady: Promise.resolve({ runBrowserBuildGenerate: async () => {
      appState.build = { repertoire_id: "other", revision: 12 };
      return { changes: [] };
    } }), effectiveMaiaRating: () => 1500, effectiveStockfishDepth: () => 12,
    getSharedMaia3Provider: () => ({}), postJson: vi.fn(async () => ({ summary: { added_nodes: 1 } })),
    hydrateBuild: vi.fn(),
  };
  const run = new Function(...Object.keys(deps), `${code}\nreturn completeOneGap;`)(...Object.values(deps));
  await run({ nodeId: "root", moveUci: "e7e5" });
  expect(deps.postJson).toHaveBeenCalledWith("/api/build/generate/apply-plan", expect.objectContaining({ repertoire_id: "r", base_revision: 4 }));
  expect(deps.hydrateBuild).not.toHaveBeenCalled();
});
