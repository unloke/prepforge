// The local-first infrastructure stays feature-blind, and every write that
// changes a Build tree goes through Build's own serialized writer
// (build-write.js), so it advances the tree revision and tells other tabs.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// fileURLToPath, not URL.pathname: on Windows the pathname starts "/C:/".
const root = fileURLToPath(new URL(".", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");

const INFRASTRUCTURE = ["core/api.js", "sync-queue.js", "outbox.js", "outbox-db.js", "outbox-state.js"];

it("keeps the shared sync and API layer free of Build and Train knowledge", () => {
  for (const file of INFRASTRUCTURE) {
    const code = read(file);
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)].map((m) => m[1] || m[2]);
    expect(imports.filter((path) => /(^|\/)(build|train)[-.]|controllers\//.test(path)), file).toEqual([]);
    expect(code, file).not.toMatch(/\b(buildState|trainState)\b/);
    expect(code, file).not.toMatch(/\/api\/(build|train)\b/);
  }
});

function sources(dir = root) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return name.endsWith(".js") && !name.includes(".test.") && !name.includes(".fixture.") ? [path] : [];
  });
}

// Reads and exports that don't change the tree may skip the writer.
const NOT_TREE_WRITES = new Set(["/api/build/export", "/api/build/activity/seen"]);

it("sends every Build tree write through the Build writer", () => {
  const plain = sources().flatMap((path) => [...readFileSync(path, "utf8")
    .matchAll(/\bpostJson\(\s*["'`](\/api\/build\/[^"'`]*)["'`]/g)]
    .map((m) => `${relative(root, path)} ${m[1]}`));
  expect(plain.filter((hit) => !NOT_TREE_WRITES.has(hit.split(" ")[1]))).toEqual([]);
  expect(plain.length).toBeGreaterThan(0); // the scan still finds the allowed ones
});
