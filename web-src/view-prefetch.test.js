import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each view chunk is mocked; two report when they are evaluated.
const loaded = {};
vi.mock("./views/dashboard.js", () => { loaded.hit?.("dashboard"); return {}; });
vi.mock("./views/build.js", () => ({}));
vi.mock("./controllers/build-session.js", () => ({}));
vi.mock("./explorer.js", () => ({}));
vi.mock("./views/analyze.js", () => ({}));
vi.mock("./controllers/analyze-session.js", () => ({}));
vi.mock("./coach/bundle.js", () => ({}));
vi.mock("./views/train.js", () => ({}));
vi.mock("./controllers/train-session.js", () => ({}));
vi.mock("./train-resume.js", () => ({}));
vi.mock("./views/games-controller.js", () => ({}));
vi.mock("./views/replay.js", () => ({}));
vi.mock("./views/scout-controller.js", () => { loaded.hit?.("scout"); return {}; });
vi.mock("./views/scout.js", () => ({}));
vi.mock("./views/teams-controller.js", () => ({}));
vi.mock("./views/teams.js", () => ({}));
vi.mock("./views/settings-controller.js", () => ({}));
vi.mock("./views/settings.js", () => ({}));

const source = readFileSync(new URL("./view-prefetch.js", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");

function fakeRoot() {
  const listeners = {};
  return {
    listeners,
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
}
const tab = (view, section) => ({ closest: () => ({ dataset: { view, ...(section ? { replaySection: section } : {}) } }) });

afterEach(() => vi.unstubAllGlobals());

describe("view prefetch", () => {
  it("covers every view controller the shell loads lazily", () => {
    const lazy = [...app.matchAll(/import\("(\.\/views\/[a-z-]+-controller\.js|\.\/train-resume\.js)"\)/g)].map((m) => m[1]);
    expect(lazy.length).toBeGreaterThanOrEqual(5);
    for (const spec of lazy) expect(source).toContain(`import("${spec}")`);
  });

  it("warms a view when the pointer reaches its nav link, Scout by its section", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const { prefetchViews, warmView } = await import("./view-prefetch.js");
    const hits = [];
    loaded.hit = (name) => hits.push(name);
    const root = fakeRoot();
    prefetchViews({ root });
    root.listeners.pointerover({ target: tab("replay", "scout") });
    root.listeners.focusin({ target: tab("dashboard") });
    root.listeners.pointerover({ target: { closest: () => null } });
    await vi.dynamicImportSettled();
    expect(hits).toEqual(["scout", "dashboard"]);
    // Warmed once: a second hover is free.
    warmView("scout");
    await vi.dynamicImportSettled();
    expect(hits).toEqual(["scout", "dashboard"]);
  });

  it("walks every view in idle slots after first paint, and not at all on Save-Data", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { connection: { effectiveType: "4g" } });
    vi.stubGlobal("requestAnimationFrame", (cb) => cb());
    const slots = [];
    const { prefetchViews } = await import("./view-prefetch.js");
    vi.useFakeTimers();
    prefetchViews({ root: fakeRoot(), idle: (cb) => slots.push(cb) });
    vi.runAllTimers();
    vi.useRealTimers();
    let n = 0;
    while (slots.length) { slots.shift()(); n += 1; }
    expect(n).toBe(9); // eight views, then the empty queue
    vi.resetModules();
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const again = await import("./view-prefetch.js");
    const none = [];
    again.prefetchViews({ root: fakeRoot(), idle: (cb) => none.push(cb) });
    expect(none).toEqual([]);
  });
});
