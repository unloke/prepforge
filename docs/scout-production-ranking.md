# Scout Production Ranking — pipeline、資料語意與固定 contract

> 本文件是 Scout production ranking 的權威說明。下一位研究者只需讀這份文件與
> production modules（§1），即可理解現況並專注研究 parent/child route selection
> algorithm（§6）。本輪（2026-09-25）**不設計新的 ranking algorithm**。

Baseline commit：`1b7b28f fix(scout): preserve supported trunks during nested collapse`
（nested-selection 行為以此為 temporary baseline，見 §4）。

## 1. Production modules

| Module | 角色 |
| --- | --- |
| `web-src/views/scout.js` | Scout UI runtime entry（由 `web-src/app.js` lazy `import("./views/scout.js")`）。串流控制、live trie、enrichment 排程。 |
| `web-src/scout.js` | 資料模型與核心：PGN/ND-JSON 解析、opening trie、branch 聚合、plausibility、struggle/prior、`rankGamePlan`（Module B 實作）。 |
| `web-src/scout-probability.js` | 樣本感知的條件機率估計（`opponentMoveProbability`：jeffreys/laplace/wilson）。 |
| `web-src/scout-prefilter.js` | Hidden Stockfish prefilter：leaf 評分、gate、nested collapse、pool 提供。 |
| `web-src/scout-maia.js` | Maia3 enrichment 與 final game-plan display lines。 |
| `web-src/scout-selector.js` | Production Module B 邊界：`selectProductionRoutes` → `rankGamePlan`（`PRODUCTION_MODULE_B_ID = "scout-v2"`）。 |
| `web-src/scout-report.js` | Section report 組裝（`buildScoutSectionReport`）：把 branches、prefilter 結果、Maia 結果接成最終 game plan。 |
| `web-src/scout-stats.js` / `scout-summary.js` / `scout-engine.js` / `scout-explorer.js` / `scout-refutation.js` | Intel、summary、engine deep-scan、explorer reads、refutation——**不參與 route selection 排序**。 |
| `web-src/engine/game-analyzer.js` / `engine/stockfish-provider.js` / `engine/maia3-provider.js` | 引擎存取層（Stockfish depth-8 leaf reads、Maia3 ONNX）。 |

非 production（research/archive，見 §5）：`scout-v12-report.js`、`scout-v13-*`、
`scout-bias-*`、`scout-graph.js`、`scout-route-audit.js`、`scout-shadow-prep-*`、
`scout-ref-df-census.js`、`scout-v15-*`、`scout-stockfish-uci.js` 等研究模組，
以及 `research/**`、`scripts/scout-*.mjs`、protocol JSON、歷史設計文件
（`docs/scout-v12-design.md`、`docs/scout-v13-design.md`）。

## 2. Production call flow

以 runtime imports / call sites 為準，唯一 production flow：

```
games → trie → candidate branches → plausibility → Stockfish prefilter
      → nested collapse → enrichment → final game plan
```

1. **games** — `scout.js` `createScoutClient().streamGames` 串流 Lichess PGN/ND-JSON，
   解析成 game records（`ucis`/`sans`/`score`/`speed`/`datestamp`/`gameId`）；
   `views/scout.js` `onScoutGame` 累積 `scoutState.games`。
2. **trie** — `views/scout.js` `liveTrieForColor` / `insertIntoLiveTries`：
   `createOpeningTrie` + `insertGameIntoTrie`（`maxPlies: Infinity`，每局 O(opening depth)）。
   Report fallback 為 `scout-report.js` 內 `buildOpeningTrie(games, oppColor, { speedFilter })`。
3. **candidate branches** — `scout.js` `rankedOpeningBranches(games, oppColor, { speedFilter, trie, baselineScorePct })`：
   `aggregateOpeningBranches` 把每局歸入其 **exact opponent-terminal route**（依 `gameId` 去重），
   再逐支標註 struggle / plausibility / prior，以 `exploitabilityPrior` 排序。
   `views/scout.js` `openingBranchBundleForColor` 接 `trimRankedBranches`
   （prior noise floor 為主要剪裁，`[SCOUT_BRANCH_MIN_KEEP=64, SCOUT_BRANCH_HARD_CEILING=300]` 夾限）。
4. **plausibility** — `scout.js` `opponentRoutePlausibility`：沿路線**只對對手決策 ply** 計算
   `opponentMoveProbability(moveGames, parentGames, "jeffreys")` 的條件機率，取最弱者即 `routeReach`。
   `SCOUT_MIN_ROUTE_REACH = 0.1` 以下整條拒絕——三處一致：
   `rankedOpeningBranches` 過濾、`rankPrefilterCandidates` gate、`rankGamePlan` 過濾。
5. **Stockfish prefilter** — `scout-prefilter.js` `runStockfishPrefilter`：
   `collectPrefilterFens` 只取 leaf FEN → `engine/game-analyzer.js` `analyzeGamePositions`
   （depth `SCOUT_STOCKFISH_DEPTH = 8`）→ `scorePrefilterLine`（`prefilterScore = userLeafAdvantage`）
   → gate（routeReach ≥ 0.1、`isOpponentComfortZone`、OR-gate：`mateIn > 0` 或
   `adv ≥ 20cp` 或 `struggle ≥ 0.15 且 adv > 0` 或 `exploitabilityPrior > 0.4 且 adv > 0`）
   → `exploitabilityRank` 排序。
6. **nested collapse** — 兩處（詳見 §4）。
7. **enrichment** — Maia3：`scout-prefilter.js` `mergeGlobalPrefilterRanked` 合併兩色 pool →
   `scout-maia.js` `enrichGlobalMaiaPool`（`engine/maia3-provider.js`）補 `maiaWdl`/`maiaScorePct`；
   另有 explorer reads（`scout-explorer.js`）與 deep-scan engine aggregation（`scout-engine.js`）。
   這些是 intel/enrichment，**不改變 route selection 排序**。
8. **final game plan** — `scout-report.js` `buildScoutSectionReport`：`buildGamePlanDisplayLines`
   把 prefilter/Maia 顯示線對回 branches → `scout-selector.js` `selectProductionRoutes`
   （= `scout.js` `rankGamePlan`）→ `attachPrepReplies` → UI rows。

## 3. Ranking signal 定義

| 欄位 | 定義 | 來源 |
| --- | --- | --- |
| `games` | **exact terminal branch count**：個人對局中完整走到此 candidate route（opponent-terminal）且開局紀錄止於此的局數（gameId 去重）。 | `aggregateOpeningBranches` |
| `routeReach` | **weakest sample-aware opponent conditional decision probability**：路線上所有對手決策 ply 的 jeffreys 條件機率之最小值。只計對手決策，不含我方著。 | `opponentRoutePlausibility`（scout.js） |
| `prefixGames` | **deepest reliable family-prefix sample**：`branchStruggle` 往回找到最深、`gameCount ≥ SLIP_MIN_GAMES = 3` 的 prefix 節點樣本數，backing struggle 訊號。 | `branchStruggle`（scout.js） |
| `ancestorGames` | **existing ancestor sample**：最後一著的 parent 節點 `gameCount`（fallback trie root），供 `isOpponentComfortZone` 等使用。 | `rankedOpeningBranches` 內 `triePrefixStats(...).at(-1)` |
| `routeSupportGames` | **實際走到完整 candidate route 的個人對局數**＝trie 對該完整 UCI prefix 的 `gameCount`（新欄位，見 §3.1）。 | `rankedOpeningBranches` 內 `triePrefixStats(trie, b.ucis)` |

支援性訊號（非上述五欄）：`branchScore`（recency × length × think-time 權重和）、
`share`/`rawShare`、`scorePct`/`w`/`d`/`l`、`exploitabilityStruggle`、`offModal`（僅診斷）、
`exploitabilityPrior`（=（struggle + 0.08）×（log1p(prefixGames) + 0.1)）、
`prefilterScore`（depth-8 leaf `userLeafAdvantage`）、`mateIn`/`hasUserReply`、
`ancestorScorePct`/`ancestorFrequency`、`routePlausibility`（完整決策細節）、
`maiaScorePct`/`maiaWdl`、Wilson 上下界與 `prepCategory`（`enrichPrepTarget`）、`lastSeen`。

### 3.1 routeSupportGames（本輪新增）

- **定義**：實際走到完整 candidate route 的個人對局數。
- **來源**：trie 對該完整 UCI prefix 的 `gameCount`（`triePrefixStats(trie, b.ucis)` 的最後一個節點）。
  trie 只能在 ply cap 內解析完整 prefix 時取此值；無法完整解析（或無 trie）時退化為
  `games`（exact terminal count 是 full-route reach 的下界）。
- **語意區別**（characterization tests 固定驗證）：
  - `games` = 只數「止於此 route」的對局（40 games terminal at trunk → `trunk.games = 40`）。
  - `routeSupportGames` = 數「走過完整 route」的對局（40 terminal + 40 續行 → `trunk.routeSupportGames = 80`、`child.routeSupportGames = 40`）。
  - `routeReach` = 對手決策條件機率（0..1 的機率值），不是 game count。
- **傳遞**：`rankedOpeningBranches` →（`trimRankedBranches`）→ `scorePrefilterLine`
  （prefilter scored entries）→ `rankPrefilterCandidates` / `runStockfishPrefilter` 的 `ranked` →
  `mergeGlobalPrefilterRanked` pool → `rankGamePlan` 輸出之 final game-plan candidate
  （`enriched.routeSupportGames`）。
- **本輪不使用它改變任何 ranking decision**（排序與 nested selection 保持 1b7b28f 行為）。

## 4. Nested collapse 的位置與 temporary baseline

Nested（prefix）關係由 `scout.js` `isNestedLine` 判定（UCI path 互為 prefix）。collapse 發生在兩處：

1. **prefilter 階段**：`scout-prefilter.js` `rankPrefilterCandidates` 末段呼叫
   `collapseNestedPrefilterLines`（在 OR-gate 與 `exploitabilityRank` 排序之後）。
2. **final game-plan 階段**：`scout.js` `rankGamePlan` 的 `chosen` 迴圈
   （排序之後、輸出之前；`selectProductionRoutes` 即此路徑）。

**1b7b28f temporary rule（本輪固定不動）**：兩處皆先比 personal route support
（`entry.line.games`／`g.games`，exact terminal count）——support 不同則高者勝（不回退到 score）；
support 相同才比 engine score（`prefilterScore`）；再相同才看深度（child 優先取代 parent）。
`routeReach`（對手決策機率）與 family counts **不作為 full-route support 證據**。
這是 temporary baseline，**不是最終演算法**——替換它就是 §6 的問題。

固定 contract：`web-src/scout-nested-support.test.js`（40/40 corpus、sparse 1/1 與 2/2、
<10% opponent-decision rejection、equal-support 時 engine score 決勝、routeSupportGames
傳遞與三欄語意區隔）。演算法研究階段不得破壞這些測試。

## 5. 本輪範圍（清理與保留）

- 已從 production runtime graph 移除 **確認 dead 的 v12 production branch**
  （`views/scout.js` 的 `?scoutV12` mode：`v12Audits` 永遠為空 → report 不可能渲染，
  含 `isV12Mode`/`paintV12Panel`/`handleV12ActionClick` 等，以及 `app.js` 的 `?scoutV12`
  eager-init hook）。
- **保留**：`research/**`、benchmark / verification scripts、protocol JSON、
  歷史設計文件、E2E infrastructure、全部現行 Scout production tests。
- v13 / shadow / bias 等研究模組原樣保留（v13 仍可由 `?scoutV13=1` 進入）；
  `scout-v12-report.js` 作為 archive 保留（v13 研究模組仍 import 其 `V12_BANNED_VOCAB`）。

## 6. 留給下一階段的唯一問題

> Given parent and child routeSupportGames, continuation evidence, sample size and
> engine score, determine when a deeper child has sufficient personal evidence to
> represent its parent route.

本輪先不決定（留給演算法研究）：

- support threshold
- Bayesian estimator
- confidence interval
- engine/support weighting
- Maia weighting
