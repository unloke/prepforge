import { expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function readySignal(ensureSettingsView, settingsLoads) {
  const source = appSource();
  const start = source.indexOf("async function whenSettingsReady()");
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function("ensureSettingsView", "settingsLoads", `return (${source.slice(start, end)});`)(ensureSettingsView, settingsLoads);
}
it("waits for lazy binding and renders started while another render settles", async () => {
  const lazy = deferred(), first = deferred(), second = deferred();
  const loads = new Set([first.promise]);
  const ready = readySignal(() => lazy.promise, loads);
  const settled = vi.fn();
  const view = { bound: true };
  const promise = ready().then((value) => { settled(); return value; });
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  lazy.resolve(view);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  loads.add(second.promise);
  loads.delete(first.promise);
  first.resolve();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  loads.delete(second.promise);
  second.resolve();
  expect(await promise).toBe(view);
});
it("settles after a failed load and propagates a lazy import failure", async () => {
  const load = deferred();
  const loads = new Set([load.promise]);
  const view = {};
  const ready = readySignal(async () => view, loads)();
  await Promise.resolve();
  loads.delete(load.promise);
  load.reject(new Error("offline"));
  expect(await ready).toBe(view);
  await expect(readySignal(async () => { throw new Error("chunk failed"); }, new Set())()).rejects.toThrow("chunk failed");
});
