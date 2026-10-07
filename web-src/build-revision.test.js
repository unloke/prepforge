import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { advanceBuildRevision, queuedBuildRevision, withBuildRevision } from "./build-revision.js";
import { appSource } from "./test-app-source.js";

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

it("reply preview binds saving to the approved snapshot, never optimistic gap writes", () => {
  const source = appSource();
  expect(source).toContain('import("./controllers/coverage-replies.js")');
  expect(source).toContain("getBuild: () => appState.build");
  const code = readFileSync(new URL("./controllers/coverage-replies.js", import.meta.url), "utf8");
  expect(code).toContain("const snapshot = getBuild()");
  expect(code).toContain("base_revision: snapshot.revision");
  expect(code).toContain("repertoire_id: snapshot.repertoire_id");
  expect(code).toContain("if (!isCurrent() || !isValid() || isBuildReadOnly()) throw");
  expect(code).toContain("if (isCurrent())");
  expect(code).not.toContain("onBuildBoardMove");
  expect(code).toContain("if (!approved) return");
});
