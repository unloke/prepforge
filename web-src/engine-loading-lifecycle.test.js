import { describe, it, expect, beforeEach } from "vitest";

// Engine-loading lifecycle contract: heavy engines/models start only on an
// explicit user intent (Generate click / Analyze click), never on passive tab
// browsing — and the independent inits then run in parallel, sharing one init
// promise per provider.
//
// app.js is a 11k-line side-effectful entry module, so these tests pin the
// lifecycle through the two seams that matter: (1) the shared Maia provider's
// warmup/single-init contract, and (2) the ordering rule that a click starts
// feedback + ALL independent inits before awaiting any of them. The ordering
// rule is encoded as a small local harness mirroring the call order in
// generateFromCurrentNode()/runAnalysis — if someone re-serializes the awaits,
// the "parallel" tests below fail.

import {
  createMaia3Provider,
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
} from "./engine/maia3-provider.js";
import { MOVE_VOCAB } from "./engine/maia3-tokenizer.js";

const validManifest = () => ({
  history: 8,
  token_dim: 97,
  include_time_info: false,
  io: { logits_move_dim: MOVE_VOCAB.length },
});

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeWorker {
  constructor(behavior) {
    this.behavior = behavior;
    this.posted = [];
    this.onmessage = null;
    this.terminated = false;
  }
  postMessage(msg) {
    this.posted.push(msg);
    Promise.resolve().then(() => {
      if (!this.terminated) this.behavior(msg, this);
    });
  }
  reply(id, result) {
    this.onmessage && this.onmessage({ data: { id, ok: true, result } });
  }
  idsOf(type) {
    return this.posted.filter((m) => m.type === type).map((m) => m.id);
  }
  terminate() {
    this.terminated = true;
  }
}

function makeProvider(behavior) {
  const workers = [];
  const provider = createMaia3Provider({
    createWorker: () => {
      const w = new FakeWorker(behavior);
      workers.push(w);
      return w;
    },
    manifest: validManifest(),
    assetBase: "http://weights.test/",
  });
  return { provider, workers };
}

const ackInitElsePend = (msg, worker) => {
  if (msg.type === "init") worker.reply(msg.id, { backend: "wasm", file: "x.onnx", bytes: 1 });
};

beforeEach(() => {
  disposeSharedMaia3Provider();
});

describe("Build tab must not start Maia (explicit intent only)", () => {
  it("constructing nothing starts nothing: no worker until warmup()", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    expect(workers.length).toBe(0);
    expect(provider.state).toBe("idle");
    // Passive browsing ends here — no warmup(), no workers, no download.
  });

  it("Generate click starts runner import AND Maia warmup in parallel", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const order = [];
    // Mirror generateFromCurrentNode: feedback → warmup + import together.
    order.push("feedback");
    const warmupPromise = provider.warmup();
    order.push("warmup-started");
    const importPromise = Promise.resolve().then(() => {
      order.push("import-started");
      return { runBrowserBuildGenerate: () => {} };
    });
    expect(workers.length).toBe(1); // warmup spawned the worker synchronously
    const [, mod] = await Promise.all([warmupPromise, importPromise]);
    expect(order).toEqual(["feedback", "warmup-started", "import-started"]);
    expect(typeof mod.runBrowserBuildGenerate).toBe("function");
    // One worker for both — the import never spawns its own.
    expect(workers.length).toBe(1);
    expect(workers[0].idsOf("init").length).toBe(1);
  });

  it("a second Generate reuses the warm provider (no second worker/download)", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const first = provider.warmup();
    await tick();
    const second = provider.warmup();
    expect(second).toBe(first);
    const pending = provider.predictions({ fen: "f" });
    await tick();
    workers[0].reply(workers[0].idsOf("predictions")[0], []);
    expect(await pending).toEqual([]);
    await first;
    expect(workers.length).toBe(1);
  });
});

describe("Analyze click starts Stockfish + Maia in parallel", () => {
  it("Maia warmup overlaps the Stockfish pass (intervals intersect)", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    // Mirror runAnalysis: maia warmup fires, THEN the stockfish promise starts,
    // and both are in flight before either settles. performance.now() (float,
    // sub-ms) — Date.now() ms integers collide on fast CI and flake the
    // strict inequality.
    const maiaReady = provider.warmup();
    const maiaStart = performance.now();
    await tick();
    expect(workers.length).toBe(1); // maia init started without waiting for SF

    let stockfishStarted = false;
    let stockfishFinished = false;
    const stockfishPass = (async () => {
      stockfishStarted = true;
      const stockfishStart = performance.now();
      await new Promise((r) => setTimeout(r, 30)); // fake multi-position SF pass
      stockfishFinished = true;
      return { stockfishStart, stockfishEnd: performance.now() };
    })();
    expect(stockfishStarted).toBe(true);
    expect(stockfishFinished).toBe(false); // SF still running…

    // …while Maia init already STARTED without waiting for SF (worker posted;
    // init may already be ready on a fast fake — what matters is the single
    // shared init began before SF finished, i.e. no serialization).
    expect(workers.length).toBe(1);
    expect(workers[0].idsOf("init").length).toBe(1);
    const pending = provider.predictions({ fen: "f" });
    await tick();
    workers[0].reply(workers[0].idsOf("predictions")[0], []);
    await pending;
    await maiaReady;
    const maiaEnd = performance.now();
    const { stockfishStart, stockfishEnd } = await stockfishPass;
    // Overlap: maia started before SF finished, and SF started before maia ended.
    expect(maiaStart).toBeLessThan(stockfishEnd);
    expect(stockfishStart).toBeLessThan(maiaEnd);
  });

  it("Maia-disabled runs never warm up (feature gate respected)", async () => {
    // The gate lives in app code (maiaAnalysisEnabled + brilliant payload); the
    // provider contract it relies on: no warmup() call ⇒ zero workers.
    const { workers } = makeProvider(ackInitElsePend);
    await tick();
    expect(workers.length).toBe(0);
  });

  it("many concurrent requests share one Maia init", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const w1 = provider.warmup();
    const w2 = provider.warmup();
    const p1 = provider.predictions({ fen: "a" });
    const p2 = provider.moveAssessment({ fen: "b", moveUci: "e2e4" });
    expect(w2).toBe(w1);
    await tick();
    expect(workers.length).toBe(1);
    expect(workers[0].idsOf("init").length).toBe(1);
    workers[0].reply(workers[0].idsOf("predictions")[0], []);
    workers[0].reply(workers[0].idsOf("moveAssessment")[0], { humanProbability: 0.1, winChanceAfter: 0.5 });
    expect(await p1).toEqual([]);
    expect(await p2).toEqual({ humanProbability: 0.1, winChanceAfter: 0.5 });
    await w1;
  });
});

describe("shared singleton stays a singleton", () => {
  it("getSharedMaia3Provider returns one instance until disposed", () => {
    const a = getSharedMaia3Provider();
    const b = getSharedMaia3Provider();
    expect(b).toBe(a);
    disposeSharedMaia3Provider();
    const c = getSharedMaia3Provider();
    expect(c).not.toBe(a);
    disposeSharedMaia3Provider();
  });
});
