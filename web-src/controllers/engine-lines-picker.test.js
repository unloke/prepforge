import { describe, expect, it, vi } from "vitest";
import { createLinesPicker } from "./engine-lines-picker.js";

function makeBtn(n) {
  const attrs = { "aria-checked": String(n === 1) };
  return {
    dataset: { n: String(n) },
    focused: false,
    focus() { this.focused = true; },
    closest(sel) { return sel === "[data-n]" ? this : null; },
    getAttribute(k) { return attrs[k]; },
    setAttribute(k, v) { attrs[k] = String(v); },
  };
}

describe("createLinesPicker keyboard isolation", () => {
  it("stops propagation on Arrow/Home/End inside the picker so board navigation never fires", () => {
    const listeners = { trigger: {}, menu: {} };
    const btns = [1, 2, 3, 4, 5].map(makeBtn);
    const classes = new Set();
    const trigger = {
      attrs: {},
      focused: false,
      focus() { this.focused = true; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      addEventListener(type, fn) { listeners.trigger[type] = fn; },
    };
    const menu = {
      style: {},
      classList: {
        toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
        contains(c) { return classes.has(c); },
      },
      querySelectorAll() { return btns; },
      querySelector(sel) { return sel === "[data-n]" ? btns[0] : btns.find((b) => b.getAttribute("aria-checked") === "true"); },
      addEventListener(type, fn) { listeners.menu[type] = fn; },
      parentElement: { addEventListener() {} },
    };

    createLinesPicker({ trigger, menu, onPick: vi.fn() });

    const openEv = { key: "ArrowDown", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners.trigger.keydown(openEv);
    expect(openEv.preventDefault).toHaveBeenCalled();
    expect(openEv.stopPropagation).toHaveBeenCalled();
    expect(classes.has("is-open")).toBe(true);

    for (const [key, startIdx, expectIdx] of [
      ["End", 0, 4],
      ["ArrowLeft", 4, 3],
      ["ArrowRight", 3, 4],
      ["Home", 4, 0],
    ]) {
      btns.forEach((b) => { b.focused = false; });
      const ev = { key, target: btns[startIdx], preventDefault: vi.fn(), stopPropagation: vi.fn() };
      listeners.menu.keydown(ev);
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(ev.stopPropagation).toHaveBeenCalled();
      expect(btns[expectIdx].focused).toBe(true);
    }
  });
});
