import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { announceRepertoireChanged, onRepertoireChanged } from "./repertoire-changes.js";

const here = new URL(".", import.meta.url);
const source = (path) => readFileSync(new URL(path, here), "utf8");

describe("repertoire change announcements", () => {
  it("reach every subscriber until it unsubscribes", () => {
    const first = vi.fn(), second = vi.fn();
    const stopFirst = onRepertoireChanged(first);
    const stopSecond = onRepertoireChanged(second);
    const change = { repertoireId: "r", tree: { repertoire_id: "r", nodes: [] } };
    announceRepertoireChanged(change);
    stopFirst();
    announceRepertoireChanged({ repertoireId: "r" });
    stopSecond();
    expect(first.mock.calls).toEqual([[change]]);
    expect(second.mock.calls).toEqual([[change], [{ repertoireId: "r" }]]);
  });

  it("are how Build reaches Analyze's book: no Build module imports an Analyze one", () => {
    const build = [
      ...readdirSync(new URL("controllers/", here)).filter((name) => /^build-.*\.js$/.test(name) && !name.endsWith(".test.js"))
        .map((name) => `controllers/${name}`),
      ...readdirSync(here).filter((name) => /^build-.*\.js$/.test(name) && !name.endsWith(".test.js")),
    ];
    // analyze-pgn.js is the shared PGN parser, not Analyze's state.
    const reaching = build.flatMap((path) => [...source(path).matchAll(/from "([^"]+)"/g)]
      .map(([, spec]) => spec.split("/").pop())
      .filter((name) => name.startsWith("analyze-") && name !== "analyze-pgn.js")
      .map((name) => `${path} -> ${name}`));
    expect(reaching).toEqual([]);
    expect(source("analyze-book-state.js")).toMatch(/onRepertoireChanged\(/);
  });
});
