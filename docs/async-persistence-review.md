# Persistence review — 2026-10-04

Checked against the implementation on `main` and repaired on `fix/async-persistence-review`. The reported line numbers refer to the earlier source and move as fixes land.

| Item | Verification and resulting behavior |
| --- | --- |
| 1 | Confirmed by a deferred-flush test. Annotation saves capture owner, repertoire, selected node and ID map before waiting; requests serialize. |
| 2 | Confirmed by injected network and prerequisite-flush failures. Failed saves restore the confirmed node and visible board and report `Annotations not saved`. This change uses rollback; annotations do not have a durable retry queue. |
| 3 | Confirmed by switching repertoires during a deferred flush. Both full and branch exports keep the clicked repertoire; account changes cancel publication. |
| 4 | Confirmed with reversed file-read completion. File selection and drag/drop share one source sequence created before reading; superseded reads cannot publish. |
| 5 | Confirmed with a failed parser result. File loading awaits parsing and reports success only when it returns true. Parsing errors remain visible. |
| 6 | Confirmed with memory checkpoint A and stored checkpoint B. Retry and Discard use the checkpoint bound to the prompt. Discard clears its memory copy; UUID version checks protect newer computations for the same game. |
| 7 | Confirmed with two concurrent Retry calls. One request may run at a time and the Retry button is disabled. Backend testing also confirmed that an unkeyed repeat used to create another analysis snapshot. A checkpoint now retains one request UUID across retries; repeated classify-save requests reuse its saved result. A fresh analysis gets a new UUID. |
| 8 | Confirmed two independent localStorage writes. Replaced by an IndexedDB transaction containing payload and metadata. Metadata-write fault injection rolls both back. |
| 9 | Confirmed the 100-entry rejection tail. Removed silent truncation; rejected Build and Train operations remain available for recovery. |
| 10 | Confirmed full payload scanning on every index write. IndexedDB saves address only the edited payload and its small metadata row. Latest lookup reads metadata, without scanning analysis bodies. |
| 11 | Confirmed single-payload/count caps did not bound origin storage. Analysis recovery now uses IndexedDB, without evicting unsaved work by count or size. A failed transaction reports failure so the page retains its memory copy. Cache data and unsaved analysis use separate stores and retention policies; they still share the browser's origin quota. |
| 12 | Confirmed unbounded settlement/ID history and whole-history merge cost. **Compaction is not implemented in this PR.** Tombstones and mappings remain necessary while suspended tabs may replay indefinitely. Safe compaction requires a transactional generation/replay protocol; arbitrary truncation would reintroduce duplicate replay or lose work. Existing stale-tab regression tests remain in place. |
| 13 | Confirmed per-ply board construction. One replay board now advances through the game, retaining all move and annotation fields. |
| 14 | Confirmed redundant snapshot JSON. Snapshots now use a `zlib-base64-v1` envelope and remain self-contained. Alembic converts existing database rows once; the runtime has no raw-JSON compatibility reader. Downgrade restores the prior stored encoding. |
| 15 | Confirmed unconditional PGN parsing/export during hydration. `load_game` and `iter_games` render annotated PGN only with `render_pgn=True`. Ordinary loads retain the original PGN and hydrated moves. Account export explicitly requests the annotated representation. |
| 16 | Confirmed disk JSON parsing on every cache hit. Explorer clients share an in-memory cache for the same storage object; storage events invalidate it across tabs. TTL and the evictable cache cap remain. |
| 17 | Confirmed initialization awaited cache completion. Verified bytes return immediately alongside a best-effort cache-write promise; slow or failed cache writes do not block model initialization. Worker termination may abandon caching, which only causes another download later. |
| 18 | Confirmed simultaneous chunk and assembled-model buffers. Manifest-sized streamed downloads now use one preallocated buffer, reject oversize streams early, and release the reader. Size and SHA verification still precede model use. |
| 19 | Confirmed no common request deadline. API requests now bound CSRF bootstrap, fetch and body reads: GET defaults to 30 seconds, mutations to 90 seconds, with per-call overrides and caller cancellation. Mutation timeouts report an unconfirmed result. Analysis retries use the stable request UUID; existing Build/Train receipt protections remain. |

## Measurements

Local Python 3.13, 40 iterations of a 200-ply synthetic knight cycle:

- Prior per-step board reconstruction: 19.17 ms per run.
- Shared-board reconstruction: 7.54 ms per run.
- Repeated-move snapshot: 89,029 raw JSON bytes → 4,844 bytes including the compressed envelope.
- Deterministic random legal sequence (180 plies): 77,996 → 6,932 bytes.

These are function and synthetic-data measurements, not page-speed claims or real-game compression guarantees. Snapshot round trips include evaluations, annotations and non-ASCII comments.

## Verification

Regression coverage includes reversed asynchronous completion, failed annotation writes, serialized drawings, prompt-bound discard, concurrent Retry, checkpoint transaction abort, account isolation, same-millisecond replacement checkpoints, cross-tab and same-tab Explorer invalidation, stalled cache writes, oversize model streams, caller abort, and unconfirmed write timeouts. Backend tests cover idempotent analysis retry, explicit PGN rendering, move identity and the compression migration across multiple batches.

The production entry bundle budget increases from 335,000 to 338,000 raw bytes for the request deadlines and recovery guards; its independent gzip ceiling is unchanged. Generated production assets are committed with the source changes.
