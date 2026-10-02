# PrepForge Chess architecture

Implementation snapshot: 2026-09-29. This describes the current code; it does not
freeze product or architectural decisions for future tasks.

## Runtime

The web product is a Vite JavaScript SPA served by a multi-tenant FastAPI API.
Production configuration uses PostgreSQL; local development and most tests use
SQLite. Browser workers run Stockfish WASM and Maia3 ONNX. The API validates
ownership and submitted plans, classifies supplied evaluations, and persists data.
Optional Python CLI flows also exercise local engine adapters; those are separate
from the public browser-compute flow.

## Source map

| Area | Entry points |
| --- | --- |
| API, authentication and static serving | `src/prepforge_chess/api/main.py`, `deps.py`, `routers/`, `static.py` |
| Domain types and PGN handling | `src/prepforge_chess/core/` |
| Classification and browser result processing | `services/browser_compute.py`, `classification.py`, `brilliant.py` |
| Opening trees and generation-plan application | `services/opening_builder.py`, `workspace_view.py` |
| Training, scheduling and mastery | `services/training_smart.py`, `scheduler.py`, `progress.py` |
| Persistence and schema | `storage/repositories.py`, `codec.py`, `sa_tables.py`, `api/models.py`, `migrations/` |
| SPA orchestration and account UI | `web-src/app.js`, `controllers/account.js` |
| Lazy views and shared tree rendering | `web-src/views/` |
| Browser engines and worker lifecycle | `web-src/engine/` |
| Chess legality and board navigation | `web-src/chess-local.js`, `board-navigation.js` |
| Coach explanations | `web-src/coach/` |
| Production Scout selection | `web-src/scout-selector.js`, `scout-preparation-value.js` |

## Storage

- Games store an initial FEN, compact UCI sequence, and move annotations. SAN,
  per-move FENs and PGN are reconstructed on read.
- Opening trees store a repertoire root and compact parent/arriving-move nodes.
- Evaluations are immutable snapshots. Identity includes search settings and an
  evaluation fingerprint; identical snapshots can share a row without overwriting
  earlier results.
- Training progress and attempt receipts support idempotent sync. Current browser
  pending queues remain primarily in memory; they are not a durable offline log.
- SQLAlchemy metadata and Alembic migrations define the live schema. Historical
  raw SQLite schema proposals are archived.

## Feature boundaries

Analyze prepares positions, computes in the browser, then calls classify-save.
Repertoire edits are optimistic and use batched cloud synchronization. Train
supports smart queues, line rehearsal and human-like play. Games compares practical
games with prepared material. Scout assembles opponent evidence and preparation
routes. Teams shares read-only trees and allows independent copies.

Default Scout is `scout-v2`, currently scoring version 9, selecting at most twelve
routes per color. `?scoutV13=1` still exposes an experimental runtime and keeps its
tests. Research-only studies are distinct from the production selector.

## Verification and operations

See [development checks](ROADMAP.md), [deployment](DEPLOYMENT.md), and
[Scout ranking](scout-production-ranking.md). Configuration on an actual Render,
OAuth or Stripe account cannot be inferred from a code checkpoint.

The original mixed architecture/design document is preserved in
[the archive](archive/history/ARCHITECTURE.md).
