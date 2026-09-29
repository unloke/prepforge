# Compare identity boundary

Automatic personal training evidence requires the authenticated owner's linked
Lichess identity. Fetching and comparing public external games remains allowed.

## Enforcement

- `api/routers/lichess.py::_run_compare` resolves the verified usernames from
  server-side `LinkedAccount` rows scoped to `owner`. Request source selections
  control fetching, never authorization. GET and POST share this path.
- `services/lichess_fetch.py::_summarize_fetched` retains `source_account` on
  each summary. The source must actually be a player; comparison uses that
  player's color.
- `compare_many_identities` resolves each duplicate game before truncation:
  verified self perspective wins; canonical username breaks equal-status ties.
  Source collection order cannot substitute an external opponent's perspective.
- `record_departure_misses` checks each summary's source against the verified
  identities and its player/color attribution before opening a transaction.
  Missing provenance defaults to ineligible. External-only batches never lock
  the ledger (its lock helper can insert a row), nor write progress.
- Eligible summaries retain the existing ledger-row lock, progress-row lock,
  atomic progress + ledger transaction, and bounded 300-game dedupe history.
  No schema changes or historical data cleanup are included.

## Write behavior

| Input | Before | After |
| --- | --- | --- |
| Linked self departure | Progress miss + ledger entry | Same; retry counted once |
| External departure, no linked account | Progress miss + ledger entry | Neither write |
| External departure, unrelated linked account | Progress miss + ledger entry | Neither write |
| Mixed self/external departures | Both could write | Only self writes |
| Shared game from self/external | First collected perspective won | Self perspective wins in either order |
| External compare followed by account linking | External could consume dedupe ID | First linked compare ingests once |

## Explicit adoption contract

`web-src/app.js` calls `POST /api/train/record-miss` only from the Analyze
"Train it" click handler. This is explicit adoption of a repertoire-node miss,
not automatic proof that the viewed game was played by the owner. It requires
an owned repertoire and a valid node, but no linked account. Each call records
a new miss, due immediately; it does not touch the compare ledger or promise
game-id idempotency. This behavior is preserved and documented on the endpoint.

## Regression matrix

| Contract | Coverage |
| --- | --- |
| Linked self exactly once | GET and POST; retries and case-normalized identities |
| External-only without/with other linked account | GET and POST; zero progress and ledger calls |
| Mixed self + external | GET and POST, both source orders; DB attempts and ledger IDs |
| Shared game, opposite player perspectives | GET and POST, both source orders and reverse-order retries |
| External preserves existing mastery | Actual progress equality, health equality, nonempty session queue equality |
| Missing source / verification / wrong player color | Persistence boundary returns before any repository call |
| Failed transaction then retry | Existing rollback and interleaving tests plus mixed-evidence rollback |
| Explicit adoption | Unlinked owner allowed; repeated calls count; invalid node / other owner rejected |
| PostgreSQL races | Existing eight-racer exactly-once test retained; added to PostgreSQL CI job |

## Validation

Base: `e1a9ce1` (origin/main at worktree creation).
Branch: `fix/compare-identity-boundary`. No merge performed.

- Targeted Lichess/training: **124 passed, 6 skipped**.
- Full backend: **652 passed, 12 skipped, 5 E2E deselected**.
- Ruff **0.15.17** (the version in `uv.lock`): passed `ruff check src tests`.
- SQLite Alembic upgrade + check: passed, no drift.
- ESLint: passed. Vitest: **109 files / 1,640 tests passed**.
- Production Vite build + bundle-size gate: passed.
- Stockfish browser UCI / Settings smoke: passed.
- E2E build, Scout / refutation / axe / eval-chart: **4 passed**.
- Geometry: passed at 390, 1024, 1180, 1200, and 1440 pixels using installed Chrome.

PostgreSQL execution was unavailable locally: no `TEST_POSTGRES_URL`, PostgreSQL
service, or Docker executable. Ten full-suite skips are PostgreSQL-dependent;
the remaining two require native Stockfish and Maia3 model assets. PostgreSQL
concurrency is therefore covered in code/CI but is not claimed locally verified.

Windows environment notes: the reused virtualenv points its editable package at
an older checkout. Set `PYTHONPATH=D:/auto_art/prepforge-identity-boundary/src`
for Alembic and subprocess E2E commands. Pytest uses the repository's configured
`pythonpath = ["src"]`. Initial Alembic/E2E runs without this override exercised
the old checkout; the results above are the corrected worktree runs. The global
Ruff was 0.16.8 with broader defaults; validation used the lockfile version.
