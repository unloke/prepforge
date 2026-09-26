# Scout Production Ranking ? evidence and budgeted route sets

Updated 2026-09-26. Production scoring version **8**, Module B identity `scout-v2`.
This replaces the temporary `7f79e9d` handoff rules. The complete study, alternatives,
formal objective, synthetic results and limitations are in
[scout-selection-research.md](scout-selection-research.md).

## 1. Product objective and final selector

Select at most 12 observed opening routes per opponent colour under a limited
preparation budget. Routes must have personal evidence, an opportunity worth
preparing, and contribute coverage without parent/child duplication.

`web-src/scout-preparation-value.js` is the pure selection implementation:

- `preparationValue`: Wilson lower observed coverage ? bounded preparation opportunity.
- `selectPreparationRoutes`: exact budgeted prefix-tree dynamic programming.
- Objective: sum of conservative expected preparation values, independent of opening family.
- Feasible sets are antichains: no two paths are equal or prefixes of one another.
- At every prefix, DP compares a parent against complete feasible child combinations
  at every slot count. It combines subtrees under the shared 12-slot budget.
- Twelve valuable, distinct targets from the same opening family may all be selected.
- Equal utility prefers fewer slots, then deterministic UCI traversal; an equally
  useful ancestor replaces a descendant. There is no depth bonus.
- Selected rows are displayed by preparation value, with a UCI tie-break.

The engine opportunity is cp/(100+cp) for positive user-perspective cp, 1 for a
user-favourable mate, and 0 for an assessed nonpositive edge. Missing engine data
uses a provisional 0.1. A weakness multiplier uses full-route empirical opponent
score shrunk by two pseudo-games toward Maia WDL (or their baseline when missing).
Maia never adds support or modifies the route plausibility gate.

## 2. Production pipeline

```
observed games ? opening trie + exact terminal branches
 ? supported branching prefixes + full-route evidence
 ? opponent-decision plausibility gate
 ? bounded preparation-value engine queue (?300 per colour)
 ? depth-8 leaf Stockfish reads, usable-reply / positive-opportunity gate
 ? retained assessed candidates + bounded optional Maia enrichment
 ? one final budgeted antichain DP ? attach replies / refutations ? report
```

1. `scout.js`: `aggregateOpeningBranches` keeps exact opponent-terminal paths and
   deduplicates their game IDs. `rankedOpeningBranches` adds observed opponent-terminal
   branching prefixes with ?3 supporting games and at least two observed two-ply
   continuations. No new moves, engine lines or population routes become candidates.
2. Full route support and results come from the same-colour/speed trie. Both the
   live view and report fallback build full opening tries (`maxPlies: Infinity`).
   If a complete prefix cannot be resolved, terminal support remains a lower-bound
   fallback, and incomplete plausibility is not eligible for the engine queue.
3. `opponentRoutePlausibility` retains the weakest opponent-only Jeffreys conditional
   decision estimate; <10% is rejected. It is not route frequency or full-route support.
4. `trimRankedBranches` allocates up to 300 reads by personal preparation value.
   It keeps parent and child candidates for engine comparison. No prior noise floor,
   minimum-64 fill rule, or pre-engine nested collapse remains. Probability/utility
   is cached once per candidate during queue construction.
5. `scout-prefilter.js`: one cached leaf FEN read, Stockfish depth 8, three workers.
   No usable user reply or no positive position opportunity means ineligible.
   Empirical wins do not veto an engine opportunity. Entries retain all assessed
   metrics on both the entry and its `line` object. Assessed candidates sort by
   personal preparation value; they are not nested-collapsed.
6. Maia scheduling first considers prospective DP recommendations in each colour,
   then backups, within a global 64-entry pool / 64 attempts and 12-success target.
   `buildGamePlanDisplayLines` preserves all assessed candidates, including those
   without Maia; Maia success no longer decides candidate eligibility or creates
   a separate ordering class. The final selector may choose unassessed-by-Maia rows.
7. `scout-report.js` overlays passed assessed metrics onto branch evidence, applies
   available Maia estimates and calls `scout-selector.js` ? `rankGamePlan` ? DP.
   `rankGamePlan` normalizes opponent-terminal paths and enriches display fields;
   recency lookups run on selected rows only. Report fallback is also capped at 300.
8. An assessed empty opportunity set stays empty. Only unavailable evaluations or
   an engine exception use the engine-free candidate fallback. Fallback preserves
   candidates independently of the smaller Maia backup pool. Maia errors leave
   personal selection available. Cache scopes include scoring version 8.

## 3. Data semantics

| Field | Meaning / ranking role |
| --- | --- |
| `games` | Exact terminal count; retained for existing branch diagnostics. Newly generated nonterminal candidates have 0. Not the ranking evidence. |
| `routeSupportGames` | Personal games reaching the complete route prefix; primary evidence n. |
| `evidenceGames` | Same-colour/speed corpus count N. |
| `routeScorePct` | Unweighted full-prefix empirical opponent expected score percentage. |
| `routeReach` | Weakest sample-aware opponent decision probability; plausibility gate only. |
| `routePlausibility` | Complete gate evidence, including weakest decision counts. |
| `prefilterScore` | Stockfish user-perspective leaf cp; bounded opportunity input. |
| `mateIn`, `hasUserReply` | User-favourable mate and actionable leaf assessment. |
| `maiaScorePct`, `maiaWdl` | Supplemental opponent-perspective WDL, never personal reach evidence. |
| `preparationEvidence` | `{ support, total, coverage, opportunity, value }`; coverage is Wilson lower observed frequency. |
| `ancestorGames`, `ancestorScorePct` | Remaining diagnostic prefix metadata; not selection drivers. |

Generated prefix rows also carry full-prefix `gameCount`/WDL for existing rendering
instead of showing a zero-size empirical sample. `branchScore`, recency-weighted
`share`, clocks, game lengths and `lastSeen` are not ranking drivers; legacy branch
aggregation/display/research still consume some of these fields. `prefixGames`,
`offModal`, `exploitabilityStruggle`, and `exploitabilityPrior` are no longer produced
or propagated by the production ranking path.

Coverage is a conservative historical proxy, not a calibrated next-game probability.
A route with 1/1 observations gets about .207 Wilson coverage; 2/2 about .342, and
40/40 about .912. The 95% endpoint is not a simultaneous post-selection confidence
statement. See the study for user-choice, overlap modeling and engine limitations.

## 4. Removed logic and verification contracts

Removed from production: prior-floor pruning, family-borrowed struggle prior,
comfort-zone exclusion, engine OR-rescue gates and exploitability multiplier,
pre-engine nested collapse, terminal-count/engine/depth final replacement,
Maia-presence-first sort, Maia-success-only display truncation, and final
weakness/recency/branch-score tie hierarchy. Historical prior helpers and frozen
comparators live only in `research/` for reproducible archived studies; there are
no runtime compatibility exports for the replaced algorithms.

Regression coverage: `scout-preparation-value.test.js` (synthetics, exhaustive
optimality, uncertainty, no depth bonus, cap), `scout-nested-support.test.js`
(real corpus counts, generated trunks, transport), `scout-logical-cut.test.js`
(engine budget without family quotas), plus prefilter, report, selector and live Maia
orchestration tests. Former temporary selection expectations were explicitly
replaced; the independent evidence-semantics assertions remain.

Research scripts can import frozen comparators, but the production module graph
must not import `research/scout-selection-*` or `research/scout-legacy-prior.js`.
The v13/runtime/archive boundary below remains unchanged.

## 5. Experimental runtime（?scoutV13=1）與 research/archive

### 5.1 Experimental runtime path — Scout v13

`views/scout.js` 的 `isV13Mode()`（`new URLSearchParams(window.location.search).has("scoutV13")`）
目前仍可從 UI runtime 啟用，因此 v13 **不是 pure archive**：它有活的 runtime entry，
但不屬於 default production ranking。

- 進入點：`web-src/views/scout.js` `isV13Mode()`；v13 是獨立 panel，
  `!isV13Mode()` 才會排程 classic prefilter/Maia enrichment（v13 與 default path 互斥）。
- 模組：`scout-v13-stream.js` → `scout-v13-adapter.js` / `scout-v13-funnel.js` /
  `scout-v13-extension.js` / `scout-v13-package.js` / `scout-v13-style.js` /
  `scout-v13-report.js`。
- v13 仍共用部分 research 模組：`scout-v13-*.js` import `scout-route-audit.js`、
  `scout-bias-routes.js`、`scout-bias-features.js`——這些模組自身沒有 runtime entry，
  目前僅透過 v13（及彼此）被載入，因此歸類為 experimental runtime 的共享依賴，
  而非 pure archive。

### 5.2 Legacy/archive module with a remaining shared dependency

`scout-v12-report.js`：v12 production branch 已於先前清理輪從 production runtime
graph 移除（`views/scout.js` 的 `?scoutV12` mode：`v12Audits` 永遠為空 → report
不可能渲染，含 `isV12Mode`/`paintV12Panel`/`handleV12ActionClick` 等，以及
`app.js` 的 `?scoutV12` eager-init hook）。但 `scout-v13-funnel.js` 與
`scout-v13-report.js` 仍 import 其 `V12_BANNED_VOCAB`，因此它是
**legacy/archive module with a remaining shared dependency**，不是完全 dead code。

### 5.3 Research / archive（沒有目前 runtime entry）

- bias experiments：`scout-bias-cohort.js`、`scout-bias-fit.js`
- census / ref-df：`scout-ref-df-census.js`
- graph：`scout-graph.js`（僅被其他 archive 模組引用）
- v15 studies：`scout-v15-study.js`、`scout-v15-engine-cache.js`
- shadow-prep：`scout-shadow-prep-p0.js`、`scout-shadow-prep-exact-solver.js`
- 其他：`scout-stockfish-uci.js`（目前無任何 importers）
- `research/**`、`scripts/scout-*.mjs`、protocol JSON、歷史設計文件
  （`docs/scout-v12-design.md`、`docs/scout-v13-design.md`）。

測試、E2E infrastructure、benchmark / verification scripts、protocol JSON 原樣保留。
