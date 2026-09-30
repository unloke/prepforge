# Archived research and tests

This archive is historical context, not current product or agent instructions.
Default product and research test commands do not discover its files.

- `tests/web-src/`: bias-fit/cohort and shadow-preparation studies without a live
  product entry point. Their implementation helpers remain available for replay.
- `tests/scripts/`: offline benchmark metrics tests.
- `tests/web-src/scout-v12-report.test.js`: retired v12 renderer tests. The v13
  runtime still imports the shared vocabulary constant and retains its own tests.
- `research/scout-robust-y/`: incomplete historical Robust-Y bundle and runner.
  Its `web-src/scout-meta-maia-p0.js` dependency is absent; its test was already
  excluded before this move and remains excluded from archive execution.

Run the runnable historical tests explicitly with `npm run test:archive`.
This is an investigation command, not a deployment gate. Reachable experimental
Scout v13 tests remain in the normal product suite because the UI still exposes
that runtime. Production regressions, migration tests, and browser smoke checks
also remain active.

[manifest.json](manifest.json) records original paths, archive paths and reasons.
Document snapshots are separately indexed in [docs/archive](../docs/archive/README.md).
