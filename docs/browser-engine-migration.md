# Browser-Engine Migration Plan

Goal: move Stockfish/Maia compute from server to browser so the public multi-user version can scale.

Target: public multi-user web app, frontend built with npm + Vite.

## HARD PRODUCT RULE (overrides everything below)

**All chess-engine compute MUST run in the user's browser. The server must NEVER
run engine compute in the public/default flow, and there is NO automatic
fallback to a server engine.** If the browser engine is unavailable, the UI
shows an actionable error (unsupported browser / COOP-COEP) — it does not quietly
use the server.

The server engine APIs (`/api/engine/*`, `/api/analyze/*`, `/api/build/generate/*`,
installs) remain in the codebase **only** for a future server/admin mode, gated
behind `PREPFORGE_SERVER_ENGINE_ENABLED` (**default off** → 403). Any mention of
"fallback"/"optional server engine" below is historical and subordinate to this rule.

## Locked Decisions

- Deployment: public multi-user web app.
- Bundler: Vite.
- Stockfish: **nmrugg `stockfish`@18.0.7** `stockfish-18-lite` (browser WASM). (The
  Lichess build was evaluated but is harder to integrate; revisit for net-size
  switching later.)
- Maia: Maia3 in browser via ONNX, mirroring MaiaChess.
- Maia runtime: choose fastest available backend at runtime:
  - try WebGPU when available and stable,
  - otherwise use ORT Web WASM/SIMD/threaded.
- Maia artifacts: do **not** use one int8-for-all. Per-backend selection by the
  provider. **Phase 3a (2026-06-04):** int8 is overturned — behavioral parity
  shows int8 (even per-channel) flips Build Generate's 10%/30% branch thresholds,
  so it's experimental opt-in only. Current plan ships **`maia3-fp16.onnx` (44 MB)
  for both WebGPU and WASM**, but this is **PROVISIONAL** — decided on the Python
  CPU EP; Phase 3b must confirm fp16 loads + performs on `onnxruntime-web` WASM
  (where fp16 may be slower/heavier than fp32) and WebGPU before it's final.
- Tenancy: in scope. Public launch requires per-user isolation + auth.
- Asset hosting: self-host wasm/nnue/onnx.
- Licensing: deferred for prototype; must be reviewed before public release.

---

## Current State

All engine compute currently runs server-side in `src/prepforge_chess/web/server.py`.

| Feature | Current path | Engine |
|---|---|---|
| Engine widget | `/api/engine/open/update/snapshot/pause/close` | Server Stockfish |
| Analyze | `/api/analyze/pgn/start` + status polling | Server Stockfish + server Maia3 if installed |
| Build Generate | `/api/build/generate/start` + status polling | Server Stockfish + Maia3 |
| Brilliant detection | inside Analyze | Maia3 + Stockfish evals |
| Train | `/api/train/*` | No engine |

Deployment today:
- Single Docker container.
- Single global SQLite DB.
- No auth.
- No user isolation.
- Lichess OAuth token is global.
- Docker installs Stockfish only; Maia3 is not available in deployed Docker.
- `ThreadingHTTPServer` is acceptable for local use, weak for public multi-user.

Implication:
- Compute migration and tenancy are separate but both required.
- Browser engines solve server CPU cost.
- User isolation solves public data safety.

---

## Target Architecture

Browser per user:
- `EngineProvider` JS interface
- `StockfishWasmProvider`
  - Web Worker
  - Stockfish WASM
  - NNUE asset
  - UCI protocol
- `Maia3Provider`
  - Web Worker
  - `onnxruntime-web`
  - Maia3 ONNX model
  - IndexedDB/cache
  - fastest viable backend selected at runtime
- `AdminServerEngineProvider` (`web-src/engine/admin-server-provider.js`, `createAdminServerEngineProvider`)
  - future/admin mode ONLY (PREPFORGE_SERVER_ENGINE_ENABLED); never used in the public flow, no auto-fallback

Server shared:
- Auth/session
- Per-user data
- Per-user Lichess OAuth
- Repertoire/progress/analysis storage
- Analysis save/classification endpoints
- Server engine APIs exist for future/admin mode only (default off); not a public-flow fallback

Assets:
- self-host `.wasm`, `.nnue`, `.onnx`, worker files
- cache large engine/model assets in browser

Headers:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Acceptance requirement:
- `crossOriginIsolated === true`
- Stockfish worker loads
- Maia worker loads
- wasm/onnx assets load with correct MIME/content headers

---

## Maia3 Browser Plan

Use MaiaChess as the reference implementation.

Observed in MaiaChess frontend:
- `public/maia3/maia3_simplified.onnx`
- model size about 45.7 MB
- `MaiaEngineContext.tsx` loads `/maia3/maia3_simplified.onnx`
- `maia.ts` exposes `evaluateMaia3` / `batchEvaluateMaia3`
- `maia-worker.js` runs ONNX inference off the main thread
- model is cached in IndexedDB

Implementation strategy:
- mirror/adapt their Maia3 worker and board encoding approach
- do not re-derive ONNX export/tokenization first
- verify our board encoding, legal move mapping, policy output, and value output match our builder needs
- choose backend by measured capability:
  - WebGPU if available and faster/stable
  - ORT Web WASM/SIMD/threaded otherwise

Important:
- Server-side Maia3 is NOT a fallback; browser Maia3 only (server Maia stays admin-mode only).
- Current Docker does not include Maia3.
- Do not depend on server Maia3 for the first browser prototype.

---

## Phase 0: Foundations

No behavior change.

**Status (2026-06-03) — implemented & verified locally, NOT yet committed/pushed (`server.py` + static files still show as modified in `git status`; this doc is untracked).**
- [x] **COOP/COEP/CORP headers** — added to every response via an `end_headers` override in `server.py`. Verified `crossOriginIsolated === true`, no COEP violations. Auth mechanism for the later tenancy track = **session cookie** (decided).
- [x] **Generic static serving** — `/static/*` serves any file under `STATIC_DIR` with correct MIME (incl. `.wasm`/`.onnx`/workers), path-traversal guard. Subsumes the old explicit `app.js`/`styles.css` routes.
- [x] **Static serving moved OUT of the global `request_lock`** — `do_GET` handles `/` and `/static/*` before acquiring the lock, so a large/slow asset download (e.g. ~45 MB Maia ONNX) no longer blocks concurrent API/static requests. Verified: API latency stays ~3 ms under 8 concurrent static reads.
- [x] **`_send_file` streams in 64 KB chunks** (was `read_bytes()`), so a download no longer loads the whole asset into RAM per connection. Verified byte-identical 5 MB download. Caveat: still the stdlib handler — no HTTP range requests / `sendfile`; not production-grade large-file serving. For public scale, offload `.onnx/.wasm/.nnue` to a CDN / object store (tracked for Phase 3 / infra).
- [x] **Cache-Control** — `.wasm/.onnx/.nnue` and filenames matching a Vite content-hash pattern (`-[hash8+].ext`) → `public, max-age=31536000, immutable`; everything else — non-hashed files under `assets/` (icons, metadata) and the app shell — → `no-cache`. Rule narrowed from the earlier `"assets" in path.parts`. Verified hashed vs short-hash vs `icon.png`.
- [x] 7/7 web tests pass after the refactor.
- [x] **Vite + `web-src/` restructure** — Node 24 / npm 11 installed (`C:\Program Files\nodejs`). Sources moved to `web-src/` (`index.html`, `app.js`, `styles.css`); `app.js` is now an ES-module entry (`<script type="module">`) importing `./styles.css`. `vite.config.js`: `root: web-src`, `base: /static/`, `outDir → src/prepforge_chess/web/static`, sourcemaps on; `npm run build` emits hashed `assets/*` + `index.html`. Build output is **committed** (deploy image runs `pip install .` with no Node — Docker build-stage is a later follow-up). Verified: built app renders identically, `crossOriginIsolated === true`, 0 console errors, the 4707-line module conversion is clean.
- [x] **Live-engine (widget) provider seam** — `web-src/engine/provider.js` defines the interface (`open/update/snapshot/close` → snapshot) and `createServerEngineProvider({api, postJson})`. `EngineWidget` now delegates all 5 `/api/engine/*` calls through `this.engine`. Verified live: widget reaches depth 16/16 with real PVs through the provider. Phase 1 swaps in `StockfishWasmProvider` with the same interface — no UI change. **Scope note:** this abstracts only the *live engine widget*. **Analyze (`/api/analyze/*`) and Build (`/api/build/generate/*`) still call the server directly** — their provider seams (a per-ply analysis path, Maia-backed build) come in Phase 2 / Phase 3, not here.
- [x] **`pyproject` package-data** — added `static/assets/*` (the flat `static/*` glob does not match the nested Vite bundles). Verified a clean `python -m build` wheel ships `index.html` + `assets/{js,map,css}`.

**Phase 0 is functionally complete.** 108/108 tests pass.

**Toolchain / build workflow:**
- Node **24.16.0** / npm **11.13.0** installed at `C:\Program Files\nodejs` (not added to PATH automatically — prepend it per shell). This is *not* an LTS line; Node 22 LTS is the safer pin if stability matters later.
- Frontend changes live in `web-src/`. After editing, you **must** rebuild and commit both source and output, or they drift:
  ```
  npm run build
  git add web-src src/prepforge_chess/web/static
  ```
- Dev: `npm run dev` (Vite HMR at `/static/`, `/api`+`/oauth` proxied to :8765) or `npm run build:watch`.
- Follow-up: a Dockerfile Node multi-stage build would let us stop committing build output.

**Phase 0 acceptance — outstanding checks:**
- [ ] **Lichess connect still completes after COOP severs the popup opener/postMessage** (rely on the `/api/lichess/status` poll fallback). Needs a real connect test — not covered by `crossOriginIsolated === true` alone.

**Prerequisite carried into Phase 3 (public scale):** the stdlib `ThreadingHTTPServer` should not stream large engine/model assets in production even off-lock — offload `.onnx/.wasm/.nnue` to Render static / CDN / object storage (or front with nginx). Tracked under the ASGI/infra work.

Tasks:
- Add `package.json`.
- Add Vite.
- Move frontend source to `web-src/`.
- Build output to Python-served static directory.
- Keep Python server serving static build.
- Add COOP/COEP headers.
- Add `EngineProvider` interface.
- Wrap current server APIs as `AdminServerEngineProvider` (admin-only; renamed from `ServerEngineProvider`).

Acceptance:
- UI works exactly as today.
- Existing tests pass.
- Engine widget/analyze/build still work through server provider.
- `crossOriginIsolated === true`.

Risk:
- build step in previously no-build repo.
- COOP/COEP can break external CDN assets, so self-host engine/model assets.

---

## Phase 1: Browser Stockfish Widget

**Status (2026-06-03) — DONE & verified, committed (not pushed).**
- Package choice: **nmrugg `stockfish`@18.0.7** (real SF18 WASM), not `@lichess-org/stockfish-web`. The Lichess build ships NNUE separately and its own README calls it "not straight-forward… check out nmrugg for a simpler browser Stockfish." Build used: **`stockfish-18-lite` (multi-threaded, ~7 MB, embedded small net)** — your "smallnet" choice; needs the COOP/COEP we added. **Strength note:** lite is the same Stockfish 18 *search code* with an embedded SMALL net — weaker than the full ~113 MB net, but appropriate for the browser widget prototype.
- `+ chess.js` for UCI→SAN (the widget renders `pv_san`).
- `web-src/engine/stockfish-provider.js`: `StockfishWasmProvider` (Worker + UCI + snapshot shape + White-POV scores + 15 s readiness timeout) and `createEngineProvider` — browser engine only; when not `crossOriginIsolated` or the worker fails, returns an "unavailable" provider that surfaces an actionable error. **No server fallback.**
- Assets: `scripts/sync-stockfish.mjs` copies the lite `.js/.wasm` from node_modules into `web-src/public/engine/` (gitignored); the built copy in `web/static/engine/` is committed + in `pyproject` package-data (Docker has no Node).
- **Verified:** depth 18/18 with real PVs + SAN, MultiPV=3 shows 3 lines, **zero `/api/engine/*` calls** (compute fully client-side), 0 console errors; wheel ships `static/{assets,engine}`.

Move only the live engine widget first.

Tasks:
- Add Stockfish web package/assets.
- Add `StockfishWasmProvider`.
- Spawn Worker.
- Speak UCI:
  - `uci`
  - `isready`
  - `ucinewgame`
  - `position fen ...`
  - `go depth N`
  - parse `info`
  - parse `bestmove`
- Match current PV snapshot shape.
- Add download/warmup UI.
- Cache assets where useful.
- If the browser engine is unavailable, show an actionable error (no server fallback).

Acceptance:
- Engine widget streams PVs from browser.
- Happy path does not call `/api/engine/*`.
- Server Stockfish can be stopped and widget still works.

---

## Phase 2: Browser Whole-Game Analysis

**Status (2026-06-03) — DONE & verified, committed (not pushed).**
- Browser computes one eval per position; server only parses + classifies + saves.
- `web-src/engine/game-analyzer.js`: `analyzeGamePositions` drives the browser
  Stockfish provider over all FENs to the target depth (progress + cancel),
  returning one White-POV eval per FEN. `createEngineProvider({maxDepth})` +
  `isBrowserEngineAvailable()` added to `stockfish-provider.js`.
- `src/prepforge_chess/services/replay_engine.py`: `ReplayEngine` feeds those
  evals into the **existing** `AnalysisService` by FEN, so classification /
  report / persistence run unchanged with zero server compute.
- Server endpoints (both ungated — no engine runs): `POST /api/analyze/prepare`
  (import PGN → positions + move skeleton) and `POST /api/analyze/classify-save`
  (→ existing `_analysis_payload`). Old `/api/analyze/pgn[/start|/status]` stay
  for admin mode.
- `app.js` `runAnalysis`: prepare → browser analysis → classify-save → render.
  Analyze button gated on browser-engine availability; Build → Gen still gated
  on the server engine (Phase 3 / browser Maia). No Maia ⇒ no brilliancies yet.
- Fixed a latent re-analysis bug: a duplicate non-lichess PGN reported a fresh,
  unsaved game id; the import dedup now resolves to the stored game id
  (`existing_move_signature_ids`).
- **Verified** (server engine off): only `/api/analyze/prepare` +
  `/api/analyze/classify-save` fire — zero `/api/engine/*`, zero
  `/api/analyze/pgn*`; eval chart + classifications render; 0 console errors.

Recommended first pass:
- Browser computes per-ply Stockfish results.
- Server still classifies and saves.

Tasks:
- Use browser Stockfish worker to analyze each ply.
- Replace `/api/analyze/status` polling with local progress events.
- Add API like:
  - `POST /api/analysis/classify-save`
- Client sends:
  - game metadata
  - moves
  - evals
  - best moves
  - depth
- Server returns:
  - classification
  - report payload
  - saved analysis id

Acceptance:
- Analyze PGN works with server Stockfish disabled.
- Classification remains consistent because Python logic still owns it.
- Result is saved and reloadable.

Later optimization:
- Port classification to TS only after behavior is stable.

---

## Phase 3: Browser Maia3

Move human-like move prediction to browser.

### Re-scope (2026-06-04, after peer review)

A peer review surfaced four method-level problems in the original Phase-3 sketch.
All four were checked against the code and are **valid**; Phase 3 is restructured
accordingly. The original sketch (one int8 model + "wire Build to browser Maia")
is replaced by the sub-phases below.

Verified facts (code citations):
- **Model graph** (`maia3/models.py:351-399`): one forward
  `model(tokens, self_elos, oppo_elos)` → `logits_move (B,4352=4096+256 promo)`,
  `logits_value (B,3 WDL)`, `logits_ponder (B,1)`. Inputs: `tokens`
  `(B,64,12*history[+3 time])`, `self_elos (B,)`, `oppo_elos (B,)`.
- **Two inference shapes** (`services/maia.py`): `predictions()` runs ONE forward
  and reads policy only. `move_assessment()` runs TWO forwards — policy on the
  current position, then **value on the after-move tokens with self/oppo Elo
  swapped, WDL inverted back to the mover** (`maia.py:169-181`). Brilliancy uses
  the second shape; it is not a free by-product of `predictions()`.
- **Generation is a server-side recursion** (`opening_builder.py:_expand`,
  228-330+): it alternates Stockfish multipv candidates (`_engine_candidates`,
  multipv=count, 587-594) on our turn and `maia.predictions()` on the opponent's
  turn, **creating repertoire nodes during the recursion**. Moving only the Maia
  call to the browser cannot complete generation while the server computes nothing.
- **Bare-FEN parity** (`maia.py:99,143`): both adapter paths call
  `engine._reset_history()` and feed only the current board (tiled), so they do
  not use real ancestor history today. Browser parity = same bare-FEN behavior;
  but repertoire nodes *do* have ancestor moves, so the input contract must
  reserve real history for later.
- **RMSNorm export risk** (`maia3/models.py:4,197`, `model_registry.py:44`): the
  net uses `torch.nn.RMSNorm` with `use_rms_norm: True`; ONNX export of that op is
  torch/opset-version-sensitive — hence the monkeypatch, which must be pinned and
  asserted.

### Phase 3a — ONNX export pipeline (artifacts + parity + manifest)

**Status (2026-06-04, rev. after 2nd peer review) — implemented & green;
`scripts/export_maia3_onnx.py`.**
- Loads `UofTCSSLab/Maia3-23M` via the live adapter, CPU, eval.
- RMSNorm monkeypatch (`torch.nn.RMSNorm.forward` → functional rms); asserts the
  module count — **default `--expect-rms-norm 16`** (was None → now fails by
  default on structural drift; `-1` disables). **Confirmed exactly 16**
  (`transformer.layers.0..7.norm1/norm2`), names in the manifest.
- **Legacy TorchScript exporter (`dynamo=False`)** — the torch-2.12 default dynamo
  path needs `onnxscript`, prints a `✅` that crashes Windows `cp950`, and its
  graph **fails ORT quantization** (opset conversion + symbolic shape inference).
- **fp16 now works (44 MB)** and serves **both backends**. The
  `onnxconverter-common` 1.16 fp16 path left a mistyped Cast (`/model/Cast_1`: the
  int64→float Elo cast feeding `Div_1`); fix = neutralize its buggy
  `remove_unnecessary_cast_node` cleanup + keep the Elo/RMSNorm scalar math in
  fp32 via `op_block_list` (the size win is the MatMul/Gemm/Einsum weights).
- **int8 is DEMOTED to experimental opt-in (`--int8`), NOT shipped by default.**
  Parity proved per-tensor AND per-channel int8 shift the policy head enough to
  **flip Build Generate's 10%/30% branch thresholds** (`f8c5` crosses 30%, `f2f4`
  crosses 10%) — int8 Δprob ≈ 0.017. So the review's "int8 for WASM" assumption is
  overturned: **fp16 serves WASM too.** int8 never gates the build.
- **Behavioral parity vs the live `Maia3Adapter`** (not the raw torch wrapper)
  over 5 curated probes (start, white-to-move, black-to-move, promotion,
  castling): legal-masked policy, **top-1 move**, **10%/30% kept-move SETS**, and
  the **`move_assessment` after-move value path**. Results (tol 2e-2):
  **fp32 Δprob 2e-6**, **fp16 Δprob 3.4e-3 / Δassess 1.7e-3, top-1 OK, probe
  thresholds OK**.
- **fp16 is NOT claimed "threshold-safe."** 5 probes cannot prove safety (a move
  sitting on a 0.10/0.30 boundary can always flip under fp16's ~3.4e-3 delta). The
  manifest field is `probe_threshold_sets_match` (curated probes only), plus an
  empirical **`threshold_flip_sweep`** over 200 random positions across Elos:
  **1 flip / 200 (0.5%)**, max Δprob 3.3e-3. So fp16 has a *low but nonzero*
  threshold-flip rate vs the fp32 reference — recorded as evidence, not a proof.
  (Larger near-threshold sweeps on real repertoire positions are a follow-up.)
- **Asymmetric-Elo AND after-move value-swap genuinely tested** (the adapter API
  takes one rating → self==oppo there, so this is graph-level). `raw_asym_check`
  feeds self=1100 / oppo=2200, and for an applied move builds the **after-move
  tokens** (`_history_after_move`) and compares ONNX vs torch for: policy
  (Δ=6e-5), the **value head under BOTH (A,B) and (B,A)** orderings (Δ=2.7e-4),
  and the **WDL-inverted win-chance** Brilliancy consumes (Δ=1e-3). Also asserts
  swapping changes both policy (`policy_inputs_distinct`) and value
  (`value_swap_changes_output`) — both Elo inputs are live and the swap is a real
  operation, not a no-op, for A≠B. **Distinctness is measured on the ONNX graph
  itself** (`onnx(.,A,B)` vs `onnx(.,B,A)`, including a dedicated `o_pol_ba` run),
  not on Torch: a Torch-only check would pass even if the export dropped an Elo
  input, since a genuine swap delta below the `tol=0.02` ONNX/Torch parity bound
  would let a swap-blind graph slip through. (Production brilliancy/build pass
  self==oppo, so the swap is a numeric no-op there; the graph supports + is
  verified for asymmetry.)
- **Atomic output via content-addressed filenames.** Artifacts are staged in a
  temp dir **inside** `out_dir` (same filesystem → promotion is an `os.replace`
  rename, never a cross-drive copy+delete). On gating success each artifact is
  renamed to `maia3-<label>-<sha12>.onnx` (a new build never overwrites a live
  file), then the **manifest is `os.replace`d as the single atomic commit point**
  that switches which files the app loads. The export path **never deletes** —
  the swap only guarantees consistency for new readers, while a client holding the
  prior manifest may not have started downloading its model yet, so deleting it
  would 404 that fetch. Stale artifacts are reaped only by a **separate standalone
  reaper**, `scripts/gc_maia3_artifacts.py` — stdlib-only (no torch/chess/maia
  imports), so it runs in a Maia-free deploy environment. It loads the *current*
  manifest (never exports, never rewrites it — so it can't leave a just-committed
  manifest pointing at a file it deleted) and deletes unreferenced content-addressed
  artifacts older than `--grace-hours` (default 72h), with `--dry-run` to preview.
  It resolves each kept model's **ONNX external-data references**, so a live model's
  `.onnx.data` weight blob is never reaped (single-file today, but toolchain drift
  could reintroduce external data); if any model fails to parse, no `.onnx.data`
  is touched that pass. **Publish and GC share one exclusive `publish_lock`** over
  `out_dir` (O_CREAT|O_EXCL lockfile, stale-lock breaking after 30 min): the
  promotion+manifest-swap runs under it and so does the whole GC pass, so a
  concurrent reaper can't read the old manifest, have publish swap a new one, then
  delete a file the new manifest references (the stat/replace/unlink interleaving).
  The temp manifest is written inside the staging dir (not `out_dir`), so the
  single `try/finally` wrapping export+verify+promote removes it on any crash — the
  staging dir is always cleaned even if export/fp16/int8 throws. Verified: forced
  failure → exit 1, manifest + artifacts byte-identical, no stage/tmp leak; GC
  fixture-tested (referenced kept, within-grace kept, unreferenced+aged deleted,
  parse-failure protects `.onnx.data`, no-manifest refuses, lock mutual-exclusion +
  stale-break).
- Artifacts (git-ignored; CDN-host; only the manifest is tracked):
  `maia3-fp16-<sha>.onnx` (44 MB, both backends), `maia3-fp32-<sha>.onnx` (87 MB,
  reference + WebGPU fallback). Both **single-file** (fp32 embeds weights — 0
  external refs; the earlier "external-data" note was wrong).
- `maia3.manifest.json` records `source_revision` (HF commit `51a0145a…`),
  content-addressed filename + SHA-256 per artifact, opset 17, pinned versions,
  per-artifact parity, the flip sweep, the asym/value-swap result, and
  `verification_backend` (**CPU EP only**). `backend_artifact` (webgpu+wasm →
  fp16) is marked **`backend_artifact_status: provisional`** — see below.

**Outstanding 3a items (carry into Phase 3b):**
- [x] **Artifacts execute under onnxruntime-web (smoke test).**
  `web-src/maia3-smoke.html` + `web-src/engine/maia3-smoke.js` load both shipped
  artifacts on both `onnxruntime-web` EPs and compare each against **that same
  artifact's** Python CPU-EP reference (`scripts/gen_maia3_smoke_fixture.py` →
  `maia3-smoke-fixture.json`: shared model-independent token inputs + a
  per-artifact `references[fp16|fp32]` output block, so fp32 is checked against fp32
  CPU EP, not cross-checked against fp16). It validates the **value head**, the
  raw-logit argmax, AND — the part **Build Generate** consumes — the **legal-masked
  policy probabilities and the 10%/30% kept-move SETS**: the fixture ships each
  position's legal-move indices + the per-artifact `policy_top`/`kept_10`/`kept_30`,
  so the browser reproduces the exact `predictions()` threshold branch (legal mask +
  softmax + 0.10/0.30 cuts) without re-deriving the index→move mapping. A non-top-1
  move crossing a branch threshold under fp16 (the known low-but-nonzero flip risk)
  now fails the combo instead of passing on a top-1-only check. Downloaded weights
  are **size + sha256 verified against the manifest** before any session is built
  (a CDN can serve a stale/truncated artifact with HTTP 200). The harness verifies
  each reference's `model_file`/`sha256` still match the manifest and **hard-stops
  before downloading** on a stale fixture — it can't report "OK" on mismatched
  references and won't waste up to 137 MB of fetches first. Run in
  Chromium against the **built app on the Python server** (the Vite dev server
  rewrites ort's dynamic wasm-loader import to `…?import` and fails — a dev-only
  quirk). **Scope:** proves the *graphs run and agree numerically* on one RTX 5060
  box, batch=1, **single-threaded** WASM (`numThreads=1`, so it works header-less);
  it does **not** validate the threaded WASM the production worker will use.
  Results (live run against the built Python-served app):

  | artifact | EP | MB | create ms | warm med ms | max valΔ (vs own CPU ref) |
  |---|---|---|---|---|---|
  | fp16 | wasm | 46.4 | 1571 | **95** | 0.0010 |
  | fp16 | webgpu | 46.4 | 1100 | 503 | 0.0037 |
  | fp32 | wasm | 91.2 | 389 | **70** | 7.4e-7 |
  | fp32 | webgpu | 91.2 | 433 | 321 | 7.4e-7 |

  All combos load, shapes match (`logits_move` 4352 / `logits_value` 3), top-1
  agrees. **Findings:** (1) at batch=1 **WASM beats WebGPU decisively** — WebGPU
  pays a ~3.5s first-inference shader-compile cost and is 4–7× slower warm; (2) fp16
  vs fp32 on WASM is a bandwidth-vs-latency trade (fp16 halves download to 46 MB for
  ~25 ms slower warm); (3) fp32 now reproduces CPU EP to ~1e-6 (vs its own
  reference) — the larger fp16 Δ is real precision loss, not measurement noise.
  **Network capture confirmed** the runtime fetches the wasm from
  `/static/engine/ort/ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (the vendored copy
  `wasmPaths` points at) — the Vite-trimmed `assets/ort-wasm-*.wasm` duplicate is
  **never requested**, closing the trim-plugin risk. **Initial default (not
  finalized):** the provider should **default to the WASM EP** with fp16 for
  `predictions()`. One machine's single-threaded result, so the manifest's
  `backend_artifact` map stays **`provisional`** on purpose — finalizing for *all*
  users needs broader-device + threaded benchmarking; keep a runtime
  capability/benchmark override. Revisit WebGPU only for batched
  `moveAssessmentBatch` (untested here — smoke is batch=1).
- [ ] **Deploy/CDN path — partially validated.** The built-app smoke now passes
  end-to-end on the Python server with the weights served at the configured base
  (network capture above), and the `pip install .` wheel ships the ort runtime +
  manifest with **zero `.onnx`** — and that's now **structural, not trim-dependent**:
  `pyproject.toml` lists `static/maia3/maia3.manifest.json` by **exact filename**, so
  a `static/maia3/*.onnx` could never be repackaged even if the Vite trim plugin is
  skipped or a build half-fails. The weight base is resolved at **runtime** (our
  deploy commits the built static and has no Node, so a build-time-only VITE var
  can't repoint a deployed bundle): `resolveModelBase()` reads, first match wins,
  `globalThis.__MAIA3_ASSET_BASE` (the production knob) → `manifest.asset_base` →
  build-time `VITE_MAIA3_ASSET_BASE` → `/static/maia3/` (local dev). The production
  knob is now **wired into the server**: setting the `PREPFORGE_MAIA3_ASSET_BASE`
  env var makes `web/server.py` render `<script>window.__MAIA3_ASSET_BASE=…</script>`
  into every served HTML document (`_inject_asset_base`, right after `<head>`, before
  the module scripts), so a committed-static deploy repoints the bundle at a CDN with
  no rebuild and no manifest edit. Covered by `test_web_server.py`
  (`test_html_injects_runtime_asset_base_from_env` + the unset/no-op case). The
  **two-origin split is now reproduced locally** by `scripts/two-origin-smoke.mjs`
  (`npm run smoke:two-origin`): it stands up the deploy image on an app origin with
  `COOP:same-origin` + `COEP:require-corp` (injecting `__MAIA3_ASSET_BASE` at the
  weight origin, exactly as `_inject_asset_base` does) and the `.onnx` on a separate
  weight origin sending `Access-Control-Allow-Origin` + `Cross-Origin-Resource-Policy:
  cross-origin`. So the asset-base override surviving into a genuine **cross-origin**
  fetch, the CDN's CORS (ACAO) header letting the cors-mode `.onnx` fetch succeed under
  cross-origin isolation, and the sha256 gate over the cross-origin bytes are all
  exercisable before any real CDN exists. Two granular negative captures: `WEIGHT_NO_ACAO=1`
  drops `Access-Control-Allow-Origin` so the cors-mode fetch fails the CORS check (page
  FATALs — the operative gate for a `fetch()`), while `WEIGHT_NO_CORP=1` drops
  `Cross-Origin-Resource-Policy` and the fetch still passes (CORP gates *no-cors*/embedded
  loads, not a cors fetch — but a real CDN should send it anyway). **Verified in a browser
  (2026-06-04):** positive run `DONE: all combos OK`, `crossOriginIsolated: true`,
  `model base: http://localhost:8788/`, fp16+fp32 fetched from the weight origin, all four
  WASM/WebGPU combos OK; CORS-failure capture FATALs with `TypeError: Failed to fetch`.
  **Still open:**
  the only un-reproduced variable is a *real* CDN/object store's header behavior —
  host the `.onnx` there, set `PREPFORGE_MAIA3_ASSET_BASE` to it (no rebuild), confirm
  it sends the same COEP-compatible (`Cross-Origin-Resource-Policy` / CORS) headers,
  and re-run the smoke against the live base before calling the production path fully
  validated. A misconfigured base 404s loudly with the runtime fix in the message; a
  CDN serving a wrong/stale artifact is rejected by the sha256 gate before inference.
- [x] **Threaded WASM validation.** Done in Stage 4c (2026-06-05): the worker runs
  multi-threaded ORT WASM under COOP/COEP, validated live by the cross-origin gate
  (`requested=4 applied=4`, ~1.8× warm-inference speedup vs single-threaded). See
  the Stage 4c entry. (Broader-device profiling remains a follow-up.)
- [ ] Larger threshold-flip sweep on real repertoire/game positions, deliberately
  covering near-boundary moves, before relying on fp16 for Build Generate parity.
- [ ] Pin the export toolchain in a requirements/lock file (currently only
  recorded in the manifest).

Goal: reproducible export producing the browser artifact, with behavioral parity.

- `scripts/export_maia3_onnx.py`:
  - Load the same checkpoint the server uses (`UofTCSSLab/Maia3-23M`) via the
    maia3 package, eval mode, CPU.
  - Apply the RMSNorm export monkeypatch; **assert the exact number of patched
    modules and log their qualified names** — fail loudly if the count drifts
    (a silent miss → a wrong export).
  - Export an fp32 base graph: 3 inputs (`tokens`,`self_elos`,`oppo_elos`) →
    `logits_move`,`logits_value` (`logits_ponder` dropped).
  - Derive `maia3-fp16.onnx` (the shipped artifact, both backends). int8 is an
    opt-in experiment only (see Status: not threshold-safe).
  - Behavioral parity (not raw graph numerics) vs the **live `Maia3Adapter`**:
    legal-masked policy, top-1 move, 10%/30% kept-move sets, and the
    `move_assessment` after-move value path.
  - Emit `maia3.manifest.json`: source repo + **revision/commit hash**, SHA-256
    per artifact, opset, patched-module count, pinned versions, per-artifact
    parity. (Implemented — see Status above.)
- The Maia provider loads `backend_artifact[webgpu|wasm]` from the manifest
  (both → fp16 today).

### Phase 3b — Maia3 provider API (two methods, history-ready contract)

- [x] **Tokenizer ported + golden-parity tested.** `web-src/engine/maia3-tokenizer.js`
  is a faithful JS port of the maia3 Python encoding (`dataset.tokenize_board` /
  `get_legal_moves_mask`, `utils.get_all_possible_moves` / `mirror_move`,
  `uci._tokens_from_history` / `_history_after_move` / `_move_from_index`): the 4352-move
  vocabulary, the (64, 97) token tensor (12-plane one-hot × `history=8` + zero ponder
  col, `include_time_info=False`), the black-to-move mirror frame (square `s^56` +
  color swap, white-frame promotions), the legal mask, and index↔move. Bare-FEN scope
  (history ignored for now, per the contract below). `maia3-tokenizer.test.js` pins it
  byte-for-byte against the committed `maia3-smoke-fixture.json` `tokens`/`legal_indices`
  (straight from the Python adapter) across **seven Python golden positions** chosen to
  exercise every corner of the vocabulary + mirror frame: a white- and a black-to-move
  base, a black-to-move promotion (white-frame promo vocab), castling **both colours**
  (`e1g1`/`e1c1` and their black mirror), and en passant **both colours** (capture to an
  empty square, the black case through the mirror). Plus index↔move round-trips on every
  case and a `legalMoveIndices` that **throws** on any legal move missing from the vocab
  (no silent drop, so no plausible-but-wrong re-softmax). Built on `chess.js` (already a
  dep).
- [x] **Provider + worker + inference math implemented & unit-tested.**
  `web-src/engine/maia3-inference.js` holds the PURE post-processing (legal-masked
  softmax, the side-to-move human-probability lookup, and the WDL→`winChanceAfter`
  transform — `softmax3` + the largest-remainder permille port of
  `maia3.uci._probabilities_to_permille` / `invert_wdl`), so it's tested in node with no
  ORT (`maia3-inference.test.js`: terminal `[]`, the mirror-frame lookup, and known WDL
  values). `maia3-worker.js` owns the onnxruntime-web session (download → size+sha256
  gate → `InferenceSession.create`) and runs `predictions` / `moveAssessment` /
  `moveAssessmentBatch` (one shared policy forward + one padded value forward over the
  dynamic batch axis). `maia3-provider.js` is the main-thread front: it resolves the
  asset base on the page, spawns the worker, and implements the request-id correlation +
  failure/recovery contract; it imports **no** ORT, so `maia3-provider.test.js` drives a
  fake worker to prove concurrent-reply routing, single-error isolation, worker-crash →
  unavailable → re-init, and retryable init.
- [x] **Real bundle path validated by a live worker harness.** Before any UI wiring, a
  minimal entry (`web-src/maia3-provider-harness.html` + `maia3-provider-harness.js`,
  added as a Vite input) imports the real `maia3-provider`, which spawns the actual
  `new Worker(new URL("./maia3-worker.js", import.meta.url))`. This is the ONLY build path
  that emits a `maia3-worker` chunk with `onnxruntime-web` bundled *inside* the worker —
  the app/smoke never imported the provider, so that chunk (and the in-worker ORT import,
  vendored wasm path, weight fetch + sha256 gate, request round trip) was previously
  unbuilt and untested. Verified the built `assets/maia3-worker-*.js` carries
  `InferenceSession`, pins `/static/engine/ort/`, and runs the sha256 gate. **Live run
  (2026-06-04, RTX 5060, built app on the Python server, `crossOriginIsolated: true`):
  WASM backend — all checks OK.** `predictions()` reproduces the committed Python CPU
  reference's top move on all six symmetric-Elo golden positions including the three
  black-to-move mirror-frame cases (`e2e1q` promo, `e8g8` castle, `d7d5` en passant —
  these return ~0 with a naive lookup, see `brilliant-search-cap`); init (worker boot +
  46 MB fetch + sha256 + session create) ~2.7 s, warm `predictions` ~100–140 ms,
  `moveAssessmentBatch` ~340 ms; `moveAssessment` legal/illegal, batch mixed +
  all-illegal, and a concurrency (no-cross-wires) check all pass. **Open:** the
  `?backend=all` run hung in the **WebGPU-in-worker** `InferenceSession`/first-run path
  (the main-thread smoke's WebGPU EP was fine), so the worker-WebGPU path needs separate
  investigation before it's an option — not a blocker since the provider defaults to WASM
  (WASM beats WebGPU at batch=1).
- **Next:** wire into the UI (Phase 3c) — add the IndexedDB weight cache +
  download/progress UX, then validate threaded WASM.

`web-src/engine/maia3-provider.js` (+ `maia3-worker.js`, IndexedDB cache):
- `predictions({ fen, historyFens?, rating }) -> [{ move_uci, probability, rank }]`
  — one forward, policy only. Port board tokenization, legal-move mask, and the
  side-to-move (mirrored) index→move mapping (the `_move_from_index` frame: a
  naive softmax+dict lookup returns ~0 for black-to-move — see
  `brilliant-search-cap` memory).
- `moveAssessment({ fen, moveUci, historyFens?, rating }) -> { humanProbability, winChanceAfter }`
  — **separate** method: builds after-move tokens, **swaps self/oppo Elo**,
  inverts WDL to the mover. Support **batch** (`moveAssessmentBatch`) so a node's
  candidate set is one padded forward, not N.
- `historyFens` is **accepted but ignored for now** (bare-FEN parity); reserving
  it avoids an input-contract rewrite when we later feed real ancestor history.

**Worker init — asset base is resolved on the MAIN THREAD, then handed to the
worker.** The worker has its own `globalThis` and cannot see
`window.__MAIA3_ASSET_BASE` (the global the server's `_inject_asset_base` renders
into the page). So `resolveModelBase()`'s precedence chain (injected global →
`manifest.asset_base` → build-time `VITE_MAIA3_ASSET_BASE` → `/static/maia3/`) must
run in the provider **on the page**, and the resolved value is passed in the worker
init message, e.g. `{ type: "init", assetBase, manifest }`. If the worker tried to
resolve it itself it would always miss the injected global and silently fall back to
`/static/maia3/` — which 404s in the no-weights deploy image — even though the
main-thread smoke passed. The worker treats `assetBase` as opaque and only fetches
`assetBase + artifact.file` (+ the sha256 gate). `assertManifestContract()` runs
once on the supplied manifest before the first tokenization.

**Request correlation & failure/recovery contract.** Every provider→worker message
carries a monotonic **request id**; the worker echoes it on every reply, and the
provider keeps a `Map<id, {resolve, reject}>` so concurrent requests can't cross
wires. Failure isolation:
- A **single inference error** (an ORT/internal throw mid-request) rejects ONLY that
  request's Promise and deletes its map entry — the worker stays alive and later
  requests succeed. (Terminal/illegal inputs are NOT errors: they resolve with `[]` /
  `null` per the contract above.)
- A **worker crash** (`worker.onerror` / `messageerror`, or a failed init) is fatal
  for that worker: the provider rejects **all** pending Promises with a fatal error
  and enters an `unavailable` state.
- **Init is retryable.** The provider inits lazily and caches the in-flight `ready`
  promise; if init (download / sha256 / session-create) fails, the cached promise is
  cleared and a dead worker is torn down, so the **next call re-attempts** on a fresh
  worker rather than wedging the provider permanently. The worker factory is injected
  (default: a real module `Worker`), so this correlation/recovery logic is unit-tested
  against a fake transport without a browser.

**Terminal positions & illegal input** (matches the Python `Maia3Adapter` in
`services/maia.py`, which returns `None` for an unparseable/illegal move):
- `predictions()` returns `[]` when the position has **no legal moves** (checkmate /
  stalemate). The provider must short-circuit on an empty legal-index set **before**
  the softmax — a legal-masked softmax over zero indices yields `-Infinity`/`0`/`NaN`
  (see `legalMaskedProbs` in `maia3-smoke.js`), so "no legal moves" is a guard, not a
  degenerate inference.
- `moveAssessment()` returns `null` when `fen` is unparseable, or `moveUci` is
  unparseable or not legal in `fen` — no forward pass — mirroring the Python
  `move_assessment` `None` path (it returns `None` for both a bad FEN and a bad move;
  see `services/maia.py`). (`tokensAfterMove()` already returns `null` for an illegal
  move; a bad FEN throws in `chess.js` and is caught to `null`.)
- `moveAssessmentBatch()` **preserves input order** and returns `null` in the slot of
  each unparseable/illegal move, scoring the legal moves in the same padded forward;
  callers read results positionally.

### Phase 3c — Build Generate architecture (browser recursion → tree plan)

The server must never compute, so the recursion + node creation moves to the
browser; the server only validates and persists. Chosen model: **browser runs
the whole generation, then submits a tree-mutation plan**.

**Stage status:**
- [x] **Stage 1 — pure recursion planner.** `web-src/engine/build-generator.js`
  (`generateBuildPlan`) is a line-by-line JS port of `_expand` / `_upsert_child`
  emitting `planned_add`/`updated` changes; node-tested against fakes.
- [x] **Stage 2 — browser orchestrator.** `web-src/engine/build-generate-runner.js`
  binds the planner to the real browser engines (Stockfish MultiPV + Maia3),
  sizing MultiPV to `branchLimit + maxManualPreparedChildren` (no silent clamp;
  over-cap throws), failing on timeout rather than persisting a partial set.
- [x] **Stage 3 — `POST /api/build/generate/apply-plan` (server apply).**
  Implemented (2026-06-05). Ungated, **NO compute** (`_create_builder()` inert
  adapters → works on the Maia-free deploy image). Takes
  `{ repertoire_id, root_node_id, plan }` and `OpeningBuilderService.apply_generation_plan`
  re-validates every move's legality (`chess_core.apply_uci` raises → 400) and
  parentage (parentRef/nodeId resolve only within the anchor subtree; same-run
  `tmp-` ids resolve in DFS order), **recomputes** `is_mainline` /
  `is_user_prepared_move` itself (client `intendedMainline` is intent only), and
  **restricts plan sources to `generated_stockfish`/`generated_maia3`** so a
  client can't inject `manual`/`imported_pgn` authorship. Existing-child merges
  are fill-only-when-null + protected-source (parity with `_upsert_child`);
  drift-safe (re-merges if a move now exists). All-or-nothing: the repertoire is
  saved once at the end, so a malformed change raises before any persistence.
  **Untrusted-payload hardening** (post-review): `_read_json` caps the request
  body at 2 MB (rejected by Content-Length before the read); the plan caps
  `changes` (≤2000) and planned-node depth-from-anchor (≤64); `tempId` must be a
  unique `tmp-`-prefixed string that can't collide with a real node id (so a
  forged/dup id can't rebind a later `parentRef`); `plan.rootNodeId` must match
  the request `root_node_id` (a stale/wrong-anchor plan is refused, not retargeted);
  `maiaProbability` must be finite in `[0,1]`; `engineEvaluation` is shape-checked
  (bounded UCI-string `pv`, finite numeric `wdl`). Tests:
  `tests/test_opening_builder.py` (tempId chaining, mainline recompute,
  illegal-move reject + no-persist, non-generated-source reject, unknown-parent
  reject, manual-merge no-duplicate/no-relabel, update fill-only, plus the
  hardening: root-id mismatch, too-many-changes, too-deep + at-limit chain,
  malformed/dup tempId, out-of-range probability, malformed engine eval) +
  `tests/test_web_server.py` (ungated 200 with server engine disabled, illegal
  move → 400, too-many-changes → 400).
- [~] **Stage 4 — app wiring (UI).** In progress, split into sub-stages:
  - [x] **Stage 4a — Build → Generate wired to the browser (2026-06-05).**
    `app.js` `generateFromCurrentNode` now calls `runBrowserBuildGenerate`
    (Stockfish + Maia3 in the browser) to build the plan, then POSTs it to
    `POST /api/build/generate/apply-plan` and hydrates the returned workspace —
    **zero `/api/build/generate/start|status|cancel`**, no server compute. The
    old server-poll path (`pollBuildJob`, `cancelHeavyJob`) was removed. **Cancel
    is two-phase** (post-review fix): GENERATION (local, pre-POST) is cancellable
    — the job-toast Stop aborts an `AbortController`, the recursion checks the
    signal, and an explicit re-check bails before the POST, so Stop persists
    NOTHING; SAVING (the apply-plan POST) is NOT cancellable — aborting the fetch
    can't un-persist an atomic server apply, so the Stop button is removed
    (synchronously, before the awaited POST) rather than imply a cancel that
    wouldn't hold. `postJson(path, body, options)` now forwards `signal` to fetch. The Generate button
    is gated on `isBrowserEngineAvailable()` (same as Analyze), not the server
    flag. **Conservative controls** (per review): ply depth capped at
    `GEN_MAX_PLY_DEPTH=12` (default 6), a new your-move branch-count control capped
    at `GEN_MAX_BRANCHES=3` (default 1); a `GEN_PLAN_CHANGES_SOFT_CAP=2000`
    (mirrors server `MAX_PLAN_CHANGES`) fails with an actionable message before the
    POST instead of a raw 400. **Static rebuilt** (`npm run build`): the app bundle
    now emits the `maia3-worker` chunk for the first time (the app shell pulls in
    the provider→worker). 106/106 JS unit tests pass; build transforms clean.
    **Outstanding: a live in-browser end-to-end run** (create repertoire →
    Generate → Maia downloads → plan applies) before calling 4a fully verified —
    the orchestrator/worker were validated live in 3b, but the app glue hasn't been
    exercised end-to-end yet.
  - [~] **Stage 4b — Maia weight cache + download/progress UX (2026-06-05).**
    Implemented & unit-green; the **real worker bundle path was re-validated live**
    via `npm run gate:cross-origin` (headless Chrome, `crossOriginIsolated=true`):
    the refactored `maia3-weights-loader` → ORT-in-worker fetched the 46 MB `.onnx`,
    passed the size/sha256 gate, created the session, and ran predictions — all
    checks OK. So the loader refactor didn't break the production bundle.
    **Still outstanding (interactive):** the cache-HIT path on a warm reload (the
    gate runs once in a fresh profile → only the cache-MISS→fetch→put path runs
    live; hit/evict are unit-tested), the `app.js` download-progress toast end to
    end, and a full create-repertoire→Generate UI run (same as 4a).
    - **IndexedDB weight cache** (`web-src/engine/maia3-weight-cache.js` +
      `maia3-weights-loader.js`): the worker checks the cache (keyed by the
      content-addressed filename) before the network, so only the FIRST Generate
      pays the ~46 MB download; later runs (and page reloads) load from IndexedDB.
      **Best-effort** — any IDB failure (private mode / quota) is swallowed to a
      miss and falls back to fetch, never breaking inference. The manifest **size +
      sha256 gate runs on the cached bytes too** (cache is a speed optimization,
      never a trust boundary); a **cache hit that FAILS the gate is evicted and
      re-fetched** (post-review fix — a corrupt/stale cached blob must not wedge
      init forever), and only verified bytes are ever written back. Single-model
      cache (a new artifact evicts the prior one, so it can't grow unbounded across
      versions). The cache→verify→fetch orchestration lives in the ORT-free,
      dependency-injectable `maia3-weights-loader.js` (the worker can't be
      node-tested — it imports ORT), unit-tested incl. the corrupt-cache fallback,
      bad-network-bytes-throw, and the size/sha gates (`maia3-weights-loader.test.js`);
      the cache primitives are tested against an in-memory fake IDB
      (`maia3-weight-cache.test.js`).
    - **Warm provider reuse** (`getSharedMaia3Provider` / `disposeSharedMaia3Provider`
      in `maia3-provider.js`): repeated Generate runs now reuse ONE warm
      worker + ORT session instead of re-creating it per call. The orchestrator
      `runBrowserBuildGenerate` takes a **borrowed** `maiaProvider` it uses but does
      NOT terminate (vs an injected `createMaia` it owns + tears down — tests still
      use that path). The shared provider self-heals (a crash/timeout clears its
      cached init promise and re-inits next call).
    - **Download-progress UX**: the loader streams the weight fetch
      (`resp.body.getReader()`) and the worker posts non-settling `{ progress,
      phase, loaded, total }` messages (phases `cache`/`download`/`verify`/`session`)
      on the init request id; the provider routes them to a settable
      `onInitProgress` handler (ignored once the id has settled / after teardown).
      Progress `total` is the **manifest size** (`entry.bytes`) when the response has
      no `Content-Length`, so the percentage is meaningful instead of pinning every
      chunk to 100% (post-review fix); a present, sane `Content-Length` still wins.
      `app.js` shows `downloading Maia model · NN%` / `loading cached Maia model` /
      `verifying` / `starting Maia engine` in the job toast, replacing the coarse
      "loading" status. Unit-tested: cache round-trip/eviction/delete/no-op,
      corrupt-cache→evict→refetch, progress total with/without Content-Length,
      progress routing + late-message no-op + handler detach, borrowed-provider
      not-terminated + handler set/clear. **126/126 JS unit tests pass; static rebuilt.**
  - [x] **Stage 4c — threaded-WASM enabled + validated (2026-06-05).** The worker
    no longer pins `numThreads=1`: the provider resolves the ORT WASM thread count
    on the MAIN thread from page capabilities (`resolveThreadCount` —
    `crossOriginIsolated ? min(hardwareConcurrency, MAX_WASM_THREADS=4) : 1`, with an
    optional explicit override), passes it in the init message, and the worker
    applies it before session create — **re-clamping to 1 if the worker itself
    isn't `crossOriginIsolated`** (no SharedArrayBuffer → a threaded session can't
    construct). WebGPU forces 1 (GPU EP doesn't use the WASM pool). The worker
    echoes the count actually applied (`info.numThreads`) so threading is
    observable. The production app benefits automatically: `getSharedMaia3Provider()`
    uses the auto resolution, and the server enforces COOP/COEP, so the public flow
    is multi-threaded.
    - **Validated live** via `npm run gate:cross-origin` (now requests `?threads=4`;
      override with `THREADS=N`): in real headless Chrome with
      `crossOriginIsolated=true`, `requested=4 applied=4` — threading genuinely
      engaged (a >1 request returning single-threaded **fails** the harness's new
      `wasm-threads` check), all correctness checks stayed green, and warm
      `predictions` ran **~52.7 ms vs the single-threaded smoke's ~95 ms (≈1.8×)**;
      init ~1.5 s, batch ~111 ms.
    - **Scope:** one headless box (RTX 5060, GPU disabled in the gate). The thread
      count is capability-gated + capped, and falls back to 1 without isolation, so
      it's safe by construction; broader-device latency profiling is a follow-up,
      not a blocker. Unit-tested: `resolveThreadCount` (isolation gate, cores cap,
      explicit override, missing hardwareConcurrency) + init-message wiring
      (wasm/no-COI/webgpu) in `maia3-provider.test.js`. **133/133 JS unit tests pass.**

- Port the `_expand` recursion to JS (or reuse the existing **pure** planner
  `opening_generation.generate_from_position`, which already returns a plan of
  `planned_add`/`updated` changes without persistence — the natural seam).
- Browser drives both engines locally: Stockfish multipv candidates (our turn) +
  Maia `predictions` (opponent's turn), building an in-memory subtree with the
  same thresholds (10% mainline / 30% branch).
- New server endpoint `POST /api/build/generate/apply-plan` (ungated, no compute):
  takes `{ repertoire_id, root_node_id, plan }`, **re-validates move legality and
  parentage server-side**, then mutates + saves the repertoire. Old
  `/api/build/generate[/start|/status|/cancel]` stay for admin mode only.
- Acceptance: Build → Generate completes end-to-end with
  `PREPFORGE_SERVER_ENGINE_ENABLED=0`.

### Phase 3d — Brilliancy in the browser (independent feature)

**Status (2026-06-05) — server half done + tested; browser wiring landed; live
Gold-Coin UI run outstanding.** Chosen approach: **send the browser-computed
`(humanProbability, winChanceAfter)` to the server, which replays them into the
EXISTING Python `BrilliantAnalyzer`** (not a JS port) — so the unintuitive/reveal/
sound thresholds + win-chance math stay in one validated place, zero server compute.

- **Server (`services/replay_maia.py` + `classify_save_payload`):** `ReplayMaia`
  mirrors `ReplayEngine` — it returns the client's `(human_probability,
  win_chance_after)` per `(fen, uci)` (FEN/UCI-normalized keys), `None` for any move
  the browser didn't assess (→ analyzer skips Brilliant for it, the correct
  degradation). `classify-save` accepts an optional `maia_assessments` list, validates
  it (FEN+UCI strings, finite `human_probability`/`win_chance_after` in [0,1], ≤1000
  items → 400 on malformed), builds `BrilliantAnalyzer(maia=ReplayMaia(...))`, and runs
  it through the same `AnalysisService`. Omitted/empty → the Phase-2 behaviour (no
  Brilliant). `prepare` now advertises `brilliant.{enabled,rating}` so the browser
  assesses at the rating the analyzer expects (ReplayMaia ignores rating server-side —
  the client owns matching it). The Stockfish truth win-chances are still computed in
  Python from the replayed evals. **Tested** (`test_replay_maia.py` +
  `test_web_server.py`): brilliant flagged from client numbers (unintuitive + winning),
  intuitive move NOT flagged, no-assessments → no Brilliant, prepare advertises the
  rating, and 7 malformed-payload → ValueError cases.
- **Browser (`app.js`):** after the Stockfish whole-game pass, `runAnalysis`
  computes `provider.moveAssessment` for each played move (best-effort, via the shared
  Maia provider — model downloads once, then IndexedDB-cached; progress + a
  "checking brilliancies N/M" toast), and posts them as `maia_assessments`. Any failure
  (no weights / inference error) is swallowed → analysis completes without brilliancies,
  exactly the server's no-Maia path. Cancel is honoured mid-assessment.
- Why server-replay over `moveAssessmentBatch`: the analyzer needs ONE assessment per
  *played* move (different FENs), not a batch of candidates at one FEN, so per-move
  `moveAssessment` is the right call; batching buys nothing across plies.
- **Correctness rests on two already-validated facts:** the Python `BrilliantAnalyzer`
  was validated on the Gold Coin game (`brilliant-search-cap` memory), and the browser
  `moveAssessment` reproduces the Python Maia numbers (3a smoke + 3b/4c gate). So the
  browser path flags the same moves transitively.
- **Outstanding:** the live end-to-end UI run — paste the Gold Coin PGN, Analyze, and
  confirm exactly `23...Qg3` is flagged Brilliant in the browser (the transitive
  argument is strong, but the app.js glue hasn't been exercised against the real model
  end to end yet). Optional later optimization: pre-filter which plies get a Maia
  assessment (today all played moves are assessed; the server only consults the
  Best/Excellent ones), without porting the classification math to JS.

### Shared tasks
- Add `onnxruntime-web`, Maia worker, IndexedDB model cache, download/progress UX.
- No server fallback; browser Maia3 only (server Maia stays admin-mode only).

### Risk
- ONNX input/output contract mismatch (mitigated by 3a golden parity vs live adapter).
- WebGPU quantized-op support (mitigated by shipping fp16 for WebGPU).
- 25–45 MB first download; backend differences; mobile performance.
- RMSNorm export drift across torch versions (mitigated by pinning + module-count assert).

---

## Phase 4: Public Settings Cleanup

Tasks:
- Remove public UI actions:
  - `Install Stockfish`
  - `Install Maia3`
- Replace with:
  - Browser Stockfish status
  - Maia3 model status
  - Download Maia model
  - Clear cached model
  - Engine mode: Browser only
  - Depth
  - Threads/performance mode
- Store settings per user.

NOTE: much of this already landed early (alongside the hard-rule guards) — the
public Settings now shows browser engine status (available/unavailable) + "Maia3
not yet available" and the server install buttons + first-run install prompt were
removed.

Acceptance:
- Settings no longer pretends to install engines on the public server.
- Each user has independent engine preferences.

---

## Parallel Track: Multi-Tenancy

Required before public launch.

Tasks:
- Add auth.
- Add users table.
- Add `user_id` to:
  - games
  - repertoires
  - repertoire nodes
  - training sessions
  - training progress
  - analyses
  - app settings
  - Lichess OAuth token
- Ensure all repository queries filter by `user_id`.
- Migrate existing single-user data to an owner/admin user.
- Add per-user Lichess OAuth.
- Add rate limiting for the admin-only server engine APIs (if ever enabled).
- Consider FastAPI/ASGI migration.

Acceptance:
- Two users cannot see or modify each other's data.
- Lichess OAuth token is per user.
- Training and repertoire state are isolated.

---

## Suggested Order

1. Phase 0: Vite + provider seam + COOP/COEP.
2. Phase 1: browser Stockfish widget.
3. Phase 2: browser Stockfish whole-game analysis.
4. Multi-tenancy track before public launch.
5. Phase 3: browser Maia3.
6. Phase 4: public settings cleanup.
7. Optional: ASGI/FastAPI migration if concurrency becomes painful.

---

## Deferred Risks

Licensing:
- Prototype can proceed.
- Before public release, review:
  - `@lichess-org/stockfish-web`
  - Stockfish/NNUE assets
  - MaiaChess frontend code
  - Maia3 ONNX/model license
  - compatibility with current project license

Server engine (admin mode only — NOT a public fallback):
- Disabled by default (`PREPFORGE_SERVER_ENGINE_ENABLED=0` → 403).
- If ever enabled for an admin/server deployment: must be queued, rate-limited, capped.
- The public flow never uses it and never auto-falls-back to it.

Performance:
- Desktop Chromium should be the first target.
- On unsupported/low-end browsers the UI shows "engine unavailable" (lower depth is an option) — it does NOT fall back to a server engine.

---

## Appendix: Session fixes already landed (2026-06-03)

These were handled in the same session that produced this plan; recorded here so they aren't lost.

- **Train turn-badge "image not loading":** there was never a PNG — `static/` has zero image
  assets and pieces are inline SVG. The badge above the board rendered a bare `"W"`/`"B"`
  letter. Replaced with the inline king SVG of the side-to-move (`pieceSvg('K'|'k')`) in
  `app.js` (`renderTraining` + recovery round) and gave the badge contrasting disc
  backgrounds in `styles.css` (`.train-turn-badge`): white king on dark disc, black king on
  cream. Verified in-browser, both sides.
- **Maia3 fp16/fp32 `rms_norm` UserWarning:** harmless upstream `maia3` perf warning
  (non-fused kernel fallback); results are correct. Becomes moot once Maia compute leaves the
  server. Not changed.
