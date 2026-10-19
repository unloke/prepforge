// The result card and the setup row: no emoji, plain copy, and stat cells that
// fill their row. A session with a skip AND a day streak has five cells; a
// fixed four-column grid left three empty columns under the last one.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createTrainView } from "./train.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const view = readFileSync(join(root, "views", "train.js"), "utf8");
const styles = readFileSync(join(root, "styles.css"), "utf8");
const markup = readFileSync(join(root, "index.html"), "utf8");

function summaryView() {
  const host = (extra = {}) => ({ hidden: false, innerHTML: "", textContent: "", ...extra });
  const elements = {
    "train-summary": host(),
    "train-queue": host(),
    "train-summary-stats": host(),
    "train-summary-delta": host(),
    "train-summary-foot": host(),
  };
  globalThis.document = { getElementById: (id) => elements[id] || null, querySelector: () => null, querySelectorAll: () => [] };
  const view = createTrainView({
    appState: {}, boards: {}, renderSyncChip: () => {}, setTrainBanner: () => {},
    updateTrainTurnBadge: () => {}, onStreakRendered: () => {},
  });
  return { view, elements };
}

it("hides the health delta when there is no before/after pair to compare", () => {
  const { view: train, elements } = summaryView();
  train.renderSmartSummary({ cardsDone: 4, healthBefore: null }, { correct: 4 }, null, null);
  expect(elements["train-summary-delta"].hidden).toBe(true);
  expect(String(elements["train-summary-delta"].innerHTML)).toBe("");
});

it("shows the delta again on the next session that does have one", () => {
  const { view: train, elements } = summaryView();
  train.renderSmartSummary(
    { cardsDone: 4, healthBefore: { mastered: 0, learning: 1, due: 1, weak: 1, untrained: 2 } },
    { correct: 4 },
    { health: { mastered: 1, learning: 1, due: 0, weak: 1, untrained: 2 }, due_tomorrow: 2 },
    null,
  );
  expect(elements["train-summary-delta"].hidden).toBe(false);
  expect(String(elements["train-summary-delta"].innerHTML)).toContain("Mastered");
});

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
