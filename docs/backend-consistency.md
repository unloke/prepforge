# Backend consistency

Analysis reports persist a self-contained `move_results_json` snapshot alongside
the run summary in `analysis_results`. Recall selects both in one owner-scoped
statement, ordered by `(analyzed_at DESC, id DESC)`. Later writes to shared game
annotations and reclamation of unused engine evaluations do not alter a report.

Migration `c28e6b94f701` leaves historical snapshots NULL: the old shared move rows
cannot reliably be attributed to an analysis run. Recall returns HTTP 409 with
an instruction to analyze the game again, rather than combine unrelated results.
New analyses populate the snapshot through both repository save paths.

Migration `d39f7ca50812` adds `training_sessions.state_version`. Every session write
increments it, including fresh starts using an existing session ID. Smart start
returns the version, and browser flushes and unload requests send it with their
captured queue/position. Sync compares it while holding the session lock before
applying attempts. Stale or missing versions cannot replace queue/position;
independent new attempts still commit exactly once. The response includes
`state_applied` and the committed `state_version`. An identical state retry after
a lost response is acknowledged without rewriting it. A conflicting browser
keeps its original version and reports that the session must be resumed.

Smart and ordinary per-move answers lock/read session and progress, compute the
answer, and write both through one connection and transaction. PostgreSQL uses
row locks; SQLite takes its writer lock before reading session state. Failure of
either write rolls back both, so retry does not double-count a failed operation.

Library listings compute all exclusive mastery buckets and `mastery_pct` in one
grouped owner-scoped statement. The SQL follows the same untrained, weak, due,
mastered, learning precedence as `node_mastery`, including enabled ancestry and
own-side trainability. Cached tree coverage such as `shallow_lines` remains static.

`tests/test_backend_consistency.py` covers out-of-order analysis saves, delayed
and duplicate sync, lost responses, unversioned requests, rollback/retry, expiry,
and concurrent training/sync. Each case runs on isolated SQLite and, when
`TEST_POSTGRES_URL` is set, in an isolated PostgreSQL schema. The PostgreSQL CI job
includes this suite. Production data is never used by these regressions.
