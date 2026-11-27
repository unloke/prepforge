// The "Waiting for sign-in" chip opens sign-in on click; a keyboard user must
// reach and press it too, and the chip must not be a tab stop otherwise.
import { describe, expect, it, vi } from "vitest";

vi.mock("./train-shell.css", () => ({}));
vi.mock("./build-entry.js", () => ({ isBuildReadOnly: () => false }));

import { renderSyncChip } from "./sync-chip.js";
import { buildState } from "./core/state.js";
import { hooks } from "./core/hooks.js";

function fakeChip() {
  const attrs = new Map();
  const listeners = {};
  return {
    dataset: {}, hidden: true, className: "", textContent: "", title: "",
    set tabIndex(value) { attrs.set("tabindex", String(value)); },
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    attrs, listeners,
  };
}

describe("sync chip keyboard access", () => {
  it("is a focusable button only while it waits on sign-in", () => {
    const el = fakeChip();
    renderSyncChip(el, "blocked");
    expect(el.attrs.get("role")).toBe("button");
    expect(el.attrs.get("tabindex")).toBe("0");
    renderSyncChip(el, "saved");
    expect(el.attrs.has("role")).toBe(false);
    expect(el.attrs.has("tabindex")).toBe(false);
  });

  it("opens sign-in on Enter or Space, as a click does", () => {
    const el = fakeChip();
    const authRequired = vi.fn();
    hooks.authRequired = authRequired;
    buildState.buildSyncState = "blocked";
    renderSyncChip(el, "blocked");
    for (const key of ["Enter", " "]) {
      const event = { key, preventDefault: vi.fn() };
      el.listeners.keydown(event);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    el.listeners.keydown({ key: "a", preventDefault: vi.fn() });
    expect(authRequired).toHaveBeenCalledTimes(2);
    buildState.buildSyncState = "saved";
    el.listeners.keydown({ key: "Enter", preventDefault: vi.fn() });
    expect(authRequired).toHaveBeenCalledTimes(2);
  });
});
