import { afterEach, expect, it, vi } from "vitest";
import { withRequestDeadline } from "./sync-queue.js";
afterEach(() => vi.useRealTimers());
it("bounds a stalled write and marks its result unconfirmed", async () => {
  vi.useFakeTimers();
  let signal;
  const request = withRequestDeadline(s => { signal = s; return new Promise(() => {}); }, { timeoutMs: 10, method: "POST" });
  const assertion = expect(request).rejects.toMatchObject({ name: "RequestTimeoutError", resultUnconfirmed: true });
  await vi.advanceTimersByTimeAsync(10);
  await assertion;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("forwards caller cancellation and releases its deadline", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const request = withRequestDeadline(() => new Promise(() => {}), { signal: controller.signal });
  const assertion = expect(request).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
it("never starts an already cancelled request", async () => {
  const controller = new AbortController(); controller.abort();
  const run = vi.fn();
  await expect(withRequestDeadline(run, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(run).not.toHaveBeenCalled();
});
it("returns completed responses and clears their deadline", async () => {
  vi.useFakeTimers();
  expect(await withRequestDeadline(async () => ({ ok: true }))).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});
