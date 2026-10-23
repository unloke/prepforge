// A repertoire opens on a node that its own payload contains. A stale or
// removed anchor (or a selection the server no longer names) used to make
// selectBuildNode return at once, so the tree was never painted and the loading
// skeleton stayed up for a repertoire with no moves.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const session = readFileSync(new URL("./build-session.js", import.meta.url), "utf8");

it("the opening node is one the payload contains, falling back to the root", () => {
  expect(session).toMatch(/const known = \(id\) => !!id && appState\.buildNodeById\.has\(id\);/);
  expect(session).toMatch(/const nextNodeId = \[selectedNodeId, payload\.selected_node_id\]\.find\(known\) \|\| root\?\.id;/);
});
