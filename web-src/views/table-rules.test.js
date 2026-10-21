// The Library table and the Teams lists are real tables: their column header
// and their row separators are table rules, not decorative hairlines.
//
// The taste inspector counts every thin rule on the page and only exempts the
// ones inside a real table or a form field, so these regions carry the
// data-ui marker the rest of the app already uses (the replay ledger, the
// scout lines). Without it the table's own rules read as stray dividers.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "..", "index.html"), "utf8");

// The markup of one element, by id.
function byId(id) {
  const at = html.indexOf(`id="${id}"`);
  expect(at, id).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  return html.slice(open, html.indexOf(">", at));
}

it("the Library table marks its column header and its rows", () => {
  expect(byId("lib-cols")).toMatch(/data-ui/);
  expect(byId("dashboard-repertoires")).toMatch(/data-ui/);
});

it("the Teams lists mark their rows", () => {
  for (const id of ["teams-list", "team-members", "team-shared-repertoires", "teams-shared"]) {
    expect(byId(id), id).toMatch(/data-ui/);
  }
});
