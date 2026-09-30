# Analyze & Build-Generate concurrency: verification + changes

This documents (1) whether the multi-worker Analyze flow can ever have two workers compute
the same position, (2) what was changed, and (3) why the more aggressive Build-Generate
parallelism phases were deferred. It is the write-up for the work tracked in the
`worker-dispatch.test.js`, `game-analyzer`, `analysis.py`, and `build-generator` changes.

## 1. Verdict on "can two workers get the same position?"

The reviewed analysis was **correct about the index race, and the original intuition was
also correct about FENs** — they were answering two different questions.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| No two workers are handed the same task **index** | ✅ True | `takeNextPosition()` reads-and-increments `nextIndex` with no `await` between, so under the single-threaded event loop the increment is atomic. Proven in `worker-dispatch.test.js` → "Claim 1". |
| `/api/analyze/prepare` already dedups FENs (distinct `fen_before` + final `fen_after`) | ✅ True | `analyze.py` builds `positions` through a `seen` set, so the live UI never sends duplicate FENs. |
| The browser pool itself is safe against duplicate FENs | ⚠️ **Was not** | `analyzeGamePositions` had **no internal dedup**. If `positions` ever contained a repeated FEN (a careless caller, a future caller, or a game with a repeated position), each duplicate index went to a different worker and the **same FEN was searched multiple times concurrently**. Demonstrated by the originally-failing "duplicate FENs" test (FEN `A` was searched 3×). |
| The Python `_analyze_game_parallel` recomputes `fen_after(N)` and `fen_before(N+1)` | ✅ True | They are the same board; `_analyze_move` called `analyze_position(fen_before)` and `evaluate_position(fen_after)` with no shared cache, so consecutive moves re-searched the shared position. |

So: the live browser UI was safe **only because the server pre-deduped**. The pool was not
robust on its own, and the Python CLI path genuinely double-computed overlapping positions.

## 2. What changed

### Analyze (browser) — `web-src/engine/game-analyzer.js`
- **Internal FEN dedup + fan-out.** The worker pool now pulls from a queue of *distinct*
  FENs; each distinct FEN is searched exactly once and its eval is fanned out to every
  index that shares it. Output is identical for distinct input (the live flow), and the
  function is now correct regardless of caller dedup. Progress still reports on the original
  position scale, so the toast bar still reaches its full total.
- **Adaptive concurrency.** `resolveConcurrency` now scales with
  `navigator.hardwareConcurrency` (≈ one worker per core, reserving a core for the UI),
  clamped to `[1, 6]`. Each provider runs a single Stockfish thread (the provider never
  sends `setoption Threads`), so one worker ≈ one core — the previous flat cap of 4
  under-used larger machines.

### Analyze (Python CLI/legacy) — `src/prepforge_chess/services/analysis.py`
- **Per-run `_PositionEvalCache`.** A thread-safe, coalescing memo keyed by FEN. At the
  default `multipv == 1`, `fen_after` is served from the *analysis* of that position (its
  top line equals the static eval), so the shared `fen_after(N) == fen_before(N+1)`
  positions are searched **once instead of twice**. A 6-ply game drops from 12 searches to
  7 (one per distinct position). Values are unchanged — proven by
  `test_per_run_cache_keeps_results_identical_to_uncached`.

### Build Generate progress — `build-generator.js`, `build-generate-runner.js`, `app.js`
- The planner emits an observational `onEvent` stream (`{type:"search", engine}` and
  `{type:"expanded", relativePly}`). The toast uses it to keep the *message* honest
  ("searching candidate moves" vs "consulting Maia for human replies" vs "expanding
  branches"). The bar stays on the estimated-unit scale so a chatty stream can't fake
  completion. The total estimate is deliberately over-estimated ~30% so a small job doesn't
  snap to 100% and a big one isn't pegged at the ceiling. The "saving" phase already locks
  the job (non-cancellable). `onEvent` is purely observational — proven not to affect the
  plan by a determinism test.

### Build Generate concurrency — `build-generator.js`
- On the opponent's turn the **Stockfish best-move search and the Maia prediction now run
  concurrently** (`Promise.allSettled`) instead of sequentially. They are independent reads
  of the same FEN backed by *separate* providers, so this overlaps the two slowest per-node
  operations with no determinism cost (both are awaited before use; neither depends on the
  other's completion order). Proven by the "overlaps the two engine reads" and "same plan
  regardless of which read resolves first" tests.

## 3. Why the deeper Build-Generate phases were deferred

The plan proposed a Stockfish **provider pool** expanding independent child subtrees in
parallel (Phase D) and a **Maia provider pool** (Phase E). These are deferred deliberately:

1. **Maia is the bottleneck, and it is a single provider.** Build downloads a ~46 MB model
   and reuses one warm session across runs. Cross-subtree parallelism still funnels every
   opponent node through that one Maia provider, so the subtrees serialize on Maia anyway.
   The realized win from parallel subtrees is therefore small until Maia is itself pooled —
   and a Maia pool multiplies memory/init cost (Phase E's own caveat).
2. **Determinism is a hard product requirement.** The plan's own bar is "same input →
   byte-for-byte stable plan; manual moves not overwritten; mainline rules don't drift."
   The recursion mutates a shared working tree where sibling order decides mainline
   assignment and `tempId` numbering. A correct parallel version needs buffered per-subtree
   expansion with deterministic `tempId` remapping at merge. That is achievable but is a
   large, high-blast-radius change (a subtle merge bug corrupts a user's repertoire), and
   given (1) the payoff does not justify shipping it without extended validation.

The safe, high-value concurrency (concurrent Stockfish + Maia per node) is shipped now. The
`onEvent` stream is the Phase A/B instrumentation foundation a future pooled scheduler would
build on. If Maia is pooled later, the buffered-merge parallel expansion becomes worthwhile
and the determinism tests in `build-generator.test.js` are the oracle to hold it to.
