# Scout production ranking — observed decision preparation

Updated 2026-09-26. Scoring version **9**, Module B identity `scout-v2`.
This supersedes scoring version 8's conservative full-route coverage objective.
See [selection research](scout-selection-research.md) for rationale, formulas,
real before/after results, reproduction commands and limitations.

## 1. Product objective

Choose at most 12 observed, non-nested routes per opponent colour. Maximize unique
opponent-decision preparation coverage plus bounded leaf opportunities. A route
is a plan through controllable user moves and historically observed opponent
responses; historical user move frequency is not an opponent-response probability.

`web-src/scout-preparation-value.js` implements the objective and exact budgeted
prefix-tree DP. Each opponent decision receives conditional reach times a
sample-reliability weight. Repeated decisions supported by the same nested game
set receive diminishing credit. Shared decision prefixes are counted once across
the selected set. The DP compares a parent with every feasible child combination,
then adds an edge's decision credit once if that subtree is used.

No minimum route length, opening-family quota, singleton exclusion, or length-only
bonus is used. A deeper route adds value only through observed decisions and/or
leaf opportunity. Short tactical routes can still win. Full-route `n=1` remains
one game, even if its shared opening decisions have much more historical evidence.

## 2. Production pipeline

1. Actual games generate exact opponent-terminal opening routes and supported
   branching prefixes. No population or engine-generated route becomes a candidate.
2. The full same-colour/speed trie supplies exact support, empirical results and
   `preparationDecisions`: opponent-only `{ ply, moveGames, parentGames }` counts.
3. The existing weakest-opponent-decision Jeffreys plausibility gate stays at 10%.
   This is separate from the raw conditional product used in decision utility.
4. The bounded engine queue ranks single-route preparation utility and retains up
   to 300 candidates per colour. This remains a heuristic compute allocation;
   parent/child candidates can both reach the engine.
5. Stockfish depth 8, three workers, cached leaf FEN reads. The existing actionable
   reply / positive user opportunity gate remains. Assessed metrics and decision
   evidence travel with each line; no intermediate nested collapse is performed.
6. Prospective DP recommendations receive optional Maia enrichment first, then
   backups (global 64 attempts/pool, 12-success target). Maia is at most two
   pseudo-games for leaf outcome opportunity, never opponent reach or support.
7. The report overlays assessed metrics and Maia onto observed branch evidence,
   then invokes the same DP. Available Maia is not a separate selection class.
8. An assessed empty opportunity set remains empty. Engine-unavailable fallback
   uses the same decision objective on observed candidates with provisional leaf
   opportunity 0.1. Only callers without conditional evidence use conservative
   observed-frequency leaf utility; they get no invented decision-coverage credit.
   Cache scopes include scoring version 9.

## 3. Evidence and score fields

| Field | Meaning |
| --- | --- |
| `games` | Exact terminal branch count; zero for generated nonterminal candidates |
| `routeSupportGames` | Personal games reaching the entire prefix, never ancestor support |
| `evidenceGames` | Same-colour/speed corpus count |
| `preparationDecisions` | Opponent-only exact conditional counts, one-based ply |
| `routeScorePct` | Full-prefix empirical opponent score |
| `routeReach`, `routePlausibility` | Weakest Jeffreys estimate / evidence for the plausibility gate |
| `prefilterScore`, `mateIn`, `hasUserReply` | User-perspective engine opportunity / usability |
| `maiaScorePct`, `maiaWdl` | Supplemental opponent WDL estimate |
| `preparationEvidence.coverage` | Wilson lower observed frequency, retained as a diagnostic and incomplete-evidence fallback |
| `preparationEvidence.conditionalReach` | Product of raw opponent-only conditional frequencies; a descriptive plug-in estimate |
| `preparationEvidence.decisionCoverage` | Single-route sum of diminishing decision credits |
| `preparationEvidence.terminalValue` | Conditional reach × full-route reliability × bounded opportunity |
| `preparationEvidence.value` | Single-route utility, used for queue/display; set utility deduplicates shared decisions |

`ancestorGames`, `ancestorScorePct`, recency, clocks and game lengths remain
aggregation/display diagnostics, not direct route-selection drivers. No old
family-prior, Maia-presence sort, or terminal-count nested replacement is restored.

## 4. Verification and research boundary

`scout-selection-v2.test.js` covers the pinned public-game failure both before
engine availability and after actual depth-8 reads, controllable user moves,
rare opponent responses, single-game continuations, repeated-evidence saturation,
bounded Maia and 90 exhaustive comparisons of the shared-decision DP.
Existing evidence transport, report, queue, prefilter and live fallback tests remain.

The frozen v8 objective is in `research/scout-selection-v8.js`; only the offline
study imports it. Production imports no historical selector. The implementation
and test details are in [selection research](scout-selection-research.md).

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
