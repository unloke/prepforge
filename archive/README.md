# Archived research and tests

This archive is historical context, not current product or agent instructions.
Default product and research test commands do not discover its files.

- `tests/web-src/`: bias-fit/cohort and shadow-preparation studies without a live
  product entry point. Their implementation helpers remain available for replay.
- `tests/scripts/`: offline benchmark metrics tests.
- `tests/web-src/scout-v12-report.test.js`: retired v12 renderer tests. The v13
  runtime and the other research-only Scout modules moved from `research/lib/` to
  `2026-10-31/research/lib/` (see below); `web-src/` holds product code only.
- `research/scout-robust-y/`: incomplete historical Robust-Y bundle and runner.
  Its `web-src/scout-meta-maia-p0.js` dependency is absent; its test was already
  excluded before this move and remains excluded from archive execution.

- `2026-10-31/`: superseded research removed from `main` on 2026-10-31, kept at its
  original relative path: the retired v13 runtime and bias/route-audit helpers
  (`research/lib/`), the shadow-prep and ref-df studies with their `scripts/` drivers,
  ORCBR B1 protocols, the v11 path-guard study (shipped as `web-src/scout-path-guard.js`),
  the unused baseline/greedy selectors, `vitest.research.config.mjs` and the raw
  `coach-review-ratings.json`. Relative imports into `web-src/` resolve only against a
  matching historical revision: `main` at 9179d1d9921ff14173b33b3b1859c12c10432054 is the last commit that had them.

Run the runnable historical tests explicitly with `npm run test:archive`.
This is an investigation command, not a deployment gate. Production regressions, migration tests, and browser smoke checks
also remain active.

[manifest.json](manifest.json) records original paths, archive paths and reasons.
Document snapshots are separately indexed in [docs/archive](../docs/archive/README.md).
