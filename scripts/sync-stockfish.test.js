import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capSharedHeap, discoverStockfishBuild, stockfishBuild, syncStockfish } from "./sync-stockfish.mjs";

const root = resolve(import.meta.dirname, "..");

describe("Stockfish package synchronization", () => {
  it("discovers the threaded lite pair from package metadata", () => {
    expect(
      discoverStockfishBuild({
        packageJson: { version: "99.1.0", buildVersion: "99" },
        files: ["stockfish-99-lite.js", "stockfish-99-lite.wasm", "stockfish-99-lite-single.js"],
      }),
    ).toEqual({
      sourceJs: "stockfish-99-lite.js",
      sourceWasm: "stockfish-99-lite.wasm",
      buildVersion: "99",
    });
  });

  it("fails closed when upstream changes the expected layout", () => {
    expect(() =>
      discoverStockfishBuild({
        packageJson: { version: "99.1.0", buildVersion: "99" },
        files: ["stockfish-99-lite.js"],
      }),
    ).toThrow(/missing WASM pair/);
  });

  it("syncs the engine into a folder named by its hash, with its identity", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "node_modules", "stockfish", "package.json"), "utf8"),
    );
    const manifest = syncStockfish();
    expect(manifest.packageVersion).toBe(packageJson.version);
    expect(manifest.engineVersion).toBe(String(packageJson.buildVersion));
    expect(manifest.dir).toMatch(/^[a-f0-9]{8}$/);
    expect(manifest.files.script.bundled).toBe(`${manifest.dir}/stockfish-lite.js`);
    expect(manifest.files.wasm.bundled).toBe(`${manifest.dir}/stockfish-lite.wasm`);
    expect(manifest.net).toBe("nn-61e7af4bb97d");
    expect(manifest.id).toBe(`sf${packageJson.buildVersion}@${packageJson.version}+${manifest.files.wasm.sha256.slice(0, 8)}/nn-61e7af4bb97d`);
    expect(stockfishBuild()).toMatchObject({ id: manifest.id, dir: manifest.dir });
    const script = readFileSync(join(root, "web-src", "public", "engine", manifest.dir, "stockfish-lite.js"), "utf8");
    expect(script).toContain("maximum:4096,shared:!0");
  });

  it("refuses a script whose shared heap declaration it cannot cap", () => {
    expect(() => capSharedHeap("new WebAssembly.Memory({initial:1})")).toThrow(/changed upstream/);
  });

  it("loads the engine from the build's folder and renders the bundled manifest version", () => {
    const provider = readFileSync(
      join(root, "web-src", "engine", "stockfish-provider.js"),
      "utf8",
    );
    const settings = readFileSync(join(root, "web-src", "views", "settings.js"), "utf8");
    const html = readFileSync(join(root, "web-src", "index.html"), "utf8");
    expect(provider).toContain("/static/engine/${STOCKFISH.dir}/stockfish-lite.js");
    expect(provider).not.toMatch(/stockfish-\d+-lite\.js/);
    expect(settings).toContain('/static/engine/stockfish.manifest.json');
    expect(html).toContain('id="settings-stockfish-version">checking…</b>');
    expect(html).not.toMatch(/Stockfish \d+ lite/);
  });
});
