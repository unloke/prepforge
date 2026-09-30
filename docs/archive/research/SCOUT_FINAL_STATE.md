# Scout / Module B — final production state

**Status:** research closed. Production Scout is usable.  
**Date:** 2026-08-17  
**Acceptance run:** `scout-v2-acceptance-20260817`  
**This file is the single handoff.** `CURRENT_STATE.json` is the machine pointer. Historical research narrative lives in git history, not here.

## Final production choice

### Module A (fixed)

Existing production reach pipeline in `web-src/scout.js`:

- Fetch the opponent’s public Lichess games in the browser (no PrepForge compute).
- Split by the opponent’s colour.
- Build the opening trie and exact opponent-terminal branches.
- Report reach, frequency, recency, and colour baselines.

Module A was not redesigned. Exact-12 content budget is not a reach metric.

### Module B (selected)

**Official method: `scout-v2`** (`PRODUCTION_MODULE_B_ID` in `web-src/scout-selector.js`).

- Scoring version: `SCOUT_SCORING_VERSION = 3`
- Exact route budget: **12 per colour** (`SCOUT_GAME_PLAN_LIMIT`)
- Implementation: exploitability prior → hidden Stockfish prefilter → Maia enrichment → `selectProductionRoutes` / `rankGamePlan`
- UI stamp: `data-module-b="scout-v2"` on each Scout section

**Why this method**

No research candidate has a lawful official burned report with `admission=true` against the required controls (frequency, recency, frequency×recency, parent-support). The comparison index `research/module-b-final-comparison-ledger.json` covers 229 existing reports and **zero** admissions.

Literal production Scout v2 was `UNAVAILABLE_FAIL_CLOSED` on the research inventory (research inputs cannot reconstruct the live browser selector). That does **not** authorize a research identity as product. The usable product method is the existing Scout v2 path.

### Alternatives compared (already executed; not reopened)

- Required research controls: frequency, recency, frequency×recency, parent-support.
- 100+ frozen `*-outcome-12-v1` identities (see family-closure ledger + this comparison ledger).
- Near-misses only: SBU, TRU (frequency CI positive; recency/parent failed). Not product-authorized.
- Last closed identities: PKOR-v1, SKRM-v1 — coverage-adjacent, utility CIs failed.

### Stronger-but-not-legal

None. v3 semantics are frozen but have **no real prospective study and no Result authority**. No candidate may be declared better under v3.

Experimental `?scoutV12=1` / `?scoutV13=1` are not production.

## Final validation

| Item | Value |
|---|---|
| Run ID | `scout-v2-acceptance-20260817` |
| Kind | Product acceptance, not a new Result join |
| Dataset / protocol | Production fixtures + existing frozen v1 burned evidence. Official future scientific protocol remains `MODULE_B_BENCHMARK_V3.md` (no real study). Historical burned evidence remains v1 (`MODULE_B_BENCHMARK.md`) and is not retuned. |
| Production contract | exact budget 12 / colour; opponent-terminal routes; selector ignores injected Result/future labels; deterministic replay |
| Baseline comparison | 229 existing reports, `admittedCount=0` |
| Tests | See acceptance receipt |
| Reproducibility | Fixture selector replay is byte-stable. Burned scientific joins are frozen and not rerun. |

## Known limitations

- After Maia enrichment, extra loaded games often do not change rank unless the prefilter candidate set changes (`SCOUT_BUG_INVESTIGATION.md`).
- Maia success target 12 is global across colours, not 12 per colour.
- Mid-stream game plan is empirical until fetch pauses/ends and engines finish.
- `GAME_PLAN_MIN_GAMES = 1` can surface thin lines before Maia completes.
- v3 prospective causal benchmark has no real scheduled study.
- Research inventory cannot reconstruct literal Scout v2, so research vs product is not a paired scientific bakeoff.

## Research conclusion

Module B was explored far past diminishing returns under the frozen v1 burned protocol. Every Result-exposed identity failed admission. v2/v3 semantic corrections retired future use of those joins as causal proof, and v3 has no real data. There is no evidence that unlimited discovery will produce a better **usable** product method than Scout v2.

Research stops now. Restart only with new evidence, new data, or a genuinely new method hypothesis — not because Scout v2 “only tied” or “might be beaten with another weight.”

## Restart point (if Module B is ever reopened)

Frozen:

- `MODULE_B_BENCHMARK_V3.md` and `research/module-b-outcome-benchmark-v3.protocol.json` (future science; no Result yet)
- Historical v1/v2 files are immutable reproduction/history only
- All burned identities; no rerun, retune, or rename
- Fresh B and replacement A remain closed until explicitly authorized
- Product Scout v2 remains the baseline that must be beaten **on a lawful new study**, not by reinterpreting burned joins

Must beat: production `scout-v2` (and the required controls if a v1-style burned protocol is ever reused, which it should not be).

Official benchmark: `MODULE_B_BENCHMARK_V3.md`.

Failed directions: see `research/module-b-research-stop-family-closure-ledger-20260812.json`, `CURRENT_STATE.json` `scientificDispositions`, and `research/module-b-final-comparison-ledger.json`.

Do not ignore: Result isolation, exact-12 budget, Module A owns reach, no live assistance, no coverage-as-utility.

## Extension points (keep; do not speculate)

- Replace Module B by changing `PRODUCTION_MODULE_B` / `selectProductionRoutes` in `web-src/scout-selector.js` and the alias in `web-src/scout.js`.
- Do not import `research/` into `src/` or `web-src/`.
- Re-run product acceptance with `npm test -- --run scout-selector.test.js`.
- Research-only runners stay under `research/` and `scripts/run_*eval*`.
