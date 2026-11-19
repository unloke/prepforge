import { afterEach, describe, expect, it, vi } from "vitest";
import { animateView, swapView } from "./view-swap.js";
import { eagerCss as css } from "./test-styles-source.js";

function animation() {
  let finish, reject;
  const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  return {
    animationName: "view-enter", finished, finish, reject,
    cancel: vi.fn(() => reject(new Error("Animation was canceled"))),
  };
}

function view(id, active = false, arrival = null) {
  const classes = new Set(active ? ["is-active"] : []);
  return {
    id, classes,
    getAnimations: vi.fn(() => arrival ? [arrival] : []),
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
  };
}

function environment({ reduce = false, hidden = false } = {}) {
  const root = view("root");
  vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
  vi.stubGlobal("document", {
    documentElement: root, visibilityState: hidden ? "hidden" : "visible",
    startViewTransition: vi.fn(),
  });
  return root;
}

afterEach(() => {
  swapView([], "", { animate: false });
  vi.unstubAllGlobals();
});

describe("live route view swap", () => {
  it("activates live content synchronously, with one arrival until the fade ends", async () => {
    const root = environment();
    const arrival = animation();
    const a = view("a", true), b = view("b", false, arrival);
    const onSwap = vi.fn(() => expect(b.classes.has("is-arriving")).toBe(true));
    expect(swapView([a, b], "b", { onSwap })).toBe(arrival);
    expect(a.classes.size).toBe(0);
    expect(b.classes.has("is-active")).toBe(true);
    expect(b.classes.has("is-view-entering")).toBe(true);
    expect(onSwap).toHaveBeenCalledOnce();
    expect(document.startViewTransition).not.toHaveBeenCalled();
    arrival.finish();
    await arrival.finished;
    expect([...b.classes]).toEqual(["is-active"]);
    expect(root.classes.size).toBe(0);
  });

  it.each([{ reduce: true }, { hidden: true }])("swaps instantly with %j", (options) => {
    const root = environment(options);
    const a = view("a", true), b = view("b", false, animation());
    const onSwap = vi.fn();
    expect(swapView([a, b], "b", { onSwap })).toBeNull();
    expect(onSwap).toHaveBeenCalledOnce();
    expect(b.getAnimations).not.toHaveBeenCalled();
    expect([...b.classes]).toEqual(["is-active"]);
    expect(root.classes.size).toBe(0);
  });

  it("cancels the old animation synchronously without its late cleanup clearing the new one", async () => {
    const root = environment();
    const first = animation(), second = animation();
    const a = view("a", true), b = view("b", false, first), c = view("c", false, second);
    swapView([a, b, c], "b");
    swapView([a, b, c], "c");
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(b.classes.size).toBe(0);
    expect(c.classes.has("is-active")).toBe(true);
    await Promise.resolve();
    expect(c.classes.has("is-arriving")).toBe(true);
    expect(root.classes.has("view-swap")).toBe(true);
    second.finish();
    await second.finished;
    expect([...c.classes]).toEqual(["is-active"]);
  });

  it("clears all animation markers for an instant interruption", async () => {
    const root = environment();
    const first = animation();
    const a = view("a", true), b = view("b", false, first), c = view("c");
    swapView([a, b, c], "b");
    swapView([a, b, c], "c", { animate: false });
    await Promise.resolve();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(root.classes.size).toBe(0);
    expect(b.classes.size).toBe(0);
    expect([...c.classes]).toEqual(["is-active"]);
  });

  it("cleans up when a running animation is rejected", async () => {
    const root = environment();
    const arrival = animation();
    const a = view("a", true), b = view("b", false, arrival);
    swapView([a, b], "b");
    arrival.reject(new Error("External cancellation"));
    await Promise.resolve();
    expect([...b.classes]).toEqual(["is-active"]);
    expect(root.classes.size).toBe(0);
  });

  it("does not leave markers when CSS has no runnable animation", () => {
    const root = environment();
    const a = view("a", true), b = view("b");
    expect(swapView([a, b], "b")).toBeNull();
    expect([...b.classes]).toEqual(["is-active"]);
    expect(root.classes.size).toBe(0);
  });

  it("can animate only Train's live panel, leaving its board untouched", async () => {
    const root = environment();
    const arrival = animation();
    const train = view("train", true), panel = view("panel", false, arrival);
    const update = vi.fn();
    animateView(train, update, { target: panel });
    expect(update).toHaveBeenCalledOnce();
    expect(train.classes.has("is-arriving")).toBe(true);
    expect(train.classes.has("is-view-entering")).toBe(false);
    expect(train.getAnimations).not.toHaveBeenCalled();
    expect(panel.classes.has("is-view-entering")).toBe(true);
    arrival.finish();
    await arrival.finished;
    expect([...train.classes]).toEqual(["is-active"]);
    expect(panel.classes.size).toBe(0);
    expect(root.classes.size).toBe(0);
  });

  it("uses live CSS entrances without snapshot names or pointer blocking", () => {
    expect(css).toContain(".is-view-entering { animation: view-enter var(--dur) var(--ease-out) both; }");
    expect(css).not.toMatch(/view-transition-name/);
    expect(css).not.toMatch(/\.is-view-entering\s*\{[^}]*pointer-events/);
  });
});
