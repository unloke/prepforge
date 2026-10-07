import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./controllers/toast-stack.js", import.meta.url), "utf8");
const toastSource = source.slice(source.indexOf("class Toast {"), source.indexOf("class ToastStack {"));
const Toast = new Function("requestAnimationFrame", `${toastSource}\nreturn Toast;`)((fn) => fn());

afterEach(() => vi.useRealTimers());

it("completed Analyze progress disappears even with a pending trailing repaint", () => {
  vi.useFakeTimers();
  const toast = Object.create(Toast.prototype);
  Object.assign(toast, {
    dock: { id: "analysis-job-dock" }, state: "running", el: { remove: vi.fn() },
    stack: { _forget: vi.fn() }, _applyState: vi.fn(), _renderFill: vi.fn(), _dropStop: vi.fn(),
    titleEl: {}, messageEl: {},
  });
  toast.dock._jobToast = toast;
  toast._progressFlushTimer = setTimeout(() => toast._flushProgress(), 90);
  toast.complete({ title: "Analysis ready" });
  expect(toast.removed).toBe(true);
  expect(toast.el.remove).toHaveBeenCalledOnce();
  expect(toast.dock._jobToast).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("replacing a docked card disposes its timers and keeps the new card active", () => {
  vi.useFakeTimers();
  class Card extends Toast {
    _build() {
      return { classList: { add: vi.fn() }, remove: vi.fn() };
    }
  }
  const stack = { _forget: vi.fn() };
  const dock = { isConnected: true, appendChild: vi.fn() };
  const old = new Card(stack, { dock });
  old._arm(1000, vi.fn());
  old.idleTimer = setTimeout(() => {}, 1000);
  old._progressFlushTimer = setTimeout(() => {}, 90);
  expect(vi.getTimerCount()).toBe(3);

  const next = new Card(stack, { dock });
  expect(old.removed).toBe(true);
  expect(old.el.remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(dock._jobToast).toBe(next);
  expect(stack._forget).toHaveBeenCalledWith(old);
  next.dismiss(true);
  expect(dock._jobToast).toBeNull();
});
