// Phase 3b→3c provider LIVE harness (docs/browser-engine-migration.md).
//
// maia3-smoke.js creates ORT sessions on the MAIN thread, so it never exercises the
// production bundle path. This harness drives the REAL one: it imports the
// main-thread `maia3-provider`, which spawns the actual Web Worker via
// `new Worker(new URL("./maia3-worker.js", import.meta.url))` — the ONLY build path
// that emits a `maia3-worker` chunk with `onnxruntime-web` bundled INSIDE the worker.
// Running it once end-to-end proves the things the unit tests' fake worker can't reach:
//   • the worker chunk + ORT-in-worker resolve and boot,
//   • the asset base resolved on the page survives into the worker init message,
//   • the `.onnx` weight fetch + size/sha256 integrity gate pass in the worker,
//   • the request-id round trip (predictions / moveAssessment / batch) works, and
//   • concurrent requests don't cross wires.
//
// Numeric PARITY is already covered by maia3-smoke (browser EP vs Python CPU ref); here
// we only sanity-check that live worker output reproduces the committed reference for
// the symmetric-Elo golden positions, so a broken tokenizer/index→move mapping in the
// real bundle would still fail loudly.
import { createMaia3Provider } from "./maia3-provider.js";
import { moveFromIndex } from "./maia3-tokenizer.js";
import fixture from "./maia3-smoke-fixture.json";

const MANIFEST_URL = "/static/maia3/maia3.manifest.json";
// fp16 EP-vs-CPU policy-prob drift runs ~3e-3; match the manifest's 0.02 parity_tolerance.
const POLICY_PROB_TOL = 0.02;

// The provider takes ONE rating (worker feeds self_elo == oppo_elo), so only the
// fixture's symmetric-Elo cases are reproducible here; the asymmetric case (1900/1100)
// would feed different Elos than its reference was generated with.
function symmetricCases() {
  return fixture.cases
    .map((c, i) => ({ ...c, _index: i }))
    .filter((c) => c.self_elo === c.oppo_elo);
}

// Which reference block matches the artifact this backend will load (manifest
// backend_artifact[backend] → file → references[label]).
function referenceLabelForBackend(manifest, backend) {
  const file = manifest.backend_artifact && manifest.backend_artifact[backend];
  for (const [label, ref] of Object.entries(fixture.references || {}))
    if (ref.model_file === file) return label;
  return null;
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// A predictions() distribution must be non-empty, sorted descending, rank 1..n
// contiguous, and sum to ~1 over the legal moves.
function checkDistributionShape(preds) {
  const issues = [];
  if (!Array.isArray(preds) || preds.length === 0) {
    issues.push("empty / non-array predictions");
    return issues;
  }
  let sum = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i];
    if (typeof p.move_uci !== "string") issues.push(`pred[${i}] missing move_uci`);
    if (!(p.probability >= 0 && p.probability <= 1)) issues.push(`pred[${i}] prob out of [0,1]: ${p.probability}`);
    if (p.rank !== i + 1) issues.push(`pred[${i}] rank ${p.rank} != ${i + 1}`);
    if (i > 0 && p.probability > preds[i - 1].probability + 1e-9) issues.push(`pred[${i}] not sorted desc`);
    sum += p.probability;
  }
  if (!approx(sum, 1, 1e-3)) issues.push(`probabilities sum to ${sum.toFixed(5)} != 1`);
  return issues;
}

// Cross-check the live top move against this artifact's Python CPU reference: map the
// reference's top legal vocab index → uci in the board frame and compare to preds[0].
function checkAgainstReference(preds, ref, fen) {
  const issues = [];
  const top = ref.policy_top && ref.policy_top[0];
  if (!top) return ["reference has no policy_top"];
  const expectedUci = moveFromIndex(top.index, fen);
  if (preds[0].move_uci !== expectedUci)
    issues.push(`top move ${preds[0].move_uci} != ref ${expectedUci} (index ${top.index})`);
  if (!approx(preds[0].probability, top.prob, POLICY_PROB_TOL))
    issues.push(`top prob ${preds[0].probability.toFixed(5)} vs ref ${top.prob} > ${POLICY_PROB_TOL}`);
  return issues;
}

function record(checks, name, issues, detail) {
  checks.push({ name, ok: issues.length === 0, issues, detail });
}

// Was a runtime asset base injected into the page (the production CDN seam:
// server.py / the two-origin harness drop window.__MAIA3_ASSET_BASE before the modules
// run)? Local single-origin dev has none, so resolveModelBase falls back to same-origin.
function assetBaseInjected() {
  return typeof globalThis !== "undefined" && !!globalThis.__MAIA3_ASSET_BASE;
}

// Run the full battery against one backend's provider. Each check is isolated so one
// failure doesn't abort the rest; a thrown error becomes that check's failure.
// `requireCrossOrigin` (set by the two-origin harness via ?requireCrossOrigin=1) turns
// the cross-origin weight seam from "report-only" into a hard gate.
async function runBackend(backend, manifest, onProgress, requireCrossOrigin = false, requestedThreads = null) {
  const result = { backend, ok: false, checks: [], timings: {}, refLabel: null, numThreads: null };
  const refLabel = referenceLabelForBackend(manifest, backend);
  result.refLabel = refLabel;
  if (!refLabel) {
    result.checks.push({ name: "reference-label", ok: false, issues: [`no fixture reference matches backend_artifact.${backend}`] });
    return result;
  }
  const refs = fixture.references[refLabel];

  const provider = createMaia3Provider({ backend, numThreads: requestedThreads });
  const checks = result.checks;
  const guard = async (name, fn) => {
    try {
      const issues = (await fn()) || [];
      record(checks, name, issues);
    } catch (err) {
      record(checks, name, [String((err && err.message) || err)]);
    }
  };

  try {
    const cases = symmetricCases();

    // 1. init + predictions on every symmetric golden position. The FIRST call boots
    //    the worker: ORT load + weight fetch + sha256 gate + session create. A failure
    //    in any of those surfaces here as a rejected predictions() promise.
    onProgress(`[${backend}] init + predictions ...`);
    for (const c of cases) {
      const startedReady = provider.state;
      const t0 = performance.now();
      const preds = await provider.predictions({ fen: c.fen, rating: c.self_elo });
      const dt = +(performance.now() - t0).toFixed(1);
      if (startedReady !== "ready") result.timings.initMs = dt; // first call includes boot
      else (result.timings.predMs ||= []).push(dt);
      const issues = [
        ...checkDistributionShape(preds),
        ...checkAgainstReference(preds, refs.outputs[c._index], c.fen),
      ];
      record(checks, `predictions:${c.name}`, issues, { ms: dt, top: preds[0] && preds[0].move_uci });
    }
    record(checks, "state:ready-after-init", provider.state === "ready" ? [] : [`state=${provider.state}`]);

    // THREADED WASM (Stage 4c). The worker echoes the ORT WASM thread count it actually
    // applied (clamped to 1 without cross-origin isolation). When threading was requested
    // AND the page is crossOriginIsolated, the run must come up multi-threaded — a reported
    // 1 means SharedArrayBuffer / nested-worker threading silently failed to engage.
    {
      const applied = provider.info && provider.info.numThreads;
      result.numThreads = applied;
      const coi = typeof crossOriginIsolated !== "undefined" ? !!crossOriginIsolated : false;
      const issues = [];
      if (!Number.isInteger(applied)) issues.push("worker did not report numThreads");
      else if (backend === "wasm" && coi && Number.isInteger(requestedThreads) && requestedThreads > 1 && applied < 2)
        issues.push(`requested ${requestedThreads} threads under cross-origin isolation but only ${applied} applied`);
      record(checks, "wasm-threads", issues, { requested: requestedThreads, applied, crossOriginIsolated: coi });
    }

    // CROSS-ORIGIN WEIGHT SEAM (the gate this harness exists to close). The worker
    // echoes the URL it actually fetched the .onnx from. When the page injected an asset
    // base (production CDN seam / two-origin harness), that fetch MUST land on a
    // different origin than the app — proving window.__MAIA3_ASSET_BASE survived into the
    // worker and the weight GET happened on the CDN, not same-origin fallback. Without an
    // injected base (local dev) the fetch is legitimately same-origin, so we only assert
    // the URL is reported — unless ?requireCrossOrigin=1 demands the seam be exercised.
    {
      const injected = assetBaseInjected();
      const fetchUrl = provider.info && provider.info.url;
      const fetchOrigin = fetchUrl ? new URL(fetchUrl, location.href).origin : null;
      const crossOrigin = !!fetchOrigin && fetchOrigin !== location.origin;
      const issues = [];
      if (!fetchUrl) issues.push("worker did not report the weight fetch URL");
      if (requireCrossOrigin && !injected)
        issues.push("requireCrossOrigin set but no window.__MAIA3_ASSET_BASE was injected");
      if ((injected || requireCrossOrigin) && fetchUrl && !crossOrigin)
        issues.push(`weight fetched same-origin (${fetchUrl}); expected a cross-origin asset base`);
      record(checks, "cross-origin-weight-fetch", issues, {
        assetBaseInjected: injected,
        resolvedAssetBase: provider.assetBase,
        fetchUrl,
        fetchOrigin,
        appOrigin: location.origin,
        crossOrigin,
      });
    }

    // 2. moveAssessment — legal move yields { humanProbability, winChanceAfter } in [0,1].
    await guard("moveAssessment:e2e4-legal", async () => {
      const a = await provider.moveAssessment({ fen: cases[0].fen, moveUci: "e2e4", rating: 1500 });
      if (!a) return ["returned null for a legal move"];
      const iss = [];
      if (!(a.humanProbability >= 0 && a.humanProbability <= 1)) iss.push(`humanProbability ${a.humanProbability} out of [0,1]`);
      if (!(a.winChanceAfter >= 0 && a.winChanceAfter <= 1)) iss.push(`winChanceAfter ${a.winChanceAfter} out of [0,1]`);
      result.timings.assessSample = a;
      return iss;
    });

    // 3. moveAssessment — illegal move is null with NO forward (contract).
    await guard("moveAssessment:e2e5-illegal", async () => {
      const a = await provider.moveAssessment({ fen: cases[0].fen, moveUci: "e2e5", rating: 1500 });
      return a === null ? [] : [`expected null, got ${JSON.stringify(a)}`];
    });

    // 4. moveAssessmentBatch — order preserved, illegal slot null, legal slots scored;
    //    the legal slot's humanProbability must match the single-call path (shared
    //    policy forward = same math).
    await guard("moveAssessmentBatch:mixed", async () => {
      const moves = ["e2e4", "d2d4", "e2e5"]; // last is illegal
      const t0 = performance.now();
      const out = await provider.moveAssessmentBatch({ fen: cases[0].fen, moves, rating: 1500 });
      result.timings.batchMs = +(performance.now() - t0).toFixed(1);
      const iss = [];
      if (out.length !== 3) iss.push(`length ${out.length} != 3`);
      if (out[2] !== null) iss.push(`illegal slot not null: ${JSON.stringify(out[2])}`);
      for (const k of [0, 1]) {
        if (!out[k]) { iss.push(`legal slot ${k} null`); continue; }
        if (!(out[k].humanProbability >= 0 && out[k].humanProbability <= 1)) iss.push(`slot ${k} humanProbability out of range`);
        if (!(out[k].winChanceAfter >= 0 && out[k].winChanceAfter <= 1)) iss.push(`slot ${k} winChanceAfter out of range`);
      }
      const single = result.timings.assessSample;
      if (out[0] && single && !approx(out[0].humanProbability, single.humanProbability, 1e-4))
        iss.push(`batch e2e4 humanProbability ${out[0].humanProbability} != single ${single.humanProbability}`);
      return iss;
    });

    // 5. moveAssessmentBatch — all-illegal returns all-null (and, per the Phase 3c fix,
    //    spends ZERO inference: legal filtering happens before the policy forward).
    await guard("moveAssessmentBatch:all-illegal", async () => {
      const out = await provider.moveAssessmentBatch({ fen: cases[0].fen, moves: ["e2e5", "a1a8"], rating: 1500 });
      return out.length === 2 && out[0] === null && out[1] === null ? [] : [`expected [null,null], got ${JSON.stringify(out)}`];
    });

    // 6. Request correlation — fire two different requests concurrently; ids must not
    //    cross (predictions stays a distribution, batch stays an aligned array).
    await guard("concurrency:no-cross-wires", async () => {
      const [preds, batch] = await Promise.all([
        provider.predictions({ fen: cases[0].fen, rating: cases[0].self_elo }),
        provider.moveAssessmentBatch({ fen: cases[0].fen, moves: ["e2e4", "d2d4"], rating: 1500 }),
      ]);
      const iss = [];
      if (!Array.isArray(preds) || preds.length === 0 || typeof preds[0].move_uci !== "string")
        iss.push("predictions reply malformed (possible id cross-wire)");
      if (!Array.isArray(batch) || batch.length !== 2 || !batch[0] || !batch[1])
        iss.push("batch reply malformed (possible id cross-wire)");
      return iss;
    });
  } finally {
    provider.terminate();
  }

  result.ok = checks.every((c) => c.ok);
  return result;
}

export async function runHarness(onProgress = () => {}) {
  const report = {
    startedAt: new Date().toISOString(),
    webgpuAvailable: typeof navigator !== "undefined" && !!navigator.gpu,
    crossOriginIsolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : null,
    backends: [],
  };

  const manifest = await (await fetch(MANIFEST_URL)).json();
  report.assetBaseInjected = assetBaseInjected();

  const params = new URLSearchParams(location.search);
  // ?requireCrossOrigin=1 (set by the two-origin CDN harness) makes the cross-origin
  // weight seam a hard gate: the run fails unless an asset base was injected AND the
  // worker fetched the .onnx from a different origin than the app.
  const requireCrossOrigin = params.get("requireCrossOrigin") === "1";
  report.requireCrossOrigin = requireCrossOrigin;

  // ?threads=N (Stage 4c) requests N ORT WASM worker threads; the provider clamps it to its
  // ceiling and to 1 without cross-origin isolation. Default null = auto (page capabilities).
  const threadsRaw = params.get("threads");
  const requestedThreads = threadsRaw != null && /^\d+$/.test(threadsRaw) ? Number(threadsRaw) : null;
  report.requestedThreads = requestedThreads;

  // ?backend=wasm|webgpu|all — default wasm only (the smoke's WASM-beats-WebGPU
  // finding makes WASM the production default; "all" also boots a WebGPU worker).
  const want = params.get("backend") || "wasm";
  const backends = want === "all" ? ["wasm", "webgpu"] : [want];

  for (const backend of backends) {
    if (backend === "webgpu" && !report.webgpuAvailable) {
      report.backends.push({ backend, ok: false, skipped: true, checks: [{ name: "webgpu-available", ok: false, issues: ["navigator.gpu unavailable"] }] });
      continue;
    }
    onProgress(`running backend "${backend}" ...`);
    report.backends.push(await runBackend(backend, manifest, onProgress, requireCrossOrigin, requestedThreads));
  }

  report.ok = report.backends.length > 0 && report.backends.every((b) => b.ok);
  report.finishedAt = new Date().toISOString();
  return report;
}
