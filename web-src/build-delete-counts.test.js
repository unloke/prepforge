// Regressions for Repertoire header counts after a local-first delete / undo.
//
// deleteBuildNodeLocal prunes the subtree and repaints the tree, but the panel
// head ("N lines · M moves · K to train") is painted by syncViewHeads, which
// syncViewHeads -> views/build.js -> app.js wiring only runs on a tree
// re-render pass. It used to be left out of the delete/undo paths, so the head
// kept the pre-delete counts until something else repainted it (a save landing
// or stepping the board). Measured in the browser: after deleting 3...Bf5 the
// head still read "2 lines · 7 moves" while the tree showed 6 moves.
import { describe, expect, it } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();

function bodyOf(marker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start) + 2;
  return source.slice(start, end);
}

describe("Build delete/undo repaint the repertoire header counts", () => {
  const del = bodyOf("async function deleteBuildNodeLocal(nodeId) {");

  it("refreshes the panel head after pruning the subtree", () => {
    const prune = del.indexOf("pruneLocalBuildSubtree(nodeId)");
    const refresh = del.indexOf("syncViewHeads()");
    expect(prune).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(prune);
  });

  it("refreshes the panel head again when the undo restores the subtree", () => {
    const undo = del.indexOf("onUndo: async () => {");
    expect(undo).toBeGreaterThan(-1);
    expect(del.indexOf("syncViewHeads()", undo)).toBeGreaterThan(undo);
  });
});
