# Browser-Engine Migration Plan

Goal: move Stockfish/Maia compute from server to browser so the public multi-user version can scale.

Target: public multi-user web app, frontend built with npm + Vite.

## Locked Decisions

- Deployment: public multi-user web app.
- Bundler: Vite.
- Stockfish: Lichess `@lichess-org/stockfish-web` path for prototype.
- Maia: Maia3 in browser via ONNX, mirroring MaiaChess.
- Maia runtime: choose fastest available backend at runtime/implementation time:
  - try WebGPU when available and stable,
  - otherwise use ORT Web WASM/SIMD/threaded,
  - keep fallback path explicit.
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
- `ServerEngineProvider`
  - optional fallback only

Server shared:
- Auth/session
- Per-user data
- Per-user Lichess OAuth
- Repertoire/progress/analysis storage
- Analysis save/classification endpoints
- Optional queued/rate-limited server engine fallback

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
- Server-side Maia3 fallback is optional.
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
- Wrap current server APIs as `ServerEngineProvider`.

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
- Fallback to `ServerEngineProvider` if browser engine unavailable.

Acceptance:
- Engine widget streams PVs from browser.
- Happy path does not call `/api/engine/*`.
- Server Stockfish can be stopped and widget still works.

---

## Phase 2: Browser Whole-Game Analysis

Move Stockfish eval compute to browser.

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

Tasks:
- Self-host `maia3_simplified.onnx`.
- Add `onnxruntime-web`.
- Add Maia worker.
- Add IndexedDB model cache.
- Add download/progress UX.
- Add `Maia3Provider`.
- Implement/port:
  - board preprocessing
  - legal move mask
  - move index mapping
  - policy decoding
  - value decoding
- Wire Build human candidate generation to browser Maia3.
- Keep server fallback optional only.

Acceptance:
- Build can produce human-like candidate moves with server Maia disabled.
- First model download shows progress.
- Subsequent loads use cached model.
- Works on at least one Chromium browser.

Risk:
- ONNX input/output contract mismatch.
- 45MB first download.
- browser backend differences.
- mobile performance.

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
  - Engine mode
  - Depth
  - Threads/performance mode
  - Server fallback toggle
- Store settings per user.

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
- Add rate limiting for server fallback.
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

Server fallback:
- Optional.
- Must be queued, rate-limited, and capped.
- Do not rely on it for scale.

Performance:
- Desktop Chromium should be the first target.
- Mobile fallback may need lower depth or server queue.

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
