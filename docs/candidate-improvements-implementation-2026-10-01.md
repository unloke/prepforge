# 候選改善項目：實作與驗證

日期：2026-10-01。從 `9b9f3ba1834ef7140780e2c23727d7b07ccad42f` 開始，在 `fix/head-review-concurrency-auth-lifecycle` 分支分段實作。修正前的完整 16 類審查與量測見 [HEAD 審查](candidate-improvements-head-2026-10-01.md)。本紀錄區分已修正的問題、已提供但尚未部署的操作路徑，以及仍需環境量測或契約設計的改善。

保留免費 hard cap、Maia 不設付費牆及目前產品範圍。Stripe 改動只修正既有 webhook 的 correctness，不啟用或增加付費功能。既有文件搬移、刪除與其他未追蹤檔案未納入實作 commits。

## 實作結果

| ID | 狀態 | 實作與界限 |
| --- | --- | --- |
| C01 | 安全操作路徑完成；receipt retention 延後 | 新增 production `lifecycle` CLI，預設 dry run，`--apply` 回收孤兒 evaluation/position，`--trim-analyses` 明確選擇每 game 保留最新 10 個分析。沒有自動啟用排程。Receipt 只盤點、不刪除：server 尚未強制 replay horizon，刪除會破壞 exactly-once。測試確認老 receipt 經 cleanup 後，同 UUID replay 仍不重複計分。 |
| C02 | 完成 process 內保護；部署量測待補 | compare 最多 8 個 identities、單 request 最多 200 盤 upstream work；GET/POST 共用每 IP 6/min limiter。latest 每 IP 60/min，超過 8 個 linked accounts 時要求明確選擇。PGN/NDJSON export 共用 4 個 concurrent slots、15 秒 cache、128 entries/16 MB cache cap、2 MB response cap 與 429 cooldown，保留 Retry-After。這些 cache/semaphore/cooldown 為 process-local，跨 worker/server IP 的總量仍需 staging 量測。 |
| C03 | 完成已確認的數值 drift | Explain 與 Coach 共用 cp→win conversion，±1000 clamp、integer conversion、mate/terminal handling 與 server 契約一致。Golden fixture 納入 extreme cp、mate、forced/great 與 Explain。Forced/great 仍是 browser display tiers，沒有擅自改 persisted server enum；best-move short circuit 的 loss 表示也保留各 surface 契約。 |
| C04 | 完成；PostgreSQL concurrent case 交 CI | Stripe 使用 SQLite/PostgreSQL atomic INSERT ON CONFLICT event claim；claim 與 effect 同 transaction，失敗 rollback 可重試、duplicate 回成功。Checkout 必須符合既有 authoritative customer mapping，reference/metadata mismatch 不 mutation。獨立連線 parallel HTTP tests 在 SQLite 通過；PostgreSQL variants 使用 TEST_POSTGRES_URL 並加入 CI，本機未執行。 |
| C05 | 完成已重現的 N+1 / export / cleanup 問題 | Game hydration 改成每頁批次載入，新增 stable keyset iterator，export 分段輸出 JSON、不聚合完整 response。Progress/sessions 使用 bounded iterator，repertoire 每次輸出一棵 tree。Orphan reclaim 與 analysis trim 改 set-based SQL。新增 account pagination、analysis ordering、receipt cutoff indexes。相容的 list_games 仍回傳完整 list，list_repertoires 仍可載入完整 trees；本次没有把所有舊 repository API 改成分頁 response。 |
| C06 | Upgrade backfill 完成；PG 持鎖風險未消失 | f3 fingerprint upgrade 使用 500-row keyset pages 與 executemany；10,001 rows 的 regression 要求 driver UPDATE executions ≤25 並核對 digest。沒有改 immutable snapshot identity。單一 PostgreSQL DDL transaction 仍可能持鎖到 commit，downgrade 仍是原有全量策略；已部署資料庫不重跑歷史 revision。 |
| C07 | 完成已重現的 accessibility 缺口 | Repertoire menu 有 menu/menuitem roles、初始 focus、Arrow/Home/End/wrap、Escape、focus restore、outside click 與 touch 行為。Settings popover 有 controls/expanded、Escape dismissal 與 reopen。以 built SPA 的真實瀏覽器操作驗證。其他 info surfaces/local language metadata 沒有進行無證據的全面重寫。 |
| C08 | 完成 | Train 使用既有 sync error classification primitive；423 retriable，409 payload conflict permanent，保留 rejected group 且繼續後續 groups。Build 與 Train 各自保留 domain flush policy。沒有刪除 tombstones/idMap。 |
| C09 | 完成 | CI 在 production build 後檢查 committed static freshness，包含新增未追蹤 output；加入 Train keyboard E2E 與 browser contract smoke。Freshness helper 用暫存 Git repo 測 unchanged、modified、新 output，避免用 source regex 取代行为。 |
| C10 | 已移除已確認的 standing copy，runtime coverage 部分完成 | Shared repertoire banner 常駐說明移除。Library populated/empty/error 的 built-SPA 測試涵蓋 onboarding action、Retry recovery、內容恢復後 empty state 消失，以及 banner 說明不存在。尚未宣稱全部 JS views 的 no-standing-explanations 規則已被測試覆蓋；既有 broad UI smoke 另行驗證。 |
| C11 | 完成 | Command palette 優先 visible label exact/prefix/contains，再看 keywords；移除導向同 view 的 duplicate Analyze action，保留 engine/analyse aliases。Executable ranking test 與 browser Enter navigation 確認 game→Games。 |
| C12 | 完成 | Corrupted setting 仍安全 fallback，同時 warning 記 user/key、不記敏感 value。Repertoire generic update 只允許 name/is_active。Full-suite 發現 Alembic fileConfig 停用既有 logger，已改 disable_existing_loggers=False，並重跑順序重現與全 suite。 |
| C13 | 完成已确认的 metadata drift | 兩條 server analysis pipeline 共用純 quality/generated metadata helpers，equivalence fixture 納入 quality、depth、node/time-only configuration。Browser-compute 保持 server 不重跑 engine。未將兩條完整 pipeline 強行合併。 |
| C14 | 延後需契約或實證的架構工作 | Settled tombstones/idMap 保留目前 stale-tab correctness；安全淘汰需要 epoch/replay horizon。Scout default/experimental/research、TrainingService/SmartTrainingService、Stockfish/Maia failure models、transport/domain wording、loading/theme primitives 與 app.js 拆分的審查結果仍以基準報告為準；未以檔名或相似程式碼為理由直接合併不同產品語意。Main bundle 已量測且通過 budget，接近上限，後續新功能仍需控制 eager imports。 |

## 驗證

- Python 3.13 本機完整 suite：**737 passed、17 skipped、5 deselected**；一個既有 FastAPI/Starlette TestClient deprecation warning。預設未執行的 opt-in E2E / PostgreSQL tests 不算已驗證。
- JavaScript 完整 suite：**143 files、1,933 tests passed**。
- Built-SPA review accessibility smoke：通過 keyboard、focus、touch、popover、palette、Library populated/empty/error/recovery 操作。
- UI v2 broad browser smoke：**9/9 通過**，涵蓋 Library、Repertoire、Train、Games、Scout、Analyze、Teams、Settings 與 states，多 viewport 無 overflow 或 page errors。
- Train keyboard E2E：本機單獨執行通過，已加入 CI。
- ESLint、Ruff、committed static freshness 與 bundle size gate：通過。ESLint 全 repo 為 0 errors、331 warnings，並未宣稱已清除所有既有 lint warnings。Main JS **316.2 KiB / gzip 98.6 KiB**，budget **317 / 99 KiB**。
- SQLite Alembic upgrade / downgrade / re-upgrade 與 schema drift check：通過。Query-plan tests 確認新增 index 被使用；這些不是 PostgreSQL EXPLAIN measurements。
- Streaming export 合成量測：1,000 games，每 game 8,192 字元 comment，輸出 **8,457,203 bytes / 1,010 chunks / 26 SQL executions**，tracemalloc Python peak **3,818,548 bytes**。實際消費 StreamingResponse、不收集全部 output；此數字不是 process RSS，也不是 production PostgreSQL latency。

本機沒有可用 PostgreSQL server 或 TEST_POSTGRES_URL，因此未聲稱實測 PostgreSQL lock、WAL、query plan、parallel webhook 結果。CI 中的 PostgreSQL regression 應在合併前確認通過。測試與探針 log 位於本機 `artifacts/head-candidate-audit-2026-10-01/`，不作為 committed production artifacts。

## 部署與剩餘工作

部署時執行 `alembic upgrade head`，新增 revision 為 `a91d4c2e7b60_account_lifecycle_indexes`。既有已升級資料庫只需新 index migration；尚未經過 f3 fingerprint backfill 的大型 PostgreSQL 資料庫仍需安排 migration window，chunking 不會解除同一 transaction 的 DDL locks。

Lifecycle CLI 使用與 server 相同的 DATABASE_URL，不自動建立 schema。先執行 `python -m prepforge_chess.services.data_lifecycle` 查看 dry run，再依 [部署說明](DEPLOYMENT.md#data-lifecycle-operations) 執行或安排 `--apply`。未替使用者啟用外部排程或執行 production data cleanup。Referenced immutable evaluations 不直接按時間刪除，analysis history trimming 是明確 opt-in。

下一批需要設計或環境證據的工作是：server 可驗證的 offline replay horizon/epoch、跨 process Lichess 資源保護量測、大型 PostgreSQL migration / query-plan 實測、其他 runtime UI states 覆蓋，以及依實際 chunk/coupling 決定 Scout/app.js 邊界整理。這些尚未完成，不以本次 correctness 修正取代驗證。
