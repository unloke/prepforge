SQLite, median of 5 runs; 300 games; batches of 100.

Python 3.11 / Windows; scratch schema from the API test fixture. Branching opening
trees reach 20 plies; own-side progress includes due, mastered and untrained moves.
Listings/dashboard cover cumulative owner trees (50, 550, 2,550 total nodes).
API measurements include auth, CSRF validation, mutations and JSON serialization;
setup, resets, warmup and profiling are excluded. Matching games depart at ply 1
and scan 30 positions at/after departure. Ingest batches miss the same popular opening move.

| Operation | Nodes | Before ms / SQL | After ms / SQL |
|---|---:|---:|---:|
| load_repertoire | 50 | 2.69 / 2 | 2.50 / 2 |
| workspace_after_move | 50 | 1.03 / 3 | 1.09 / 3 |
| list_health_due | 50 | 2.49 / 3 | 2.50 / 3 |
| dashboard_api | 50 | 5.12 / 12 | 5.16 / 12 |
| build_add_moves_api | 50 | 8.96 / 11 | 8.95 / 11 |
| build_delete_nodes_api | 50 | 11.36 / 15 | 8.40 / 13 |
| smart_start_api | 50 | 8.96 / 15 | 9.51 / 15 |
| smart_move_api | 50 | 8.26 / 13 | 8.07 / 13 |
| match_one_game | 50 | 4.83 / 0 | 1.89 / 0 |
| match_game_batch | 50 | 489.84 / 0 | 187.22 / 0 |
| departure_ingest_batch | 50 | 73.19 / 303 | 2.04 / 6 |
| load_repertoire | 500 | 24.88 / 2 | 22.86 / 2 |
| workspace_after_move | 500 | 3.71 / 3 | 3.28 / 3 |
| list_health_due | 500 | 31.97 / 3 | 4.68 / 3 |
| dashboard_api | 500 | 21.02 / 12 | 7.38 / 12 |
| build_add_moves_api | 500 | 41.71 / 11 | 38.66 / 11 |
| build_delete_nodes_api | 500 | 69.16 / 15 | 38.37 / 13 |
| smart_start_api | 500 | 35.19 / 15 | 32.21 / 15 |
| smart_move_api | 500 | 31.13 / 13 | 30.48 / 13 |
| match_one_game | 500 | 33.32 / 0 | 1.93 / 0 |
| match_game_batch | 500 | 3241.64 / 0 | 191.16 / 0 |
| departure_ingest_batch | 500 | 71.76 / 303 | 2.24 / 6 |
| load_repertoire | 2000 | 97.86 / 2 | 91.31 / 2 |
| workspace_after_move | 2000 | 15.07 / 3 | 11.20 / 3 |
| list_health_due | 2000 | 648.85 / 3 | 12.78 / 3 |
| dashboard_api | 2000 | 317.46 / 12 | 11.35 / 12 |
| build_add_moves_api | 2000 | 151.00 / 11 | 140.55 / 11 |
| build_delete_nodes_api | 2000 | 246.27 / 15 | 141.87 / 13 |
| smart_start_api | 2000 | 119.78 / 15 | 108.12 / 15 |
| smart_move_api | 2000 | 167.64 / 13 | 99.25 / 13 |
| match_one_game | 2000 | 199.90 / 0 | 2.30 / 0 |
| match_game_batch | 2000 | 12615.87 / 0 | 225.65 / 0 |
| departure_ingest_batch | 2000 | 73.73 / 303 | 2.14 / 6 |

Changes:

- Carry repertoire ID through mastery recursion: SQLite now searches both existing index columns instead of scanning a repertoire for every parent.
- Filter reentry candidates by canonical piece placement: normalize game positions and possible matches, rather than every tree position per game (203,000 to 3,000 normalizations in the large batch profile).
- Reuse the deleted tree for the response: one tree read instead of two.
- Reuse Build mastery for health; skip ancestor expansion for the unfiltered tree report: remove repeated traversal while keeping live due states.
- Keep SAN's existing push; release the recursive hydration closure: avoid replaying each move twice and retaining released trees until cyclic GC.
- Accumulate ingest progress within the locked transaction: one read/write per target while preserving each game's miss, deduplication and rollback.

Measured and left alone: small tree loading (~2.5 ms), hydrated Build payload
(~1–11 ms), and training queue logic. Full tree replay still dominates large loads
(91 ms; FEN serialization is ~two-thirds of the profile). No stored derived-tree
format, cache, cap, pagination or new index was added. Full FEN/evaluation identity
stays unchanged: these read profiles do not attribute cost to position-table clock
duplicates; evaluation-heavy workloads were not benchmarked.

Evidence: [baseline JSON](read-path-before.json), [after JSON](read-path.json),
[cProfile summaries](read-path-profiles.txt). The query-plan regression test pins
both index columns; reentry, duplicate-target ingest and tree-release tests cover
the new paths. Large add-moves timings varied across rechecks (141–284 ms); the
tree-retention test failed before releasing the closure and passes afterward.

Net code: +409 lines (+25 production, +107 tests, +277 harness), excluding reports
and the user's existing AGENTS.md edit. Python 3.11 suite: 777 passed, 36 skipped,
6 deselected; no web-src changes. The py launcher reported no installed Python;
the installed Python 3.11 executable ran the suite with a workspace basetemp
(the default pytest temp directory was inaccessible). No commits.

Risks: SQLite timings do not predict PostgreSQL latency; PostgreSQL integration
tests require TEST_POSTGRES_URL. Ingest savings depend on repeated targets (100
distinct targets still require ~303 statements). Matching still visits the tree
per departing game, but only validates candidate positions; it relies on the
canonical piece-placement FEN produced by hydration. API wall timings include
thread scheduling and GC variation.

Reproduce (with Python 3.11 when the py launcher is unavailable):

```powershell
$env:PYTHONPATH = 'src'
& "$env:LOCALAPPDATA/Programs/Python/Python311/python.exe" scripts/bench_read_path.py --runs 5 --baseline docs/benchmarks/read-path-before.json -o .bench-current.md
```
