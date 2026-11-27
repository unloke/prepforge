// handoffs.repertoiresChanged: Build and Train say the repertoire listing moved,
// and the shell refreshes what shows it. A finished Train session also changes
// the due counts in the repertoire head.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = app.indexOf("function repertoiresChanged(");
const fn = (deps) => new Function(...Object.keys(deps), `return (${app.slice(start, app.indexOf("\n}\n", start) + 2)});`)(...Object.values(deps));

describe("repertoiresChanged", () => {
  it("refreshes the Library listing and returns its promise", async () => {
    const deps = { refreshDashboardRepertoires: vi.fn(async () => "listed"), refreshRepertoireHead: vi.fn(async () => {}) };
    await expect(fn(deps)()).resolves.toBe("listed");
    expect(deps.refreshRepertoireHead).not.toHaveBeenCalled();
  });

  it("also refreshes the repertoire head after training, without waiting on it", async () => {
    const deps = { refreshDashboardRepertoires: vi.fn(async () => {}), refreshRepertoireHead: vi.fn(() => new Promise(() => {})) };
    await fn(deps)({ trained: true });
    expect(deps.refreshRepertoireHead).toHaveBeenCalledOnce();
    expect(deps.refreshDashboardRepertoires).toHaveBeenCalledOnce();
  });
});
