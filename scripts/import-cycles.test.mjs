import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importGraph, moduleName, stronglyConnected } from "./import-cycles.mjs";

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

// Builds the files in a temp directory and returns each import loop as sorted
// module names with "/" separators, so the expectations hold on Windows too.
async function cyclesIn(files) {
  root = mkdtempSync(join(tmpdir(), "import-cycles-"));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const graph = await importGraph(root);
  return stronglyConnected(graph).map((group) => group.map((id) => moduleName(root, id)).sort());
}

it("sees a loop through an import that leaves off the extension, as Vite resolves it", async () => {
  expect(await cyclesIn({ "a.js": 'import "./b";\n', "b.js": 'import "./a.js";\n' })).toEqual([["a.js", "b.js"]]);
});

it("sees a loop through a directory import that Vite resolves to its index", async () => {
  expect(await cyclesIn({
    "app.js": 'import { x } from "./feature";\nexport const y = 1;\n',
    "feature/index.js": 'import { y } from "../app.js";\nexport const x = y;\n',
  })).toEqual([["app.js", "feature/index.js"]]);
});

it("follows a directory's package.json entry, lazy imports and root-absolute paths", async () => {
  expect(await cyclesIn({
    "a.js": 'export const load = () => import("./pkg");\n',
    "pkg/package.json": '{ "main": "main.js" }',
    "pkg/main.js": 'import "/c";\n',
    "c.js": 'export * from "./a";\n',
  })).toEqual([["a.js", "c.js", "pkg/main.js"]]);
});

it("treats a ?worker import as a separate bundle, and still checks the worker's own imports", async () => {
  expect(await cyclesIn({
    "a.js": 'export const load = () => import("./w.js?worker");\n',
    "w.js": 'import "./a.js";\nimport "./x.js";\n',
    "x.js": 'import "./w.js";\n',
  })).toEqual([["w.js", "x.js"]]);
});

it("sees a loop through a template-literal import() with no interpolation", async () => {
  expect(await cyclesIn({
    "a.js": "export const load = () => import(`./b.js`);\n",
    "b.js": 'import "./a.js";\n',
  })).toEqual([["a.js", "b.js"]]);
});

it("does not count a ?raw import as a code dependency", async () => {
  expect(await cyclesIn({
    "a.js": 'import text from "./b.js?raw";\nexport default text;\n',
    "b.js": 'import "./a.js";\n',
  })).toEqual([]);
});

it("reads TypeScript with type annotations", async () => {
  expect(await cyclesIn({
    "a.ts": 'import { b } from "./b";\nexport const a: number = b + 1;\n',
    "b.ts": 'import { a } from "./a";\nexport const b: number = 1;\nexport const later = (): number => a;\n',
  })).toEqual([["a.ts", "b.ts"]]);
});

it("reports no loop for a one-way chain or for test files", async () => {
  expect(await cyclesIn({
    "a.js": 'import "./b";\n',
    "b.js": 'import "./data.json";\n',
    "a.test.js": 'import "./a";\n',
    "data.json": "{}",
  })).toEqual([]);
});

it("names modules with / separators on Windows and POSIX alike", () => {
  expect(moduleName("C:\\repo\\web-src", "C:/repo/web-src/views/a.js?raw", win32)).toBe("views/a.js?raw");
  expect(moduleName("C:\\repo\\web-src", "C:\\repo\\web-src\\core\\state.js", win32)).toBe("core/state.js");
  expect(moduleName("/repo/web-src", "/repo/web-src/views/a.js", posix)).toBe("views/a.js");
});
