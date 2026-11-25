import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginLuckyDiscovery,
  cancelLuckyDiscovery,
  finishLuckyDiscovery,
  luckyDiscoveryCurrent,
} from "./train-lucky-control.js";

function buttonStub() {
  return {
    disabled: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name] ?? null; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Random discovery ownership", () => {
  it("cancellation releases the button immediately and aborts the run", () => {
    const button = buttonStub();
    vi.stubGlobal("document", { getElementById: (id) => id === "feeling-lucky" ? button : null });
    const state = { playStartToken: 0 };
    const run = beginLuckyDiscovery(state);
    expect(state.luckyBusy).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    cancelLuckyDiscovery(state);

    expect(state.luckyBusy).toBe(false);
    expect(state.luckyRun).toBeNull();
    expect(run.controller.signal.aborted).toBe(true);
    expect(luckyDiscoveryCurrent(state, run)).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("an old run's finish cannot clear its replacement", () => {
    const state = { playStartToken: 0 };
    const first = beginLuckyDiscovery(state);
    cancelLuckyDiscovery(state);
    const second = beginLuckyDiscovery(state);

    finishLuckyDiscovery(state, first);

    expect(state.luckyRun).toBe(second);
    expect(state.luckyBusy).toBe(true);
    expect(luckyDiscoveryCurrent(state, second)).toBe(true);

    finishLuckyDiscovery(state, second);
    expect(state.luckyRun).toBeNull();
    expect(state.luckyBusy).toBe(false);
  });

  it("a newer Practice start supersedes discovery ownership", () => {
    const state = { playStartToken: 0 };
    const run = beginLuckyDiscovery(state);
    state.playStartToken += 1;
    expect(luckyDiscoveryCurrent(state, run)).toBe(false);
  });
});
