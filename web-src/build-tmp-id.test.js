import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appSource } from "./test-app-source.js";

const root = dirname(fileURLToPath(import.meta.url));
const app = appSource();

// The function body contains a template literal, so match up to the closing
// brace at the start of a line rather than the first "}" character.
const mintBody = app.match(/function mintBuildTmpId\(\)\s*\{([\s\S]*?)\n\}/);

// The Build temp id doubles as the outbox's operation identity: `mergeById`
// dedupes queued adds by it and `settled` tombstones drop ops by it. Every tab
// of an account shares ONE localStorage key, so the id must be unique per tab.
// A bare per-tab counter restarts at 1 in every tab, so two tabs would mint the
// same "tmp-1" for different moves and the merge would drop the second tab's
// unsaved move as if the first tab's copy had already been settled.
describe("build provisional temp ids", () => {
  it("mints an id scoped to this tab, not a bare per-tab counter", () => {
    expect(mintBody).not.toBeNull();
    expect(mintBody[1]).toContain("OUTBOX_TAB_ID");
  });

  it("keeps the 'tmp-' prefix the server requires for planned adds", () => {
    expect(mintBody).not.toBeNull();
    // workspace.py rejects any tempId that is not a "tmp-"-prefixed string.
    expect(mintBody[1]).toContain("`tmp-${OUTBOX_TAB_ID}-");
  });

  it("derives the tab id from a per-tab random value, not a fixed constant", () => {
    const tabId = app.match(/const OUTBOX_TAB_ID\s*=\s*([^;]+);/);
    expect(tabId).not.toBeNull();
    expect(tabId[1]).toContain("Math.random()");
  });
});
