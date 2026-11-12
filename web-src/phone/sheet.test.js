// The phone sheet's gestures: a drag on the tab row raises or lowers the sheet
// (the finger lifts over the board, so the release is read on the window), and
// a held repertoire row opens its menu once, with the closing tap swallowed.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindLongPress, bindSheet } from "./sheet.js";

const win = new EventTarget();

function element() {
  const el = new EventTarget();
  const classes = new Set();
  el.classList = {
    toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    contains: (name) => classes.has(name),
  };
  return el;
}

function pointer(type, props) {
  return Object.assign(new Event(type, { cancelable: true }), { isPrimary: true, pointerType: "touch", ...props });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
  vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("raises the sheet on an upward drag released off the row, and lowers it on a downward one", () => {
  const view = element();
  const row = element();
  bindSheet(view, row, null);
  row.dispatchEvent(pointer("pointerdown", { clientY: 400 }));
  win.dispatchEvent(pointer("pointerup", { clientY: 280 }));
  expect(view.classList.contains("is-raised")).toBe(true);
  row.dispatchEvent(pointer("pointerdown", { clientY: 100 }));
  win.dispatchEvent(pointer("pointerup", { clientY: 300 }));
  expect(view.classList.contains("is-raised")).toBe(false);
  // A tap is not a drag.
  row.dispatchEvent(pointer("pointerdown", { clientY: 400 }));
  win.dispatchEvent(pointer("pointerup", { clientY: 410 }));
  expect(view.classList.contains("is-raised")).toBe(false);
});

it("opens a held row's menu once and swallows the tap that ends the hold", () => {
  const row = element();
  const open = vi.fn();
  const click = vi.fn();
  bindLongPress(row, open);
  row.addEventListener("click", click);
  row.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 20 }));
  vi.advanceTimersByTime(500);
  expect(open).toHaveBeenCalledTimes(1);
  // Android also fires contextmenu for the same hold: no second menu.
  row.dispatchEvent(new Event("contextmenu", { cancelable: true }));
  row.dispatchEvent(new Event("click", { cancelable: true }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(click).not.toHaveBeenCalled();
  // A short tap still clicks.
  row.dispatchEvent(pointer("pointerdown", {}));
  row.dispatchEvent(pointer("pointerup", {}));
  row.dispatchEvent(new Event("click", { cancelable: true }));
  expect(click).toHaveBeenCalledTimes(1);
});
