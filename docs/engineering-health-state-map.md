# Engineering-health state map

Checkpoint: 2026-09-18

## Git and integration state

| Ref | State | Relationship |
| --- | --- | --- |
| `origin/main` | `43383b2` | latest fetched main; integration base |
| `goal/engineering-health` | `db2d7e8` | exactly 0 behind and 9 ahead of `origin/main`; clean |
| `goal/lucky-nav-verification` | `ac79ddd` | original dirty checkout; deployment/static worktree only, index empty |
| `964266a` | legacy Lucky commit | patch-equivalent to integration commit `c28b685`; not an ancestor of latest main |
| `5970963` | CI/ESLint | patch-equivalent to `93defd7` |
| `fddac10` | theme/navigation | patch-equivalent to `02c8e8f` |
| `ac79ddd` | status severity | patch-equivalent to `7fe9caa` |

The integration branch deliberately contains the verified Lucky baseline, CI/ESLint
gate, dark theme/navigation, explicit status severity, lazy-chunk smoke alignment,
license correction, and deterministic Scout E2E fixes. Deployment/static edits are
not present on this branch.

## Runtime dependency boundaries

```text
app.js
  └─ lazy import views/scout.js on Scout interaction
       ├─ production Scout v2
       │    scout.js
       │    scout-report → scout-refutation
       │    scout-stats / scout-summary / scout-selector
       │    scout-engine / scout-prefilter → Stockfish provider
       │    scout-maia → Maia3 provider
       │    explorer and engine assets (runtime lazy paths)
       ├─ query-gated experimental panels
       │    scout-v12-report (?scoutV12)
       │    scout-v13-report / scout-v13-stream (?scoutV13)
       └─ E2E-only fixture path
            VITE_ENABLE_SCOUT_E2E=1 + ?scout_e2e=1
```

`research/**` is reached only through `vitest.research.config.mjs` and
`npm run test:research`; it has no app import path. Robust-Y remains
`unresolved/archive` because its historical `../../web-src/scout-meta-maia-p0.js`
dependency is missing. The unmoved `web-src` v15/shadow-prep/census/harness files
have no app runtime import path but are not claimed as fully directory-isolated
research until a later, explicitly authorized source move.

## Bundle baseline

Measured after clean builds, using `origin/main=43383b2` as baseline:

| Asset | `origin/main` | integration | delta |
| --- | ---: | ---: | ---: |
| main JS raw / gzip | 258.95 / 82.27 kB | 270.49 / 85.93 kB | +11.54 / +3.66 kB |
| main CSS raw / gzip | 116.04 / 21.59 kB | 120.47 / 22.53 kB | +4.43 / +0.94 kB |

The existing raw/gzip budgets remain unchanged and pass. No budget increase was
made to justify the branch delta.

## Verification and deferred work

- JS lint, 83 Vitest suites / 1388 tests, research tests (5 suites / 92 tests),
  Python CI scope, pytest, and Alembic drift checks pass locally and in PR CI.
- Browser acceptance covers desktop, 375px layout, Games/Scout, More menu,
  first-click navigation, history, themes, keyboard focus, and overflow.
- Cross-origin engine and production ORT/Maia smoke checks pass.
- Docker image/static serving and image-contained engine assets remain unverified
  because no Docker-compatible runtime is installed on the validation host.
- Deployment/static changes remain working-tree-only in the original checkout.
- App split, Scout source moves, API adapter refactor, and new product features
  remain separate/deferred work.
