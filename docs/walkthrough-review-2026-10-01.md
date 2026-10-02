# Product walkthrough working-tree review

Reviewed the uncommitted walkthrough changes against the current implementation.
Historical walkthrough reports were treated as observations, not acceptance rules.
Reproduction used executable deferred-promise tests, real SQLite transactions,
Playwright viewport flows, and real browser Stockfish/Maia workers.

## 1. Confirmed and fixed

| Finding | Reproduction and correction |
| --- | --- |
| Scout bounded batches skipped one source's history | Two sources with different oldest dates resumed from one global minimum. Each source now resumes from its own watermark. |
| Scout duplicate/filtered pages ended pagination | A full duplicate page became `done`; rejected games did not advance the export cursor. Full pages remain resumable and raw PGN timestamps advance the cursor before parsing/deduplication. |
| Practice Start outlived its mode/session | Deferred board loading followed by a mode switch or overlapping Start installed an obsolete game. Generation ownership now guards installation, stale errors, delayed confirmations, and queued board input. |
| Palette bypassed New game confirmation | The palette called Start directly. It now uses the same button and confirmation path as the page. |
| Games auto/manual checks raced | Earlier responses replaced later results, released the later busy state, or displayed results for changed sources. Request, source, and account ownership guard state, lazy rendering, errors, and busy cleanup. |
| Partially played first Smart card was not counted on restart | A two-target card had `current_index == 0` but a next target. Restart now recognizes its `current_node_id`. |
| Restart counter committed before session replacement | Injecting a session-write failure left the count increased. Locked session reread, count, and replacement now share one transaction; overlapping restarts cannot count the same replaced generation twice. |
| Deleted-review archive committed after node deletion | Injecting an archive-write failure left the reviewed node deleted. Archive mutation and deletion now commit/rollback together, with insert-claim setting locks. |
| Recapture depended on unrelated material advantage | A player already a rook ahead recapturing a pawn was described as making an ordinary capture. Classification now compares the two local captures. |
| Dashboard due differed from schedulable reviews | Disabled/weak nodes and another owner's progress appeared due. Today now uses Library's effective-enabled/own-move/weak rules and only the owner's active repertoires; due soon is the next 24-hour partition. |
| Moved documents broke current navigation | Updated the documentation index to the archived snapshots and explicitly identified their historical status. |
| Browser gates used obsolete UI contracts | Updated explicit PGN setup, direct mobile Analyze navigation, two-decimal eval, Games departure label, and guest onboarding actions. Assertions still exercise actual analysis, board state, and navigation. |
| Windows checkout changed generated HTML | A post-commit rebuild exposed CRLF-dependent Vite HTML output. Targeted LF attributes keep the source and generated HTML deterministic across checkout/build. |

Behavioral tests were run failing before fixes for the async, transaction,
recapture, and dashboard findings. Added positive due/soon partition coverage.
The reviewed main bundle is about 326 KB raw / 102 KB gzip. Its budget moves
from 325/101 KB to 327/102 KB; worker and stylesheet budgets are unchanged.

## 2. Confirmed but deferred

No confirmed release-blocking issue was deferred. A complete historical training
event ledger is outside this repair: `reviews_7d` still counts recently reviewed
progress rows plus deleted-row timestamps, rather than every individual attempt.
The session counter preserves replaced played Smart generations, rather than
introducing a new historical session table. These are the existing metric contracts.

## 3. Not reproducible / already correct

- Games already orients the board using `user_color` and distinguishes in-prep
  moves from departures; the viewport gate exercises these states.
- Smart cards can contain several own moves. Card count, first-try correct/missed
  counts, due, weak, and new are different quantities, not equality constraints.
- Coach alternatives refer to the position before the played move. Engine PV
  and its arrow refer to the current position. Their different sides/times do
  not demonstrate a wrong-color engine arrow.
- Scout already aggregates decision routes; a terminal route with one game does
  not prove that opening prefixes were not aggregated. The selector was retained.
- The sidebar's existing collapse behavior and signed-out/auth navigation pass
  browser state/accessibility gates; no additional collapse regression was found.

## 4. New findings

The pagination, Start ownership, palette confirmation bypass, Games response
ownership, transaction rollback, partial-card counting, material-independent
recapture, dashboard scope, broken document links, and stale gate contracts above
were found during this review. The dashboard scope discrepancy predates this
working tree; the new auto-check and bounded batching made lifecycle and cursor
coverage especially important.

## 5. Full gate results

- Vitest: 141 files, 1,878 tests passed.
- Python: 747 passed, 17 skipped, 5 deselected; PostgreSQL and browser E2E are also
  required in PR CI. Local skips concern optional backend/browser execution.
- Ruff and ESLint: passed.
- SQLite Alembic upgrade and metadata drift check: passed.
- Production build and bundle size: passed; generated deploy output is committed.
- UI v2: 9/9 suites passed, including real Stockfish Analyze at four viewports.
- Accessibility/menu/popover/palette browser smoke: passed.
- Stockfish browser smoke: passed.
- Maia cross-origin provider gate: passed with real worker/model fetching;
  runner restored the production build afterward.
- Release runner: all nine gates passed, including lazy chunks, Analyze/Build/Train
  friction audits, and Analyze → Build → Train → reload cross-flow.

Local logs are under `artifacts/review-*.log`; release evidence is under
`tmp/audits/`. These scratch outputs, local agent configurations, and unrelated
worktrees are not product source and are not included in the PR.
