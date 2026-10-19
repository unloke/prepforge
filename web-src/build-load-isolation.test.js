// Regression: picking another repertoire cancels the previous load's in-flight
// request. The load handlers bail when their sequence number is stale, but the
// sequence only advanced when the next load STARTED. Switching from A to B
// while A was still loading left A "current": A's late response hydrated A's
// tree on top of B's (wrong repertoire, and B's skeleton never cleared) and A's
// slower failure path was free to report an error and restore the old board.
import { describe, expect, it } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

function bodyOf(marker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start) + 2;
  return source.slice(start, end);
}

describe("editRepertoire load isolation", () => {
  const edit = bodyOf("async function editRepertoire(repertoireId, nodeId = null) {");

  it("advances the load sequence before it can throw, so the previous load is stale at once", () => {
    const mark = edit.indexOf("const loadSeq = ++buildLoadSeq;");
    expect(mark).toBeGreaterThan(-1);
    // Nothing can throw between the sequence bump and the skeleton: the bump is
    // the first statement, and setBuildLoading follows immediately.
    expect(edit.indexOf("setBuildLoading(true)", mark)).toBeGreaterThan(mark);
    expect(edit.slice(0, mark)).not.toMatch(/await|throw/);
  });

  it("guards every await with the load sequence", () => {
    // hardFlushBuild, the load itself and hydrateBuild each re-check before
    // touching state; a newer load must not be overwritten by an older response.
    const afterFlush = edit.indexOf("await hardFlushBuild();");
    expect(edit.indexOf("if (loadSeq !== buildLoadSeq) return;", afterFlush)).toBeGreaterThan(afterFlush);
    const afterHydrate = edit.indexOf("await hydrateBuild(payload");
    expect(edit.indexOf("if (loadSeq !== buildLoadSeq) return;", afterHydrate)).toBeGreaterThan(afterHydrate);
  });
});
