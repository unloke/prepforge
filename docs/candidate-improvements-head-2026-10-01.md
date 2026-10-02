# 候選改善項目整合：HEAD 重新驗證

基準：`9b9f3ba1834ef7140780e2c23727d7b07ccad42f`，2026-10-01。

本文件記錄上述基準 commit 的審查結果。後續實作與驗證狀態見 [實作紀錄](candidate-improvements-implementation-2026-10-01.md)；下列問題描述與數字保留為修正前的證據，不代表目前 HEAD 仍有同樣問題。

初始審查階段只新增審查文件與隔離探針，沒有修改產品實作、migration、額度或 monetization。開始時工作目錄已有文件搬移／刪除及未追蹤檔案；審查範圍內的 tracked source/config/test 沒有相對 HEAD 的變更。`docs/README.md` 的部分連結指向工作目錄中已刪除的文件，因此沒有把歷史文件當成產品契約。

狀態的定義：**成立**表示目前 source 或執行結果支持問題；**部分修正**表示某一子問題已解决，但候選項目不能整體關閉；**待驗證**表示尚不能從此次證據判定實際影響；**延後**表示差異合理或只有維護收益，尚無理由立即重構。優先序 P1 是應先處理的 correctness/resource 問題，P2 是局部 UX、operational 或維護改善，P3 是可延後的架構整理。條件式優先序不是聲稱該功能已在部署環境啟用。

## 建議合併成以下工作項目

| ID | 優先序 | 工作項目 | 目前證據與完成條件 |
| --- | --- | --- | --- |
| C01 | P1，清理啟用前 | 定義並強制 replay horizon，再接 retention caller | 清掉 receipt 後，同 UUID replay 讓 attempts 1→2。需 server 可驗證的期限／session epoch，超期不重新計分；再加 report-first CLI/排程與操作紀錄。不能只增加 cron。 |
| C02 | P1 | 限制 Lichess compare 單次 amplification | 100 usernames 被接受，100 次 upstream fetch、請求最多 5,000 PGN，只有每 request 4 workers 的 concurrency cap。需獨立的 username/work budget、client limiter 與共享 upstream cooldown；不必讓所有 route 共用同一 limiter。 |
| C03 | P1 | 統一 classification 數值契約並擴充 golden surfaces | 實際 server/browser 在 clamp 與 mate 邊界會跨 tier，進而改變 Brilliant eligibility。先明定 conversion、forced/great 表示方式，再測 Explain 與 terminal。 |
| C04 | P1，若 billing 啟用；否則 P2 | Stripe atomic event claim 與 authoritative customer binding | parallel HTTP probe 回 200/500；後者 unique conflict。customer 不符仍可依 reference 改 plan。需 claim/effect 同 transaction、duplicate 成功回覆、customer mismatch 不 mutation；不新增付費功能。 |
| C05 | P1/P2，依帳號資料量 | 大帳號 export/list 與資料庫清理成本 | 1,000 games 的 list 是 2,001 SQL；export 全量建立 dict；receipt cutoff 缺 index，分析排序缺複合 index，orphan/trim IDs 全量進 Python。需 bounded reads、適當 index 與 set-based/chunk cleanup。 |
| C06 | P1，大型 DB 尚未跑該 revision 時 | Fingerprint migration 的 backfill 與 lock 策略 | 10,000 rows：10,016 SQL executions、約 4.69 MB Python peak。chunk/executemany 可改善 memory/round trips，但單一 PG transaction 的 DDL lock duration 必須另外處理。 |
| C07 | P2 | Repertoire menu、info popover 的可存取性 | 瀏覽器重現缺 roles、初始 focus、Arrow 導覽，以及 popover 缺 controls/Escape。需測 keyboard、focus restore、outside click、touch。 |
| C08 | P2 | Build/Train HTTP classification primitive | 已有 `sync-errors.js`，但 Train pure flush 仍有第二份分類；409/423 不一致。共用分類、保留 domain policy，測 mixed failure 與 409 payload conflict。 |
| C09 | P2 | CI freshness guard 與 Train keyboard E2E | 現有產物重建一致，但 CI 沒有 dirty-tree freshness guard；Train keyboard smoke 本機通過，CI 未列入。 |
| C10 | P2 | Runtime UI copy/state 行為測試 | 目前 shape tests 無法保證規則；shared banner 的常駐說明仍存在。採 populated/empty/error 實際 DOM 檢查，避免把 live data 或 onboarding 誤刪。 |
| C11 | P2 | Palette 精確 label 排序／重複 Analyze | `game` 搜尋先出兩個 Analyze，Enter 到 Analyze；两項現有 navigation 相同。需明定 exact-label ranking 與是否保留 action。 |
| C12 | P2 | Settings corruption 可觀測性與 repository write boundary | JSON 損壞無 warning/telemetry；generic repertoire updater 無 whitelist，但目前 callers 只傳 name/is_active。應加小型 boundary，不能把它描述成已證實的外部任意欄位注入。 |
| C13 | P2/P3 | Analysis output metadata 契約 | 兩條 pipeline 的品質與 metadata 不完全等價；保留 browser-compute 不重跑 engine。先補 equivalence coverage，再決定抽 shared pure core。 |
| C14 | P3，另保留量測 | Outbox storage lifecycle、Scout experimental/research boundary、app.js 漸進拆分 | 無可安全直接淘汰的 tombstone 規則；default/experimental 算法目標不同。先明定邊界和 replay 語意，不因重複檔名就合併。 |

## 1. 資料生命週期與資料庫

| 候選項目 | 判定 | 現況與證據 |
| --- | --- | --- |
| Lifecycle production caller | 成立 | `services/data_lifecycle.py:47,69` 有 report/reclaim；搜尋 `src/`、`scripts/`、`.github/` 沒有外部 operational caller。`api/main.py` lifespan 只有 DB pool disposal。測試呼叫不是 production path。無法排除部署平台另有 repo 外排程，但 repo 沒有可部署的 route/CLI/job wiring。 |
| positions / engine_evaluations | 成立：未見定期 retention | shared derived rows 刻意不隨帳號刪除；只有孤兒回收 helper。仍被引用的 immutable eval 不會由 orphan reclaim 刪除。 |
| analysis_results | 成立：沒有 automatic retention | game/account deletion 與保留中的 game history 是不同 lifecycle。`trim_analyses` 預設 false；keep 10 只在 caller opt-in 後生效，目前沒有 operational caller。 |
| train_attempt_receipts | 成立，但不可直接啟用清理 | 90 天常數存在；30 天 offline retry 只有宣告與註解，outbox 和 sync handler 未強制期限。探針透過實際 `sync_progress`→receipt aging→`reclaim_orphans(dry_run=False)`→同 UUID replay，attempts 1→2。目前沒有 caller，所以不是已在 production 發生的定期重複計分事件。 |
| Evaluation fingerprint | 符合目前 immutable contract | `storage/codec.py:148` fingerprint 包含 engine name、FEN、實際 depth/nodes/time 與 cp/mate/best/PV/WDL 的 stored forms。repository insert-on-conflict-do-nothing，差異結果變新 row；相同內容 dedupe。這是防止其他分析覆寫歷史的修正，不應退回 mutable config-only cache key。engine artifact 是否完整被識別取決於 caller 的 engine name，digest 不會自動加入未提供的二進位 hash。 |
| Fingerprint 長期資料量 | 成立：operational gap | 輕微差異可造成新 snapshot；沒有 retention caller 時，孤兒與 referenced history 都可能成長。先量測 row/storage growth，再決定 user-visible history retention；不能將所有相同 config 結果強行合併。 |
| Migration scalability | 成立 | `f3a9c1e7b2d4...:66` `.mappings().all()`，逐 row UPDATE，O(N) Python materialization 與 N 次 update executions。10k SQLite probe 約 2.26s / 4,688,848 bytes Python peak / 10,016 statements。這是簡短 PV 的合成資料，非 process RSS、非真實大型 PG 的 network timing。 |
| PostgreSQL lock impact | source + 官方規則推論；實測待補 | migration 先 ADD COLUMN，再 backfill，再 NOT NULL/unique；`migrations/env.py` 使用 transaction context。ADD COLUMN 的 ACCESS EXCLUSIVE lock 可保持到 transaction 結束，阻塞其他讀寫；chunking 仍在同 transaction 時不會自動縮短持鎖時間。真正 PG wall-clock、WAL、lock wait、長交易影響未量測。[ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)、[Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)。已跑完的部署不應為此重跑 revision；處理未升級 DB 的 migration 操作策略。 |
| list_games | 成立 | `repositories.py:737` 先取全部 IDs，再 `load_game`。100 games=201 SQL，1,000=2,001；2-ply、無 eval 合成資料已足以重現 N+1。實際有 evaluations 時成本可再增加。 |
| list_repertoires | 部分修正 | `repositories.py:959` 批次 rep/nodes/evals；無 eval 的 101 與 1,001 reps 都只 2 SQL。完整 node trees 仍 `.all()` materialize，memory 隨內容長大。普通 `/api/repertoires` 使用 metadata listings，不等於每次 UI listing 都讀 full tree。 |
| Account export | 成立 | `api/routers/account.py:45` rate limit 5/hour，但 `list_games`/full repertoires/progress/sessions 全量讀取並返回完整 dict；repertoire package 還有 dump→loads。rate limit 沒有限制單次記憶體。此次測量 list 子路徑，未量測 full export 的 ASGI serialization peak。 |
| Analyzed-games paging/index | 部分修正 | `repositories.py:1975` owner-scoped ROW_NUMBER、stable keyset、50 default/max200，不再全量 response 或重複同時間 snapshot。1,000 synthetic analyses 的實際 page 1 SQL/50 items；SQLite plan 仍 scan + 兩處 TEMP B-TREE ORDER BY。schema 的 analysis_results 只有 PK，缺 `(game_id, analyzed_at DESC, id DESC)` 類 index；PG plan 待量測，不能照抄 SQLite plan。 |
| Receipt cutoff index | 成立 | model 只有 session_id index 與複合 PK；created_at cutoff plan 是 SCAN。啟用安全 retention 時一併處理。 |
| Orphan/analysis trim ID loading | 成立 | `repositories.py:1418,1443,1477` 先 `.all()` IDs 或全部 history 再 Python 分組、IN delete；大型集合有 memory/parameter 成本。每類 reclaim 各自 transaction，report 的 before/after 也不是一致性快照；future caller 需定義併發與批次操作語意。 |
| Corrupted settings | 成立 | `repositories.py:134` JSONDecodeError/TypeError 回 default，沒有 logging/telemetry；正常缺值與損壞無法區分。宜保留安全 fallback，同時記 user/key 與 corruption counter，避免記錄敏感 setting value。 |
| Generic repertoire updater | 成立：內部 boundary 缺口 | `repositories.py:862` `.values(**fields)` 無 whitelist；目前 `opening_builder.py:1238,1244` 明確傳 name/is_active，沒有發現將任意 request dict 直接展開至此 API。 |

## 2. API 與外部服務

Compare GET/POST 的 count 會 clamp 至 50，但 `CompareBody.usernames` 和 account_ids 沒有長度上限；合併去重後也沒有 username cap。`compare_many_identities` 每 username 抓 count 盤，再合併後才截總輸出，所以 50-row response 不代表最多抓 50 PGN。stubbed upstream probe 使用 100 names，驗證 100 calls、5,000 requested games、最高 4 concurrent calls。這是 service/schema 執行量測，沒有向 Lichess 發送壓力測試。

`latest` 只接受 linked identities，不接受任意 external usernames，每 identity 1 game、4 workers；它與 compare 應分開估算。repository 中未見 linked identity 總量 cap。兩 route 沒有 route limiter，shared `Limiter` 也沒有 default limits。fetch_recent_pgns 無 shared cache/429 cooldown，HTTP 429 被包成 LichessFetchError，route 通常轉 502；Explorer 已有獨立 cache/120-minute limiter/429 handling，不能套用它的保護來判定 compare 安全。跨 request/process 的 server IP 工作量與 Lichess 實際限流行為仍需 staging 量測。

Stripe duplicate 的 sequential tests 通過，但 parallel HTTP probe 在 initial `db.get(StripeEvent)` 之後用 barrier 固定交錯，兩者都判定未見 event。結果 200/500，500 是 `UNIQUE constraint failed: stripe_events.id`。effect 與 event insert 同一 transaction，所以不能由此聲稱 plan effect 被 commit 兩次；問題是競態沒有被轉成成功 duplicate acknowledgment。PostgreSQL 的相同交錯仍需測試。

Checkout completed 分支優先按 `client_reference_id`/metadata 找 user，沒有要求 event.customer 等於 user.stripe_customer_id。signed-event handler 的 isolated probe 讓 `cus-other` reference 已綁 `cus-authoritative` 的 user，plan 仍變 pro，customer 留原值。它不是 unsigned client 能直接偽造 webhook 的證據：signature verification 是存在的。應將 authoritative mapping 與 event claim 一起處理，billing 未啟用時保持 dark，不藉此擴展收費。

## 3. Outbox / local-first sync

`sync-outbox.js` 現在刻意保存 settled tombstones 與 idMap，連 quiescent clear 也保留，以防 suspended tab 把已完成 op 合併回来；不能直接加 TTL 或清空 idMap。owner isolation、op merge、拒絕項目保留、quota failure warning 已有測試與實作。

Node probe 的 synthetic state 各有 N 個 build tombstones、N 個 train tombstones、N 個 id mappings：

| N | JSON 字元 | UTF-16 bytes estimate | merge + stringify |
| --- | ---: | ---: | ---: |
| 1,000 | 43,710 | 87,420 | 0.61 ms |
| 10,000 | 475,710 | 951,420 | 9.54 ms |
| 50,000 | 2,555,710 | 5,111,420 | 63.57 ms |

這證明成本隨 history 增長，並非量到實際 browser quota 已滿：quota accounting、其它 localStorage keys、device/browser CPU 尚未 benchmark。先用 epoch/replay contract 定義安全淘汰，且 server receipt 期限必須相容；可先增加使用量 telemetry。

`sync-errors.js` 已經是 shared primitive，因此「完全沒有共用 taxonomy」過時；但 `train-sync.js:49` 仍有獨立 isRetriableSyncError。Build classifier 的 409 是 conflict、retriable=false/keepsDraft=true，Train pure flush 的 409 是 retriable=true；423 Build 被分類成 validation，Train 是 retriable。409 對 Build 是 revision reconciliation，Train 的 UUID/payload 衝突可能是 permanent for that payload，不能只統一成自動重試。

Build permanent failure 逐 operation isolation；Train 以 session group 隔離並繼續後續 group。成功、拒絕、unsent 的保存方式有 executable tests；這些 domain policies 不需要被同一 flush algorithm 取代。將 common status facts 抽小型 helper，再讓 domain 解釋 conflict payload。

## 4. Analyze / classification / Coach

server 使用 scale 0–1、clamp ±1000、sigmoid 0.00368208；browser Explain/Coach 使用 0–100、clamp ±1500。normal cp error boundaries 已對齊為 2/5/10/15 percentage points，但 numeric conversion 與 mate mapping 不一致：server mate 約 .97545/.02455，Coach mate 1/0。

| Eval 情境（played 非 best UCI） | Server 真實 classifier | Browser classifier/Explain | 影響 |
| --- | --- | --- | --- |
| best +2000cp，played +850cp | loss 1.7343%，Excellent | loss 3.7918%，Good | browser 不會按 ≤2% leg 當 Brilliant candidate，而 server tier 可以符合 eligibility |
| best mate+3，played +1000cp | loss 0%，Excellent | loss 2.4553%，Good | 同上；不是只有顯示小數差異 |

Browser `classifyMoveRich` 有 Forced 與 Great（isBest && onlyMove && after≥25），server enum/classify_move 沒有這兩 tier/input。這可以是 richer Coach presentation，但不能說「完全相同」。best/excellent→browser Best 的 display mapping 已在 golden contract 刻意允許。`explain.js:413` 的 classifyMove 沒有 forced/great inputs。

golden fixture 的 mate/extreme cases 多將 loss_pct 設 null，某些例子只證明都屬 Blunder；尚無 forced/great fixture、上表 extreme cross-tier cases 或完整 Explain surface。terminal/mate0 的專項 tests 存在，也不等於所有 surfaces 已共享 golden。應先決定數值契約，再補代表性的棋局與邊界，而非刪除這些已存在的 regression tests。

`AnalysisService` 與 `classify_precomputed_game` 仍需要：前者承接 engine/CLI/legacy orchestration，後者是 production browser-compute fast path、不重跑 engine。equivalence fixture 本輪通過，classification、comments、summary、critical ply、cp evals 相同；但 fixture `_snapshot` **沒有比對 generated_meta 或 quality**。實作中 fast path 建 quality、generated_meta.depth；AnalysisService result.quality 預設 None，meta 沒 depth。共同 conversion/comment/core 可逐步抽取，但不應把 fast path 退回 engine pipeline。critical tiers 目前相同，沒有發現該項 drift。

Coach call graph：`PositionCoach._eval` 先查本地 50-entry cache，再查 `savedPositionEvalRead`，有 authoritative saved eval 時 reuse；否則自己的 provider 做 MultiPV2 短讀。game analyzer 是 distinct-FEN queue/pool，EngineWidget 是 live streaming UI provider；Maia 已使用共享 provider。故「Analyze/Coach 完全重算所有已保存結果」不成立；不同 MultiPV/搜索目標、未保存 live positions 仍會各算。saved read 沒有 minimum actual depth/MultiPV completeness gate，未量測其對 Great/onlyMove 的實際影響，應列 focused runtime follow-up，而不是立即全域共享 Stockfish mutable search instance。browser tests 未使用真實 Maia weights 或真實 engine CPU benchmark。

## 5. Training pipelines

兩服務皆有 route/browser caller。Smart 的 card scheduling、run-in、首答 grading、requeue、mixed repertoire/session memo 與 legacy full-line modes 是刻意差異；ownership 同時有 route guard 與 service 的 owner-scoped repertoire loading，不因 helper 重複就移除其中一條。

`TrainingService._reply_after` 只回 line_order path 中的下一 node；Smart 在 target path 結尾還會取 first enabled child。對 card 的最後 own move，Smart 可以動畫一個已準備的對手 child，legacy line 結尾則沒有 path reply；Smart docstring 明確說明最後一招也保留動畫。這是可見但有明確設計理由的差異，不是已確認 bug。fallback child selection 是否应依 mainline/priority 決定，尚沒有產品要求或實際錯誤例子；應用相同 legal tree/card-vs-line scenario 比較後才抽 selection core。既有 training tests 本輪通過，尚未做兩模式 browser animation 的逐畫面等價測試。

## 6. Scout boundaries、report paths 與 sampling

本輪建立 app-relative source import inventory，並用 Vite 實際 `chunk.modules/imports/dynamicImports` 檢查 bundle composition；source inventory 使用 literal-import 掃描，條件式 URL/env branches 另按 entry 判讀，不能把所有 reachable code 都算 default。完整結果見 `frontend-results.json`。

| 路徑 | 現況 |
| --- | --- |
| default production | `views/scout.js` → `scout.js` / report / stats / prefilter / preparation-value / maia / engine / explorer / refutation / selector / probability / summary / init guard。ranking identity `scout-v2`、scoring version9 是不同層，並非檔名必須改 v9。 |
| opt-in experimental | `?scoutV13` 存在即啟用（`?scoutV13=0` 也 true）；dynamic import v13 stream/report，default enrichment branch與它互斥。adapter/funnel/extension/package/style，以及 bias-routes/features/route-audit 都有 experimental caller，不是可直接刪的研究 dead code。 |
| legacy shared dependency | v12 report 沒有產品 report entry，但 v13 import `V12_BANNED_VOCAB`；其 import closure 可觸及 graph helpers，bundle tree shaking 可移除不使用的部分。需把 vocabulary constant 抽小型中立 module，才容易完全移走 legacy renderer。不能以「v12 沒 entry」推論整個檔案沒 caller。 |
| no app entry / research candidates | bias-cohort、bias-fit、ref-df-census、shadow-prep-p0/exact-solver、stockfish-uci、v15-study/engine-cache、maia-harness，以及 `research/**`、offline scripts。no-app-entry inventory 不是全部都可刪的證明；移檔前保留 scripts/test import paths 和 research opt-in discovery。 |
| E2E infrastructure | scout-e2e-fixtures 另由 build env 控制；與 experimental v13 分開，不能算成 live paid/product feature。 |

default 與 v13 目標／output contract 不同，仍同時維護但不是兩條宣稱同義的 production pipeline。建議明確標 experimental entry、逐個移 research-only modules；暫不合併 ranking。`docs/scout-production-ranking.md` 是導航，graph inventory 才是這次 evidence。

Repertoire fetch 原候選 **沒有在相同 Start 重現**：view 只有 initScoutState 和 Add line target picker 兩個 `/api/repertoires` call sites，分屬不同動作。`scout-init.test.js` executable reentrancy test 驗證兩次 Start 在初始化中只 1 API/1 stream call，本輪通過。Add line 重新取 metadata 可反映後續 repertoire 變更；不是天然可共用永久 cache。browser probe 的跨 Library/Analyze/Settings/Scout navigation 總 calls=6，不是 Scout duplicate request 的證據。

| Budget/window | Scope 與目前語意 |
| --- | --- |
| terminal opening candidate engine cap | 每 opponent color，hard ceiling300；兩色最多600候選，depth8，prefilter concurrency3。48 是 legacy/default branch-score/fallback limit，不能把它描述成全部 production engine work cap。 |
| final game-plan rows | 每 color最多12，minimum route support1；weakness/refutation 仍有 legacy7、slip3，作用域不同。 |
| Maia enrichment | 兩色 ranked pools 合併 global，64 max attempts、12 success target，不是每色各64/12。失敗與 cached result、dedupe 由 real helpers/tests 判定；Maia不增加 personal route support/reach。 |
| Deep scan | `selectEngineScope` 先 color/speed filter，再最近60 games；每色60，不是合併60。aggregate需minimum analyzed games/coverage，不能把 shallow leaf prefilter當全盤分析。 |
| Freshness | 先 color/speed filter，再 recent 約20% clamp20–80，previous 是 recent×4，實際80–320；minimum recent3並含share floor。同色歷史基準，不是白黑合併 window。 |
| Recent-change/profile | `opponentProfile` **先在合併資料取 last20/previous20，再各自按 color filter**，每色兩段都至少3。與同色 freshness 的 scope 不同；合成帳號最新40盤都是黑色時，白色 profile badge 不亮，但白色100盤的 freshness 可以偵測新 opening。差異已執行重現，是否要讓兩個 surfaces 表示同一時間概念需產品判定，不直接改 window。 |
| Maia rating sample | 每 color 的 median，但 `syncMaiaScope` 傳全部已載入 games，**沒有先按 activeSpeed filter**；例如該色 blitz1000、rapid2500/2600 的 median=2500。speed 會進 cache scope，而 rating 可來自跨 speed corpus。是否該採同 speed rating 是待定語意，不是免費額度問題。 |
| Personal repertoire lookup | init先全部 active reps，再 `.slice(0,6)`，**白黑合併最多6份**，不是每色6；普通 hard cap下是否可達截斷須依現有帳號來源判定。 |
| History streaming | UI的Start/Pause/Continue增量stream，`scoutClient.streamGames` 可用 since/until/max，default並非永久只取固定最近N；會持有已載入 games。高歷史量的browser heap與render cost尚未做長時量測。 |

scope/candidate/global Maia、selector DP、stats tests 本輪通過；沒有找到應直接改成「所有 cap 每色」的理由。這輪尚未把 v13 全部 enrichment resource budgets 用真 engine/真 Maia逐項量測；它保留 experimental follow-up，不能用 default cap代替其安全證據。

## 7–8. Worker lifecycle 與 Fetch/error semantics

Stockfish provider 是 UCI streaming、stop/bestmove drain、opChain、generation fencing，timeout要避免不可識別的舊 UCI output污染下一次 search。Maia是 async manifest/model warmup、correlated request IDs、pending map、LRU result cache、singleton reuse，crash後teardown/fail pending/清ready promise，next call重試。兩者都有 teardown/crash但 failure model不同；現有 providers tests通過。共用一個完整 lifecycle state machine列P3；若只抽 detach/terminate小helper，仍需保留provider policy和 race tests。

`postJson` 已委派給 app `api`，不是另一份 transport。`api` 統一 credentials、CSRF、FastAPI detail flattening、authRequired、Retry-After與 AbortSignal。直接 fetch的API mutations主要是 delete undo commit與 beforeunload Build/Train keepalive；它們使用現有cookie/header、durable outbox保留未ack ops，不能為使用统一api而破壞unload semantics。

但 non-JSON error path只設定status，沒擷取Retry-After；normal JSON branch有擷取。這是可局部修的小型transport drift。keepalive response不可觀測時保留未確認狀態合理；domain-specific Lichess/Explorer wording與 upstream429不同（見C02）。沒有證據要求把所有external asset/profile/stream fetch也改成CSRF API wrapper。cancellation已forward，但長時 worker＋view cancellation的實際CPU釋放仍需測量。

## 9–10. UI copy、empty states 與 accessibility

No-standing-explanations測試 **覆蓋不足**：ui-layout主要針對 index.html特定markup/字串，其他view測試也有source shape；不能保證runtime populated states沒有說明。具體仍有 `index.html:258` shared banner「You can browse and train ... Copy it ...」，有內容時常駐；read-only title和Copy action已足以表示狀態，操作說明可移tooltip。

Coverage `COVERAGE_IDLE_HINT` 在尚未scan/無資料時是空狀態，Scan控制在旁；Settings未登入/未link的instruction會在有linked content後消失，屬允許onboarding/blocking recovery。Scout的數量、coverage不足、suggested reply、reason是live report/data；Analyzequality在details內按需展開，不能僅依`hint`或`<p>`判違規。

Library無repertoire有New/Import按鈕；Build有New/Import/Browse與board affordance；Train無active prep提供Library下一步；Teams有登入/Create/Join等狀態；ScoutStart與source picker在控制列，沒有opening data時有fetch/filter恢復提示；Analyze空態是「Play on the board, or analyze a PGN」，PGN輸入在收合details，屬可改善discoverability而不是完全沒有action。另Library filter-no-match與analysis history-no-saved只顯示訊息，可評估clear filter/open PGN shortcut，列P2局部UX，不需所有empty state再加長教學。

瀏覽器用committed production bundle與isolatedAPI fixtures驗證：

| Surface | 結果 |
| --- | --- |
| Repertoire menu | container/item都沒有menu/menuitem roles，Enter開啟後focus仍在⋯，ArrowDown沒有item focus。Escape/outside-click已有全域close；Escape測到回到同一trigger是因focus從未離開，不是驗證了完整focus restore。mouseup/click觸發可用，touch viewport/assistive technology測試尚未跑。 |
| Settings info popover | aria-expanded會切換、有實際target、可reopen；aria-controls缺失，Escape後仍visible；Settings內outside-click有關閉code，沒有完整dialog focus contract。 |
| Auto-disappear content | Settings help不auto-expire；Train hint已有retention regression tests。未把所有toast逐一證明可再次取得，應按內容是否關鍵另檢查。 |
| Language | root lang=en；experimental v13 report含中文而未見局部lang metadata。default英文report沒有同一問題；中文panel應標適當lang（字形/內容決定zh-Hant等），不更改全頁語言。 |

## 11–12. Loading/error primitives 與 visual system

現有spinner/skeleton/plain text不等於semantic drift：Build tree skeleton是保留geometry的navigation load；JobToast有phase/progress/cancel；status-pill是background sync；blocked prerequisite/empty state不是loading；toast/inline error分別服務全域與局部恢復。已存在JobToast、status-pill、modal等primitive。小問題是Teams/history loading仍使用empty-state/hint markup，應補對應aria-busy/status與保留error CTA，但沒有必要一次重寫全部狀態表達。

PostCSS inventory：6份product CSS有241個literal font-size declarations、141個token宣告之外的hex/rgb declarations；`inventory.json`列出同一at-rule context的重複selectors。这是maintenance inventory，不是241/141個a11y bugs：piece/swatch/WDL等色值可有固定語意，後續cascade overrides也可能故意重複。theme color tokens已成熟，優先處理文字contrast、focus、cross-theme mismatch，再合併layout尺寸，而非全面機械tokenization。

repository CSS沒找到forced-colors專項rules；reduced-motion已分布於styles/analyze-chart/scout。browser確認forced-colors/reduced-motion emulate可用，但此次沒有做完整screenshots/contrast/OS high-contrast或所有breakpoint boundary sweep，故這些是**待驗證**而非「已重現不可讀」。新測試應覆蓋small text、selection、focus及圖表/棋盤在forced colors下的可辨識度。

## 13. Command Palette / information architecture

瀏覽器搜尋：analyze→view:analyze、action:analyze兩個同label；games→Games；game→Analyze view、Analyze action、Games；review→Games、Train。`game`按Enter實際到view-analyze。`app.js` action:analyze也只有switchView(analyze)，因此duplicate navigation已確認。exact label與keyword目前同樣最高100分，再按label排序，導致game這種keyword撞名。

Library是collection，Repertoire是edit workspace，Games是replay section，Scout也是replay內section；這組navigation不是三個同義view。先修ranking與重複action，不為統一文字把實際不同目的頁全部改名。`frontend-results.json`有其它query的完整實際排序。

## 14–15. Build/CI、source-shape tests 與 bundle boundaries

CI有Python/JS、PostgreSQLmigration、Stockfish、UI-v2、Scout/axe/eval-chart E2E；**沒有**build後git diff/dirty-tree guard，也未列test_train_keyboard_smoke.py。Pytestdefault `not e2e`所以它不會被一般Pythonjob間接跑到。本機明確執行此E2E通過，可納CI，注意CI已安裝Chromium且test可skip，guard應避免缺browser被悄悄當成功。

本次用同一Vite configbuild到隔離artifactoutDir，停用publicDir copy與trim plugin的hardcoded closeBundle（避免碰產品static），保留正常JS/CSS transforms/tree shaking。35個生成檔逐byte與committed static相同。因此**目前generated bundles fresh**；沒有guard是future regression gap。publicengine/ORT/modelmanifest沒有在此隔離build重同步；要完整CIguard仍應執行正常`npm run build`，處理環境flags與deterministicengine sync。

main artifact 實際323,046 bytes、gzip100,673；budget325,000/101,000，只剩1,954 raw和327 gzip bytes。bundle gate通過。CSS125,619 bytes，worker約153KiB，不接近其budget。Vite chunk graph 主入口 static import chess chunk，dashboard/teams/game-analyzer/analyze/build/train/settings/replay/scout/coverage等已lazy。experimental v13 report/stream是dynamic chunks；沒找到research-only modules被eager載入主bundle的證據。

最大的main來源仍app.js（完整module render資訊見frontend-results）；EngineWidget/PositionCoach、JobToast、board interactions、transport/sync、teams/navigation等耦合在同檔。可以依controller/domain邊界拆純logic或lazy feature orchestration，但拆檔不保證縮bundle，需移dynamic import boundary並看chunk graph。先處理coupling/testability，再決定lazyloading，不用bundle大小當唯一架構理由。

inventory找到31個JS source-text test候選檔（readFileSync＋source字串的保守掃描），詳細檔名在inventory。`api-errors.test.js`還從app source抽function執行，雖比pure regex有行為證據，仍依赖shape。適合先把409/transport/menu/popover/controller行为測試改成可import函式或browser實際DOM；assetpackaging、securityheader、researchimportboundary、committedbuild結構這種真正staticcontract可保留。這輪沒有為了審查大量改寫既有test。

## 16. 保持的產品條件

免費額度／數量上限維持hardcap；不設計付費功能或Pro gating；Maia與Maia功能不加paywall。現有billingcode接受correctness審查，不視為新的monetization規格。performance budgets、sampling limits、retention是correctness/resource策略，不用它們替代或放寬既定免費cap。

## 驗證紀錄與限制

執行結果：Pythonselected suites共129passed/8skipped（未配置PostgreSQL及部分環境依賴），TrainkeyboardE2E另1passed；Vitest兩組共26files/372tests passed；bundle-sizegate通過。這是focused regression evidence，沒有跑全repository test suite或fullCI。

新探針與結果放在`artifacts/head-candidate-audit-2026-10-01/`：

- `probe.py` / `probe-results.json`：真實repository/query counts、actual analyzed-pageSQLiteplan、10k migration、parallel webhookHTTP、customer mismatch、receipt replay、mocked upstreamfanout、server classification。
- `frontend-probe.mjs` / `frontend-results.json`：browser pureclassifiers/Explain、Palette實際ranking、syncstatus分類、outbox量級、隔離build的chunkmodules及sourceimportinventory。
- `browser-probe.mjs` / `browser-results.json`：committedSPA的menu/popover/Palette操作；APIfixtures和externalnetworkblock，非production連線。
- `inventory.mjs` / `inventory.json`：CSSmaintenanceinventory、source-test候選、35generatedfilesbytecomparison、實際mainbytes/gzip。
- `sampling-probe.mjs` / `sampling-results.json`：真實 Scout profile/freshness/deep-scan/rating helpers 的不對稱 color/speed 合成案例。

可重跑命令（專案根目錄，現有依賴）：

```powershell
.venv313/Scripts/python.exe artifacts/head-candidate-audit-2026-10-01/probe.py
node artifacts/head-candidate-audit-2026-10-01/frontend-probe.mjs
node artifacts/head-candidate-audit-2026-10-01/browser-probe.mjs
node artifacts/head-candidate-audit-2026-10-01/inventory.mjs
node artifacts/head-candidate-audit-2026-10-01/sampling-probe.mjs
.venv313/Scripts/python.exe -m pytest -q -m e2e tests/e2e/test_train_keyboard_smoke.py
node scripts/check-bundle-size.mjs
```

未完成的驗證應作為後續工作保留：realPostgreSQL競態/lockwait/queryplan/largebackfill；production外部排程與billingenabled狀態；fullaccountexportpeakRSS；outbox真實browserquota與慢device成本；Scoutfullhistory/v13真引擎workbudgets；Coach/Analyze真engineworker/CPU/cancellationtrace；所有viewempty/populated/error狀態的visual/a11y、touch與forcedcolors。上文對這些項目沒有宣稱已實際重現或已修正。
