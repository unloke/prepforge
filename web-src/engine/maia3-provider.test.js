import { describe, it, expect } from "vitest";

import { MOVE_VOCAB } from "./maia3-tokenizer.js";
import { createMaia3Provider, resolveThreadCount, MAX_WASM_THREADS } from "./maia3-provider.js";

// The provider imports NO onnxruntime-web (only the worker does), so its request
// correlation + failure/recovery contract is unit-testable here against a FAKE worker —
// no browser, no ORT. Each test injects a `createWorker` factory and drives replies.

const validManifest = () => ({
  history: 8,
  token_dim: 97,
  include_time_info: false,
  io: { logits_move_dim: MOVE_VOCAB.length },
});

const tick = () => new Promise((r) => setTimeout(r, 0));

// A controllable stand-in for a real module Worker. `behavior(msg, worker)` runs (async)
// for each posted message; helpers reply()/crash() invoke the provider's handlers.
class FakeWorker {
  constructor(behavior) {
    this.behavior = behavior;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
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
  replyError(id, error) {
    this.onmessage && this.onmessage({ data: { id, ok: false, error } });
  }
  progress(id, data) {
    this.onmessage && this.onmessage({ data: { id, progress: true, ...data } });
  }
  crash(reason = "boom") {
    this.onerror && this.onerror({ message: reason, type: "error" });
  }
  terminate() {
    this.terminated = true;
  }
  // ids the provider posted for a given message type
  idsOf(type) {
    return this.posted.filter((m) => m.type === type).map((m) => m.id);
  }
}

// Factory that records every worker it creates and uses one shared behavior.
function trackedFactory(behavior) {
  const workers = [];
  return {
    workers,
    createWorker: () => {
      const w = new FakeWorker(behavior);
      workers.push(w);
      return w;
    },
  };
}

// Behavior: auto-ack init, leave every other request pending for the test to drive.
function ackInitElsePend(msg, worker) {
  if (msg.type === "init") worker.reply(msg.id, { backend: "wasm", file: "x.onnx", bytes: 1 });
}

function makeProvider(behavior, opts = {}) {
  const f = trackedFactory(behavior);
  const provider = createMaia3Provider({
    createWorker: f.createWorker,
    manifest: validManifest(),
    assetBase: "http://weights.test/",
    ...opts,
  });
  return { provider, workers: f.workers };
}

describe("init", () => {
  it("becomes available and passes assetBase + manifest to the worker", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    // kick init via a request we then satisfy
    const p = provider.predictions({ fen: "startpos" });
    await tick();
    const w = workers[0];
    const initMsg = w.posted.find((m) => m.type === "init");
    expect(initMsg.assetBase).toBe("http://weights.test/");
    expect(initMsg.manifest.token_dim).toBe(97);
    expect(provider.isAvailable()).toBe(true);
    // satisfy the predictions request
    w.reply(w.idsOf("predictions")[0], []);
    expect(await p).toEqual([]);
  });

  it("rejects via assertManifestContract on a drifting manifest (no worker spawned)", async () => {
    const f = trackedFactory(ackInitElsePend);
    const provider = createMaia3Provider({
      createWorker: f.createWorker,
      manifest: { ...validManifest(), token_dim: 96 },
      assetBase: "http://weights.test/",
    });
    await expect(provider.predictions({ fen: "x" })).rejects.toThrow(/token_dim/);
    expect(f.workers.length).toBe(0); // failed before creating a worker
    expect(provider.isAvailable()).toBe(false);
  });
});

describe("request correlation", () => {
  it("routes concurrent replies to the right Promise regardless of order", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const a = provider.moveAssessment({ fen: "f", moveUci: "a1a2" });
    const b = provider.moveAssessment({ fen: "f", moveUci: "b1b2" });
    await tick();
    const w = workers[0];
    const msgs = w.posted.filter((m) => m.type === "moveAssessment");
    expect(msgs.length).toBe(2);
    // reply in REVERSE post order, tagging each result with its move
    const byMove = Object.fromEntries(msgs.map((m) => [m.moveUci, m.id]));
    w.reply(byMove["b1b2"], { humanProbability: 0.2, winChanceAfter: 0.6 });
    w.reply(byMove["a1a2"], { humanProbability: 0.1, winChanceAfter: 0.5 });
    expect(await a).toEqual({ humanProbability: 0.1, winChanceAfter: 0.5 });
    expect(await b).toEqual({ humanProbability: 0.2, winChanceAfter: 0.6 });
  });
});

describe("single-request failure isolation", () => {
  it("rejects only the failing request; the worker stays usable", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const a = provider.predictions({ fen: "f1" });
    const b = provider.predictions({ fen: "f2" });
    await tick();
    const w = workers[0];
    const [idA, idB] = w.idsOf("predictions");
    w.replyError(idA, "inference blew up");
    w.reply(idB, [{ move_uci: "e2e4", probability: 1, rank: 1 }]);
    await expect(a).rejects.toThrow(/inference blew up/);
    expect(await b).toEqual([{ move_uci: "e2e4", probability: 1, rank: 1 }]);
    // provider not poisoned by the single error
    expect(provider.isAvailable()).toBe(true);
    const c = provider.predictions({ fen: "f3" });
    await tick();
    w.reply(w.idsOf("predictions")[2], []);
    expect(await c).toEqual([]);
    expect(workers.length).toBe(1); // no new worker spun up
  });
});

describe("worker crash", () => {
  it("rejects all pending, goes unavailable, and re-inits on the next call", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const inflight = provider.predictions({ fen: "f" });
    await tick();
    workers[0].crash("segfault");
    await expect(inflight).rejects.toThrow(/crashed: segfault/);
    expect(provider.isAvailable()).toBe(false);
    expect(workers[0].terminated).toBe(true);

    // Next call re-inits on a FRESH worker (retry after crash).
    const retry = provider.predictions({ fen: "f2" });
    await tick();
    expect(workers.length).toBe(2);
    const w2 = workers[1];
    w2.reply(w2.idsOf("predictions")[0], []);
    expect(await retry).toEqual([]);
    expect(provider.isAvailable()).toBe(true);
  });
});

describe("init failure is retryable", () => {
  it("rejects + goes unavailable, then re-inits successfully on the next call", async () => {
    let attempt = 0;
    const behavior = (msg, worker) => {
      if (msg.type === "init") {
        attempt += 1;
        if (attempt === 1) worker.replyError(msg.id, "sha256 mismatch");
        else worker.reply(msg.id, { backend: "wasm" });
      }
    };
    const { provider, workers } = makeProvider(behavior);
    await expect(provider.predictions({ fen: "f" })).rejects.toThrow(/sha256 mismatch/);
    expect(provider.isAvailable()).toBe(false);
    expect(workers[0].terminated).toBe(true);

    const retry = provider.predictions({ fen: "f" });
    await tick();
    expect(workers.length).toBe(2);
    const w2 = workers[1];
    w2.reply(w2.idsOf("predictions")[0], [{ move_uci: "d2d4", probability: 1, rank: 1 }]);
    expect(await retry).toEqual([{ move_uci: "d2d4", probability: 1, rank: 1 }]);
  });
});

describe("init timeout", () => {
  it("rejects on a stuck init, goes unavailable, terminates the worker, and re-inits next call", async () => {
    let attempt = 0;
    const behavior = (msg, worker) => {
      if (msg.type !== "init") return;
      attempt += 1;
      // First worker never acks init (a stuck fetch / wedged backend); the retry worker acks.
      if (attempt >= 2) worker.reply(msg.id, { backend: "wasm", file: "x.onnx", bytes: 1, url: "http://weights.test/x.onnx" });
    };
    const { provider, workers } = makeProvider(behavior, { initTimeoutMs: 20 });
    await expect(provider.predictions({ fen: "f" })).rejects.toThrow(/timed out/);
    expect(provider.isAvailable()).toBe(false);
    expect(workers[0].terminated).toBe(true); // stuck worker torn down, not leaked

    // Next call re-inits on a FRESH worker (timeout is retryable, not a permanent wedge).
    const retry = provider.predictions({ fen: "f2" });
    await tick();
    expect(workers.length).toBe(2);
    const w2 = workers[1];
    w2.reply(w2.idsOf("predictions")[0], []);
    expect(await retry).toEqual([]);
    expect(provider.isAvailable()).toBe(true);
  });

  it("ignores a late init reply from a worker that already timed out", async () => {
    let initCount = 0;
    let firstWorker = null;
    let firstInitId = null;
    const behavior = (msg, worker) => {
      if (msg.type !== "init") return;
      initCount += 1;
      if (initCount === 1) {
        // Worker #1: capture the init id but never reply now — let it time out.
        firstWorker = worker;
        firstInitId = msg.id;
      } else {
        worker.reply(msg.id, { backend: "wasm" }); // retry worker acks
      }
    };
    const { provider, workers } = makeProvider(behavior, { initTimeoutMs: 20 });
    await expect(provider.predictions({ fen: "f" })).rejects.toThrow(/timed out/);
    expect(provider.isAvailable()).toBe(false);
    expect(workers[0].terminated).toBe(true);

    // The timed-out worker now replies init OK LATE. Teardown nulled its handlers, so this
    // must be a no-op: it must NOT flip the provider back to ready (handler-lifecycle race).
    firstWorker.reply(firstInitId, { backend: "wasm" });
    await tick();
    expect(provider.isAvailable()).toBe(false);

    // A fresh call still re-inits cleanly on a NEW worker.
    const retry = provider.predictions({ fen: "f2" });
    await tick();
    expect(workers.length).toBe(2);
    const w2 = workers[1];
    w2.reply(w2.idsOf("predictions")[0], []);
    expect(await retry).toEqual([]);
    expect(provider.isAvailable()).toBe(true);
  });

  it("initTimeoutMs: 0 disables the timeout (init can take arbitrarily long)", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend, { initTimeoutMs: 0 });
    const p = provider.predictions({ fen: "f" });
    await new Promise((r) => setTimeout(r, 30)); // longer than any default would allow
    const w = workers[0];
    w.reply(w.idsOf("predictions")[0], []);
    expect(await p).toEqual([]);
    expect(provider.isAvailable()).toBe(true);
  });
});

describe("lastError diagnostics (Settings surfacing)", () => {
  it("is null before any failure and after a clean init", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    expect(provider.lastError).toBe(null);
    const p = provider.predictions({ fen: "startpos" });
    await tick();
    const w = workers[0];
    w.reply(w.idsOf("predictions")[0], []);
    await p;
    expect(provider.lastError).toBe(null);
  });

  it("records a worker-reported init failure (e.g. ORT / weight fetch) with phase init", async () => {
    const behavior = (msg, worker) => {
      if (msg.type === "init") worker.replyError(msg.id, "failed to fetch weights: 503");
    };
    const { provider } = makeProvider(behavior);
    await expect(provider.predictions({ fen: "f" })).rejects.toThrow(/failed to fetch weights/);
    expect(provider.lastError).toMatchObject({ phase: "init" });
    expect(provider.lastError.message).toMatch(/failed to fetch weights: 503/);
    expect(typeof provider.lastError.at).toBe("number");
  });

  it("records an init timeout with phase init", async () => {
    const { provider } = makeProvider((msg) => void msg, { initTimeoutMs: 20 });
    await expect(provider.predictions({ fen: "f" })).rejects.toThrow(/timed out/);
    expect(provider.lastError).toMatchObject({ phase: "init" });
    expect(provider.lastError.message).toMatch(/timed out/);
  });

  it("records a worker crash with phase crash", async () => {
    const { provider, workers } = makeProvider(ackInitElsePend);
    const inflight = provider.predictions({ fen: "f" });
    await tick();
    workers[0].crash("segfault");
    await expect(inflight).rejects.toThrow(/crashed/);
    expect(provider.lastError).toMatchObject({ phase: "crash" });
    expect(provider.lastError.message).toMatch(/segfault/);
  });

  it("clears lastError once a later init succeeds (retry recovers)", async () => {
    let attempt = 0;
    const behavior = (msg, worker) => {
      if (msg.type !== "init") return;
      attempt += 1;
      if (attempt === 1) worker.replyError(msg.id, "sha256 mismatch");
      else worker.reply(msg.id, { backend: "wasm" });
    };
    const { provider, workers } = makeProvider(behavior);
    await expect(provider.predictions({ fen: "f" })).rejects.toThrow(/sha256 mismatch/);
    expect(provider.lastError).not.toBe(null);
    const retry = provider.predictions({ fen: "f" });
    await tick();
    const w2 = workers[1];
    w2.reply(w2.idsOf("predictions")[0], []);
    await retry;
    expect(provider.lastError).toBe(null);
  });
});

describe("observable cross-origin seam", () => {
  it("exposes the resolved assetBase and the worker init result (incl. fetch url)", async () => {
    const { provider, workers } = makeProvider((msg, worker) => {
      if (msg.type === "init") worker.reply(msg.id, { backend: "wasm", file: "x.onnx", bytes: 7, url: "http://weights.test/x.onnx" });
    });
    const p = provider.predictions({ fen: "startpos" });
    await tick();
    const w = workers[0];
    w.reply(w.idsOf("predictions")[0], []);
    await p;
    expect(provider.assetBase).toBe("http://weights.test/");
    expect(provider.info).toMatchObject({ url: "http://weights.test/x.onnx", file: "x.onnx" });
  });
});

describe("init progress routing (Stage 4b)", () => {
  it("forwards init progress to the handler without settling init, then resolves on ok", async () => {
    const events = [];
    // Behavior: on init, emit cold-init progress phases, THEN reply ok.
    const behavior = (msg, worker) => {
      if (msg.type !== "init") return;
      worker.progress(msg.id, { phase: "download", loaded: 23, total: 46 });
      worker.progress(msg.id, { phase: "download", loaded: 46, total: 46 });
      worker.progress(msg.id, { phase: "verify", loaded: 0, total: 46 });
      worker.progress(msg.id, { phase: "session", loaded: 0, total: 46 });
      worker.reply(msg.id, { backend: "wasm", file: "x.onnx", bytes: 46, cached: false });
    };
    const { provider, workers } = makeProvider(behavior, {
      onInitProgress: (e) => events.push(e),
    });
    const p = provider.predictions({ fen: "startpos" });
    await tick();
    const w = workers[0];
    w.reply(w.idsOf("predictions")[0], []);
    expect(await p).toEqual([]);
    expect(provider.isAvailable()).toBe(true);
    expect(events).toEqual([
      { phase: "download", loaded: 23, total: 46 },
      { phase: "download", loaded: 46, total: 46 },
      { phase: "verify", loaded: 0, total: 46 },
      { phase: "session", loaded: 0, total: 46 },
    ]);
  });

  it("ignores a progress message for an already-settled id (no late handler call)", async () => {
    const events = [];
    let initId = null;
    let initWorker = null;
    const behavior = (msg, worker) => {
      if (msg.type !== "init") return;
      initId = msg.id;
      initWorker = worker;
      worker.reply(msg.id, { backend: "wasm" }); // settle immediately
    };
    const { provider } = makeProvider(behavior, { onInitProgress: (e) => events.push(e) });
    const p = provider.predictions({ fen: "f" });
    await tick();
    // A stray progress message arrives AFTER init already settled — must be a no-op.
    initWorker.progress(initId, { phase: "download", loaded: 1, total: 2 });
    expect(events).toEqual([]);
    void p;
  });

  it("setInitProgressHandler(null) detaches the handler", async () => {
    const events = [];
    const behavior = (msg, worker) => {
      if (msg.type !== "init") return;
      worker.progress(msg.id, { phase: "download", loaded: 1, total: 2 });
      worker.reply(msg.id, { backend: "wasm" });
    };
    const { provider } = makeProvider(behavior, { onInitProgress: (e) => events.push(e) });
    provider.setInitProgressHandler(null);
    const p = provider.predictions({ fen: "f" });
    await tick();
    expect(events).toEqual([]); // handler detached before init ran
    void p;
  });
});

describe("resolveThreadCount (Stage 4c)", () => {
  it("forces single-threaded without cross-origin isolation (no SharedArrayBuffer)", () => {
    expect(resolveThreadCount({ crossOriginIsolated: false, hardwareConcurrency: 16, requested: 8 })).toBe(1);
    expect(resolveThreadCount({ crossOriginIsolated: false, hardwareConcurrency: 16 })).toBe(1);
  });
  it("uses min(cores, ceiling) when isolated and no explicit request", () => {
    expect(resolveThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 2 })).toBe(2);
    expect(resolveThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 16 })).toBe(MAX_WASM_THREADS);
  });
  it("honours an explicit request, capped at the ceiling", () => {
    expect(resolveThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 16, requested: 2 })).toBe(2);
    expect(resolveThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 1, requested: 3 })).toBe(3);
    expect(resolveThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 16, requested: 99 })).toBe(MAX_WASM_THREADS);
  });
  it("falls back to 1 core when hardwareConcurrency is missing/bogus", () => {
    expect(resolveThreadCount({ crossOriginIsolated: true })).toBe(1);
    expect(resolveThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 0 })).toBe(1);
  });
});

describe("numThreads wiring in the init message (Stage 4c)", () => {
  const withCOI = (value, fn) => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, "crossOriginIsolated");
    const prev = globalThis.crossOriginIsolated;
    Object.defineProperty(globalThis, "crossOriginIsolated", { value, configurable: true, writable: true });
    return Promise.resolve(fn()).finally(() => {
      if (had) globalThis.crossOriginIsolated = prev;
      else delete globalThis.crossOriginIsolated;
    });
  };

  it("passes the resolved (capped) thread count to the worker for wasm under isolation", async () => {
    await withCOI(true, async () => {
      const { provider, workers } = makeProvider(ackInitElsePend, { backend: "wasm", numThreads: 2 });
      const p = provider.predictions({ fen: "startpos" });
      await tick();
      const initMsg = workers[0].posted.find((m) => m.type === "init");
      expect(initMsg.numThreads).toBe(2);
      workers[0].reply(workers[0].idsOf("predictions")[0], []);
      await p;
    });
  });

  it("forces 1 thread when the page is not cross-origin isolated", async () => {
    await withCOI(false, async () => {
      const { provider, workers } = makeProvider(ackInitElsePend, { backend: "wasm", numThreads: 4 });
      const p = provider.predictions({ fen: "startpos" });
      await tick();
      expect(workers[0].posted.find((m) => m.type === "init").numThreads).toBe(1);
      workers[0].reply(workers[0].idsOf("predictions")[0], []);
      await p;
    });
  });

  it("forces 1 thread for the webgpu backend (GPU EP doesn't use the WASM thread pool)", async () => {
    await withCOI(true, async () => {
      const { provider, workers } = makeProvider(ackInitElsePend, { backend: "webgpu", numThreads: 4 });
      const p = provider.predictions({ fen: "startpos" });
      await tick();
      expect(workers[0].posted.find((m) => m.type === "init").numThreads).toBe(1);
      workers[0].reply(workers[0].idsOf("predictions")[0], []);
      await p;
    });
  });
});

describe("terminal / illegal pass-through", () => {
  it("returns [] and null straight from the worker", async () => {
    const { provider, workers } = makeProvider((msg, worker) => {
      if (msg.type === "init") worker.reply(msg.id, {});
      else if (msg.type === "predictions") worker.reply(msg.id, []);
      else if (msg.type === "moveAssessment") worker.reply(msg.id, null);
      else if (msg.type === "moveAssessmentBatch") worker.reply(msg.id, [null, { humanProbability: 0.3, winChanceAfter: 0.7 }]);
    });
    expect(await provider.predictions({ fen: "terminal" })).toEqual([]);
    expect(await provider.moveAssessment({ fen: "f", moveUci: "zzzz" })).toBe(null);
    expect(await provider.moveAssessmentBatch({ fen: "f", moves: ["zzzz", "e2e4"] })).toEqual([
      null,
      { humanProbability: 0.3, winChanceAfter: 0.7 },
    ]);
    void workers;
  });
});
