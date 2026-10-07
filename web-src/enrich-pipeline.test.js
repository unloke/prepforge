import { afterEach, expect, it, vi } from "vitest";
import { createEnrichPipeline } from "./enrich-pipeline.js";

afterEach(() => vi.useRealTimers());

it("debounces superseded reads and coalesces behind a running generation", async () => {
  vi.useFakeTimers();
  let finish;
  const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const stage = createEnrichPipeline({ debounceMs: 400, run });
  stage.schedule();
  await vi.advanceTimersByTimeAsync(400);
  const old = stage.generation;
  expect(stage.inFlight).toBe(true);
  stage.schedule(); stage.schedule();
  expect(stage.generation).toBeGreaterThan(old);
  expect(stage.inFlight).toBe(false);
  await vi.advanceTimersByTimeAsync(400);
  expect(run).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(stage.generation);
});

it("cancels both a timer and a coalesced successor", async () => {
  vi.useFakeTimers();
  let finish;
  const run = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const stage = createEnrichPipeline({ debounceMs: 300, run });
  stage.schedule(); stage.cancel();
  await vi.advanceTimersByTimeAsync(300);
  expect(run).not.toHaveBeenCalled();
  stage.flush(); stage.schedule();
  await vi.advanceTimersByTimeAsync(300);
  stage.cancel(); finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  expect(stage.inFlight).toBe(false);
});

it("keeps streaming render deadlines fixed and forced renders synchronous", async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const stage = createEnrichPipeline({ debounceMs: () => 800, run });
  stage.schedule(true);
  await vi.advanceTimersByTimeAsync(400);
  stage.schedule(true);
  await vi.advanceTimersByTimeAsync(400);
  expect(run).toHaveBeenCalledTimes(1);
  stage.schedule(true); stage.flush();
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(800);
  expect(run).toHaveBeenCalledTimes(2);
});
