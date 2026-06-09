# PrepForge Chess — SaaS Roadmap

> **Purpose:** single source of truth for the "monetized website" migration, so
> work can be resumed across separate chat sessions. When you start a new
> session, point the assistant here: _"read docs/ROADMAP.md and continue the
> current phase."_

## Product decision (locked)

Turn PrepForge into a **monetized website** (hosted storage + team collaboration
+ classroom), while **open-sourcing the whole codebase under GPL-3.0** (forced by
python-chess GPL / maia3 AGPL). Money comes from hosted data access, never the
engine code. Engines run **in the browser** — the server stores data, enforces
ownership, and bills; it never computes chess.

### Architecture (locked)
- **Backend:** FastAPI (new `src/prepforge_chess/api/`), replacing the 3146-line
  stdlib `web/server.py` via **strangler pattern** (both run side-by-side until
  Phase 2 finishes).
- **DB:** PostgreSQL in prod, SQLite for dev/tests, one `DATABASE_URL`.
- **Identity:** Email + password is the primary account (owns plan + Stripe).
  Lichess OAuth is a *linked account* for game import only.
- **Billing:** personal paywall, Free/Pro on `users.plan`. Team/classroom schema
  exists but **no per-seat billing** — a team is a feature, gated by plan logic.

## Conventions
- New code lives in `prepforge_chess.api.*`. Don't extend `web/server.py`.
- Every phase ships with tests and leaves `pytest` green.
- Migrations via Alembic: `py -m alembic revision --autogenerate -m "..."` then
  `py -m alembic upgrade head`.
- Run API locally: `uvicorn prepforge_chess.api.main:app --reload` → http://127.0.0.1:8000/docs
- Install deps: `py -m pip install -e ".[server,dev]"`

---

## Phases

### Phase 1a — Foundation + Identity ✅ DONE
Email/password auth, sessions, security headers, health, DB/migrations skeleton.
- Files: `api/{config,db,models,security,deps,middleware,main}.py`,
  `api/routers/auth.py`, `migrations/`, `tests/test_api_auth.py`.
- Acceptance: register→me→logout→login works; CSP/nosniff/frame headers present;
  `/healthz` ok; Lichess token encryptable (Fernet). **All met.**

### Phase 1b — Security baseline ✅ DONE
Harden the public surface before porting endpoints.
- [x] Rate limiting (slowapi) on auth endpoints (brute-force defense).
- [x] CSRF double-submit (cookie + `X-CSRF-Token` header) on unsafe methods.
- [x] Lichess OAuth wired as **account linking** → `linked_accounts` with the
      token **encrypted at rest** (replaces legacy plaintext `settings_json`).
- [x] Peer-review fixes: throttle `last_seen_at` writes (≤ every 5 min);
      test HSTS in prod mode.
- Files: `api/ratelimit.py`, `api/middleware.py` (+CSRF), `api/routers/lichess.py`,
  `tests/test_api_security.py`, `tests/test_api_lichess.py`.
- Acceptance: >N logins/min → 429; unsafe request without CSRF token → 403;
  Lichess link/callback/unlink works with mocked network; tokens stored encrypted.
- Deferred to later (tracked, non-blocking): expired-session purge scheduling +
  per-user session cap → **Phase 6**; trust `X-Forwarded-For` for rate-limit key
  once behind Render proxy → **Phase 3**.

### Phase 2 — Port legacy endpoints 🔶 IN PROGRESS
Move `web/server.py` `/api/*` handlers into FastAPI routers; rewrite
`storage/repositories.py` (raw sqlite3) to SQLAlchemy so it runs on Postgres.
Carry over the existing `owner_user_id` isolation; bridge legacy `user_profiles`
↔ new `users`. Retire the global `request_lock`.
- Acceptance: frontend (`web-src/app.js`) works against the FastAPI app; legacy
  server deletable.

**Strategy (locked): keep the public seams, swap the backend.** `PrepForgeRepository`
is consumed by 7 services + CLI (×4) + the legacy web server + ~13 test files. To
avoid churning all of them at once we preserve the *public API* — the method
signatures, the `core.models` dataclass returns, AND the
`connect_database()` / `initialize_database()` factory names — and only change what
they return/use internally (sqlite3 → SQLAlchemy). The existing repository test
suite is the regression net at every step.

**Sub-slices (do in order; each leaves `pytest` green):**
- **2a-1 ✅ Legacy schema as SQLAlchemy** — define the 19 legacy tables
  (`user_profiles`, `games` (+`owner_user_id`), `positions`, `engine_evaluations`,
  `moves`, `analysis_results`, `maia_predictions`, `repertoires`, `opening_nodes`,
  `opening_lines`, `generation_runs`, `training_sessions`, `training_progress`,
  `training_mistakes`, `lichess_imports`, `practical_opening_matches`,
  `engine_settings`, `app_settings`, `user_sessions`) as SQLAlchemy Core `Table`s
  on the shared `api.db.Base.metadata`, so one `MetaData`/one Alembic manages the
  whole DB and Postgres DDL is generated, not hand-rolled. Faithful port of types
  (JSON/datetime kept as TEXT, bool-flags as INTEGER) to minimize repo-logic change
  in 2a-2; JSONB/TIMESTAMPTZ optimization is deferred. Drift-guard test asserts the
  SQLAlchemy schema == `schema.sql` + runtime migrations. File: `storage/sa_tables.py`,
  `tests/test_sa_tables.py`. **Additive — no consumer touched.**
- **2a-2 ✅ Backend swap** — `PrepForgeRepository` internals reimplemented on
  SQLAlchemy Core (against `sa_tables`); constructor takes an `Engine`.
  `connect_database`/`initialize_database` now return a SQLAlchemy `Engine`
  (SQLite via `StaticPool` for `:memory:`, FK pragma per connection) so the ~20
  call sites stay unchanged. sqlite-isms translated: `?`→bound params,
  `ON CONFLICT`→dialect-aware `_upsert` (sqlite/pg `insert().on_conflict_do_update`,
  `COALESCE(existing, excluded)` for owner-fill), `COLLATE NOCASE`→`func.lower()`,
  dynamic `IN (...)`→`col.in_()`. **Decision (locked):** chose the *full factory
  swap* over a shared-connection bridge — legacy SQLite API compat isn't valuable
  and the d4 data is disposable. So the remaining raw-`sqlite3` consumers were ported
  in the same pass: `AppSettingsService` and the legacy `web/server.py` (13 inline-SQL
  sites: dashboard counters + owner-gate helpers, via `text()`/Core on `self.engine`).
  The runtime sqlite migration machinery (`_apply_migrations`,
  `_apply_multitenancy_migration`, `_drop_legacy_global_lichess_unique`,
  `_ensure_column`, `_ensure_legacy_profile`) is **retired** — `metadata.create_all`
  owns DDL now; fresh DBs ship the per-owner-unique `games` schema directly. The
  obsolete in-place-migration test was dropped (its per-owner-dedup assertion is
  already covered by `test_two_owners_import_same_lichess_game_independently`).
  `create_user_profile` supplies the three columns `schema.sql` used to default
  server-side (`preferred_engine`/`default_analysis_depth`/`settings_json`), since
  `sa_tables` carries no server defaults. `schema.sql` is kept **only** as the
  static drift reference (now a complete mirror: `owner_user_id` + `user_sessions`
  + the 3 multi-tenancy indexes folded in); `tests/test_sa_tables.py` loads it via a
  throwaway `sqlite3` connection, decoupled from the production path.
- **2a-3 ✅ Alembic baseline** — `migrations/env.py` now imports
  `prepforge_chess.storage.sa_tables` so the 19 legacy tables register on
  `Base.metadata` alongside the identity tables. Generated
  `9fc171c00d10_legacy_domain_tables_baseline` (revises the identity baseline
  `bbed25d490b5`) covering all 19 tables + FKs + indexes. `alembic upgrade head`
  applies clean; `alembic check` reports **"No new upgrade operations detected"**
  (zero drift); fresh-DB `upgrade head`→`downgrade base` round-trips cleanly. One
  Alembic history now owns the whole schema (identity + legacy). `schema.sql` +
  `tests/test_sa_tables.py` retained for now as the static drift reference; can be
  retired once nothing else reads `schema.sql` (follow-up).
- **2b Endpoint port** — move `web/server.py` `/api/*` handlers into FastAPI routers
  reusing the now-SQLAlchemy repository; retire the global `request_lock`; bridge
  `user_profiles` ↔ `users`. Legacy server deletable when `web-src/app.js` runs green
  against FastAPI.
  - **2b-1 ✅ Bridge + read-only slice** — **bridge decision (locked): the data-owner
    id IS `users.id`.** `current_owner` (`api/deps.py`) resolves the authenticated
    `User` to an `owner_user_id` by lazily materializing a `user_profiles` row whose
    `id == user.id` (`repository.ensure_profile`, idempotent `ON CONFLICT DO NOTHING`),
    so legacy owner-scoped queries find an owner with **no schema change** (additive,
    `alembic check` still clean). The repository binds to the API's shared engine
    (`api/db.get_engine`) via `get_repository`, so identity (ORM `Session`) and domain
    data (Core) run on one DB/pool — no `request_lock`. Ported read-only endpoints:
    `GET /api/dashboard`, `GET /api/repertoires` (`api/routers/workspace.py`), and a
    `GET /api/auth/status` compatibility shim (signed-in keys off the session now, not
    a Lichess username). 6 new tests (`tests/test_api_workspace.py`) cover auth-gating,
    empty-workspace payloads, status display-name/email fallback, and owner isolation.
  - **2b-2a ✅ Repertoire write path** — ported the two repertoire mutations whose
    SPA responses are ignored, so they need no Build-view payload: `POST
    /api/repertoires/delete` and `POST /api/repertoires/set-active`
    (`api/routers/workspace.py`). Both reuse `current_owner` and pass through a new
    `_owned_repertoire` IDOR gate (foreign/missing repertoire → **404**, mirroring the
    legacy `_assert_repertoire_owner`; unclaimed NULL-owner rows allowed). Implemented
    directly on the repository — new `repertoire_meta` (lightweight id/name/is_active/
    owner lookup, no tree load) + `set_repertoire_active`; `delete_repertoire` already
    existed and cascades (opening_nodes/training FKs are `ON DELETE CASCADE`) — so **the
    Maia-requiring `OpeningBuilderService` is bypassed entirely**. CSRF is enforced by
    the existing middleware (tests cover 403-without-token, 401-without-session,
    cross-owner 404, delete + set-active round-trips). 5 new tests; **219 green**, ruff
    clean, `alembic check` still zero-drift.
  - **2b-2b ✅ Build-view unblock + `build/load`** — **resolved the Maia blocker:**
    `OpeningBuilderService` no longer requires a Maia adapter at construction — the
    no-silent-fake guard moved to a `maia` *property* that raises only when the
    generation path actually reads the model (`opening_builder.py`). `tree_report` /
    `create_repertoire` / `add_move` are pure data and now work model-free, matching
    "server never computes chess". Extracted the Build payload into a shared, Maia-free
    `services/workspace_view.py` (`build_workspace_payload` + `opening_item_to_json` +
    `engine_eval_to_json`) and ported **`GET /api/build/load?repertoire_id=`**
    (`api/routers/workspace.py`, owner-gated via `_owned_repertoire`). Updated the
    `test_maia_adapter` contract test (construction OK; `.maia` access still raises).
    The legacy `_build_workspace_payload`/`_opening_item_to_json`/`_engine_eval_to_json`
    are left in place (feature-frozen) and will be **deleted with `web/server.py`** rather
    than refactored to delegate — temporary, self-resolving duplication. **222 green**,
    ruff clean, zero-drift.
  - **2b-2c ✅ Build write path** — ported the three Build mutations onto the
    `current_owner` bridge: `POST /api/repertoires/create`, `POST /api/build/rename`,
    `POST /api/build/add-move` (`api/routers/workspace.py`). All run on the **Maia-free**
    `OpeningBuilderService` (pure data ops) and return `build_workspace_payload`.
    Ownership: create stamps the caller via a new `repository.claim_repertoire`
    (fill-NULL-only `UPDATE`, mirrors legacy `_claim_repertoire` — never reassigns an
    existing owner); rename/add-move pass through `_owned_repertoire` (foreign → 404).
    add-move replicates the legacy classification (own-turn move → `prepared` tag +
    `is_user_prepared_move`; first enabled child → mainline). Input validation matches
    legacy (`ValueError`/bad color/empty name/illegal move → **400**, blank name →
    "Untitled repertoire"). 9 new tests (auth/CSRF gating, owner isolation, claim,
    round-trips, validation). **233 green**, ruff clean, zero-drift.
  - **2b-2d-i ✅ Analyze browser-compute flow** — ported the Analyze view's job
    endpoints onto the bridge: `POST /api/analyze/prepare` (import PGN owner-scoped →
    return positions + move skeleton), `POST /api/analyze/classify-save` (replay the
    browser's per-position evals through the unchanged `AnalysisService` via
    `ReplayEngine`, with optional `ReplayMaia`-backed Brilliant detection, and persist),
    plus reads `GET /api/analyses` + `GET /api/analyses/{id}` and the pure
    `GET /api/board` FEN utility (`api/routers/analyze.py`). The **server-engine**
    variants (`/api/analyze/pgn`, `/pgn/start`, `/status`, `/cancel`, `/demo`,
    `/api/jobs/active`) are deliberately **dropped** — they need a server engine the
    SaaS deploy doesn't run. Ownership: new `repository.claim_or_verify_game`
    (fill-NULL + verify, mirrors legacy `_claim_or_verify_game`) — fresh import claims,
    foreign game → 404 (classify-save) / 404 (recall, via owner-scoped load). Shared
    Maia-free serializer `services/analysis_view.py` (`analysis_result_to_payload`,
    mirrors `workspace_view.py`; legacy `_analysis_payload` frozen, deleted with the old
    server). Validation matches legacy (empty PGN/positions, incomplete payload, bad
    maia_assessment → 400). 15 new tests (`tests/test_api_analyze.py`). **248 green**,
    ruff clean, zero-drift.
  - **2b-2d-ii ✅ Build-Generate apply-plan** — ported `POST
    /api/build/generate/apply-plan` onto the `current_owner` bridge
    (`api/routers/workspace.py`). The browser ran the whole Stockfish+Maia3
    generation recursion locally and submits a tree-mutation plan; the endpoint runs
    **no engine** — it reuses the existing `OpeningBuilderService.apply_generation_plan`
    (re-validates legality + parentage server-side, recomputes `is_mainline` /
    `is_user_prepared_move`, persists all-or-nothing) and returns
    `build_workspace_payload` with the run summary. Owner-gated via `_owned_repertoire`
    (foreign → 404); malformed plan (illegal move, non-generated source, rootNodeId
    mismatch, unknown anchor) → 400. The **server-engine** variants
    (`/api/build/generate`, `/start`, `/cancel`, `/status`) are deliberately **dropped**
    (need a server-side engine the SaaS deploy doesn't run). 10 new tests
    (`tests/test_api_build_generate.py`). **258 green**, ruff clean, zero-drift.
  - **2b-2d-iii ✅ Settings (per-owner)** — ported `GET`/`POST /api/settings`
    (`api/routers/settings.py`). The only persistent preference in the browser-compute
    model is the Stockfish **depth** the SPA's WASM engine runs at. **Multi-tenancy
    fix vs legacy:** the old single-tenant server kept depth in the *global*
    `app_settings` key/value store (one value shared by all users); the SaaS API stores
    it **per owner** on `user_profiles.settings_json` via the existing
    `get/set_profile_setting` (same mechanism as the Lichess token), so one tenant's
    depth never changes another's. Shared `services.app_settings.owner_stockfish_depth`
    +`clamp_stockfish_depth` helpers; `/api/analyze/prepare` + `classify-save` now read
    the **per-owner** depth (not the global) so prepare echoes exactly what settings
    persisted. `POST` uses `StrictInt` (bool/float/string → 422, never silent-coerced
    `true`→1); out-of-range *integers* are clamped, not rejected. The legacy
    *server-engine introspection* (Stockfish binary path/version, CUDA availability,
    Maia3 package, install action) is deliberately **dropped** — the SaaS deploy runs no
    engine to introspect. 10 new tests (`tests/test_api_settings.py`). **268 green**,
    ruff clean, zero-drift. **Note:** `main.py` imports the router as `settings_router`
    to avoid shadowing the `settings = get_settings()` config local inside `create_app`.
  - **2b-2d-iv ✅ Lichess import/compare** — ported the Lichess game endpoints onto the
    bridge in `api/routers/lichess.py` (the OAuth *linking* was already done in 1b):
    `GET /api/lichess/compare` (fetch the linked account's recent **public** games — no
    token needed, only the username — and match each against THIS owner's repertoires via
    `lichess_fetch.compare_recent_games`, owner-scoped), `GET /api/lichess/latest` (the
    "you just finished a game" watcher: latest game flagged `is_new` against a per-owner
    last-seen marker; `include_moves` returns the PGN for feeding into Analyze), and
    `POST /api/lichess/seen` (records the acknowledged game id). **Multi-tenancy:** the
    username comes from the caller's `LinkedAccount.provider_user_id` (never a
    client-supplied one), comparison scopes to the caller's repertoires, and the last-seen
    marker lives **per-owner** on `user_profiles.settings_json` (key `lichess.last_seen_game_id`).
    No link → 400; upstream Lichess failure → 502. No separate `/import` endpoint — import
    happens through the existing Analyze `prepare` flow. 12 new tests
    (`tests/test_api_lichess_games.py`, network + OAuth mocked). **283 green**, ruff clean,
    zero-drift.
  - **2b-2d-iv-compat ✅ Legacy SPA Lichess seams** — peer review caught that the new
    router dropped four surfaces `web-src/app.js` still calls, which would break the
    FastAPI cutover. Added thin compatibility shims in `api/routers/lichess.py` (no
    behaviour change, no new compute): **`GET /api/lichess/status`** → legacy
    `{connected, username}` shape (the new `GET /api/lichess` returns `{linked, ...}`)
    for the account chip / OAuth fallback poll / game watcher; **`POST /api/lichess/compare`**
    accepting `{username, count}` — the client `username` is **ignored** (compare stays
    owner-scoped to the linked account; multi-tenant isolation preserved) and `count` is
    clamped 1..50; **`GET /api/lichess/latest?light=1`** mapped to `include_moves=False`
    (metadata-only path that carries the true `finished_at`, so the recency gate keeps
    working); **`GET /oauth/login`** (unprefixed `legacy_router`) aliasing
    `/api/lichess/login` so the popup flow doesn't 404 (the PKCE `redirect_uri` is still
    `/api/lichess/callback`, so the callback handler is shared). 8 new tests in
    `tests/test_api_lichess_games.py`. **291 green**, ruff clean. **Known cutover detail
    (not a shim):** the new callback redirects to `/?lichess=linked` instead of the
    legacy postMessage-and-close HTML, so the OAuth popup stays open; the SPA's fallback
    status poll still completes the link. Closing the popup is left to the SPA cutover.
  - **2b-2d-v ✅ Train (trainer)** — ported the spaced-repetition trainer onto the
    `current_owner` bridge: `POST /api/train/{start,move,skip,hint}`
    (`api/routers/train.py`). `TrainingService` walks the stored repertoire tree with
    python-chess (move legality only) — **no Stockfish/Maia runs server-side**, so this
    is a straight port, fully consistent with "server never computes chess". Shared
    Maia-free serializer `services/training_view.py` (`prompt_to_json` /
    `training_line_to_json` / `heuristic_strategy` / `walk_opening_nodes`, mirrors
    `workspace_view.py`; legacy `_prompt_to_json`/`_training_line_to_json`/
    `_heuristic_strategy` frozen, deleted with the old server). Ownership: `/start` gates
    via `_owned_repertoire` then loads **without** the owner filter (matches legacy);
    session-keyed endpoints pass through a new `_owned_session` (session→repertoire owner,
    foreign → 404, mirrors legacy `_assert_session_owner`). Validation: bad
    `TrainingMode` → 400, illegal/empty move (`ValueError`) → 400, untrainable repertoire
    (no own-move lines) → 400. The unauthenticated demo (`/api/train/demo/start`) is
    deliberately **dropped** (mirrors the dropped `/api/analyze/demo`): the SaaS model is
    account-centric and a shared ownerless demo repertoire has no clean home in the
    multi-tenant DB. Also added the **`POST /api/auth/signout`** legacy shim the SPA still
    calls (web-src/app.js → `{ok: true}`; shares logout's session-close, no guest-session
    rotation in the SaaS model). 13 new tests (`tests/test_api_train.py`). **304 green**,
    ruff clean, zero-drift.
  - **2b-2d-vi ✅ SPA CSRF wiring** — the blocker for real-browser testing. New
    dependency-injectable `web-src/csrf.js` (`readCsrfCookie` / `isSafeMethod` /
    `createCsrfTokenSource`): reads the non-HttpOnly `pf_csrf` cookie, bootstraps
    `GET /api/csrf` once (de-duped across concurrent first-load POSTs) when it's
    missing, and `app.js`'s `api()` now attaches `X-CSRF-Token` on every unsafe
    method (covers `postJson` **and** the 3 direct `api(..., {method:"POST"})`
    sites). Also: `api()` sends `credentials:"same-origin"` and reads
    `payload.error || payload.detail` so FastAPI's `{detail}` error shape surfaces
    real messages post-cutover. 14 new vitest cases (`web-src/csrf.test.js`);
    full JS suite **154 green**. No Python change.
  - **2b-2d+ remaining** — retire `request_lock` fully (dead code in
    `web/server.py`, deleted with it); then the real-frontend smoke test +
    delete `web/server.py`.
  - **2b-2e ✅ Remaining SPA endpoints ported (smoke-test unblocker).** The six
    handlers the GAP flagged — plus a **7th** the audit caught (`GET
    /api/repertoires/export-pgn`, the top-level tree-PGN export, which neither the
    original "all ported" note nor the peer review's list of 6 had) — are now on the
    `current_owner` bridge. All pure data/utility (no engine), owner-gated where they
    touch stored data:
    - `POST /api/build/action` → `build_action` (set-mainline / toggle-prepared /
      toggle-branch / delete / comment / tag / queue / critical), `_owned_repertoire`
      gate, toggles read live node state, unknown action / illegal op → 400.
    - `POST /api/build/annotations` → `build_annotations` (persist arrows/circles, echo
      back; no full reserialization, matching legacy).
    - `POST /api/build/export` + `GET /api/repertoires/export-pgn` → `build_export` /
      `export_tree_pgn` (json package / mainline-or-path PGN / full tree PGN; bad
      format → 400). All three in `api/routers/workspace.py`.
    - `POST /api/repertoires/import` → `import_repertoire`. **Multi-tenancy fix vs
      legacy:** the package carries the *original* repertoire/node ids, so a second
      user importing the same package would upsert onto the first user's row (a
      cross-tenant data clobber — owner stays put via COALESCE, but the victim's tree
      gets overwritten). New `_reassign_ids` mints fresh ids for the repertoire + every
      node (remapping parent links) so each import is an independent repertoire the
      importer owns. Empty package → 400.
    - `POST /api/repertoires/import-pgn` → `import_repertoire_pgn` (tree PGN → branches;
      `import_tree_pgn` already generates fresh uuids, so no re-id needed; bad color → 400).
    - `POST /api/board/move` → `board_move` in `api/routers/analyze.py` (extracted a
      shared `_board_payload` helper alongside the existing `GET /api/board`). **Decision
      (locked): ported as a stateless server utility, NOT moved client-side.** It's pure
      python-chess (legality + SAN echo), auth-gated only; porting keeps the cutover a
      pure backend swap with zero SPA logic change. A later optimization can move it to
      chess.js, but that's not a cutover blocker. Illegal move / bad FEN → 400.
    - **Train demo (finding #2):** `/api/train/demo/start` stays **dropped** (no unauth
      demo in the SaaS model). Fixed the SPA instead — `web-src/app.js::startTraining`
      no longer calls it when there's no repertoire; it prompts "Create a repertoire in
      Build first" and returns early, so the smoke test won't 404.
    - 24 new tests (`tests/test_api_build_actions.py`): board/move utility, every node
      action, annotation persistence, json/pgn/tree export, package + PGN import incl. the
      cross-tenant-isolation regression, owner-gating + CSRF. **326 green**, ruff clean.
  - **SPA cutover note:** ~~the legacy `postJson` does not yet send `X-CSRF-Token`~~
    **resolved in 2b-2d-vi above.**
  - **2b-2f ✅ FastAPI serves the SPA + browser smoke (cutover unblocker).** The
    FastAPI app had no static serving — only API routes — so the *same* `web-src/app.js`
    could not actually run against it in a browser. Added `api/static.py`
    (`register_static`, wired last in `main.py` so the `/api` + `/oauth` routers win):
    serves `GET /` (the app shell) and `GET /static/{path}` with a faithful port of the
    legacy serving semantics — explicit engine MIME types (wasm/onnx/workers),
    `Cache-Control` (immutable for content-hashed/`.wasm`/`.onnx`, `no-cache` for the
    shell), `PREPFORGE_MAIA3_ASSET_BASE` runtime injection into the HTML, the
    `web-src/public/maia3/` dev-weights fallback, and a path-traversal guard. **Key
    cutover detail:** cross-origin **isolation headers** (`COOP: same-origin` +
    `COEP: require-corp` on the document, `CORP: same-origin` on assets) are set *here*,
    on the static responses only — not globally — so the threaded WASM engines get
    `SharedArrayBuffer` (`crossOriginIsolated === true`) without breaking the dev `/docs`
    page or the JSON API under `require-corp`. 7 new tests (`tests/test_api_static.py`):
    index + isolation headers, hashed-asset immutable cache + CORP, 404s, traversal guard,
    asset-base injection (incl. `</script>` escape). **Real-browser smoke PASSED**
    (uvicorn + built SPA): `crossOriginIsolated` true; shell boots with **zero console
    errors**; CSRF bootstrap → register (201, session cookie) → `auth/status` signed_in →
    create repertoire → add-move all succeed through the live ASGI stack via the SPA's
    `api()` wrapper; POST without `X-CSRF-Token` → 403; session persists across reload
    (dashboard renders the created repertoire); `/oauth/login` issues its redirect.
    **333 green**, ruff clean. (Local `.claude/launch.json` gained a `saas-api` uvicorn
    entry for `preview_start`; the dev DB is `alembic upgrade head` on the default
    gitignored SQLite.)

### Phase 3 — Postgres cutover + deploy entrypoint 🔶 CODE DONE (deploy is user-side)
**Status (2026-06-08):** all the *code/config* for the cutover is done and verified
locally — `Dockerfile` now installs `.[server]` and runs `uvicorn …api.main:app
--proxy-headers` (no legacy server, no Stockfish/Maia, no SQLite disk); `render.yaml`
provisions managed Postgres, runs `alembic upgrade head` as a `preDeployCommand`, sets
the prod env vars, and health-checks `/healthz`; `config.py` auto-pins Postgres URLs to
the `postgresql+psycopg://` driver (Render hands back a bare scheme); a CI workflow
(`.github/workflows/ci.yml`) gates pytest+ruff+alembic and vitest+build. **Preflight
passed:** 338 Py tests, 154 JS tests, ruff clean, alembic zero-drift, prod-mode uvicorn
boot (`/docs` 404, `/` serves the SPA with COOP/COEP, register→status→CSRF-403 round-trip),
and the built wheel was confirmed to bundle the SPA shell + JS/CSS + both WASM engines +
manifest with **zero ONNX weights**. **Remaining = operational (needs the user's Render
account):** connect the repo, set `PREPFORGE_SECRET_KEY` in the dashboard, deploy, then run
the Phase 3d production smoke checklist. The legacy `web/server.py` (+ `request_lock` + the
CLI `ui` command) has now been **deleted** (Phase 2b finish-line complete), so there is no
hidden legacy production path — a rollback is a git revert, not a second live entrypoint.

Provision Render managed Postgres; run Alembic; connection pool; honor proxy
headers (`uvicorn --proxy-headers`) so rate-limit/IP logic sees real client IPs.

**Deployment reality (today): the deployed image still runs the LEGACY server.**
`Dockerfile` installs `.` (NOT `.[server]`, so FastAPI/SQLAlchemy/Alembic are absent
from the image) and its `CMD` launches `python -m prepforge_chess ui` (the stdlib
`web/server.py`), not the SaaS API. So `render.yaml` deploys legacy, by design, while
Phase 2 finishes — **the SaaS backend is not live and must not be described as such.**
The cutover (do as one atomic switch, only after the remaining 2b work + SPA CSRF are
done so the SPA can actually talk to the API):
- [ ] Dockerfile: `pip install .[server]` so the SaaS deps land in the image.
- [ ] Provide a Postgres-backed `DATABASE_URL` (Render managed PG) instead of the
      SQLite disk; drop the `/data` disk mount once off SQLite.
- [ ] Run `alembic upgrade head` as a release/entrypoint step **before** the server
      starts — neither the Dockerfile nor the FastAPI app creates tables in prod today,
      so a fresh DB would be empty. (The app deliberately does not `create_all` on
      boot; migrations own prod DDL.)
- [ ] Switch `CMD` to `uvicorn prepforge_chess.api.main:app --host 0.0.0.0 --port $PORT
      --proxy-headers`.
- [ ] Set `PREPFORGE_ENV=production` + a strong `PREPFORGE_SECRET_KEY`
      (`require_production_secret` fails loudly otherwise) + `PREPFORGE_ALLOWED_ORIGINS`.
- Acceptance: prod runs on Postgres via uvicorn+FastAPI; `alembic upgrade head` applied
  on deploy; load test shows concurrent writes don't lock.

### Phase 4 — Billing (Stripe) 🔶 CODE DONE (needs Stripe keys to go live)
Implemented in `api/routers/billing.py` (registered in `main.py`):
- `GET /api/billing/status` → `{plan, billing_enabled, price_configured}`.
- `POST /api/billing/checkout` → Stripe Checkout (mode=subscription) for the Pro
  price; creates/reuses the Stripe customer (`users.stripe_customer_id`); returns the
  redirect URL. 503 if unconfigured, 409 if already Pro.
- `POST /api/billing/portal` → Stripe customer portal URL (manage/cancel). 400 if the
  user has no customer yet.
- `POST /api/stripe/webhook` → **CSRF-exempt, signature-verified, idempotent**; the
  authority on `users.plan`. Handles `checkout.session.completed` (→ Pro),
  `customer.subscription.updated` (active/trialing → Pro, else Free), and
  `customer.subscription.deleted` (→ Free). Each event id is recorded in the new
  `stripe_events` table inside the same txn, so a redelivery is a no-op.
- **Free/Pro quota:** Free users are capped at `PREPFORGE_FREE_REPERTOIRE_LIMIT`
  (default 5) repertoires — `POST /api/repertoires/create` returns **402** past the cap
  (new lightweight `repository.count_repertoires`); Pro is unlimited.
- **CSRF note resolved:** `CSRFMiddleware` now takes `exempt_paths` via its constructor
  (injected at `create_app()` as `{billing.WEBHOOK_PATH}`) — the mutable module-level
  `CSRF_EXEMPT_PATHS` global is gone.
- Migration `f6818a5e1449` (`stripe_events`); `alembic check` zero-drift.
- 15 tests `tests/test_api_billing.py` (Stripe SDK fully mocked): status/gating, checkout
  customer-create + URL + 409, portal 400/URL, webhook 503/bad-signature-400/plan-flip/
  idempotent/downgrade, and the Free quota 402 + Pro bypass. **Acceptance met:**
  upgrade→Pro flips plan, quota enforced, webhook idempotent.
- **To go live (user):** set `PREPFORGE_STRIPE_SECRET_KEY`, `PREPFORGE_STRIPE_WEBHOOK_SECRET`,
  `PREPFORGE_STRIPE_PRICE_PRO`; register the webhook endpoint in the Stripe dashboard.
  *(Stripe SDK already ships in `.[server]`.)*

### Phase 5 — Teams / classroom ⬜
Add `team_id` + `visibility (private|shared|team)` to repertoires (now in
SQLAlchemy). Sharing, membership roles, classroom teacher/student views. "Create
team" gated to Pro. No seat billing.
- Acceptance: shared repertoire visible to team members per role.

### Phase 6 — Ops / launch ⬜
Sentry, structured logging, DB backups, graceful shutdown, expired-session purge
+ session cap (deferred from 1b), CDN for ONNX weights, CI (GitHub Actions:
pytest + ruff), legal pages (ToS/Privacy/GDPR).
- Acceptance: green CI; monitored; backed up; can onboard a real paying user.

---

### Phase 3 replacement plan - GitHub + Render cutover
The short Phase 3 checklist above is now **superseded** by this concrete deploy plan.
Phase 2 endpoint porting, CSRF, FastAPI static serving, and real-browser smoke are done;
the next work is an atomic switch from the legacy SQLite/stdlib deployment to the
FastAPI/Postgres SaaS deployment.

**Current deploy reality:** `Dockerfile` and `render.yaml` still deploy the legacy
stdlib app. `Dockerfile` installs `.` (not `.[server]`) and starts
`python -m prepforge_chess ui`, so Render would run `web/server.py` and SQLite under
`/data`. That is not enough for SaaS launch.

#### Phase 3a - Preflight before touching Render ✅ DONE
- [x] Commit generated static assets consistently: old `index-DZQ9yCXi.js(.map)` removed,
      new Vite `index-Doi_VsnZ.js(.map)` added, `static/index.html` points at the new hash.
- [x] Verify local deploy build: `pytest` **338 green**, `npm test` **154 green**, `npm run
      build` OK, `ruff` clean, `alembic upgrade head` + `alembic check` zero-drift.
- [x] Verify production-mode local boot (uvicorn, `PREPFORGE_ENV=production`, SQLite
      preflight DB migrated via `alembic upgrade head`).
- [x] Confirmed `/docs` 404 in prod, `/healthz` ok, `/` serves the SPA with COOP/COEP/CORP +
      CSP + HSTS (so `crossOriginIsolated` will be true), and register→status→CSRF-403 +
      create round-trip work through the live ASGI stack.
- [x] **Extra (deploy de-risk):** built the wheel and confirmed `pip install .[server]`
      bundles the SPA shell + hashed JS/CSS + both WASM engines + maia3 manifest as package
      data, with **zero ONNX weights** — so the non-editable Docker install serves `/`.

#### Phase 3b - Dockerfile switch ✅ DONE
- [x] Install SaaS extras: `pip install --no-cache-dir ".[server]"`.
- [x] Legacy server gone from the image. `CMD` is now
      `uvicorn prepforge_chess.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers`.
- [x] Removed `PREPFORGE_DB_PATH`, `/data` creation, and `install-stockfish` from the image.
- [x] Static build ships via committed Vite output (package-data, verified in the wheel) —
      `COPY src` carries it; no Node stage needed. Also `COPY alembic.ini` + `migrations` so
      the Render `preDeployCommand` can run `alembic upgrade head` inside the image.

Recommended simple first-cut Docker contract:
```dockerfile
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml README.md alembic.ini ./
COPY migrations ./migrations
COPY src ./src
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir ".[server]"
EXPOSE 8000
CMD ["sh", "-c", "uvicorn prepforge_chess.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
```

#### Phase 3c - Render blueprint ✅ DONE (in `render.yaml`; provisioning is user-side)
- [x] `render.yaml` declares a managed Postgres (`prepforge-chess-db`) and wires its
      `connectionString` into `DATABASE_URL`. `config.py` pins the scheme to
      `postgresql+psycopg://` automatically, so a bare `postgres://`/`postgresql://` boots.
- [x] SQLite disk removed from `render.yaml`; no `/data` mount.
- [x] `preDeployCommand: alembic upgrade head` runs before every release (app never
      `create_all()`s in prod). Also `healthCheckPath: /healthz`.
- [x] Prod env vars set in the blueprint: `PREPFORGE_ENV=production`,
      `PREPFORGE_SECRET_KEY` (`sync:false` — set in dashboard), `DATABASE_URL` (fromDatabase),
      `PREPFORGE_ALLOWED_ORIGINS`. `PREPFORGE_MAIA3_ASSET_BASE` left for later (CDN).
- [x] No Stripe env vars (deferred to Phase 4).
- [ ] **User action:** connect the repo to Render, set `PREPFORGE_SECRET_KEY` in the
      dashboard (`python -c "import secrets; print(secrets.token_urlsafe(48))"`), and deploy.

Recommended Render shape:
```yaml
databases:
  - name: prepforge-chess-db
    plan: starter

services:
  - type: web
    name: prepforge-chess
    runtime: docker
    plan: starter
    preDeployCommand: alembic upgrade head
    envVars:
      - key: PREPFORGE_ENV
        value: production
      - key: PREPFORGE_SECRET_KEY
        sync: false
      - key: DATABASE_URL
        fromDatabase:
          name: prepforge-chess-db
          property: connectionString
      - key: PREPFORGE_ALLOWED_ORIGINS
        value: https://prepforge-chess.onrender.com
```
If Render provides a plain `postgres://` URL, normalize it to SQLAlchemy's
`postgresql+psycopg://` in config or set the explicit URL manually.

#### Phase 3d - Production smoke checklist
Run these after the first Render deploy, before calling it launched:
- [ ] `/healthz` ok and logs show FastAPI/uvicorn, not `prepforge_chess ui`.
- [ ] `alembic current` equals repo head; `alembic check` was clean before deploy.
- [ ] `/` loads the SPA, hashed JS/CSS return 200, engine WASM/worker assets return
      200, and the document has COOP/COEP so `crossOriginIsolated === true`.
- [ ] Register a new account; session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`;
      `/api/auth/status` returns signed in after reload.
- [ ] Unsafe POST without CSRF header returns 403; normal SPA POSTs succeed.
- [ ] Create repertoire, add move, mark prepared, add annotation, export JSON/PGN,
      import JSON, import PGN.
- [ ] Analyze: prepare PGN, browser compute/classify-save path persists, analyses list
      reloads.
- [ ] Train: start/move/hint/skip against the user's repertoire.
- [ ] Lichess: `/oauth/login` redirects; with real credentials, callback links account,
      fallback status poll updates the chip even if popup does not close.
- [ ] Multi-tenant spot check: second account cannot load/export/mutate first account's
      repertoire, analysis, training session, or Lichess markers.

#### Phase 3e - Rollback and guardrails
- [ ] Keep the legacy deploy config in git history, but do not keep `web/server.py` as a
      hidden production path once SaaS cutover is accepted. A rollback should be a git
      revert/redeploy, not two live app entrypoints.
- [ ] Before deleting `web/server.py`, run
      `rg "web.server|prepforge_chess ui|request_lock|PREPFORGE_DB_PATH"` and remove
      dead docs/config references or explicitly mark them legacy-only.
- [ ] Add GitHub Actions before public launch:
      Python: `pip install -e ".[server,dev]"`, `pytest`, `ruff`, `alembic check`.
      JS: `npm ci`, `npm test -- --run`, `npm run build`.
- [ ] Add basic production logging/monitoring before paid users: structured error logs,
      uptime monitor on `/healthz`, and Postgres backup confirmation.

Acceptance: a fresh clone can build from GitHub, Render deploys the FastAPI app with
Postgres, migrations run before boot, the production smoke checklist passes, and there is
no dependency on the legacy SQLite `/data` deployment path.

## Current status
**Phases 1a + 1b DONE; Phase 2 endpoint/static cutover work DONE; Phase 3 deploy
cutover NEXT.** Latest known verification: **333 Python tests green** after FastAPI
static serving/browser smoke, JS suite **154 green**, ruff clean on the touched SaaS API
surface. The currently committed deploy files still point at the legacy server until
Phase 3 changes `Dockerfile`/`render.yaml`.
- 1b test-infra note: `csrf_headers` lives in `tests/api_helpers.py` (a plain
  top-level module, like `stub_maia`), NOT imported from `conftest`. Do **not**
  add `tests/__init__.py` / `pythonpath="."` — it makes `tests/` a package and
  breaks the legacy `from stub_maia import` suite.
- **2a-1 DONE:** legacy 19-table schema is now SQLAlchemy Core in
  `storage/sa_tables.py` on the shared `api.db.Base.metadata`; `tests/test_sa_tables.py`
  guards parity with `schema.sql`. Additive — no consumer changed.
- **2a-2 DONE:** repository + `AppSettingsService` + legacy `web/server.py` all run on
  the SQLAlchemy `Engine`; raw `sqlite3` is gone from the runtime path. Full factory
  swap (not a bridge) — see the 2a-2 sub-slice above for the locked decision + details.
- **2a-3 DONE:** `migrations/env.py` imports `sa_tables`; baseline migration
  `9fc171c00d10` creates the 19 legacy tables; `alembic check` clean (zero drift);
  one Alembic history covers identity + legacy. 208 tests green, ruff clean.
- **2b-1 DONE:** identity bridge (`owner_user_id == users.id`, profile materialized
  lazily) + SQLAlchemy repository wired into FastAPI on the shared engine; read-only
  `/api/dashboard`, `/api/repertoires`, `/api/auth/status` ported. **214 tests green**,
  ruff clean, `alembic check` still zero-drift (no schema change). See the 2b-1 sub-slice.
- **2b-2a DONE:** repertoire write path — `POST /api/repertoires/delete` +
  `/api/repertoires/set-active` on the `current_owner` bridge + new `_owned_repertoire`
  IDOR gate (foreign → 404), implemented straight on the repository (`repertoire_meta`,
  `set_repertoire_active`, existing cascading `delete_repertoire`), bypassing the
  Maia-coupled builder. **219 green**, ruff clean, zero-drift. See the 2b-2a sub-slice.
- **2b-2b DONE:** Maia blocker cleared — `OpeningBuilderService` constructs without a
  Maia (loud guard deferred to a `maia` property used only by generation); shared
  Maia-free `services/workspace_view.py` serializes the Build payload; `GET
  /api/build/load` ported (owner-gated). **222 green**, ruff clean, zero-drift. See 2b-2b.
- **2b-2c DONE:** Build write path — `POST /api/repertoires/create` (+ `claim_repertoire`),
  `POST /api/build/rename`, `POST /api/build/add-move` on the `current_owner` bridge +
  `_owned_repertoire` gate, all on the Maia-free builder returning `build_workspace_payload`.
  **233 green**, ruff clean, zero-drift. See the 2b-2c sub-slice.
- **2b-2d-i DONE:** Analyze browser-compute flow — `POST /api/analyze/prepare` +
  `/classify-save` (ReplayEngine/ReplayMaia, server computes no chess), `GET
  /api/analyses` + `/api/analyses/{id}`, `GET /api/board`; new
  `repository.claim_or_verify_game` IDOR gate + shared `services/analysis_view.py`
  serializer. Server-engine variants dropped. **248 green**, ruff clean, zero-drift.
  See the 2b-2d-i sub-slice.
- **2b-2d-ii DONE:** Build-Generate apply-plan — `POST /api/build/generate/apply-plan`
  on the `current_owner` bridge reusing `OpeningBuilderService.apply_generation_plan`
  (no compute; re-validates + recomputes flags + persists all-or-nothing), owner-gated
  (`_owned_repertoire`), returning `build_workspace_payload`. Server-engine generate
  variants dropped. 10 new tests. **258 green**, ruff clean, zero-drift. See 2b-2d-ii.
- **2b-2d-iii DONE:** Settings — `GET`/`POST /api/settings` storing the Stockfish depth
  **per owner** (`user_profiles.settings_json`, not the legacy global `app_settings`);
  analyze prepare/classify-save read the per-owner depth; `StrictInt` validation;
  server-engine introspection dropped. 10 new tests. **268 green**, ruff clean,
  zero-drift. See 2b-2d-iii.
- **2b-2d-iv DONE:** Lichess import/compare — `GET /api/lichess/{compare,latest}` +
  `POST /api/lichess/seen` on the bridge, using the linked `provider_user_id`,
  owner-scoped matching, per-owner last-seen marker; no-link→400, upstream→502. 12 new
  tests. **283 green**, ruff clean, zero-drift. See 2b-2d-iv. Also folded in the infra
  peer-review WAL polish: `api/db.py` now sets `journal_mode=WAL` once at engine build
  (persistent file setting) and keeps only `foreign_keys=ON` in the per-connect listener.
- **2b-2d-iv-compat DONE:** legacy SPA Lichess seams restored after peer review —
  `GET /api/lichess/status` ({connected, username}), `POST /api/lichess/compare`
  (client username ignored, count clamped), `GET /api/lichess/latest?light=1`
  (→ metadata-only, keeps `finished_at`), `GET /oauth/login` alias. Shims only, no new
  compute. 8 new tests. **291 green**, ruff clean. See the 2b-2d-iv-compat sub-slice.
- **2b-2d-v DONE:** Train (trainer) — `POST /api/train/{start,move,skip,hint}` on the
  `current_owner` bridge; pure python-chess data ops (no engine), straight port. Shared
  `services/training_view.py` serializer; `_owned_session` IDOR gate (foreign → 404);
  demo dropped. Also added the `POST /api/auth/signout` legacy shim ({ok: true}). 13 new
  tests. **304 green**, ruff clean, zero-drift. See the 2b-2d-v sub-slice.

- **2b-2d-vi DONE:** SPA CSRF wired — `web-src/csrf.js` (cookie read + de-duped
  `/api/csrf` bootstrap) + `api()` attaches `X-CSRF-Token` on all unsafe methods,
  sends `credentials:"same-origin"`, accepts `{detail}` errors. 14 new vitest cases;
  JS suite **154 green**. This clears the real-browser-testing blocker. See 2b-2d-vi.
- **2b-2e DONE:** the last SPA endpoints ported — `POST /api/build/{action,annotations,
  export}`, `GET /api/repertoires/export-pgn` (7th, missed by the GAP list),
  `POST /api/repertoires/{import,import-pgn}`, `POST /api/board/move` (server utility,
  not moved client-side). Import re-ids the tree (`_reassign_ids`) to stop cross-tenant
  clobber. Train demo dropped from the SPA (no unauth demo). 24 new tests; **326 green**,
  JS **154 green**, build OK, ruff clean. SPA↔router audit now shows zero unported paths.
  See the 2b-2e sub-slice.

**Next: Phase 2b finish-line.** SPA CSRF + all endpoint porting (2b-2e) + FastAPI SPA
serving and the **real-browser smoke (2b-2f, PASSED)** are done — a full audit of
`web-src/app.js` `/api/*` calls vs registered FastAPI routes shows **zero unported
paths** (the dropped `/api/train/demo/start` was removed from the SPA, not ported), and
the built SPA boots and round-trips auth/CSRF/create/add-move against uvicorn in a real
browser with `crossOriginIsolated` true and zero console errors. Remaining:
1. ~~**Real-frontend smoke test**~~ **DONE in 2b-2f.** Covered: shell boot, CSRF
   bootstrap, register→session, signed-in status, create repertoire, add-move, CSRF-403
   negative, session persistence across reload, dashboard render, `/oauth/login`
   redirect. **Still to verify with real Lichess creds** (couldn't mock OAuth in-browser):
   the callback redirects to `/?lichess=linked` (popup stays open) and the SPA's fallback
   status poll completes the link — the redirect entry point works; the full round-trip
   is untested. A deeper pass could also drive build action/annotation/export, import
   (json+pgn), analyze classify-save, and train move through clicks, but the wire surface
   for all of these is green (333 tests) and the `api()` path is now browser-proven.
2. ~~**Retire `request_lock`**~~ **DONE** — removed with `web/server.py` (it lived only
   there; FastAPI runs lock-free on one shared engine/pool).
3. ~~**Delete `web/server.py`**~~ **DONE (2026-06-08).** Deleted the 3168-line stdlib
   server + its frozen `_*_payload` serializers + the superseded legacy static-serving
   code. Also removed the CLI `ui` command (`run_ui`, the `ui` subparser, and the
   `DEFAULT_DB_PATH`/`run_web_server` import) and the four legacy server test files
   (`test_web_server`, `test_engine_session`, `test_lichess_oauth`, `test_multitenancy`
   — they drove `PrepForgeWebApp`/`EngineSession` over `ThreadingHTTPServer`; the
   multi-tenant isolation they covered now lives in the `test_api_*` suite). README
   updated to run `uvicorn prepforge_chess.api.main:app` instead of `prepforge-chess ui`.
   `services.lichess_oauth` stays (the new `api/routers/lichess.py` uses it). **265 green,
   ruff clean.** No remaining live `web.server` imports.
**Phase 2b is now fully complete.** See `memory/saas-direction.md`.

**Infra peer-review fixes (2026-06-08):**
- **API SQLite FK pragma (resolved):** `api/db.py::make_engine` set `PRAGMA
  foreign_keys=ON` once at build time, but SQLite scopes it per connection and resets
  it to OFF on each new one — so only the first pooled connection enforced FKs (broken
  cascade deletes on later concurrent connections). Now re-asserted (with WAL) on every
  connect via `event.listens_for(engine, "connect")`, mirroring
  `storage.database.make_sqlite_engine`. Regression test in `tests/test_api_db_config.py`
  holds 3 connections open at once and asserts all report `1`.
- **`PREPFORGE_DATABASE_URL` override (resolved):** `config.py` documented it but a bare
  `validation_alias="DATABASE_URL"` replaces the `env_prefix`, so only `DATABASE_URL`
  was read. Now `AliasChoices("DATABASE_URL", "PREPFORGE_DATABASE_URL")` — both work,
  `DATABASE_URL` taking precedence (Render/Heroku convention). Tests cover both.
- **Deploy entrypoint + migration rollout (tracked → Phase 3, NOT fixed here):** the
  deployed image still runs legacy `prepforge_chess ui` and installs `.` not `.[server]`,
  and nothing runs `alembic upgrade head` on deploy. Deliberately left as-is — flipping
  to uvicorn now would deploy a half-finished SaaS backend the SPA can't talk to (no CSRF
  bootstrap yet). Concrete cutover steps are enumerated in Phase 3.

**Peer-review follow-ups status:** ruff (#2) already clean repo-wide — resolved.
`schema.sql` retirement (#1) still open: it now has **no runtime reader** (only
`tests/test_sa_tables.py` via `database.SCHEMA_PATH`); safe to retire alongside that
test + the README/ARCHITECTURE references once desired, now that `alembic check` is the
live drift guard.
