import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { swapView } from "./view-swap.js";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function view(id, active = false) {
  const classes = new Set(active ? ["is-active"] : []);
  return {
    id,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    classes,
  };
}

function withTransitions({ reduce = false } = {}) {
  const pending = [];
  vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
  vi.stubGlobal("document", {
    visibilityState: "visible",
    startViewTransition(update) {
      let done;
      const finished = new Promise((resolve) => { done = resolve; });
      pending.push(() => { update(); done(); });
      return { finished };
    },
  });
  return pending;
}

afterEach(() => vi.unstubAllGlobals());

describe("route view swap", () => {
  it("keeps the old page painted until it is captured, then swaps", async () => {
    const pending = withTransitions();
    const a = view("view-a", true);
    const b = view("view-b");
    const onSwap = vi.fn();
    swapView([a, b], "view-b", { onSwap });
    expect(a.classes.has("is-active")).toBe(true);
    expect(onSwap).not.toHaveBeenCalled();
    pending.shift()();
    expect(a.classes.has("is-active")).toBe(false);
    expect(b.classes.has("is-active")).toBe(true);
    expect(b.classes.has("is-arriving")).toBe(true);
    expect(onSwap).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.classes.has("is-arriving")).toBe(false);
  });

  it("swaps instantly for reduced motion", () => {
    const pending = withTransitions({ reduce: true });
    const a = view("view-a", true);
    const b = view("view-b");
    const onSwap = vi.fn();
    expect(swapView([a, b], "view-b", { onSwap })).toBeNull();
    expect(pending).toHaveLength(0);
    expect(onSwap).toHaveBeenCalledOnce();
    expect([...b.classes]).toEqual(["is-active"]);
  });

  it("swaps instantly without the API", () => {
    vi.stubGlobal("document", {});
    const a = view("view-a", true);
    const b = view("view-b");
    expect(swapView([a, b], "view-b")).toBeNull();
    expect([...b.classes]).toEqual(["is-active"]);
  });

  it("a second switch before the capture wins", () => {
    const pending = withTransitions();
    const [a, b, c] = [view("view-a", true), view("view-b"), view("view-c")];
    swapView([a, b, c], "view-b");
    swapView([a, b, c], "view-c");
    // The replaced transition's late update does nothing.
    pending.shift()();
    expect(a.classes.has("is-active")).toBe(true);
    pending.shift()();
    expect(c.classes.has("is-active")).toBe(true);
    expect(b.classes.size).toBe(0);
  });

  it("names the workspace, never the board, and drops the old CSS view fade", () => {
    expect(css).toMatch(/\.workspace \{[^}]*view-transition-name:\s*view/);
    expect(css).not.toMatch(/board[^{]*\{[^}]*view-transition-name/);
    expect(css).not.toMatch(/\.view\.is-active \{[^}]*animation:/);
  });
});
