# Scout Production Ranking — pipeline、資料語意與固定 contract

> 本文件是 Scout production ranking 的權威說明。下一位研究者只需讀這份文件與
> production modules（§1），即可理解現況並專注研究 parent/child route selection
> algorithm（§6）。最後修正：2026-09-26（文件修正輪；production code 與 ranking
> algorithm 維持 `9dfbbf7` 狀態，不設計新演算法）。

Baseline commit：`1b7b28f fix(scout): preserve supported trunks during nested collapse`
（nested-selection 行為以此為 temporary baseline，見 §4）。

## 0. 三層分類：default production / experimental runtime / research archive

| 層 | 進入方式 | 內容 |
| --- | --- | --- |
| **Default production path**（Scout v2 / current production ranking） | 一般使用者載入 Scout 時的預設行為 | `games → trie → rankedOpeningBranches → opponentRoutePlausibility → Stockfish prefilter → nested collapse → Maia enrichment → rankGamePlan → final game plan`（§2） |
| **Experimental runtime path**（Scout v13） | `?scoutV13=1`——目前 UI runtime 仍可啟用 | stream-native prep packages；**不是** default production ranking，但**也不是** pure archive（見 §5.1） |
| **Research / archive** | 沒有任何目前 runtime entry | shadow-prep、bias experiments、census / ref-df、v15 studies、`research/**`、research scripts / protocol JSON、歷史設計文件（見 §5.2、§5.3）；例外：`scout-route-audit.js` 等無 entry 模組目前僅作為 v13 的共享依賴被載入（§5.1） |

## 1. Production modules（default production path）

以下僅涵蓋 default production path；experimental / research 模組見 §5。

| Module | 角色 |
| --- | --- |
| `web-src/views/scout.js` | Scout UI runtime entry（由 `web-src/app.js` lazy `import("./views/scout.js")`）。串流控制、live trie、enrichment 排程；另含 `?scoutV13=1` 的 experimental v13 branch（§5.1）。 |
| `web-src/scout.js` | 資料模型與核心：PGN/ND-JSON 解析、opening trie、branch 聚合、plausibility、struggle/prior、`rankGamePlan`（Module B 實作）。 |
| `web-src/scout-probability.js` | 樣本感知的條件機率估計（`opponentMoveProbability`：jeffreys/laplace/wilson）。 |
| `web-src/scout-prefilter.js` | Hidden Stockfish prefilter：leaf 評分、gate、nested collapse、pool 提供。 |
| `web-src/scout-maia.js` | Maia3 enrichment 與 final game-plan display lines。 |
| `web-src/scout-selector.js` | Production Module B 邊界：`selectProductionRoutes` → `rankGamePlan`（`PRODUCTION_MODULE_B_ID = "scout-v2"`）。 |
| `web-src/scout-report.js` | Section report 組裝（`buildScoutSectionReport`）：把 branches、prefilter 結果、Maia 結果接成最終 game plan。 |
| `web-src/scout-stats.js` / `scout-summary.js` / `scout-engine.js` / `scout-explorer.js` / `scout-refutation.js` | Intel、summary、engine deep-scan、explorer reads、refutation——不參與 route selection 排序。 |
| `web-src/engine/game-analyzer.js` / `engine/stockfish-provider.js` / `engine/maia3-provider.js` | 引擎存取層（Stockfish depth-8 leaf reads、Maia3 ONNX）。 |

## 2. Production call flow（default path）

以 runtime imports / call sites 為準，default production path（v2）的 flow：

```
games → trie → candidate branches → plausibility → Stockfish prefilter
      → nested collapse → Maia enrichment → final game plan
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
   這是 **opponent-decision plausibility gate**（對手決策條件機率門檻），
   **不是 personal route-support threshold**（個人對局數門檻）。
5. **Stockfish prefilter** — `scout-prefilter.js` `runStockfishPrefilter`：
   `collectPrefilterFens` 只取 leaf FEN → `engine/game-analyzer.js` `analyzeGamePositions`
   （depth `SCOUT_STOCKFISH_DEPTH = 8`）→ `scorePrefilterLine`（`prefilterScore = userLeafAdvantage`）
   → gate（routeReach ≥ 0.1、`isOpponentComfortZone`、OR-gate：`mateIn > 0` 或
   `adv ≥ 20cp` 或 `struggle ≥ 0.15 且 adv > 0` 或 `exploitabilityPrior > 0.4 且 adv > 0`）
   → `exploitabilityRank` 排序。
6. **nested collapse** — 兩處（詳見 §4）。
7. **Maia enrichment** — `scout-prefilter.js` `mergeGlobalPrefilterRanked` 合併兩色 pool →
   `scout-maia.js` `enrichGlobalMaiaPool`（`engine/maia3-provider.js`）補 `maiaWdl`/`maiaScorePct`。
   Maia enrichment **不改變** games、routeSupportGames、routeReach 等個人證據，
   但**會改變 final `rankGamePlan` 排序**（§2.1）。
   另有 explorer reads（`scout-explorer.js`）與 deep-scan engine aggregation（`scout-engine.js`）；
   這兩者是 intel/refutation 來源，不參與 route selection 排序。
8. **final game plan** — `scout-report.js` `buildScoutSectionReport`（report fallback）或
   `views/scout.js` live path：`applyMaiaToLines` 把 Maia 結果接上 lines →
   `buildGamePlanDisplayLines` 把 prefilter/Maia 顯示線對回 branches →
   `scout-selector.js` `selectProductionRoutes`（= `scout.js` `rankGamePlan`）→
   `attachPrepReplies` → UI rows。

### 2.1 Maia 在 final ranking 中的精確角色（`rankGamePlan` 排序）

`scout.js` `rankGamePlan` 的 sort（`selectProductionRoutes` 即此路徑）目前順序：

1. **Maia 有無**：有 `maiaScorePct` 的 candidate 優先於沒有的
   （`aHasMaia !== bHasMaia → aHasMaia ? -1 : 1`）。
2. **兩者都有 Maia 時**：`maiaScorePct` 升冪——分數越低（對手期望得分越低、
   越可剝削）越優先。`maiaScorePct` 是 Maia3 WDL 折算成**對手 perspective**
   的期望得分百分比（`wdlToOpponentPerspective` + `maiaScorePctFromWdl`，
   = win + 0.5 × draw）。
3. **接著**（兩者皆無 Maia、或 Maia 分數相同）依序比較：
   weakness（`openingWeaknessScore`）、recency（`lastSeen`）、`branchScore`、
   `share`、`games`，最後以路線 key 做決定性 tie-break。
4. 排序之後才進入 nested collapse（§4）與 `limit` 截斷。

精確語意：

- Maia enrichment **不改變** games、routeSupportGames、routeReach 等 personal evidence。
- Maia **會影響** final `rankGamePlan()` 排序：有 Maia 結果的 candidate 目前
  優先於沒有 Maia 結果的 candidate（fixed tests：`scout.test.js`
  「Maia-assessed lines rank before unenriched lines regardless of empirical
  opportunity」）。
- Maia 也影響 badge 語意：有 Maia 時 `enrichPrepTarget` 以 `maiaScorePct`
  取代 `scorePct` 作為 attack/weapon 分類基準（此時不套 Wilson margin）。
- `g.maiaScorePct` 由 `scout-report.js` / `views/scout.js` 經
  `applyMaiaToLines` → `enrichPrepTarget(..., { maiaScorePct })` 接上後進入排序。

## 3. Ranking signal 定義

| 欄位 | 定義 | 來源 |
| --- | --- | --- |
| `games` | **exact terminal branch count**：個人對局中完整走到此 candidate route（opponent-terminal）且開局紀錄止於此的局數（gameId 去重）。 | `aggregateOpeningBranches` |
| `routeReach` | **weakest sample-aware opponent conditional decision probability**：路線上所有對手決策 ply 的 jeffreys 條件機率之最小值。只計對手決策，不含我方著。 | `opponentRoutePlausibility`（scout.js） |
| `prefixGames` | **deepest reliable family-prefix sample**：`branchStruggle` 往回找到最深、`gameCount ≥ SLIP_MIN_GAMES = 3` 的 prefix 節點樣本數，backing struggle 訊號。 | `branchStruggle`（scout.js） |
| `ancestorGames` | **parent/ancestor sample currently used by downstream logic**：最後一著的 parent 節點 `gameCount`（fallback trie root），供 `isOpponentComfortZone` 等使用。 | `rankedOpeningBranches` 內 `triePrefixStats(...).at(-1)` |
| `routeSupportGames` | **實際走到完整 candidate route 的個人對局數**＝trie 對該完整 UCI prefix 的 `gameCount`（`9dfbbf7` 加入，見 §3.1）。 | `rankedOpeningBranches` 內 `triePrefixStats(trie, b.ucis)` |

其他訊號（非上述五欄）：`branchScore`（recency × length × think-time 權重和）、
`share`/`rawShare`、`scorePct`/`w`/`d`/`l`、`exploitabilityStruggle`、`offModal`（僅診斷）、
`exploitabilityPrior`（=（struggle + 0.08）×（log1p(prefixGames) + 0.1)）、
`prefilterScore`（depth-8 leaf `userLeafAdvantage`）、`mateIn`/`hasUserReply`、
`ancestorScorePct`/`ancestorFrequency`、`routePlausibility`（完整決策細節）、
Wilson 上下界與 `prepCategory`（`enrichPrepTarget` 派生）、`lastSeen`。

`maiaScorePct`/`maiaWdl`（Maia enrichment 產出）**參與 final `rankGamePlan` 排序**
（§2.1），並在有 Maia 時接管 `enrichPrepTarget` 的 attack/weapon 分類基準；
它們不屬於 personal evidence（見 §2.1 精確語意）。

### 3.1 routeSupportGames（`9dfbbf7` 加入）

- **定義**：實際走到完整 candidate route 的個人對局數。
- **來源**：trie 對該完整 UCI prefix 的 `gameCount`（`triePrefixStats(trie, b.ucis)` 的最後一個節點）。
  trie 只能在 ply cap 內解析完整 prefix 時取此值；無法完整解析（或無 trie）時退化為
  `games`（exact terminal count 是 full-route reach 的下界）。
- **語意區別**（characterization tests 固定驗證：`web-src/scout-nested-support.test.js`）：
  - `games` = 只數「止於此 route」的對局（40 games terminal at trunk → `trunk.games = 40`）。
  - `routeSupportGames` = 數「走過完整 route」的對局（40 terminal + 40 續行 → `trunk.routeSupportGames = 80`、`child.routeSupportGames = 40`）。
  - `routeReach` = 對手決策條件機率（0..1 的機率值），不是 game count。
- **傳遞**：`rankedOpeningBranches` →（`trimRankedBranches`）→ `scorePrefilterLine`
  （prefilter scored entries）→ `rankPrefilterCandidates` / `runStockfishPrefilter` 的 `ranked` →
  `mergeGlobalPrefilterRanked` pool → `rankGamePlan` 輸出之 final game-plan candidate
  （`enriched.routeSupportGames`）。
- **目前不使用它改變任何 ranking decision**：排序與 nested selection 保持
  `1b7b28f` 行為；`routeSupportGames` 只被計算與傳遞，尚未參與 nested selection
  （nested 比較仍用 exact-terminal `games`，見 §4）。

## 4. Nested collapse 的位置與 temporary baseline

Nested（prefix）關係由 `scout.js` `isNestedLine` 判定（UCI path 互為 prefix）。collapse 發生在兩處：

1. **prefilter 階段**：`scout-prefilter.js` `rankPrefilterCandidates` 末段呼叫
   `collapseNestedPrefilterLines`（在 OR-gate 與 `exploitabilityRank` 排序之後）。
2. **final game-plan 階段**：`scout.js` `rankGamePlan` 的 `chosen` 迴圈
   （排序之後、輸出之前；`selectProductionRoutes` 即此路徑）。

**1b7b28f temporary rule（固定不動，僅是 temporary baseline，不是下一階段推薦的
最終演算法）**：兩處皆先比 personal route support
（`entry.line.games`／`g.games`，exact terminal count）——support 不同則高者勝（不回退到 score）；
support 相同才比 engine score（`prefilterScore`）；再相同才看深度（child 優先取代 parent）。
`routeReach`（對手決策機率）與 family counts **不作為 full-route support 證據**。
`routeSupportGames` 雖已計算並傳遞（§3.1），**尚未參與 nested selection**。
替換這條 temporary rule 就是 §6 的問題。

固定 contract：`web-src/scout-nested-support.test.js`（40/40 corpus、sparse 1/1 與 2/2、
<10% opponent-decision rejection、equal-support 時 engine score 決勝、routeSupportGames
傳遞與三欄語意區隔）。演算法研究階段不得破壞這些測試。

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

## 6. 留給下一階段的唯一問題

> Given parent and child routeSupportGames, continuation evidence, sample size,
> existing opponent-decision plausibility (routeReach) and engine score
> (prefilterScore), determine when a deeper child has enough personal evidence to
> replace its parent as the representative route.

下一階段要研究的面向：

- continuation ratio（parent support 中實際續行進入 child 的比例）
- sample-size confidence（稀疏樣本的可靠度）
- Bayesian / interval estimator
- sparse 1/1、2/2 的行為（現行 corpus 已固定這些案例，見 §4 contract tests）
- high-support continuations 何時該取代 parent
- engine score（`prefilterScore`）作為 secondary evidence 的角色

下一階段**不需要**重新研究（已由本文件與現有 code/tests 固定）：

- production pipeline（§2）
- v12/v13 歷史（§5）
- games / routeSupportGames / routeReach 的定義（§3、§3.1）
- Scout UI architecture（§1、§2）

現行 temporary nested rule（§4）只是 baseline，不是本問題的答案。
