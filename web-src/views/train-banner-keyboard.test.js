// The coach banner's sub line is clamped; a tap shows the rest. A keyboard user
// reaches the banner with Tab and opens it with Enter or Space.
import { afterEach, expect, it } from "vitest";

import { createTrainView } from "./train.js";

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    listeners, tabIndex: -1,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    classList: { toggle: (name) => (classes.has(name) ? classes.delete(name) : classes.add(name)), contains: (name) => classes.has(name) },
  };
}

afterEach(() => { delete globalThis.document; });

it("is a tab stop that Enter and Space expand and collapse, like a tap", () => {
  const banner = element();
  const sub = element();
  globalThis.document = {
    getElementById: (id) => ({ "train-banner": banner, "train-banner-sub": sub }[id] || null),
    querySelector: () => null, querySelectorAll: () => [],
  };
  createTrainView({ appState: {}, boards: {}, renderSyncChip: () => {}, setTrainBanner: () => {}, updateTrainTurnBadge: () => {}, onStreakRendered: () => {} });
  expect(banner.tabIndex).toBe(0);
  let prevented = 0;
  const press = (key, target = banner) => banner.listeners.keydown({ key, target, preventDefault: () => { prevented += 1; } });
  press("Enter");
  expect(sub.classList.contains("expanded")).toBe(true);
  press(" ");
  expect(sub.classList.contains("expanded")).toBe(false);
  expect(prevented).toBe(2);
  press("a");
  press("Enter", {}); // a key on something inside the banner is not the banner's
  expect(sub.classList.contains("expanded")).toBe(false);
  banner.listeners.click();
  expect(sub.classList.contains("expanded")).toBe(true);
});
