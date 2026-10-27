// Round-2 integration fixes that span views: the shared phone sheet, the
// route swap's layer, the source picker's Done, Check games with an added
// username, the Scout head on a phone and the history sheet's close.
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { swapView } from "../view-swap.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const styles = read("../styles.css");
const phone = read("../phone.css");
const teams = read("./teams.css");
const scout = read("./scout.css");

afterEach(() => vi.unstubAllGlobals());

describe("the route swap's layer", () => {
  it("names the workspace only while a swap runs", () => {
    expect(styles).toContain(":root.view-swap .workspace { view-transition-name: view; }");
    expect(styles).not.toMatch(/^\.workspace \{ view-transition-name: view; \}/m);
  });

  it("sets and clears :root.view-swap around the transition", async () => {
    const rootClasses = new Set();
    let run, done;
    const finished = new Promise((r) => { done = r; });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("document", {
      visibilityState: "visible",
      documentElement: { classList: { add: (c) => rootClasses.add(c), remove: (c) => rootClasses.delete(c) } },
      startViewTransition(update) { run = update; return { finished, ready: Promise.resolve() }; },
    });
    const mk = (id, on) => { const s = new Set(on ? ["is-active"] : []); return { id, classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, v) => (v ? s.add(c) : s.delete(c)) } }; };
    swapView([mk("a", true), mk("b")], "b");
    expect(rootClasses.has("view-swap")).toBe(true);
    run(); done();
    await finished; await Promise.resolve(); await Promise.resolve();
    expect(rootClasses.has("view-swap")).toBe(false);
  });
});

describe("the shared phone sheet", () => {
  it("dims with its own spread shadow, never a layer over its fill", () => {
    const rule = phone.match(/\.phone-sheet\.is-open \{[^}]*\}/)[0];
    expect(rule).toMatch(/box-shadow: 0 0 0 100vmax rgba\(0, 0, 0, 0\.45\)/);
    const before = phone.match(/\.phone-sheet\.is-open::before \{[^}]*\}/)[0];
    expect(before).not.toMatch(/background/);
  });

  it("leaves Teams without its local sheet workaround", () => {
    expect(teams).not.toMatch(/#team-actions\.is-open::after/);
    expect(teams).not.toMatch(/#team-actions\.is-open \{ bottom:/);
  });
});

describe("the source picker", () => {
  it("closes with Done in its head, not a lone footer button", () => {
    const js = read("./shared/source-composer.js");
    expect(js).toMatch(/<div class="src-head">[^]*?data-src-done>Done<\/button><\/div>/);
    expect(js).not.toContain("src-foot");
  });
});

describe("Check games", () => {
  it("is live with only an added username picked", () => {
    expect(read("../controllers/account.js")).toContain("btn.disabled = !appState.lichessUsername && !appState.gamesExternalCount;");
    expect(read("./games-controller.js")).toContain("appState.gamesExternalCount = normalizeSelection(selection).external.length;");
  });
});

describe("the Scout head on a phone", () => {
  it("is two fixed grid lines with the name cut first", () => {
    expect(scout).toMatch(/\.cs-head \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto auto;/);
    expect(scout).toMatch(/\.cs-head \.scout-section-who \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    expect(scout).toMatch(/\.cs-head \.scout-coverage-label \{ display: none; \}/);
  });
});

describe("the training history sheet", () => {
  it("closes with a text Done", () => {
    expect(read("./train-history.js")).toContain('<button class="btn sm th-done" type="button" data-close>Done</button>');
    expect(read("./train-history.css")).toMatch(/\.th-head \.th-done \{[^}]*color: var\(--accent-strong\);/);
  });
});
