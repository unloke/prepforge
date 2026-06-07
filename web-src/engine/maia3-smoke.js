// Phase 3b smoke test (docs/browser-engine-migration.md).
//
// Loads the shipped Maia3 artifacts on each onnxruntime-web execution provider
// (WASM CPU + WebGPU), runs one inference per (artifact × EP), verifies output
// shapes and rough numeric agreement against the Python CPU-EP reference fixture,
// and measures session-create + inference latency. The point is to FINALIZE the
// manifest's provisional backend_artifact map (fp16-for-both was a CPU-EP guess)
// with real browser evidence.
//
// Runs on the main thread (a smoke harness, not the production path); the
// production provider will move this into maia3-worker.js. Single-threaded wasm
// (numThreads=1) so it works under the Vite dev server, which doesn't send the
// COOP/COEP headers threaded wasm needs (the Python server does).
import * as ort from "onnxruntime-web/webgpu";
import fixture from "./maia3-smoke-fixture.json";
import { assertManifestContract } from "./maia3-tokenizer.js";

ort.env.wasm.wasmPaths = "/static/engine/ort/";
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

// The manifest is small and tracked, so it always ships in-image at /static/maia3/.
// The ONNX weights are CDN/object-store hosted (never in the image), so the weight
// base URL is resolved at RUNTIME — our deploy commits the built static and has no
// Node, so a build-time-only VITE var can't point a deployed bundle at a CDN. See
// resolveModelBase().
const MANIFEST_URL = "/static/maia3/maia3.manifest.json";
const WARM_RUNS = 5;
// logits_value is a 3-vector ~[-3,3]; fp16 vs fp32-CPU-ref should agree well
// within this. Looser than the 0.02 export tol because we're crossing EPs.
const VALUE_TOL = 0.05;
// Legal-masked policy probability agreement (browser EP vs this artifact's CPU ref).
// Matches the manifest's 0.02 parity_tolerance; fp16 EP-vs-CPU Δprob runs ~3e-3.
const POLICY_PROB_TOL = 0.02;

// Resolve the weight base URL at RUNTIME (no rebuild / no Node at deploy). First
// match wins:
//   1. globalThis.__MAIA3_ASSET_BASE — runtime global the server/ops inject into the
//      page (e.g. <script>window.__MAIA3_ASSET_BASE="https://cdn/maia3/"</script>
//      rendered from an env var). Lets a committed-static deploy point at a CDN with
//      no rebuild — this is the production knob.
//   2. manifest.asset_base — optional field in the in-image manifest (fetched at
//      runtime, hand-editable JSON; also Node-free).
//   3. import.meta.env.VITE_MAIA3_ASSET_BASE — build-time default, when Vite builds.
//   4. "/static/maia3/" — local dev, where a developer's git-ignored weights sit.
// A clean clone / Docker deploy has NO weights under /static/maia3/, so production
// MUST set (1) or (2) to a host that serves the .onnx.
//
// MAIN-THREAD ONLY: source (1) is `window.__MAIA3_ASSET_BASE`, which a Web Worker's
// separate `globalThis` cannot see. The Phase 3b worker provider must therefore call
// this on the PAGE and pass the resolved base into the worker's init message
// (`{ type: "init", assetBase }`) — a worker resolving it itself would always miss
// the injected global and fall back to /static/maia3/ (404 in the deploy image). See
// the Phase 3b worker-init contract in docs/browser-engine-migration.md.
function resolveModelBase(manifest) {
  const fromGlobal =
    typeof globalThis !== "undefined" ? globalThis.__MAIA3_ASSET_BASE : undefined;
  const base =
    fromGlobal ||
    (manifest && manifest.asset_base) ||
    import.meta.env?.VITE_MAIA3_ASSET_BASE ||
    "/static/maia3/";
  return String(base).replace(/\/?$/, "/");
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Legal-masked softmax over only the legal logit indices — identical to masking the
// full vector to -inf and softmaxing (the backend path), but the fixture hands us the
// legal indices so the browser never re-derives the tokenizer/index->move mapping.
function legalMaskedProbs(logitsMove, legalIndices) {
  let max = -Infinity;
  for (const i of legalIndices) if (logitsMove[i] > max) max = logitsMove[i];
  const ex = legalIndices.map((i) => Math.exp(logitsMove[i] - max));
  const sum = ex.reduce((a, b) => a + b, 0);
  const probByIndex = new Map();
  legalIndices.forEach((i, k) => probByIndex.set(i, ex[k] / sum));
  return probByIndex;
}

// Set of legal indices whose legal-masked prob >= threshold. Mirrors Build Generate's
// keep rule exactly (sorted-desc, break on prob < threshold => keep {prob >= t}).
function keptSet(probByIndex, threshold) {
  const kept = [];
  for (const [i, p] of probByIndex) if (p >= threshold) kept.push(i);
  return kept.sort((a, b) => a - b);
}

function sameIntSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function feedsFor(testCase) {
  const [b, s, t] = testCase.token_shape;
  return {
    tokens: new ort.Tensor("float32", Float32Array.from(testCase.tokens), [b, s, t]),
    self_elos: new ort.Tensor("int64", BigInt64Array.from([BigInt(testCase.self_elo)]), [1]),
    oppo_elos: new ort.Tensor("int64", BigInt64Array.from([BigInt(testCase.oppo_elo)]), [1]),
  };
}

function argmax(arr) {
  let bi = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  return bi;
}

// Compare one browser inference against THIS artifact's own CPU-EP reference
// output (expected = fixture.references[label].outputs[caseIndex]). Validates the
// value head, the raw-logit argmax, AND — the part Build Generate actually depends
// on — the legal-masked policy probabilities and the 10%/30% kept-move SETS. fp16
// has a known low-but-nonzero threshold-flip rate, so a top-1-only check would pass
// even if a non-top-1 move crossed a branch threshold under WASM/WebGPU.
function compareToReference(expected, testCase, logitsMove, logitsValue) {
  const issues = [];
  if (logitsMove.length !== fixture.logits_move_dim)
    issues.push(`logits_move length ${logitsMove.length} != ${fixture.logits_move_dim}`);
  if (logitsValue.length !== fixture.logits_value_dim)
    issues.push(`logits_value length ${logitsValue.length} != ${fixture.logits_value_dim}`);

  let maxValueDiff = 0;
  for (let i = 0; i < expected.logits_value.length; i++)
    maxValueDiff = Math.max(maxValueDiff, Math.abs(logitsValue[i] - expected.logits_value[i]));
  if (maxValueDiff > VALUE_TOL)
    issues.push(`max value-logit diff ${maxValueDiff.toFixed(4)} > ${VALUE_TOL}`);

  const refTop1 = expected.logits_move_top[0].index;
  const gotTop1 = argmax(logitsMove);
  if (gotTop1 !== refTop1) issues.push(`raw-logit top1 ${gotTop1} != ref ${refTop1}`);

  // --- Legal-masked policy parity (Build Generate behavior) -------------------
  const probByIndex = legalMaskedProbs(logitsMove, testCase.legal_indices);

  // Per-move probability agreement at the reference's top legal moves.
  let maxPolicyDiff = 0;
  for (const { index, prob } of expected.policy_top)
    maxPolicyDiff = Math.max(maxPolicyDiff, Math.abs((probByIndex.get(index) ?? 0) - prob));
  if (maxPolicyDiff > POLICY_PROB_TOL)
    issues.push(`max policy-prob diff ${maxPolicyDiff.toFixed(4)} > ${POLICY_PROB_TOL}`);

  // Legal top-1 move must match the reference's.
  const refPolicyTop1 = expected.policy_top[0].index;
  let gotPolicyTop1 = -1;
  let best = -Infinity;
  for (const [i, p] of probByIndex) if (p > best) ((best = p), (gotPolicyTop1 = i));
  if (gotPolicyTop1 !== refPolicyTop1)
    issues.push(`legal top1 ${gotPolicyTop1} != ref ${refPolicyTop1}`);

  // The 10%/30% kept-move SETS Build Generate branches on must match exactly.
  const kept10 = keptSet(probByIndex, fixture.thresholds.mainline);
  const kept30 = keptSet(probByIndex, fixture.thresholds.branch);
  if (!sameIntSet(kept10, expected.kept_10))
    issues.push(`kept@${fixture.thresholds.mainline} [${kept10}] != ref [${expected.kept_10}]`);
  if (!sameIntSet(kept30, expected.kept_30))
    issues.push(`kept@${fixture.thresholds.branch} [${kept30}] != ref [${expected.kept_30}]`);

  return {
    maxValueDiff,
    maxPolicyDiff,
    refTop1,
    gotTop1,
    top1Match: gotTop1 === refTop1,
    policyTop1Match: gotPolicyTop1 === refPolicyTop1,
    kept10,
    kept30,
    issues,
  };
}

// Verify the fixture's reference for this artifact still matches the manifest
// (file + sha256). A stale fixture makes the numeric comparison meaningless, so a
// mismatch is a hard failure for the combo — not a soft warning that can still
// report "OK".
function referenceMismatch(label, manifest) {
  const ref = fixture.references && fixture.references[label];
  if (!ref) return `fixture has no reference for artifact "${label}"`;
  const art = manifest.artifacts && manifest.artifacts[label];
  if (!art) return `manifest has no artifact "${label}"`;
  if (ref.model_file !== art.file)
    return `fixture[${label}] model_file ${ref.model_file} != manifest ${art.file}`;
  if (ref.model_sha256 !== art.sha256)
    return `fixture[${label}] sha256 ${ref.model_sha256} != manifest ${art.sha256}`;
  return null;
}

async function runCombo(epName, modelBytes, label, manifest) {
  const result = { ep: epName, label, model: (manifest.artifacts[label] || {}).file, ok: false };

  // Stale-fixture gate: skip inference entirely — comparing against a reference
  // that no longer matches the shipped artifact would be noise, not validation.
  const mismatch = referenceMismatch(label, manifest);
  if (mismatch) {
    result.error = `fixture mismatch: ${mismatch}`;
    result.skipped = true;
    return result;
  }
  const ref = fixture.references[label];

  try {
    const tCreate0 = performance.now();
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: [epName],
      graphOptimizationLevel: "all",
    });
    result.createMs = +(performance.now() - tCreate0).toFixed(1);

    const cases = [];
    let firstMs = 0;
    const latencies = [];
    for (let c = 0; c < fixture.cases.length; c++) {
      const tc = fixture.cases[c];
      const feeds = feedsFor(tc);
      const t0 = performance.now();
      const out = await session.run(feeds);
      const dt = performance.now() - t0;
      if (c === 0) firstMs = dt;
      const lm = out.logits_move.data;
      const lv = out.logits_value.data;
      const cmp = compareToReference(ref.outputs[c], tc, lm, lv);
      cases.push({ name: tc.name, ...cmp });
      // warm latency: re-run the first case a few times
      if (c === 0) {
        for (let w = 0; w < WARM_RUNS; w++) {
          const w0 = performance.now();
          await session.run(feeds);
          latencies.push(performance.now() - w0);
        }
      }
    }
    latencies.sort((a, b) => a - b);
    result.firstInferMs = +firstMs.toFixed(1);
    result.warmMedianMs = +latencies[Math.floor(latencies.length / 2)].toFixed(1);
    result.cases = cases;
    result.ok = cases.every((c) => c.issues.length === 0);
    if (typeof session.release === "function") await session.release();
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  }
  return result;
}

export async function runSmoke(onProgress = () => {}) {
  const report = {
    startedAt: new Date().toISOString(),
    webgpuAvailable: typeof navigator !== "undefined" && !!navigator.gpu,
    crossOriginIsolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : null,
    // This harness pins single-threaded WASM (see top of file) so it runs under the
    // header-less Vite dev server. It therefore validates only the single-threaded
    // runtime; the threaded WASM the production worker will use (needs COOP/COEP) is
    // out of scope here and must be validated separately in the Phase 3b worker.
    wasmNumThreads: ort.env.wasm.numThreads,
    fixtureReferences: fixture.references ? Object.keys(fixture.references) : [],
    warnings: [],
    combos: [],
  };

  const manifest = await (await fetch(MANIFEST_URL)).json();
  // Contract gate: the tokenizer's hardwired layout (history / token_dim / time
  // info / policy dim) must match the runtime manifest before we trust any token
  // shape or legal mask. Throws (caught by the page's FATAL handler) on drift.
  assertManifestContract(manifest);
  report.manifestContractOK = true;
  report.manifestBackendArtifact = manifest.backend_artifact;
  const MODEL_BASE = resolveModelBase(manifest);
  report.modelBase = MODEL_BASE;

  // Per-artifact stale-fixture check: each reference must still match the manifest
  // artifact it was generated from. runCombo enforces this as a hard per-combo
  // failure too; this top-level pass surfaces it up front for the summary.
  for (const label of Object.keys(manifest.artifacts || {})) {
    const mismatch = referenceMismatch(label, manifest);
    if (mismatch) report.warnings.push(mismatch);
  }
  report.fixtureMatchesManifest = report.warnings.length === 0;

  // Hard-stop on a stale fixture BEFORE downloading: a mismatched reference makes
  // every numeric comparison meaningless, so there's nothing worth the up-to-137 MB
  // of weight downloads. (runCombo also gates per-combo, but that's after the fetch.)
  if (!report.fixtureMatchesManifest) {
    onProgress("stale fixture — skipping downloads");
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // Load each distinct artifact once (download), then create a session per EP.
  const artifacts = {};
  for (const label of ["fp16", "fp32"]) {
    const entry = manifest.artifacts[label];
    if (!entry) continue;
    onProgress(`fetching ${entry.file} (${(entry.bytes / 1e6).toFixed(1)} MB) ...`);
    const t0 = performance.now();
    const resp = await fetch(MODEL_BASE + entry.file);
    if (!resp.ok) {
      // A default build has the weights CDN-hosted, so MODEL_BASE falls back to the
      // in-image /static/maia3/, which has no .onnx → 404 here. Fail loudly with the
      // fix instead of a cryptic ORT parse error.
      throw new Error(
        `weight fetch ${resp.status} for ${MODEL_BASE + entry.file}. The ONNX weights ` +
          `are not under "${MODEL_BASE}". Point the runtime at a host that serves them: ` +
          `set globalThis.__MAIA3_ASSET_BASE (or "asset_base" in the manifest) to a ` +
          `CDN/object store, or a local dir holding the git-ignored weights. No rebuild ` +
          `needed — the base is resolved at runtime.`,
      );
    }
    const buf = await resp.arrayBuffer();

    // Integrity gate: the manifest is the source of truth. A CDN can serve a stale,
    // truncated, or wrong-precision artifact while still returning 200, which would
    // silently invalidate every comparison below — so verify size AND sha256 before
    // building a session, and refuse on mismatch.
    if (buf.byteLength !== entry.bytes) {
      throw new Error(
        `size mismatch for ${entry.file}: served ${buf.byteLength} B != manifest ` +
          `${entry.bytes} B (${MODEL_BASE}). Refusing to run inference.`,
      );
    }
    const gotSha = await sha256Hex(buf);
    if (gotSha !== entry.sha256) {
      throw new Error(
        `sha256 mismatch for ${entry.file}: served ${gotSha} != manifest ${entry.sha256} ` +
          `(${MODEL_BASE}). The CDN artifact does not match the shipped manifest — ` +
          `refusing to run inference.`,
      );
    }
    artifacts[label] = { file: entry.file, bytes: entry.bytes, buf, fetchMs: +(performance.now() - t0).toFixed(1) };
  }

  const eps = ["wasm"];
  if (report.webgpuAvailable) eps.push("webgpu");

  for (const label of Object.keys(artifacts)) {
    const a = artifacts[label];
    for (const ep of eps) {
      onProgress(`running ${label} on ${ep} ...`);
      const r = await runCombo(ep, a.buf, label, manifest);
      r.modelBytes = a.bytes;
      r.fetchMs = a.fetchMs;
      report.combos.push(r);
    }
  }

  report.heapUsedMB =
    performance.memory && performance.memory.usedJSHeapSize
      ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1)
      : null;
  report.finishedAt = new Date().toISOString();
  return report;
}
