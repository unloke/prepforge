import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverStockfishBuild, syncStockfish } from "./sync-stockfish.mjs";

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

  it("syncs stable browser filenames and truthful metadata", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "node_modules", "stockfish", "package.json"), "utf8"),
    );
    const manifest = syncStockfish();
    expect(manifest.packageVersion).toBe(packageJson.version);
    expect(manifest.engineVersion).toBe(String(packageJson.buildVersion));
    expect(manifest.files.script.bundled).toBe("stockfish-lite.js");
    expect(manifest.files.wasm.bundled).toBe("stockfish-lite.wasm");
    expect(manifest.files.script.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files.wasm.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps runtime URLs stable and renders the bundled manifest version", () => {
    const provider = readFileSync(
      join(root, "web-src", "engine", "stockfish-provider.js"),
      "utf8",
    );
    const settings = readFileSync(join(root, "web-src", "views", "settings.js"), "utf8");
    const html = readFileSync(join(root, "web-src", "index.html"), "utf8");
    expect(provider).toContain('/static/engine/stockfish-lite.js');
    expect(provider).not.toMatch(/stockfish-\d+-lite\.js/);
    expect(settings).toContain('/static/engine/stockfish.manifest.json');
    expect(html).toContain('id="settings-stockfish-version">checking…</div>');
    expect(html).not.toMatch(/Stockfish \d+ lite/);
  });
});
