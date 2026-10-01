# PrepForge Chess HEAD review - 2026-10-01

Reviewed baseline: `8bdf0e7`. This report records the review fixes and local validation before publication. Existing documentation moves/deletions, worktrees and other unrelated files were preserved outside this change. GitHub CI results are recorded on the pull request.

## 1. Confirmed and fixed

| Area | Reproduction / consequence | Fix and behavioral coverage |
|---|---|---|
| Build revision | Two HTTP writers starting from one revision both returned 200, overwriting one another. | Transactional compare-and-swap rolls back the losing write; parallel route test now yields 200/409. All Build mutation paths carry revision; queued edits retain their original baseline. |
| Revision response | A second writer changed the tree after the first committed; the first response contained its old tree but the second writer's revision. | Return this request's committed revision. Interleaved-write regression in `tests/test_head_review.py`. |
| Long-running generation | Applying a computed plan used the current mutable Build context rather than its computation baseline. | Capture repertoire/revision for Generate and gap completion. Executable gap-completion regression changes Build during computation and checks the POST. |
| Lazy DB initialization | First parallel requests created multiple engines; a browser registration failed with `database is locked` in WAL initialization. | Lock and atomically publish one engine/session factory. Eight parallel requests created eight engines before the fix, one after. |
| Session expiry | An idle-expired cookie could refresh itself and return 200 twice. | Reject/delete before last-seen refresh. Regression returns 401 on both attempts. SQL session cleanup avoids loading all session ORM objects; full-suite cap/rate-limit tests cover timezone synchronization. |
| Recovery concurrency | Two parallel resets of one link both succeeded. | Serialize resets per account, conditionally consume the token, change password and revoke sessions in one transaction. Loser returns 400. |
| Recovery delivery | Production had no mail transport; reset text could expose the token to logs and links were relative. | Configurable STARTTLS SMTP, absolute public URL, no token/body/address in failure logs, uniform 503 when production delivery is unconfigured. Fake SMTP verifies the full link. Actual external SMTP provider was not contacted. |
| Login timing | Unknown addresses skipped password verification. | Execute dummy verification for unknown/OAuth-only accounts. |
| Outbox stale tabs | Settled operations resurrected after queue clear, after 200 later settlements, or after permanent Train rejection. Clear could erase another tab's pending work. | Retain/filter durable tombstones, preserve other pending operations and id mappings, tombstone rejected attempts, remove unsafe 200-tombstone cap. Four executable persistence/replay regressions. |
| Build queue lifecycle | A successful delete followed by failed add could leave the successful deletion in the retry batch. | Settle deletes immediately and rebase the remaining batch only after our own acknowledged write. |
| Training mixed budget | Per-repertoire minima exceeded the requested global target/new-card budget, including new-cap zero. | Allocate from the remaining global budgets; regression checks selected targets, not only session metadata. |
| Training validation | An oversized queue was rejected after attempts had already been written. | Validate before any attempt write; regression confirms no partial write. |
| Analyze ownership | Alice's in-memory failed-save checkpoint could be retried under Bob. An old response could clear/repaint Bob's state. | Owner-tag memory checkpoints and guard retry/compute/response boundaries. Regressions cover foreign checkpoints, account switch during Retry save and the full compute/classify-save path. Account switch after a successful response cancels the job lifecycle so the new account is not blocked by a permanently busy job. |
| Analyze FEN input | Repeated raw FEN keys silently overwrote conflicting evaluations; equivalent FEN spellings were falsely treated as different evaluations. | Reject conflicting raw duplicates before mapping; compare canonical evaluation content without its source FEN field. HTTP regressions cover 400 and equivalent-spelling 200. |
| Analyze persistence | Classify-save persisted an analysis twice despite `save_game_batched` already saving it. | Remove the second write; existing persistence/history and full API suite pass. |
| Mate zero | Python treated mate zero as an even score; browser always treated it as White's loss even with a signed White score. | Use signed `score_cp` for mate-zero terminal evaluation. Python/browser regressions plus cross-language suite pass. |
| Scout SAN | Castling with check/mate suffix failed heuristic recognition; piece SAN such as Nd4 matched pawn d4. | Strip suffix for castling and use exact SAN tokens. Three regressions cover both colors and mate terminal handling. |
| Research boundary | Production Scout eagerly loaded v13 report/stream modules. | Load them only on the experimental panel/run path. Lazy-chunk gate verifies default loading behavior. |
| Empty Train state | A new account with no active repertoire was told to retry Start, which cannot fix the prerequisite. | Show an empty state with Library/create-or-activate action; executable regression and signed-in audit. |
| Accessibility | Mobile More/account sheet left background interactive and focus escaped; missing PGN label/progress values; board coordinate contrast too low; Analyze touch target 40px. | Modal lifecycle with sibling account menu, inert background, focus wrap/restore; accessible labels/progress; contrast colors; 44px Analyze actions. Behavioral UI smoke, progress tests, contrast checks and signed-in mobile audit cover these. |
| Brittle tests | A fixed 1,800-character source slice failed after unrelated nearby edits. | Remove that assertion and execute restore behavior across URL restore, user navigation and an interrupted asynchronous restore. Other structural tests remain. |

## 2. Confirmed behavior retained / deferred

- **Training completion:** smart completion celebrates before sync and can fetch/render server health after a failed flush. Decide whether "finished" means local session completion or confirmed server completion before changing completion/report semantics. Pending attempts remain durable; this is not evidence of attempt loss.
- **Training batch atomicity:** oversized-queue validation is fixed, but other errors encountered after earlier valid attempts can leave earlier receipts persisted. Per-attempt receipts make retries safe; all-or-nothing semantics require a contract decision.
- **Analyze history:** repeated classify-save requests have no operation-id contract; game moves are mutable while result metadata is historical. A retry identity and immutable history snapshot policy need design before schema changes.
- **Outbox lifecycle:** tombstones now intentionally remain durable without a replay horizon. Storage compaction/TTL needs an epoch or equivalent stale-tab contract. Arbitrarily truncating again would reintroduce the reproduced resurrection bug. Checkpoint index eviction also leaves unindexed bodies and deserves storage cleanup work.
- **Account export scalability:** `list_games` loads every game through individual calls, and account export materializes all games/repertoires into one response. Streaming/chunked export should preserve the "everything owned" contract. Normal Build query counts stayed constant at 500/2,000 nodes (see benchmark).
- **Revision conflicts:** stale writes now fail safely, but a user-facing rebase/retry resolution flow remains product work. Legacy optional revision callers are fenced against concurrent requests, but cannot represent the age of a browser snapshot without sending a baseline.
- **app.js:** large orchestration remains; this review removes a concrete experimental eager import, not a broad application rewrite.

## 3. Not reproduced / already protected

- Server Analyze prepare/classify/recall ownership: current owner-scoped API tests pass. The fixed owner leak was browser checkpoint handling.
- Training cross-owner/session access and exactly-once attempt receipts: existing owner/idempotency regressions pass. PostgreSQL concurrency variants are unverified locally.
- Scout side-to-move parity, mainline selection and production score normalization: current behavioral suites pass; no new failing reproduction justified replacing the current selector with archived research rules.
- DB Build N+1 claim: benchmark shows 3 statements for load and 4 for mutations at both 500 and 2,000 nodes. Latency grows with serialization/work, not query count.
- Recovery mail is currently sent synchronously and lacks a durable backend delivery queue. Uniform HTTP bodies do not establish a constant-time recovery response; external provider timing/retry behavior was not measured.
- Multi-tab simultaneous localStorage read-modify-write and expiring flush lease remain architectural risks. Sequential stale-tab resurrection was reproduced/fixed; actual simultaneous multi-process loss was not reproduced, and this review does not claim atomic cross-tab storage.
- Broader phone overflow: current viewport and geometry checks cover it; no blanket layout rewrite.

## 4. New findings

- A response can stamp stale tree data with a later writer's revision even after write conflict detection is correct (fixed).
- Owner review also reproduced a busy Analyze job left alive after an account switch during classify-save; the final guard now goes through cancellation cleanup (fixed, full runAnalysis regression).
- Real E2E server logs exposed the lazy engine/session factory initialization race (fixed). The harness now writes server stderr to a file instead of leaving an undrained pipe.
- Full Python tests exposed ORM timezone comparison during SQL cleanup (fixed with database-side synchronization).
- Release audit called removed `/api/auth/status` and expected obsolete identity fields; it also clicked hidden desktop navigation on mobile and used input selectors for the current color select. Updated harnesses use `/api/auth/me`, current navigation and selectOption.
- Keyboard E2E used a rendered Library as a boot-ready proxy; boot could still restore Train and hide Start during the click. A boot-complete DOM marker now makes the boundary observable. The reload audit distinguishes an unfinished resumed session from a completed session starting a new queue.
- Cross-flow counted the expected guest `/auth/me` 401 as a signed-in failure, used an obsolete color input, and clicked Start after boot had already resumed Train. Its required-step checker could also pass an aborted journey with missing steps. Corrected the phase boundary/selectors/resume assertion and added executable required-step regressions. Final standalone journey passed all eight required steps with zero signed-in console errors.
- Updated signed-in Analyze audit reproduced the 40px mobile action target (fixed).
- Unsafe tombstone retention limits and unbounded retention are opposing concerns; correctness now wins until a replay horizon exists.

## 5. Gates

| Gate | Result |
|---|---|
| Python default suite | 703 passed, 12 skipped, 5 E2E deselected. |
| Vitest current default suite | 142 files, 1,922 tests passed. |
| ESLint / Ruff | Passed (`eslint --quiet`, `ruff check src tests`, matching CI scope). |
| SQLite migration upgrade / drift | Passed on a fresh database; no new upgrade operations detected. |
| E2E (Scout, refutation, axe, eval chart, training keyboard) | 5 passed in E2E build; default production build restored afterward. |
| Vite build / bundle size | Passed; main app about 315.5 KiB raw / 98.3 KiB gzip, budgets 317 / 99 KiB. |
| Lazy chunks | Passed static and real browser capture. |
| Stockfish browser smoke | Passed Stockfish 19.0.0 UCI and Settings metadata. |
| Cross-origin provider harness | Requested WASM backend passed actual cross-origin ONNX fetch and four-thread worker checks; production build restored. This does not validate WebGPU. |
| Chrome geometry | Passed desktop 1024/1180/1200/1440 and mobile 390. |
| Build SQL benchmark | 500/2,000 nodes: load 3 statements; mutations 4 statements. See `head-review-db-benchmark.json`. |
| UI 9-view/state smoke | 9/9 passed on the final production build. |
| Full release runner on isolated SQLite DB | All 9 gates passed. Required scenarios: Analyze 4/4, Build 7/7, Train 8/8, cross-flow 8/8. |
| PostgreSQL | Not run: no TEST_POSTGRES_URL, docker or psql locally. PostgreSQL migration/concurrency checks are not represented as passing. |

Evidence logs are under `artifacts/head-review-*.log`; friction audit JSON is under `tmp/audits/`. Browser builds were serialized for final verification, because harness/E2E builds rewrite the same static directory. An initial Scout registration timeout could not be diagnosed with the old undrained stderr pipe. After recording server logs, a subsequent registration failure explicitly showed WAL initialization contention; the singleton initialization regression and the final full E2E passed after the fix. Earlier harness failures due stale selectors/boot assumptions were corrected and rerun. The provider harness log contains a transient `FATAL: ... innerHTML` before its final successful WASM report; its final report/gate passed, and this is not claimed as WebGPU validation. Tests do not send real recovery email.

Non-failing warnings remain: FastAPI/Starlette TestClient deprecation, existing ineffective dynamic-import warnings, and Node DEP0190 for the Windows npm gate launcher. PostgreSQL and actual SMTP provider delivery remain unverified.
