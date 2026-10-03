# Correctness, async and persistence revalidation

Baseline: latest `origin/main` at investigation start, `ec04e7d` (PR #111).
Every listed finding remained reproducible at that HEAD; none was already fixed or obsolete.
Tests were first executed against that implementation and then against the fixes.
An isolated baseline worktree ran the same behavioral reproductions: 13 JS failures,
7 Python failures and one passing control that different stale Build requests remain conflicts.
Logs: [Vitest](../artifacts/correctness-async-persistence-20261002/baseline-vitest.log),
[pytest](../artifacts/correctness-async-persistence-20261002/baseline-pytest.log).

| Priority | Finding | Baseline executable evidence | Resolution |
| --- | --- | --- | --- |
| P0 | Smart sync session generation | Rebuild reused the session ID; an old/missing generation sync returned 200 and changed the rebuilt queue | Require generation at the HTTP boundary; validate under the session lock; preserve generation through grouping, retries and unload |
| P0 | Build commit-success / response-lost recovery | Exact add retry returned revision 409; render failure requeued confirmed adds; deleting an in-flight provisional node discarded its recovery operation | Store request receipts with tree mutations; recover original ID maps on exact retries; separate commit acknowledgement from rendering; recover adds before flushing their provisional deletes |
| P0 | Hydrate drops target pending deletes | Opening B from A emptied B's durable deletion queue | Keep every repertoire's queue and reapply B's deletions to its fresh tree |
| P0 | Train partial commit / group acknowledgement | Later UUID collision left the earlier attempt receipt committed | One transaction for the whole group, including progress, receipts and session position; whole-group rejection now matches rollback |
| P0 | Analyze Train it serialization | Competing progress update was overwritten (1 attempt instead of 2) | Lock and update the progress row in one transaction |
| P1 | Generate / Coverage late repertoire response | Save completion hydrated the previously opened repertoire after navigation | Capture repertoire, owner and navigation generation; save the original target and fence UI hydration; stop remaining Coverage lines after switching |
| P1 | Legacy Train stale result | B completed first, then slow A replaced B's session | Shared start sequence and owner/mode fences after asynchronous boundaries |
| P1 | Team detail A slow / B fast | A's name, permissions and shares replaced B's detail | Fence success and failure using detail request sequence, selected team and owner |
| P1 | Team delete atomicity | Failed team commit left its repertoires unshared | Unshare through the same connection/transaction as the team delete |
| P1 | Analyze book invalidation | Old load marked the cache loaded and cleared a replacement load | Cache generation and owner fence before publication |
| P1 | Settings stale response | Two saves ran together; old response replaced the latest setting | Serialize patches; fence loads, saves and startup settings by owner/request sequence; update engine consumers from the acknowledged full payload |
| P1 | Games partial source failure | One source failed but the response and UI omitted its error | Return source errors alongside successful games; retain a visible error with a Retry Check action, including empty results |
| Scout | Bulk success counts | Null writes counted as success; a thrown write aborted remaining lines | Count complete confirmed lines; continue after individual failures; report failures and cancellation |
| Scout | Handoff wiring | The recorder was never called by the application-created view | Inject the actual handoff recorder |

Behavioral coverage lives in `web-src/async-persistence-regression.test.js`,
`web-src/train-sync.test.js`, `web-src/build-revision.test.js`,
`web-src/views/replay-focus.test.js` and the corresponding API/service pytest tests.
Additional checks cover receipt-write rollback, cross-owner late responses, stale
Settings GETs and response loss after an optimistic delete.

Smart sync without a generation is retained for review as a permanent rejection,
not retrofitted onto a new generation. Build receipts use owner-scoped settings
storage and need no migration. Rejected attempts remain reviewable in the outbox.
PostgreSQL interleaving tests now inject their competing sync before the first
session lock: the batch deliberately holds that lock across all progress writes.

Scout ranking, the 12-per-color result contract and opening-end logic are unchanged.
Settings request actions and Analyze book actions are lazy modules to keep the
existing bundle budgets; the production entry is 322.1 KiB raw / 100.7 KiB gzip.

Local validation: full Vitest, full pytest, ESLint, Ruff, production build,
bundle gate, UI smoke (9/9), lazy-chunk and accessibility smoke, Stockfish smoke,
and E2E (6/6). PostgreSQL-specific tests run in CI; local pytest skips them when
`TEST_POSTGRES_URL` is absent. The E2E build is replaced with the production build
before committing deployment assets.
