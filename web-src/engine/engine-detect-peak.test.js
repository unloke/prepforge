import { expect, it, vi } from "vitest";
import { CRASH_KEY, createEngineProfileManager } from "./engine-profile.js";
import { ENGINE_PHASE_KEY } from "./engine-ladder.js";
import { fixture } from "./engine-profile.fixture.js";

// A step Detect keeps must hold the page's normal peak: its engines, Maia and a margin.
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

it("holds the page's margin at every step, under that step's mark", async () => {
  let f;
  const held = [];
  f = fixture({ headroom: () => { held.push(JSON.parse(f.data.get(CRASH_KEY)).workers); return 0; } });
  await f.detectEngineProfile();
  expect(held).toEqual([1, 1, 2, 3]);
});

it("a margin the device refuses ends the ladder at the step before", async () => {
  let calls = 0;
  const f = fixture({ headroom: () => { if (++calls === 3) throw new RangeError("out of memory"); return 0; } });
  // lite x1 and big x1 held their margin; big x2 could not.
  expect(await f.detectEngineProfile()).toMatchObject({ net: "big", workers: 1 });
});
