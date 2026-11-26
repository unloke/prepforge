import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importGraph, stronglyConnected } from "./import-cycles.mjs";

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

function cyclesIn(files) {
  root = mkdtempSync(join(tmpdir(), "import-cycles-"));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return stronglyConnected(importGraph(root)).map((group) => group.map((file) => relative(root, file)).sort());
}

it("sees a loop through an import that leaves off the extension, as Vite resolves it", () => {
  expect(cyclesIn({ "a.js": 'import "./b";\n', "b.js": 'import "./a.js";\n' })).toEqual([["a.js", "b.js"]]);
});

it("sees a loop through a directory import that Vite resolves to its index", () => {
  expect(cyclesIn({
    "app.js": 'import { x } from "./feature";\nexport const y = 1;\n',
    "feature/index.js": 'import { y } from "../app.js";\nexport const x = y;\n',
  })).toEqual([["app.js", "feature/index.js"]]);
});

it("follows a directory's package.json entry, lazy imports, queries and root-absolute paths", () => {
  expect(cyclesIn({
    "a.js": 'export const load = () => import("./pkg?worker");\n',
    "pkg/package.json": '{ "main": "main.js" }',
    "pkg/main.js": 'import "/c";\n',
    "c.js": 'export * from "./a#x";\n',
  })).toEqual([["a.js", "c.js", "pkg/main.js"]]);
});

it("reports no loop for a one-way chain or for test files", () => {
  expect(cyclesIn({
    "a.js": 'import "./b";\n',
    "b.js": 'import "./data.json";\nimport "react";\n',
    "a.test.js": 'import "./a";\n',
    "data.json": "{}",
  })).toEqual([]);
});
