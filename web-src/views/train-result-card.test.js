// The one Result card every Train mode ends on: at most four cells that fill
// their row, an optional what-changed line, one line of outlook, plain copy.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { drillResult, healthDelta, playResult, smartResult } from "../train-result.js";

const shell = readFileSync(new URL("../train-shell.css", import.meta.url), "utf8");
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../train-result.js", import.meta.url), "utf8");

it("a queue counts the cards it served, skipped ones included", () => {
  const result = smartResult({ cardsDone: 3, healthBefore: null }, { correct: 2, mistakes: 1, skipped: 2, best: 2 });
  expect(result.cells).toEqual([[5, "cards"], ["67%", "first try"], [2, "best streak"], [2, "skipped"]]);
  expect(result.title).toBe("Queue complete");
});

it("a session of only new moves counts what it taught instead of an empty score", () => {
  const result = smartResult({ cardsDone: 1 }, { correct: 0, mistakes: 0, skipped: 0, learned: 4 });
  expect(result.cells).toEqual([[1, "card"], [4, "learned"]]);
});

it("never shows more than four cells", () => {
  const result = smartResult({ cardsDone: 6 }, { correct: 5, mistakes: 1, skipped: 1, learned: 2, best: 4 });
  expect(result.cells).toHaveLength(4);
});

it("hides what changed until there is a before and an after to compare", () => {
  expect(smartResult({ cardsDone: 4, healthBefore: null }, { correct: 4 }).delta).toBeNull();
  const before = { mastered: 0, learning: 1, due: 1, weak: 1, untrained: 2 };
  const after = { health: { mastered: 1, learning: 1, due: 0, weak: 1, untrained: 2 }, due_tomorrow: 2 };
  const delta = String(smartResult({ cardsDone: 4, healthBefore: before }, { correct: 4 }, after).delta);
  expect(delta).toContain("Mastered 1");
  expect(delta).toContain("Due 0");
  expect(delta).not.toContain("Learning");
  expect(healthDelta(before, before)).toBeNull();
});

it("the foot says what is due tomorrow, without an exclamation", () => {
  expect(smartResult({ cardsDone: 1 }, { correct: 1 }, { due_tomorrow: 3 }).foot).toBe("3 reviews due tomorrow");
  expect(smartResult({ cardsDone: 1 }, { correct: 1 }, { due_tomorrow: 0 }).foot).toBe("Nothing due tomorrow");
  expect(smartResult({ cardsDone: 1 }, { correct: 1 }).foot).toBe("");
  expect(source).not.toMatch(/!["`]/);
});

it("a rehearsal reports lines, first-try score and misses", () => {
  const result = drillResult({ lines: [1, 2, 3, 4], repertoire_name: "Italian" }, { correct: 9, mistakes: 1 });
  expect(result.cells).toEqual([[4, "lines"], ["90%", "first try"], [1, "missed"]]);
  expect(result.title).toBe("Rehearsal complete");
});

it("a game reports how it ended and how far it went, and names why when it could not go on", () => {
  const play = { ended: "Resigned", userColor: "black", history: [{ by: "user" }, { by: "opponent" }, { by: "user" }], result: "1-0" };
  expect(playResult(play)).toMatchObject({ title: "Resigned", cells: [["1-0", "result"], [2, "moves"], ["Black", "you played"]], foot: "" });
  expect(playResult({ ...play, ended: "Opponent unavailable", failure: "Maia could not start." }).foot).toBe("Maia could not start.");
});

it("the cells fill the row they are in", () => {
  expect(shell).toMatch(/\.sum-cells \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(\d+px, 1fr\)\)/);
});

it("no emoji in the Train markup", () => {
  const train = markup.slice(markup.indexOf('id="view-train"'), markup.indexOf('id="view-replay"'));
  expect(train).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
});
