// The result card and the setup row: no emoji, plain copy, and stat cells that
// fill their row. A session with a skip AND a day streak has five cells; a
// fixed four-column grid left three empty columns under the last one.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const view = readFileSync(join(root, "views", "train.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const markup = readFileSync(join(root, "index.html"), "utf8");

it("the result card's stat cells fill the row they are in", () => {
  expect(styles).toMatch(/\.sum-cells \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(\d+px, 1fr\)\)/);
});

it("no emoji in the result card or the setup row", () => {
  expect(view).not.toMatch(/\\u\{1F525\}/);
  expect(view).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  expect(markup).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
});

it("the result card's foot says what is due, without an exclamation", () => {
  const foot = view.match(/footEl\.textContent =[\s\S]{0,320};/);
  expect(foot).not.toBeNull();
  expect(foot[0]).not.toMatch(/!/);
  expect(foot[0]).not.toMatch(/ - /);
  expect(foot[0]).toMatch(/countOf\(after\.due_tomorrow, "review"\)/);
});
