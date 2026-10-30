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

Smart batch sync holds the session lock for the entire batch, merges receipt IDs
in memory and writes the final session once. It reads only the attempted nodes'
identities, without loading repertoire trees or evaluations. Mixed queue creation
loads active trees and personal progress in batches; start and preview reuse that
request's snapshots. Preview performs no writes. See [training flow and I/O](training-flow.md)
for the measured query counts and presentation choices.

Library listings compute all exclusive mastery buckets and `mastery_pct` in one
grouped owner-scoped statement. The SQL follows the same untrained, weak, due,
mastered, learning precedence as `node_mastery`, including enabled ancestry and
own-side trainability. Cached tree coverage such as `shallow_lines` remains static.

`tests/test_backend_consistency.py` covers out-of-order analysis saves, delayed
and duplicate sync, lost responses, unversioned requests, rollback/retry, expiry,
and concurrent training/sync. Each case runs on isolated SQLite and, when
`TEST_POSTGRES_URL` is set, in an isolated PostgreSQL schema. The PostgreSQL CI job
includes this suite. Production data is never used by these regressions.

Repertoire edits acquire the database write lock before reading the tree.
PostgreSQL locks the repertoire row; SQLite claims its writer lock with a
no-op revision update that returns the current metadata. Node
changes, the revision operation and its receipt commit through that same
connection, so competing editors read the committed predecessor without
exhausting optimistic retries. `tests/test_coedit_sync.py` covers concurrent
writers and rollback when receipt persistence fails.

The browser reconciles a saved repertoire by merging its pending moves and
deletions before selecting or painting a position. Temporary selections and
branch choices resolve through the acknowledged ID map; a removed selection
lands on its nearest surviving ancestor. A superseded asynchronous selection
cannot repaint the board. Queued children resolve an acknowledged parent even
when that acknowledgement arrives during local move calculation.

Local branch deletion registers its pending tombstone and rebuilds the tree before
awaiting position selection. Undo restores and renders the subtree before its
selection await too. The deletion commits after the undo window, or when pending
edits are explicitly flushed. The floating Undo control occupies no layout space.

Outbox recovery uses a read-only IndexedDB transaction. Successful saves retain
their settlement records without an extra write or a cleanup read. A local
100-save probe using the real sync controller and fake-indexeddb counted 300
writes, down from 600; each save still checkpoints its queue before sending and
persists the server acknowledgement. This measures storage operations, not
network latency. `web-src/build-save-reconcile.test.js` covers the write count
and edits made while a save is in flight.
