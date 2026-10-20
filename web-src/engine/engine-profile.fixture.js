import { vi } from "vitest";
import { createEngineProfileManager, reserveEngineMemory, PROFILE_KEY } from "./engine-profile.js";

export const STEPS = [["lite", 1], ["big", 1], ["big", 2], ["big", 3]];
export const PROBE = `4:${globalThis.__STOCKFISH__?.big?.id}`;
// A device manager over an in-memory store, with a fake engine whose speed is
// `throughput(net, workers)`. `consent` is this device's answer on the full net:
// the full ladder only runs after a yes, so a yes is the default; the tests about
// asking pass `consent: null`. `bigPhase` is the full net's asset state.
export function fixture({ throughput = (_net, n) => n, Memory = class { constructor(options) { this.options = options; } },
  prepare, search, consent = "yes", bigPhase = { value: "ready" }, ...options } = {}) {
  const data = new Map();
  if (consent) data.set(PROFILE_KEY, JSON.stringify({ consent, probe: PROBE }));
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const engines = [];
  const modules = { lite: {}, big: {} };
  const loadModule = vi.fn(async net => { if (net === "big") bigPhase.value = "ready"; return modules[net]; });
  const reserveMemory = vi.fn(net => reserveEngineMemory(net, Memory));
  // The real manager hands this to Cache Storage; here it only empties the net,
  // which is the state the choice reads.
  const removeAsset = vi.fn(async net => { if (net === "big") bigPhase.value = "idle"; });
  const createEngine = vi.fn(async opts => {
    const index = engines.length;
    const engine = { net: opts.net, closed: false,
      prepare: vi.fn(async () => prepare?.(index, opts)), open: vi.fn(async () => {}),
      waitForSearchComplete: vi.fn(async () => {
        await search?.(index, opts);
        const n = engines.filter(e => !e.closed).length;
        return { nodes: opts.maxNodes * throughput(opts.net, n) / n };
      }),
      close: vi.fn(async () => { engine.closed = true; }),
    };
    engines.push(engine);
    return engine;
  });
  let t = 0;
  const manager = createEngineProfileManager({ storage: () => storage, createEngine, reserveMemory, loadModule, removeAsset,
    assetState: () => ({ phase: bigPhase.value }), subscribeAsset: () => () => {}, beginSession: () => () => {},
    probeBudget: async () => () => {}, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }), now: () => (t += 1000), ...options });
  return { ...manager, data, storage, engines, createEngine, reserveMemory, removeAsset, loadModule, modules };
}
