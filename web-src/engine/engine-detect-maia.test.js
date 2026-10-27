import { expect, it, vi } from "vitest";
import { CRASH_KEY, createEngineProfileManager } from "./engine-profile.js";
import { ENGINE_PHASE_KEY } from "./engine-ladder.js";
import { fixture } from "./engine-profile.fixture.js";

// Analyze holds Maia beside the engines, so each step Detect keeps must hold both.
it("runs a Maia batch at every step while that step's engines hold their heaps", async () => {
  const seen = [];
  let f;
  const maiaRound = vi.fn(async () => {
    seen.push([f.engines.filter(e => !e.closed).length, JSON.parse(f.data.get(CRASH_KEY))]);
  });
  f = fixture({ maiaLoad: async () => maiaRound });
  const result = await f.detectEngineProfile();
  expect(result).toMatchObject({ net: "big", workers: 3, measurements: { maia: true } });
  // lite x1, big x1, big x2, big x3: each batch ran under that step's crash mark.
  expect(seen.map(([open, mark]) => [open, mark.net, mark.workers, mark.probe]))
    .toEqual([[1, "lite", 1, true], [1, "big", 1, true], [2, "big", 2, true], [3, "big", 3, true]]);
});

it("a Maia failure does not stop Detect", async () => {
  const f = fixture({ maiaLoad: async () => async () => { throw new Error("no maia"); } });
  expect(await f.detectEngineProfile()).toMatchObject({ net: "big", workers: 3 });
});

it("measures without Maia where Analyze will not use it", async () => {
  const f = fixture();
  expect(await f.detectEngineProfile()).toMatchObject({ measurements: { maia: false } });
});

it("names the phase a run died in until a run completes", () => {
  const f = fixture();
  f.data.set(ENGINE_PHASE_KEY, "analyze-maia-traps-stockfish-start");
  f.data.set(CRASH_KEY, JSON.stringify({ net: "big", workers: 2, probe: false }));
  const reloaded = createEngineProfileManager({ storage: () => f.storage, device: () => ({ hardwareConcurrency: 4 }), beginSession: () => () => {} });
  expect(reloaded.lastEngineCrash()).toEqual({ net: "big", workers: 2, phase: "analyze-maia-traps-stockfish-start" });
  const run = reloaded.createEngineAnalysisRun();
  run.start();
  run.done();
  expect(reloaded.lastEngineCrash()).toBeNull();
});
