# Build database hot path benchmark

Measured against `origin/main` (`e58a3be`) and this branch on Windows,
Python 3.13, SQLAlchemy 2.0, in-memory SQLite. Run
`py -3.13 scripts/build-db-benchmark.py --sizes 500 2000` to reproduce.
Each cell is median of three calls; add-moves and apply-plan insert a new
legal move on every measured call. Timings include tree hydration and service
work, but not HTTP or browser rendering.

| Nodes | Operation | Before statements / ms | After statements / ms |
| ---: | --- | ---: | ---: |
| 500 | mark_prepared | 503 / 343 | 3 / 66 |
| 500 | annotations | 503 / 368 | 3 / 65 |
| 500 | add-moves batch | 505 / 334 | 3 / 67 |
| 500 | generation apply-plan | 508 / 346 | 3 / 71 |
| 500 | Build load | 5 / 143 | 2 / 68 |
| 2000 | mark_prepared | 2003 / 1417 | 3 / 278 |
| 2000 | annotations | 2003 / 1416 | 3 / 302 |
| 2000 | add-moves batch | 2005 / 1614 | 3 / 328 |
| 2000 | generation apply-plan | 2008 / 1488 | 3 / 315 |
| 2000 | Build load | 5 / 681 | 2 / 314 |

The remaining cost grows with the hydrated tree and payload size. Changed nodes
are upserted as one batch, simple edits update only their target fields, branch
enable/disable groups rows with the same value, and delete removes only the
selected subtree. A loaded repertoire now serves tree_report and the response.
The cached health badge is written only when its value changes.

`list_games` has no production API call site. `list_repertoires` is used by
Lichess sync, not the dashboard; the dashboard uses lightweight listing rows.
The dashboard's six training-progress COUNT queries were consolidated into one
conditional aggregate to reduce round trips on the actual dashboard endpoint.

PostgreSQL validation remains pending because this machine has no configured
PostgreSQL URL, local service, `psql`, or Docker. SQLite SQL count regression
tests cover the narrow write and repeated Build load paths.
