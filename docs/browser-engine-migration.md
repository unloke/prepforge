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
- [ ] **Browser validation — the backend map is still PROVISIONAL.** All parity is
  via the ORT **CPU** EP in Python. fp16-for-both-backends is a CPU-EP decision:
  on `onnxruntime-web` **WASM**, fp16 may need conversion or lack fast half ops and
  could be slower/heavier than fp32. Must load `maia3-fp16.onnx` in a Chromium
  worker on **both** the WASM and WebGPU EPs and measure load, numerics, memory,
  and latency before finalizing the map. Opens **Phase 3b** (needs the worker).
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

### Phase 3c — Build Generate architecture (browser recursion → tree plan)

The server must never compute, so the recursion + node creation moves to the
browser; the server only validates and persists. Chosen model: **browser runs
the whole generation, then submits a tree-mutation plan**.

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

Treat as its own deliverable, not optional wiring.
- Use `moveAssessmentBatch` over the candidates the analyzer needs.
- Reproduce `BrilliantAnalyzer` thresholds (unintuitive ≤0.10, reveal ≥0.30,
  sound) — port the classifier or send `(humanProbability, winChanceAfter)` +
  Stockfish evals to a server `classify` endpoint (no compute) that reuses the
  existing Python `BrilliantAnalyzer`.
- Acceptance: the Gold Coin game (`brilliant-search-cap` memory) still flags
  exactly `23...Qg3` in the browser path.

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
