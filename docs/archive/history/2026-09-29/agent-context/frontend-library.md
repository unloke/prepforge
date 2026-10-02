# PrepForge Frontend Context Library

> Neutral factual index of the SPA at commit `e1a9ce1d1bc374a8b8dde26a32c5e2ff0c3ad5dc`
> (origin/main, 2026-09-29). All line numbers refer to that commit. Statements are
> observations of code and tests as they exist. No findings, severity, intent, or
> recommendations are included.

**Scope**: `web-src/**`, `scripts/smoke/ui-v2/**`, frontend Vitest tests. Backend is
recorded only as endpoint + payload field names consumed by the frontend.

**Page name mapping** (nav label → internal view id → host):

| Page (nav label) | view id (`appState.currentView`) | section | static host | VIEW_TITLES |
|---|---|---|---|---|
| Library | `dashboard` | — | `#view-dashboard` | "Library" (`app.js:3245`) |
| Repertoire | `build` | — | `#view-build` | "Repertoire" |
| Train | `train` | — | `#view-train` | "Train" |
| Games | `replay` | `games` | `#view-replay` `[data-replay-panel=games]` | "Games" |
| Scout | `replay` | `scout` | `#view-replay` `[data-replay-panel=scout]` | "Scout" |
| Analyze | `analyze` | — | `#view-analyze` | "Analyze" |
| Teams | `teams` | — | `#view-teams` | "Teams" |
| Settings | `settings` | — | `#view-settings` | "Settings" |

Games and Scout are two panels of one `replay` view; deep links are `#/games` and
`#/scout` (URL aliases — `web-src/workspace-url.js:15-18,55-72,96-113`).

---

## 1. Global architecture

### 1.1 SPA entrypoint and build

- `web-src/index.html` (822 lines) is the single static shell. Sole script tag:
  `<script type="module" src="/app.js">` (`index.html:818`). No framework; vanilla ES modules.
- Vite app root is `web-src`; build output goes to `src/prepforge_chess/web/static`
  (committed; `package.json`, `vitest.config.js` header comments). Vite 6, Vitest 4,
  deps: `chess.js`, `onnxruntime-web`, `stockfish` (`package.json`).
- `web-src/app.js` (12,001 lines) is the eager monolith: shell wiring, `appState`,
  board/engine/coach/toast/modal layers, all page orchestrators. Boot tail:
  `appReadyPromise = init()` (`app.js:12000`).
- Static imports of `app.js` (`app.js:1-48`): `./styles.css`,
  `./engine/stockfish-provider.js` (createEngineProvider, isBrowserEngineAvailable),
  `./engine/maia3-provider.js` (getSharedMaia3Provider, disposeSharedMaia3Provider,
  peekSharedMaia3Provider), `./csrf.js`, `./chess-local.js`, `./theme.js`,
  `./analyze-pgn.js`, `./board-navigation.js`, `./train-sync.js`, `./explain.js`,
  `./workspace-url.js`, `./train-resume.js`, `./train-opponent.js`, `./train-lucky.js`,
  `./train-play.js`, `./engine-banner.js`, `./lichess-profile.js`,
  `./command-palette.js`, `./controllers/account.js`, `./views/shared/source-composer.js`.

### 1.2 Global shell (all static in `index.html`)

- Left rail `nav.rail#app-rail` (`index.html:11-63`): brand + 4 nav groups
  (Prepare: dashboard/build/analyze; Practice: train; Review: replay×2 —
  `data-replay-section="games"|"scout"`; Share: teams) + rail-foot settings.
  Buttons are `.tab.nav-item[data-view]`.
- Topbar `header.topbar` (`index.html:64-84`): `#topbar-title`, `#topbar-sub`,
  `#build-generate-node` (hidden), `#analyze-actions` (hidden; `#open-engine-widget`,
  `#fetch-my-game`, `#run-analysis`), `#topbar-status-slot` (`#app-status`
  role=status aria-live=polite with `data-state`/`data-severity`, `#app-status-close`),
  `#open-palette` (Ctrl+K), `#account-chip` (aria-haspopup=menu).
- Main `main.workspace#workspace-main[tabindex=-1]` hosts 7 `section.view` elements
  (`index.html:87-771`); `.is-active` toggles visibility.
- Mobile bottom bar `nav.tabbar#app-tabbar` (`index.html:773-786`): bottom-dashboard,
  bottom-build ("Prep"), bottom-train, bottom-review (`data-review-tab`), `#more-nav-btn`.
- More sheet `#more-sheet.sheet-scrim` (`index.html:788-813`): role=dialog aria-modal,
  `data-nav-mirror` items for analyze / replay:scout / teams / settings / `#sheet-palette`.
- Context menus (static hosts, filled at runtime): `#node-context-menu`,
  `#repertoire-context-menu`, `#account-menu` (`index.html:815-817`).
- Engine window `#engine-window` (`index.html:819-841`): floating engine panel
  (`#engine-head-eval`, `#engine-window-depth-readout`, `#engine-lines-*`,
  `#engine-window-pvs`, `#engine-window-resize`).
- `#toast-stack` (role=region aria-live=polite) and `#command-palette` dialog
  (`index.html:843-855` region, exact ids `toast-stack`, `command-palette`).
- Skip link `a.skip-link[href=#workspace-main]` is the first focusable
  (`index.html:10`; asserted `web-src/ui-layout.test.js:25`).

### 1.3 View switching and deep links

- `switchView(name, {fromUrl})` (`app.js:3365-3453`): sets `appState.currentView`,
  toggles `.tab`/`[data-review-tab]`/`#more-nav-btn` aria-current, syncs topbar title,
  toggles `.view.is-active`, pushes URL via `syncWorkspaceUrl({push:true})`
  (`app.js:3013-3022`), then triggers per-view preload/load (see lazy table).
- `setReplaySection(section, {focus, syncUrl})` (`app.js:3215-3243`): flips
  `[data-replay-panel]` hidden/aria-hidden between games and scout, syncs
  `.tab[data-replay-section]`, preloads the Scout chunk (`preloadScoutUi`) on scout.
- `activateWorkspaceTab({view, replaySection}, {setReplaySection, switchView})`
  (`workspace-url.js:22-31`) is the nav click entry (bound `app.js:11511-11519`).
- Deep-link codec `web-src/workspace-url.js` (131 lines): `formatWorkspaceHash`
  (55), `parseWorkspaceHash` (76), `parseWorkspaceLocation` (108),
  `serializeWorkspaceLocation` (113), `workspaceLocationFromState` (119);
  hash params `?rep=<id>&ply=<n>`. `restoreWorkspaceLocation` (`app.js:3190-3213`)
  applies it after boot; `popstate` re-applies (`app.js:11713-11720`).
- Boot order `init()` (`app.js:11901-11978`): prefs/theme → 3 BoardControllers →
  `bindEvents()` → board start positions (local chess.js) → `refreshAuthProviders` +
  `refreshAuthStatus` → `loadSignedInWorkspace()` when signed in
  (`app.js:11980-12000`) → `restoreWorkspaceLocation` → `maybeOpenSharedView`
  (`?shared=token`, `app.js:10828-10853`) → `maybeHandleJoinLink`
  (`?join=code`, `app.js:10855-10901`) → `syncWorkspaceUrl`.

### 1.4 Lazy module loading (dynamic `import()`)

| Trigger | Loader | Module | First line |
|---|---|---|---|
| Analyze/Build entry, preloads | `preloadCoach` / `preloadBuildGen` | `coach/bundle.js` / `engine/build-generate-runner.js` | `app.js:51-66` |
| coach phase chip | `loadPhaseCoach` | `coach/phase-coach.js` | `app.js:1915` |
| dashboard entry | `ensureDashboardView` / `preloadDashboardView` | `views/dashboard.js` | `app.js:3805-3845` |
| teams entry | `ensureTeamsView` / `preloadTeamsView` | `views/teams.js` | `app.js:4378-4409` |
| Analyze run | inline in `runAnalysis` | `engine/game-analyzer.js` | `app.js:5534` |
| analyze entry | `ensureAnalyzeView` | `views/analyze.js` | `app.js:5828-5860` |
| build/analyze tree | `ensureMoveTreeRenderer` | `views/shared/movetree.js` | `app.js:5861-5878` |
| build entry | `ensureBuildView` / `preloadBuildView` | `views/build.js` | `app.js:6321-6353` |
| explorer panel / play explorer | inline | `explorer.js` | `app.js:6652`, `8752` |
| train entry | `ensureTrainView` / `preloadTrainView` | `views/train.js` | `app.js:6950-6985` |
| Feeling Lucky click | inline | `feeling-lucky.js` | `app.js:9127` |
| settings entry | `ensureSettingsView` / `preloadSettingsView` | `views/settings.js` | `app.js:10274-10314` |
| replay entry | `ensureReplayView` / `preloadReplayView` | `views/replay.js` | `app.js:10747-10788` |
| Coverage scan | inline | `coverage.js` | `app.js:11007` |
| scout panel shown | `preloadScoutUi` / `ensureScoutView` | `views/scout.js` | `app.js:11211-11266`, `11404-11436` |

Scout chunk's own lazy imports (`views/scout.js`): `../explorer.js` (616, 1264,
1331), `../engine/stockfish-provider.js` (624), `../engine/build-generate-runner.js`
(625), `../engine/maia3-provider.js` (1141), `../scout-engine.js` (1214, 1535),
`../scout-explorer.js` (1261), `../scout.js` (1404, 1532, 1660, 1803, 2194, 2208),
`../scout-e2e-fixtures.js` (1651), e2e prep builder (1691).

### 1.5 Lazy CSS loading

Lazy stylesheets load only via CSS imports inside lazy JS chunks — no runtime
`<link>` injection exists (DOM-writer scan found no link creation except a download
anchor, `app.js:2917`):

| Sheet | Lines | Imported by | When |
|---|---|---|---|
| `views/analyze-chart.css` | 483 | `views/analyze.js:4` | Analyze chunk load |
| `views/replay.css` | 140 | `views/replay.js:4` | replay chunk load |
| `views/scout.css` | 436 | `views/scout.js:4` | Scout panel shown (preloadScoutUi) |
| `views/settings.css` | 202 | `views/settings.js:3` | Settings chunk load |
| `views/teams.css` | 224 | `views/teams.js:6` | Teams chunk load |

`styles.css` (6,084 lines) is eager (`app.js:1`).

### 1.6 Shared layers

- **Modal layer**: `activateModal(overlay, {initialFocus})` (`app.js:2956-3012`,
  focus trap + restore), `showInputModal` (`app.js:5018-5118`), `showConfirmModal`
  (`app.js:5119-5172`), `showInviteModal` (`app.js:4750-4814`),
  `showPromotionPicker` (`app.js:3570-3646`, shared Q/R/B/N picker, used by every
  interactive board — `web-src/promotion.test.js:64-99`), account auth modal
  (`controllers/account.js:101-111`), Lichess account chooser overlay
  (`app.js:4203-4264`).
- **Popover layer**: `views/shared/source-composer.js` — `positionPopover` (208),
  `openSourceComposer` (243; one shared surface for Games + Scout source picking),
  `selectionChips` (134), `selectionFromStorage`/`selectionToStorage` (557/582),
  `resolveFetchUsernames` (617). Settings info popovers are per-page
  (`views/settings.js:369-389`, `toggleInfoPop`).
- **Overlay layer**: `#more-sheet` (mobile nav), `#engine-window` (EngineWidget),
  context menus (`app.js:5278-5314` repertoire, `7929-7997` node, `3968` account),
  command palette (`app.js:3037-3190` + `command-palette.js` ranking).
- **Engine layer**: `EngineWidget` class (`app.js:1058-1495`, one floating window,
  docks into Build inspector via `dockEngine`/`undockEngine` `app.js:6518-6535`),
  providers `engine/engine-base.js` (45), `engine/stockfish-provider.js` (625),
  `engine/maia3-provider.js` (491) + `maia3-worker.js`/`maia3-inference.js`/
  `maia3-weights-loader.js`/`maia3-weight-cache.js`, banner model
  `engine-banner.js` (`engineUnavailableBanner` 8, `engineBannerHtml` 33) painted by
  `paintEngineBanners` (`app.js:3023-3036`) into `#analyze-engine-banner` /
  `#build-engine-banner`. Maia idle teardown after 10 min backgrounded
  (`app.js:11437-11465`).
- **Board layer**: `BoardController` (`app.js:2222-2815`; square buttons, drag ghost
  2490, coords, arrows via `renderAnnotations` 3717-3748). Three instances
  (`boards.analysis/build/train`, `app.js:529`, created `init` 11918-11928).
  Legality is browser-side: `boardAfterMove`/`boardInfo` delegate to
  `chess-local.js` `localBoardAfterMove`(35)/`localBoardInfo`(24)
  (`app.js:3762-3770`).
- **Move tree**: `views/shared/movetree.js` `createMoveTreeRenderer` (4):
  `renderMoveTree` (60), `bindMoveTreeClicks` (87), `scrollIntoViewWithin` (78).
  Used by Analyze (static import in `views/analyze.js:5`) and Build (lazy).
- **Toasts/jobs**: `Toast` (`app.js:556-947`), `ToastStack` (948), `jobToast`
  (1000; progress jobs with cancel), `showUndoToast` (1010) + `commitPendingUndos`
  (1054) for delete-undo windows.

### 1.7 appState inventory (`app.js:344-455`, comments in source)

Navigation/shell: `currentView`, `replaySection`, `pieceStyle`, `prefs`.
Analyze: `analysis`, `analysisSourcePgn`, `analysisJobId`, `analysisPolling`,
`analysisPly`, `analysisBoardFen`, `analysisVarNodes`, `analysisVarCounter`,
`analysisCurrentNodeId`, `analysisTree`, `explainContext`, `evalChartPoints`.
Build (incl. local-first sync): `build`, `buildNodeById`, `buildCurrentNodeId`,
`buildBranchChoiceId`, `buildPending`, `buildPendingDeletes`, `buildTmpCounter`,
`buildIdMap`, `buildFlushTimer`, `buildFlushing`, `buildSyncState` (saved|dirty|
syncing|error), `buildSyncRetry`, `buildUndoDeletes`, `buildUndoCommitByMove`,
`pendingRepDeletes`, `buildCollapsed` (added lazily, `views/build.js:207`).
Train: `trainingRepertoireId`, `playRepertoireIds`, `playRepertoirePreferenceKey`,
`training`, `trainMode` ("smart"|"all_lines"), `play`, `luckyBusy`, `smart`,
`trainSync` ({pending, dirty, timer, flushing, retry}), `trainSyncState`,
`trainStats`, `trainReview`, `trainBusy`, `dayStreak` (set from dashboard payload).
Identity: `lichessUsername`, `accountUsername`, `accountUserId`, `signedIn`,
`lichessAccounts`, `authProviders`, `sharedToken`.
Games: `replayResults`, `replayFilter`, `replayOpen`.
Teams: `teams`, `selectedTeamId`.
Settings/engine: `maiaRatingPinned`, `maiaAutoRating`, `serverEngineEnabled`,
`settings`, `bookState` (`app.js:2032-2038`, Analyze book cache).

### 1.8 API transport

- `api(path, options)` (`app.js:2862-2903`): fetch with `credentials:"same-origin"`,
  JSON headers + CSRF on unsafe methods via `headersWithCsrf` (`csrf.js:27-34`);
  reads body as text first, accepts `{error}` and `{detail}` error shapes, throws
  Error with `.status`.
- `postJson(path, body, options)` (`app.js:2904-2912`).
- CSRF double-submit: cookie `pf_csrf`, header `X-CSRF-Token`
  (`csrf.js:17-18`; server-side mirror `src/prepforge_chess/api/middleware.py:91`).
  Bootstrap GET `/api/csrf` deduped in-flight (`csrf.js:44-74`).
- Status line: `setStatus(message, {severity})` (`app.js:2826-2855`) writes
  `#app-status` `data-state`/`data-severity`; `setStatusError` (2856).
- Unload flushes use keepalive fetch with manual CSRF header (Build
  `beaconFlushBuild` `app.js:7380-7426`, Train `beaconFlushTrain` `app.js:10247-10273`);
  `visibilitychange` triggers `hardFlushBuild` + `flushTrainSync` (`app.js:11525-11541`).
- Direct browser fetches outside `api()`: Lichess public API
  (`train-lucky-db.js:661`, `train-lucky-titled.js:158-212`, `scout.js:1679`),
  public profile rating (`lichess-profile.js:48`), static manifests
  (`views/settings.js:121,292`, `engine/maia3-provider.js:358`).

---

## 2. Pages

### 2.1 Library (view `dashboard`)

- **Static host DOM** (`index.html:87-155`): `#dashboard-today` (hidden card),
  `#dashboard-rep-count`, `#dashboard-import-pgn`/`#dashboard-new-rep`, filter bar
  `[data-lib-filter]` (all/white/black/shared/disabled) + `#lib-filter-search`,
  `#lib-cols` (column head), `#dashboard-repertoires` (list host),
  `#dashboard-import-input` (hidden file input), aside `#lib-preview` (hidden;
  `#lib-preview-dot/name/sub/board/mix/legend`, `#lib-preview-open`,
  `#lib-preview-train`, `#lib-preview-menu`), `#dashboard-steps` (hidden card).
- **JS**: lazy `views/dashboard.js` (776 lines) `createDashboardView` (70) returns
  `{bind, loadDashboard, loadDashboardRepertoires, renderDashboardToday,
  setLibraryFilter, setLibraryQuery}` (747-754). Internal: `filterLibraryRows` (59,
  pure predicate), `renderMiniBoardHtml` (37), `renderLibraryPreview` (128-195),
  `stepsHtml` (230), `renderSteps` (269), `renderDashboardToday` (291-371),
  `renderSharedFallbackRows` (385), `renderOwnRepertoireRows` (433),
  `renderRepertoireList` (550), `setListboxRole` (598), `loadDashboardRepertoires`
  (622), `loadDashboard` (664), `handleImportPgnFile` (688), `bind` (722).
  app.js orchestrators: `ensureDashboardView` (3818), `loadDashboard` shim (3846),
  `refreshDashboardRepertoires` (3857), `promptImportRepertoireFromPgn` (3884),
  `editRepertoire` (5179), `trainRepertoire` (5264), `openRepertoireContextMenu`
  (5278), `handleRepertoireContextAction` (5324), `goToSmartTraining` (3793),
  `createRepertoirePrompt` (7511).
- **CSS**: eager `styles.css` only ("Library — Opus prototype composition" 1288;
  Today strip 1353-1430, grid 1431, filter toolbar 1444, table 1479-1627,
  preview pane 1641-1704, next steps 1705-1740+).
- **Load timing**: chunk on first dashboard entry (`switchView` →
  `ensureDashboardView`, `app.js:3436-3441`); `loadDashboard` runs when signed in.
- **API consumed**: GET `/api/dashboard?local_date=` (`views/dashboard.js:663`),
  GET `/api/repertoires` (638), GET `/api/teams` (632), POST `/api/repertoires/import`
  (705), plus app.js POST `/api/repertoires/import-pgn` (3873), create (7525),
  delete (5435), `/api/build/rename` (5348), `/api/repertoires/share-link` (5354),
  `/api/repertoires/set-active` (5384), `/api/repertoires/share` (4551/4853/4989/4997).
  Payload fields used: `repertoires[]` (id, name, color, root_fen, notes, tags,
  is_active, team_id, visibility, health{mastery_pct, trainable, mastered, learning,
  due, weak, untrained}), `shared[]`, dashboard counters (games, repertoires,
  training_sessions, due_reviews, due_soon, streak{current,best,trained_today},
  recap, recommendations[{id,title,detail,cta{label,view}}]).
- **appState**: `repertoireList`, `teams` (share badges), `pendingRepDeletes`
  (undo-window suppression), `dayStreak`, `signedIn`, `trainingRepertoireId`.
- **Runtime DOM writers**: `renderDashboardToday` → `#dashboard-today.innerHTML`
  (358), `renderSteps` → `#dashboard-steps` (278), `renderOwnRepertoireRows` /
  `renderSharedFallbackRows` / empty states → `#dashboard-repertoires` (392/442/565/582),
  `renderLibraryPreview` → `#lib-preview-board/mix/legend` + text nodes (135-178),
  `countBadge` → `#dashboard-rep-count`, error → `empty-state` (658).
- **States**: loading (list shows `Loading…` only in Teams; Library renders after
  fetch), empty ("No repertoires yet." + New/Import, 560-577), filtered-empty
  ("No repertoires match this filter.", 578-586), populated own rows (433-551),
  shared fallback rows when own list empty but shares exist (385-432, 556-559),
  error (`empty-state` with error.message, 652-660), Today strip hidden until a
  dashboard payload exists (302-305 comment).
- **Read-only/shared**: shared rows carry `sharedRow: true` and open via
  `editRepertoire` → read-only Build (see 2.2).
- **Responsive**: `previewPaneShown()` (198) — when `#lib-preview` is not visible
  (≤760px per prototype CSS) a row click opens the workspace directly instead of
  previewing (470-477).
- **Keyboard/a11y**: rows `tabindex=0`; Enter opens the selected row, Space previews
  (502-512); listbox role owned by `#dashboard-repertoires` with `role=option` on
  `.lib-opt` spans, dropped in empty states (`setListboxRole`, 598-608; ARIA note
  418-432); mastery bar `role=img` with `aria-label`.
- **Tests**: `web-src/views/library-filters.test.js` (predicate + wiring + listbox
  roles), `web-src/views/dashboard-recommendations.test.js` (empty/next-steps/CTA).
- **Smoke**: `scripts/smoke/ui-v2/library-viewport-smoke.mjs` (3 rows, Today strip
  streak+due, Train button, steps card; viewports 1440x900 / 1180x900 / 390x844).

### 2.2 Repertoire (view `build`)

- **Static host DOM** (`index.html:262-343`): `#build-board` + `svg#build-annotations`,
  board-bar (`#build-root/parent/next/end`, `#build-board-label`, `#build-sync`
  aria-live=polite, `#build-flip`), `#build-engine-banner`, `#build-rep-name` +
  `#build-menu`, `#shared-banner` (hidden static host: `#shared-banner-title`,
  `#shared-banner-note`, `#shared-fork-btn`), `#build-empty` (create/import/open),
  `#build-tree-meta` (breadcrumbs), `#build-branchbar` (hidden fork bar),
  `#builder-tree`, dock `#build-inspector` (tabs `#build-tool-explorer`,
  `#build-tool-coverage` + `#build-coverage-count`, `#build-tool-engine`;
  `#build-dock-tools` with `#inspector-dbs` masters|lichess, `#explorer-opening`,
  `#coverage-score`, `#inspector-info`, `#coverage-run`; panels `#explorer-drawer`
  (`#explorer-rows`), `#coverage-drawer` (`#coverage-gaps`), `#engine-drawer`).
- **JS**: lazy `views/build.js` (258) `createBuildView` (3) returns
  `{renderBuildRepHeader, renderBuilderTree, renderBuildBreadcrumb,
  renderBuildBranchBar}` (252-258); internals `buildPath` (15),
  `buildNormalizedTree` (24), `renderBuildBreadcrumb` (65), `renderBuildBranchBar`
  (93-146), `renderMasteryLegend` (148), `renderTreeMeta` (166), `renderBuilderTree`
  (182-241). app.js: `hydrateBuild` (6290), `renderBuildRepHeader` shim (6354),
  `openBuildMenu` (6370), `renameRepertoire` (6409), `selectBuildNode` (6471),
  `buildGoRoot/Back/Forward/ToEnd` (6753-6785), `buildBranchContext` (6800),
  `buildBranchKey` (6810), `saveBuildAnnotations` (6826), sync engine
  (`mintBuildTmpId` 6865, `buildProvisionalNode` 6886, `setBuildSync` 6919,
  `renderSyncChip` 6931, `scheduleBuildFlush` 7036, `flushBuildMoves` 7048-7200,
  `reapplyPendingBuildNodes` 7201, `pruneLocalBuildSubtree` 7227,
  `reapplyPendingBuildDeletes` 7247, `deleteBuildNodeLocal` 7272,
  `hardFlushBuild` 7362, `beaconFlushBuild` 7380, `onBuildBoardMove` 7427),
  `generateFromCurrentNode` (7615), `openNodeContextMenu` (7929),
  `handleNodeContextAction` (7998), `exportBuild` (8093), read-only UI
  (`isBuildReadOnly` 5173, `updateBuildReadOnlyUi` 5206, `removeReadOnlyBanner`
  5218, `syncCoverageReadOnlyState` 5225, `paintCoverageCount` 5253),
  shared viewer (`maybeOpenSharedView` 10828, `renderReadOnlyBanner` 10916,
  `forkReadableRepertoire` 10929), explorer panel (6507-6714),
  `setBuildInspector` (6536), `dockEngine`/`undockEngine` (6518/6528),
  coverage (`runCoverageScanUI` 10974, `renderCoverageResult` 11034,
  `completeSelectedGaps` 11115, `completeOneGap` 11163).
- **CSS**: eager `styles.css` (study layout 1805+, fork hints 1936, sync chip 2423,
  board-bar 2361); no build-specific lazy sheet.
- **Load timing**: `views/build.js` lazy on Build entry; `views/shared/movetree.js`
  lazy on first tree render; `engine/build-generate-runner.js` preloaded on entry
  (`app.js:3391-3398`) — Maia weights download only on an explicit Generate click
  (comment `app.js:3395-3398`; asserted `web-src/engine-loading-lifecycle.test.js:78-118`).
- **API consumed**: GET `/api/build/load?repertoire_id=` (`app.js:8779`), POST
  `/api/build/add-moves` (7081; body `{repertoire_id, moves:[{tempId, parentRef,
  uci}]}`), POST `/api/build/delete-nodes` (7074; `{repertoire_id, node_ids[]}`),
  POST `/api/build/annotations` (6845), POST `/api/build/action` (8076), POST
  `/api/build/rename` (6426), POST `/api/build/export` (8043/8115), POST
  `/api/build/generate/apply-plan` (7896), GET `/api/shared/{token}` (10838), POST
  `/api/shared/{token}/fork` (10940), POST `/api/repertoires/fork` (10944), GET
  `/api/lichess/explorer/{masters|lichess}` via `explorer.js` (URL builder
  `explorer.js:49-78`). Build payload fields used: `repertoire_id`, `name`, `color`,
  `nodes[]` (id, parent_id, depth, san, uci, move_number, move_side, is_mainline,
  is_enabled, is_prepared, mastery, maia_probability), `selected_node_id`,
  `writable`, `shared`, `share_team_id`, `health`, `id_map` (tmp→real),
  `removed_node_ids`, `summary{added_nodes, updated_nodes,
  high_probability_unprepared}`.
- **appState**: `build`, `buildNodeById`, `buildCurrentNodeId`,
  `buildBranchChoiceId`, `buildPending`, `buildPendingDeletes`, `buildTmpCounter`,
  `buildIdMap`, `buildFlushTimer`, `buildFlushing`, `buildSyncState`,
  `buildSyncRetry`, `buildUndoDeletes`, `buildUndoCommitByMove`, `buildCollapsed`,
  `sharedToken`.
- **Runtime DOM writers**: `renderBuildRepHeader` (`views/build.js:58`),
  `renderTreeMeta` (173, breadcrumb + mastery legend), `renderBuilderTree` (189/199/231,
  tree HTML via movetree renderer), `renderBuildBranchBar` (97/131), explorer rows
  (`app.js:6644-6706`), coverage gaps (5240, 11046, 11067), context menus (6385,
  7971), train repertoire select (8160).
- **States**: empty (`#build-empty` + tree-empty text), writable populated,
  shared read-only team (`build.writable === false` → `#shared-banner` shown,
  mutations gated client-side by `isBuildReadOnly`, server-side by owner gate),
  public share-link viewer (`?shared=token` → `appState.sharedToken`, same banner,
  fork via `#shared-fork-btn`), fork state (`#build-branchbar` with chips +
  `buildBranchChoiceId`, board branch arrows), engine on/off (`engineWidget.isOpen`
  → inspector Engine tab docks the window; else Explorer), coverage scan states
  (idle hint `COVERAGE_IDLE_HINT`, running, results, read-only suppression 5225),
  sync chip states `saved|dirty|syncing|error` (`SYNC_CHIP_VARIANTS` 6924-6930).
- **Responsive**: study board sizing from viewport (`ui-layout.test.js:45`), fork
  chips wrap (styles.css), dock becomes stacked below 1020/760 (styles.css media
  blocks 3806/3841).
- **Keyboard**: ←/→ step, ↑/↓ (j/k) move fork pick, F flips board
  (`app.js:11846-11880`); fork-bar kbd legend (`views/build.js:137`); dock tabs
  Arrow/Home/End roving (`app.js:11577-11607`); tree moves are buttons (movetree).
- **Tests**: `web-src/views/build-branchbar.test.js` (real maia share 48% vs manual
  no-share, mastery legend), `web-src/engine-loading-lifecycle.test.js`,
  `web-src/promotion.test.js` (shared picker),
  `web-src/views/shared/movetree.test.js`.
- **Smoke**: `scripts/smoke/ui-v2/build-viewport-smoke.mjs` (rep header, writable
  banner hidden + static host shape, sync chip Saved, 6 breadcrumbs, topbar
  "2 lines · 7 moves", Generate visible, fork bar 2 chips with real share, legend,
  explorer/coverage tab swap, ArrowDown pick, plus a shared read-only page pass
  lines 232-281).

### 2.3 Train (view `train`)

- **Static host DOM** (`index.html:345-470`): `#train-blitz` bar (+`#train-blitz-fill`),
  `#train-board` + `#train-annotations`, board-bar (`#train-flip`, `#train-hint`,
  `#train-skip`, `#train-board-label`, `#train-sync`), sidebar
  `.train-sidebar[data-session-state="setup"]`, `#train-modes` seg
  (smart / all_lines / play, `data-mode`), `#train-banner[data-state="idle"]`
  (aria-live=polite; `#train-banner-icon/title/sub`, `#train-turn-badge`), setup card
  (`#train-setup-title/blurb`, `#train-srs-picker`→`#train-repertoire-select`,
  `#train-blitz-row`+`#train-blitz-toggle`, `#train-srs-start`→`#start-train`),
  `#train-play-setup` (hidden: `#train-play-book` explorer|repertoire,
  `#train-play-repertoire-picker` with `#train-repertoire-menu/options/
  select-all/empty`, `#train-play-color`, `#train-play-chip`, `#train-play-trail`,
  `#start-play`, `#feeling-lucky`, `#play-takeback/resign/analyze`),
  `#train-progress-panel` (hidden: `#train-line-label`, `#train-card-kind`,
  `#train-accuracy`, `#train-card-dots`, `#train-progress-fill`, `#train-queue`
  with `#train-queue-bar/legend`, stats `#train-stat-streak/correct/mistakes`,
  `#train-line-trail`, `#train-upnext`, `#train-fresh`), `#train-summary` (hidden:
  `#train-summary-title/stats/delta/foot`, `#train-summary-new`), `#train-help`
  details; legacy hidden hooks `#train-import-input`, `#import-train-json`.
- **JS**: lazy `views/train.js` (242) `createTrainView` (3) returns
  `{renderTrainSync, renderTrainStats, renderTraining, renderSmartQueueStrip,
  renderSmartProgress, renderSmartSummary}` (235-242); `renderUpNext` (110),
  `paintCardKind` (152). app.js: `startTraining` (8460-8520), `startSmartTraining`
  (9637-9741), `smartLocalPrompt` (9742), `presentSmartPrompt` (9775),
  `submitSmartMove` (9901-10053), `skipSmartCard` (10054), `smartHint` (10079),
  `finishSmartSession` (10101-10145), `requeueSmartCard` (9891), legacy rehearsal
  (`submitTrainingMove` 9219, `enterReviewRound` 9343, `showReviewItem` 9353,
  `submitReviewMove` 9374, `finishReviewRound` 9407, `finishTrainingSession` 9425,
  `skipTrainingLine` 6437, `trainHint` 9459), blitz (`blitzEnabled` 9571,
  `setBlitzEnabled` 9579, `startBlitzTimer` 9605, `clearBlitzTimer` 9593), play vs
  human (`startPlaySession` 8800, `playOpponentReply` 8934, `submitPlayMove` 9041,
  `onFeelingLucky` 9079, `takebackPlaySession` 9155, `resignPlaySession` 9189,
  `openPlayInAnalyze` 9204; helpers `train-play.js`, `train-opponent.js`,
  `train-lucky*.js`, `feeling-lucky.js`), sync (`queueTrainAttempt` 10149,
  `markTrainPositionDirty` 10162, `scheduleTrainSync` 10168, `flushTrainSync`
  10181-10246, `beaconFlushTrain` 10247-10273; grouping in `train-sync.js`),
  controls (`trainSessionLive` 8341, `syncTrainSessionControls` 8348-8398,
  `resetTrainBoardIdle` 8399, `setTrainBanner` 8443-8458, `trainStatsReset` 8425,
  `syncTrainPickerVisibility` 8274, `renderPlayRepertoirePicker` 8230,
  `selectedTrainRepertoireIds` 8214, `localDateString` 8437).
- **CSS**: eager `styles.css` (train sidebar 1881+, coach banner 2757, blitz bar,
  progress/upnext/summary cards); no train lazy sheet.
- **Load timing**: `views/train.js` on Train entry (`app.js:3407-3410` +
  `loadTrainRepertoireOptions` 8136); `feeling-lucky.js` on Lucky click (9127).
- **API consumed**: POST `/api/train/smart/start` (`app.js:9667`; body `{mixed:true,
  fresh}` from the UI), GET `/api/train/smart/summary` (10129), POST
  `/api/train/smart/sync` (10209 + keepalive 10260; body `{session_id, attempts:
  [{node_id, correct, attempt_uuid}], card_index, queue:[encoded], local_date}`),
  POST `/api/train/start` (8494), `/api/train/move` (9237), `/api/train/skip` (6452),
  `/api/train/hint` (9471), `/api/train/record-miss` (2192), GET `/api/repertoires`
  (8141), GET `/api/build/load` (8779 for play books), explorer + Lichess public
  endpoints for Play/Lucky (`train-opponent.js`, `train-lucky*.js`). Prompt fields
  used: smart prompt (fen_before, legal_moves, kind, targets[], total_cards,
  card_index, target_index, targets_total, session_id, repertoire_name, color,
  encoded card), session bundle `cards[]`, `counts`, `health`, `due_tomorrow`,
  `day_streak`.
- **appState**: `trainingRepertoireId`, `trainMode`, `training`, `smart`
  ({sessionId, repertoireId, repertoireName, color, mixed, queue, cardIndex,
  targetIndex, …}), `play`, `luckyBusy`, `trainStats`, `trainReview`, `trainBusy`,
  `trainSync`, `trainSyncState`, `playRepertoireIds`, `dayStreak`.
- **Runtime DOM writers** (`views/train.js`; writer sites listed in §4.2):
  `renderTrainStats` (20), `renderSmartQueueStrip` (79), `renderUpNext` (110),
  `renderSmartProgress` (160), `renderSmartSummary` (181), plus app.js
  `renderPlayRepertoirePicker`
  (8242), `renderPlayTrail` (8608), hint badge (9502-9510), celebrate confetti
  (9441-9444).
- **States** (sidebar `data-session-state`: `setup|active|summary` set in
  `syncTrainSessionControls` `app.js:8353`; banner `data-state` set by
  `setTrainBanner`: `idle|move|correct|wrong|teach|reveal|runin|done` — code
  references `teach|reveal|runin` at 8363, `correct|wrong` flash at 8451-8457):
  - setup (mode picker + repertoire picker + blitz + Start),
  - smart active (progress panel, queue strip, up-next, card dots),
  - summary (`#train-summary` + health delta + `New session`),
  - smart (`trainMode="smart"`, mixed queue from `/smart/start`),
  - play / all_lines (`play` mode reveals `#train-play-setup`; all_lines uses
    `/api/train/start` line prompts),
  - blitz (toggle `#train-blitz-toggle`, `#train-blitz` bar + 10s timer,
    locked while a smart session runs — `syncTrainSessionControls` 8376-8383).
- **Permission states**: repertoire picker lists only caller's listings; play
  repertoire multi-select persists per browser (`playRepertoireStorageKey` 8184).
- **Responsive**: sidebar stacks under board at narrow widths (styles.css study
  layout media blocks 1730-1760, 3137-3160); mobile 44px targets
  (`ui-layout.test.js:540`).
- **Keyboard**: `train_keyboard_smoke.mjs` e2e; hint/skip buttons disabled per state
  (8358-8371); switches Space/Enter shared primitive
  (`ui-layout.test.js:501`).
- **Tests**: `web-src/views/train-upnext.test.js`, `web-src/train-resume.test.js`
  (`mapTrainUiSession`), `web-src/train-sync.test.js` (groupAttempts/flushGroups
  retry semantics), `web-src/train-play.test.js`, `web-src/train-opponent.test.js`,
  `web-src/train-lucky*.test.js`, `web-src/feeling-lucky.test.js`.
- **Smoke**: `scripts/smoke/ui-v2/train-viewport-smoke.mjs` (3 mode tabs, default
  Smart queue, banner data-state present, blitz row, 2 rep options, play setup
  reveal, active session Card 1/4, queue legend, up-next 3 rows).

### 2.4 Games (view `replay`, section `games`)

- **Static host DOM** (`index.html:574-599`): `section.games-panel[data-replay-panel=
  "games"]` with toolbar (`.src`: "Games from" + `#games-source-chips` +
  `#games-source-add`, `#replay-count` select 10/20/30/50, `#lichess-compare-btn`
  `[data-testid=lichess-compare]`, `#replay-summary` sum-chips hidden) and
  `#replay-results`.
- **JS**: lazy `views/replay.js` (337) `createReplayView` (127) returns
  `{renderReplayResults}` (335-337); internals `REPLAY_KINDS` (6: in-prep,
  user-error, left-prep, no-prep), `replayGameKind` (15), `replayResultClass` (24),
  `replayFocusPosition` (37, derives FEN via chess.js from `move_san_history`),
  `replayArrowsFor` (75), `replayFocusBoardHtml` (85), `renderReplaySummary` (135),
  `renderReplayMoveLine` (178), `renderReplayDetail` (208), `renderReplayRow` (239),
  `renderReplayFocus` (259). app.js: `runLichessCompare` (10416),
  `renderReplayResults` shim (10789), `replayToAnalyze` (10796), source composer
  wiring (10473-10649: `readSourceStore` 10475, `writeSourceStore` 10495,
  `gamesSourceSelection` 10518, `openGamesComposer` 10566, `paintGamesSource`
  10584, `bindGamesSource` 10612), new-game watcher (`startLichessGameWatch` 4017,
  `checkLatestLichessGame` 4089, `showNewGameWidget` 4125, `markLichessSeen` 4177,
  `fetchMyLichessGame` 4277), `syncReplayControls` (3978).
- **CSS**: lazy `views/replay.css` (140; triage ledger + focus card — header states
  toolbar lives in eager `styles.css:744-758`).
- **Load timing**: `views/replay.js` + replay.css on replay entry
  (`preloadReplayView` `app.js:10750`).
- **API consumed**: POST `/api/lichess/compare` (`app.js:10435`; body `{count,
  account_id?, account_ids?, usernames?}` — usernames from
  `resolveFetchUsernames`), GET `/api/lichess/latest?light=1` (4095) /
  `/api/lichess/latest` (4155/4287), POST `/api/lichess/seen` (4180), GET
  `/api/lichess` (account status, `controllers/account.js:319,360`). Compare
  response fields used per game: `lichess_id, white, black, result, user_color,
  in_repertoire, matched_plies, departure_ply, departure_move_uci, departure_reason,
  repertoire_id, repertoire_name, move_san_history[], expected_move_uci/san,
  expected_node_id, last_matched_node_id, training_recorded, source_account`; top
  level `count, misses_recorded, sources[]`.
- **appState**: `replayResults`, `replayFilter` (summary-chip kind or null),
  `replayOpen` (Set; one open game), `replaySection`, `lichessAccounts`,
  `lichessUsername`.
- **Runtime DOM writers** (`views/replay.js`): `renderReplaySummary` (167),
  `renderReplayResults` (297/306/312 — ledger + focus), plus app.js source tray
  `paintGamesSource` (10593/10606).
- **States**: no source (composer tray; Check enabled only with a selection —
  smoke asserts enabled-with-source, `games-viewport-smoke.mjs:141`), loading
  (setStatus), populated (summary chips + ledger rows + focus card),
  departure selected (row `is-open`; focus board + reason list + actions:
  `Train` on user-error, `Add reply` on left-prep with repertoire, `Analyze`,
  lichess ↗ link), filter-empty ("No games in this bucket", 306-309),
  no games ("No recent games found", 297-302), error (setStatus).
- **Focus board**: client-derived FEN at `departure_ply-1`; expected(good) +
  expected + played arrows from payload UCIs; illegal expected move drops the arrow
  (`replayFocusPosition` 37-73; `replay-focus.test.js`).
- **Responsive**: replay.css media 1279/1020/760 (ledger+focus stack).
- **Keyboard/a11y**: rows are `<button aria-pressed>` (renderReplayRow 239-257),
  summary chips `aria-pressed`; deep links `#/games`.
- **Tests**: `web-src/views/replay-focus.test.js`, `web-src/workspace-url.test.js`
  (games/scout deep links), `web-src/ui-layout.test.js:305` (shared Source
  Composer).
- **Smoke**: `scripts/smoke/ui-v2/games-viewport-smoke.mjs` (chips, 4 sample
  options, summary counts + "+1 queued for training", 3 rows, focus board 64
  squares, expected/played arrows + legend, filter leaves 1 row).

### 2.5 Scout (view `replay`, section `scout`)

- **Static host DOM** (`index.html:601-637`): `section.replay-card-scout.scout-panel[
  data-replay-panel="scout"]` (hidden) with toolbar (`#scout-source-chips`,
  `#scout-source-add`, `#scout-color` both|white|black, `#scout-btn`
  `[data-scout-action="start"]`, `#scout-reset-btn` hidden, counter
  `#scout-live-count` aria-live=polite), `.scout-grid` → `.scout-main`
  (`.scout-stream.stream.card` role=status with spinner copy, `.scout-empty`,
  `#scout-profile` hidden, `#scout-v3-results` hidden, `#scout-results`) and
  aside `#scout-side` (hidden, "Line detail").
- **JS**: lazy `views/scout.js` (2,210) `createScoutView(deps)` (107) returns
  `{runScout, handleScoutAction, bindControls, onShow: syncVisibleState, preload}`
  (2194-2210; `mountE2eRefutationScenario` only in e2e builds, 11267). Key
  internals: `isStreaming` (173), `clearScoutSide` (187), `updateScoutControls`
  (285), `syncVisibleState` (326), live tries (355-401), `renderScoutReport` (402),
  v13 panel (`paintV13Panel` 553, `runV13PrepPackages` 578), render throttling
  (`scheduleRender` 701, `scoutRenderForceEvery` 76, `scoutRenderDebounceMs` 85),
  enrichment pipeline (`schedulePrefilterEnrich` 766, `enrichPrefilterReads` 947,
  `enrichMaiaReads` 1094, `computeEngineAggregation` 1209, `enrichExplorerReads`
  1256; all deferred while streaming — comment 173-176), line detail
  (`localScoutLineDetailHtml` 1299, `scoutAnalyzeLine` 1350), prep write-back
  (`scoutPickRepertoire` 1361, `scoutWriteLineToRep` 1403, `scoutAddToPrep` 1457,
  `scoutPrepareAll` 1464), `copyScoutReport` (1509), `scoutRunDeepScan` (1520),
  dist drilldown (1605/1633), `bindScoutEvents` (1703), `handleScoutAction`
  (2164: running→stop, paused→resume, else start), `scoutErrorHtml` (95).
  Computation modules (lazy): `web-src/scout.js` (1,744; stream + PGN parse),
  `scout-engine.js`, `scout-explorer.js`, `scout-refutation.js`, `scout-maia.js`,
  `scout-prefilter.js`, `scout-stats.js`, `scout-graph.js`, `scout-summary.js`,
  `scout-v13-*.js`, `scout-v12-report.js`, `scout-shadow-prep-*`.
  **`web-src/scout-report.js`** (1,452) is the render library: `scoutLineKey` (30),
  `captureScoutExpanded`/`restoreScoutExpanded` (43/149),
  `renderScoutColorTabsHtml` (66), `applyScoutColorTabs` (91), tab click/keydown
  (108/120), `openScoutLine` (170), `ensureScoutLineSelection` (210),
  `scoutWdlHtml`/`scoutWdlBar` (241/252), `renderScoutEnginePanel` (323),
  `renderInlineRefutationCard` (419), `renderScoutRefutationPanel` (440),
  `buildScoutIntelligenceA11ySummary` (504), `renderScoutIntelSummary` (675),
  `renderScoutIntelligencePanel` (752), `scoutScoreCell` (767),
  `patchScoutLineMaiaCells` (783), `renderMiniBoardHtml` (807),
  `renderScoutProfile` (824).
- **CSS**: lazy `views/scout.css` (436). Per its header comment, panel/grid
  skeleton, toolbar and empty+stream states live in eager `styles.css`
  ("Scout — Opus prototype composition", 744+); the sheet owns the report itself.
- **Load timing**: chunk + scout.css load as soon as the scout panel is shown
  (`setReplaySection` `app.js:3229-3233`; `preloadScoutUi` 11404-11436); Start
  click has a pre-bind guard that runs `runScout` through the preload
  (`app.js:11551-11559`).
- **API consumed**: browser-side Lichess public game export (`web-src/scout.js:1679`
  fetch; clocks=true, standard chess only — `scout.test.js:161-169`), GET
  `/api/lichess/explorer/{db}` (enrichment via `explorer.js`), GET
  `/api/repertoires` + GET `/api/build/load` (prep target picking,
  `views/scout.js:1365,1808,1816`), Build writes through injected app.js deps
  (`buildProvisionalNode`, `hardFlushBuild` → POST `/api/build/add-moves`).
- **deps/appState**: `createScoutView` deps list (`views/scout.js:108-133`) includes
  `scoutPickedUsernames`, `getLichessUsername`, `effectiveMaiaRating`,
  `effectiveStockfishDepth`, `maiaAnalysisEnabled`, build mutators; module state
  `scoutState`, `scoutSession` (states seen in code: `"running"`, `"paused"`),
  generation counters (`scoutOpGen`, enrich seq/gens) for stale-response drops.
- **Runtime DOM writers** (`views/scout.js`): `clearScoutSide` (191), engine
  progress patch (253/271), `renderScoutReport` (485), `paintV13Panel` (566),
  dist drilldown (1626/1639), report root (1696), error (1928/2026/2144), reset
  clears (2069/2073/2113/2130); `scout-report.js` patches (185/222/788/795/803).
- **States**: pre-start (`.scout-empty` + panel visible + report empty — smoke
  lines 186-196), streaming (`scoutSession.state==="running"`; `is-streaming`
  class; `#scout-live-count`), paused/resume, completed (report + colour tabs +
  game-plan rows + charts), error (`scoutErrorHtml` into `#scout-results`),
  reset (clears results/profile/side + experimental panel — `scout-init.test.js`),
  white/black tabs (roving tabindex, visibility-only — `scout-colortabs.test.js`),
  line detail (`#scout-side` via `openScoutLine`; one row open at a time).
- **Responsive**: scout.css media 1279/760; row collapse rules asserted
  (`scout-stream-scale.test.js:28-43`); detail scrolls into view on phones
  (`revealScoutDetail` 197).
- **Keyboard/a11y**: colour tabs Arrow/Home/End (`scout-report.js:120-148`),
  a11y summaries for intel/refutation panels (`buildScoutIntelligenceA11ySummary`
  504, `refutationA11ySummary` 361).
- **Tests**: `web-src/views/scout-init.test.js`, `scout-stream-scale.test.js`,
  `scout-colortabs.test.js`, `scout-engine-scan.test.js`,
  `scout-explorer-enrich.test.js`, `scout-maia-enrich.test.js`,
  `scout-maia-candidate-cap.test.js`, `scout-maia-scope.test.js`,
  `scout-refutation-render.test.js`, `web-src/scout.test.js` (parse/clocks),
  `web-src/scout-report.test.js` (expansion capture/restore, tabs, PGN build).
- **Smoke / e2e**: `scripts/smoke/ui-v2/scout-viewport-smoke.mjs` (source chip,
  pre-start panel, profile, live count, 2 colour tabs with counts, rows, side
  detail + Analyze action, tab swap); `tests/e2e/test_scout_smoke.py` +
  `tests/e2e/scout_smoke.mjs`, `tests/e2e/test_scout_smoke.py::
  test_scout_refutation_smoke` + `scout_refutation_smoke.mjs`.

### 2.6 Analyze (view `analyze`)

- **Static host DOM** (`index.html:158-260`): `#analysis-evalbar`
  (`#analysis-evalbar-white`, `#analysis-evalbar-text`), `#analysis-board` +
  `svg#analysis-annotations`, board-bar (`#analysis-start/prev/next/end`,
  `#analysis-flip`, `#analysis-board-label`), `#analyze-sidebar` with
  `#analyze-engine-banner`, `#analysis-game-title/meta`, coach card
  `#analysis-explain` (`#coach-phase`, `#explain-engine-toggle` role=switch,
  `#coach-prose`, `#coach-maia`, `#coach-bookline`), `#analysis-results` hidden
  (`#analysis-chart-caption`, `svg#eval-chart`, `#eval-chart-tooltip`,
  `#analysis-moves`, `#analysis-summary`, `#analysis-handoff` →
  `#create-repertoire-from-game`), `#analysis-empty`, `details#pgn-drawer`
  (`#pgn-input`), `details#history-drawer` (`#analysis-history`). Topbar actions
  (`index.html:24-29`): `#open-engine-widget`, `#fetch-my-game`, `#run-analysis`.
- **JS**: lazy `views/analyze.js` (661) `createAnalyzeView` (7) returns
  `{renderAnalysis, renderClassificationBars, renderEvalChart, renderAnalysisTree,
  buildAnalysisTree, classBadgeSymbol, updateEvalChartCursor, rescaleEvalMarkers,
  bindEvalChartInteractions, evalChartNearestIndex, evalChartTooltipHtml,
  renderMoveTree, bindMoveTreeClicks, scrollIntoViewWithin}` (636-658);
  `CLASS_GROUPS` (9), `pointWinPct` (313, Lichess sigmoid),
  `updateBoardEvalBar` (289), tooltip/cursor (324-360), keyboard chart (361-426),
  `renderEvalChart` (427-583). app.js: `runAnalysis` (5469-5745; browser Stockfish
  + optional Maia via `engine/game-analyzer.js` lazy at 5534, phased jobToast,
  POST prepare → classify-save), `loadPgnIntoAnalyze` (6115), `syncPgnFromTree`
  (6091), `analyzePgnHeaderBlock` (6031), `adaptParsedTree` (6044),
  `showAnalysisPly` (5949), `analysisTreeNav` (5989), `selectAnalysisNode` (6193),
  `onAnalysisBoardMove` (6221), `resetAnalysisVariations` (6005),
  `loadAnalysisHistory` (4308), `recallAnalysis` (4339), `fetchMyLichessGame`
  (4277), handoff (`updateAnalysisHandoff` 5765, `onCreateRepertoireFromGameClick`
  5774), coach (`PositionCoach` 1588-1896, `setCoachProse` 1901,
  `maiaPhaseCoach` 1970, `updateBookline` 2134, `renderInstantCoach` 2004).
- **CSS**: lazy `views/analyze-chart.css` (483; panel body, eval chart, eval bar —
  eager sheet owns study grid + `.panel` per its header comment).
- **Load timing**: `views/analyze.js` + coach bundle on Analyze entry (`app.js:3387-3390`);
  book warm (`ensureBookLoaded` 2045) when signed in.
- **API consumed**: POST `/api/analyze/prepare` (`app.js:5501`; `{pgn}` →
  `game_id, engine, depth, positions[], moves[], brilliant{enabled, rating}`),
  POST `/api/analyze/classify-save` (5670; `{game_id, engine, depth, positions
  [{fen, …evals}], maia_assessments[{fen, uci, human_probability,
  win_chance_after, trap_gap?}]}`), GET `/api/analyses` (4314), GET
  `/api/analyses/{game_id}` (4344), GET `/api/lichess/latest` (4287), POST
  `/api/train/record-miss` (2192). Board legality is local (`chess-local.js`).
- **appState**: `analysis`, `analysisSourcePgn`, `analysisJobId`,
  `analysisPolling`, `analysisPly`, `analysisBoardFen`, `analysisVarNodes`,
  `analysisVarCounter`, `analysisCurrentNodeId`, `analysisTree`, `explainContext`,
  `evalChartPoints`, `bookState`.
- **Runtime DOM writers** (`views/analyze.js`): `renderClassificationBars` (109/149),
  `renderAnalysisTree` (243/250), tooltip/caption (322/381), `renderEvalChart`
  (483 + createElementNS graph nodes); app.js `loadAnalysisHistory` (4311-4337),
  tree empty state (5920-5927).
- **States**: initial (demo PGN prefill `prefillDemoPgn` 5465 + `#analysis-empty`
  + coach idle line "Make a move and I'll tell you what I think."), evaluating
  (jobToast phases load/stockfish/maia/classifying/saving/rendering, run button
  disabled, results hidden), result (`revealAnalysisResults` 5811: chart, class
  bars, tree, handoff), engine unavailable (`isBrowserEngineAvailable` gate at
  5470-5473 → status error `BROWSER_ENGINE_UNAVAILABLE`; banner model in
  `engine-banner.js`; `paintEngineBanners` 3023), history recall (4339),
  variation-explore state (`analysisVarNodes` client-side branches).
- **Read-only/shared**: n/a (per-user analysis; server isolates per owner —
  `tests/test_api_analyze.py::test_analyses_isolated_between_users`).
- **Responsive**: analyze-chart.css media 760 + reduced-motion; eval bar flips
  vertical/horizontal via `--white-share` custom property (comment 296-300).
- **Keyboard/a11y**: eval chart focusable when non-empty — arrows step, Enter
  selects, Home/End (`bindEvalChartInteractions` 361-426; tooltip reads SAN + % +
  classification as text); board-bar icon buttons have aria-labels; drawers are
  `<details>`.
- **Tests**: `web-src/views/analyze-chart.test.js`, `analyze-evalbar.test.js`,
  `web-src/analyze-pgn.test.js`, `web-src/explain.test.js`, coach tests
  (`web-src/coach/*`), `web-src/engine-loading-lifecycle.test.js` (Analyze starts
  Stockfish + Maia in parallel).
- **Smoke / e2e**: `scripts/smoke/ui-v2/analyze-viewport-smoke.mjs` (64 squares,
  coach idle line, run → "Analysis ready", chart + moves + 2 class-bar rows,
  layout/panel assertions, variation, eval bar hide at ply 0 / show on scored
  ply); `tests/e2e/test_eval_chart_smoke.py` + `eval_chart_smoke.mjs`.

### 2.7 Teams (view `teams`)

- **Static host DOM** (`index.html:544-595`): `.teams` grid — card `Directory`
  (`#teams-new`, search `#teams-search`, `#teams-list`); detail card
  `#team-detail-card` hidden (`#team-detail-name`, `#team-detail-role`,
  `#team-detail-invite`/`-rename`/`-delete`/`-close`; tabs `role=tablist`
  `#team-tab-members`/`#team-tab-repertoires` each with `[data-team-count]`;
  panels `#team-panel-members` (`#team-add-member`, `#team-members`) /
  `#team-panel-repertoires` (`#team-share-rep`, `#team-shared-repertoires`);
  footer `#team-invite-foot`); placeholder card `team-empty`; incoming card
  (`#teams-shared-title`, `#teams-shared-hint`, `#teams-shared`).
- **JS**: lazy `views/teams.js` (219; imports `teams.css`) `createTeamsView`
  (8) returns `{loadTeams, renderTeamsList, renderTeamSharedRepertoires,
  selectTeamPane, renderTeamTabCounts, renderTeamInviteFooter, bindTeamTabs}`
  (line 218). app.js wrappers/state: `teamRoleLabel` (4370), `teamById` (4374),
  `preloadTeamsView`/`ensureTeamsView` (4383/4391), `hideTeamDetail` (4419),
  `openTeamDetail` (4426-4553), `unshareRepertoireFromTeam` (4541),
  `createTeam` (4563), `renameTeam` (4592), `deleteTeam` (4616), `addTeamMember`
  (4636), `updateMemberRole` (4678), `removeTeamMember` (4693), `teamInvite`
  (4723), `showInviteModal` (4750), `shareRepertoireIntoTeam` (4815),
  `copySharedRepertoire` (4867), `loadSharedRepertoires` (4877),
  `openSharedRepertoire` (4933), `shareRepertoireWithTeam` (4940), and
  `maybeHandleJoinLink` (10855; `?join=<code>` redeem).
- **CSS**: lazy `views/teams.css` (224).
- **Load timing**: chunk + teams.css on first Teams entry (`ensureTeamsView`);
  `loadTeams` also runs after join-link redemption.
- **API consumed**: GET `/api/teams` → `{teams:[{id,name,role,member_count}]}`;
  GET `/api/teams/{id}` → `{name, role, members:[{user_id, display_name,
  lichess_username, role}], shared_repertoires:[{id, name, color, owner_user_id,
  owner_display_name}], invite:{exists, expires_at}}`; POST `/api/teams` `{name}`;
  PATCH/DELETE `/api/teams/{id}`; POST `/api/teams/{id}/members`
  `{lichess_username, role}`; PATCH/DELETE `/api/teams/{id}/members/{user_id}`
  `{role}`; POST `/api/teams/{id}/invite` → `{url}` (raw code returned only at
  mint; rotate semantics) and DELETE same; GET `/api/teams/join/{code}` →
  `{name, member_count, already_member}`, POST same → `{joined, team:{id,name}}`;
  GET `/api/repertoires` → `{repertoires, shared}`; POST `/api/repertoires/share`
  `{repertoire_id, team_id?, visibility: "team"|"private"}`; POST
  `/api/repertoires/fork` `{repertoire_id}` → `{name}`.
- **appState**: `teams`, `selectedTeamId`, `signedIn`, `accountUserId` (compared
  to `owner_user_id`/`user_id` to distinguish own rows).
- **Runtime DOM writers**: `loadTeams` (teams.js:65; `#teams-list` loading/
  signed-out states), `renderTeamsList` (92; rows via innerHTML + per-row
  listeners), `renderTeamSharedRepertoires` (137; `#team-shared-repertoires`),
  `renderTeamInviteFooter` (199; `#team-invite-foot`), `renderTeamTabCounts`
  (51; `[data-team-count]` textContent + hidden); app.js `openTeamDetail`
  (4426; member rows + role selects into `#team-members`, button visibility),
  `loadSharedRepertoires` (4901; `#teams-shared`), `showInviteModal` (4774;
  createElement + append overlay).
- **States**: signed-out (`"Sign in to create and join teams."`); loading
  ("Loading…"); empty list ("No teams yet."); search-no-match; error (escaped
  `error.message`); detail loading/error; role states — owner/admin see
  Invite/Rename/Add member (`canManage = owner|admin`), Delete owner-only,
  member rows show inline role `<select>` for managers (incl. self-step-down)
  vs read-only badge + Leave for plain members, member row tail fixed for
  owner; invite footer only when `invite.exists`; incoming shares
  ("Nothing shared with you yet." vs rows with `read-only` badge + Copy);
  join-link flow (signed-out nudge keeps `?join=`, preview confirm, idempotent
  join); own shared row shows Unshare, others' shows Copy.
- **Responsive**: teams.css media rules (1180/760 per sheet);
  `teams-viewport-smoke.mjs` asserts all three viewports.
- **Keyboard/a11y**: team rows `role=button tabindex=0` Enter/Space; tabs
  ArrowLeft/ArrowRight with roving tabindex + `aria-selected`; shared rows
  Enter/Space (row-level only); invite modal Escape close + focus to URL input.
- **Tests**: `web-src/views/teams-tabs.test.js`. **Smoke**:
  `scripts/smoke/ui-v2/teams-viewport-smoke.mjs`.

### 2.8 Settings (view `settings`)

- **Static host DOM** (`index.html:604-730`): `.settings` — `nav.settings-nav`
  (7 anchor links → `#set-appearance|engine|maia|strength|board|connections|
  about`); `#set-appearance` (`#settings-theme-seg` 3 `.seg-btn`, hidden native
  `#settings-theme`); `#set-engine` (`#settings-refresh`,
  `#settings-stockfish-version`, `#settings-browser-engine-status`,
  `#settings-stockfish-status`, `#engine-info`+pop); `#set-maia`
  (`#settings-maia-retry`, `#settings-maia-reset`, `#settings-maia-model`,
  `#settings-maia-status`, `#settings-maia-error`); `#set-strength`
  (`#settings-depth`+`-readout`, `#settings-maia-auto` switch+label,
  `#settings-maia-rating`+`-readout`, `#settings-maia-analysis` switch);
  `#set-board` (`#piece-style-picker`, `#board-prefs`); `#set-connections`
  (`#settings-lichess-accounts`, `#settings-link-lichess`); `#set-about`.
- **JS**: lazy `views/settings.js` (606; imports `settings.css`,
  `engine/maia3-provider.js`, `engine/maia3-weight-cache.js`)
  `createSettingsView` (7) returns `{bind, renderSettings,
  renderBrowserEngineStatus, renderMaia3Status, renderStrengthControls,
  renderThemeControl, renderMaiaAnalysis, renderConnections, refreshConnections,
  retryMaia3, verifyMaia3, resetMaia3Cache, bindSectionNav, markActiveSection,
  ensureBound}` (571-605; `ensureBound` documented test/acceptance hook).
  app.js: `ensureSettingsView` (10287), `loadSettings` (10315),
  `applySettingsPayload` (10340), `saveSettings` (10348), `setButtonGated`
  (~10377), `applyServerEngineGating` (10394).
- **CSS**: lazy `views/settings.css` (202).
- **Load timing**: chunk + settings.css on first Settings entry;
  `settingsView.bind()` runs at construction; render binds after the
  `/api/settings` round-trip (why `ensureBound` exists).
- **API consumed**: GET `/api/settings` → `{stockfish_depth, maia_rating,
  server_engine_enabled}`; POST `/api/settings` with partial
  `{stockfish_depth}` or `{maia_rating: "auto"|number}`; GET `/api/lichess` →
  `{accounts:[{id, username, is_primary}]}`; POST `/api/lichess/primary`
  `{account_id}`; DELETE `/api/lichess/{id}`; browser `fetch` of
  `/static/engine/stockfish.manifest.json` (requires `packageVersion` +
  `variant === "lite-threaded"`) and `/static/maia3/maia3.manifest.json`
  (artifacts key + bytes); `startLichessOAuth()` for linking.
- **appState / prefs**: `settings`, `serverEngineEnabled`, `maiaRatingPinned`
  (number | null = AUTO), `maiaAutoRating`, `maiaFallbackRating`,
  `lichessAccounts`, `lichessUsername`; localStorage-ish prefs via
  `pref/setPref`: `theme`, `maiaAnalysis`.
- **Runtime DOM writers**: `renderConnections` (settings.js:161; account rows
  into `#settings-lichess-accounts`), `renderMaia3Status` (249; pill
  text/class + note + error line), `renderStockfishVersion` (117),
  `renderStrengthControls` (56), `renderThemeControl` (83),
  `renderBrowserEngineStatus` (96), `markActiveSection` (391).
- **States**: connections connected (rows + per-row `⋯` menu: Set primary /
  Unlink) vs disconnected ("No Lichess account linked."); legacy single
  username fallback (`connectionAccounts` synthesizes `id:"legacy"` row);
  Maia auto (switch on, slider `disabled`, label variants with Lichess linked
  `~rating` / unlinked `using {fallback}`) vs manual pinned rating; engine
  status from `self.crossOriginIsolated` ("available"/"unavailable" + note) and
  Stockfish manifest (version string or "Stockfish version unavailable");
  Maia3 health vocabulary `MAIA_STATUS` (Ready / Available on demand / Loading /
  Cache missing / Unavailable / Error) with `MAIA_STATUS_TONE` pill classes;
  status render is peek-only (never constructs the Maia worker — source
  comment) while Retry (`verifyMaia3`) runs real inference; Reset cache
  confirms → clears IDB weights → reload; the `maiaAnalysis` toggle gates only
  Analyze inference per source comments.
- **Keyboard/a11y**: switches `role=switch` Space/Enter via `bindSwitch`;
  segmented theme buttons `aria-pressed` with hidden native select synced for
  assistive tech; account menu `role=menu` + Escape + `aria-expanded`; info
  popovers toggle `aria-expanded` + outside-click close; section nav scroll-spy
  with click-lock (800ms) and `prefers-reduced-motion` jump vs smooth scroll.
- **Tests**: `web-src/views/settings-connections.test.js`,
  `web-src/views/settings-maia-health.test.js`. **Smoke**:
  `scripts/smoke/ui-v2/settings-viewport-smoke.mjs`.

---

## 3. State matrix (UI paths)

Per spec's state list. "Path" = the DOM surface + renderer; "source" = what
determines the state. Details/line numbers live in §2; this matrix only maps
state → surface → trigger.

### 3.1 Library (`dashboard`)

| State | Path / trigger | Source |
|---|---|---|
| empty | `#dashboard-repertoires` → "No repertoires yet." + New/Import buttons; `#dashboard-steps` card can show next-steps | `repertoires[]` empty after GET `/api/repertoires` (`renderRepertoireList`) |
| own repertoires | `renderOwnRepertoireRows` rows (name, colour dot, mastery bar, health chips) | `repertoires[]` |
| shared | `renderSharedFallbackRows` (own list empty but `shared[]` present) + shared badges on rows when both | `shared[]`, `team_id`/`visibility` |
| filtered | filter bar `[data-lib-filter]` (all/white/black/shared/disabled) + `#lib-filter-search`; no-match → "No repertoires match this filter." | `filterLibraryRows` predicate over rows |
| preview (sub-state) | row click → `#lib-preview` aside (mini board, mix, legend) when `previewPaneShown()`; else direct open | viewport + selection |
| error | `empty-state` with `error.message` in list host | fetch rejection |
| Today strip | `#dashboard-today` hidden until dashboard payload; shows streak/due/recap | GET `/api/dashboard` counters |

### 3.2 Repertoire (`build`)

| State | Path / trigger | Source |
|---|---|---|
| writable | normal tree + inspector + Generate; `#build-sync` chip `saved\|dirty\|syncing\|error` | `build.writable === true` |
| shared / read-only | `#shared-banner` shown (team-shared or `?shared=token` viewer); mutations gated by `isBuildReadOnly`; coverage actions suppressed (`syncCoverageReadOnlyState`); fork button in banner | `build.writable === false`, `appState.sharedToken` |
| engine on/off | Engine widget open → Build inspector Engine tab docks `#engine-window` (`dockEngine`); closed → Explorer tab | `engineWidget.isOpen` |
| fork state | branch with alternatives → `#build-branchbar` chips + `buildBranchChoiceId`; ↑/↓ picks branch | tree structure (`buildNormalizedTree`) |
| empty | `#build-empty` (create/import/open) + tree-empty text | no repertoire loaded |
| generate states | Generate click → Maia weights download then plan → `apply-plan`; coverage scan idle→running→results | `#build-generate-node` (gated by `applyServerEngineGating`) |

### 3.3 Train (`train`)

| State | Path / trigger | Source |
|---|---|---|
| setup | sidebar `data-session-state="setup"`: mode seg, repertoire picker, blitz row, Start | no session |
| active | `data-session-state="active"`: `#train-progress-panel` (card dots, accuracy, queue bar, up-next), banner `data-state` idle\|move\|correct\|wrong\|teach\|reveal\|runin\|done` | `training` / `smart` session |
| summary | `data-session-state="summary"`: `#train-summary` (stats, delta, New session) | session finished |
| smart | `trainMode="smart"`; POST `/api/train/smart/start` → prompt cards; `submitSmartMove` → sync attempts | `smart` appState |
| play / all_lines | play → `#train-play-setup` (book source, repertoire multi-select, colour, Feeling Lucky); all_lines → `/api/train/start` line prompts | `play` appState / `trainMode` |
| blitz | `#train-blitz-toggle` + `#train-blitz` progress bar, 10s timer; locked while smart session runs | `blitzEnabled` |
| resume (sub-state) | `train-resume.js` `mapTrainUiSession` restores an interrupted session | storage |

### 3.4 Games (`replay:games`)

| State | Path / trigger | Source |
|---|---|---|
| no source | source composer tray (`#games-source-chips` + Add); Compare button disabled until selection | `gamesSourceSelection()` |
| populated | `renderReplayResults` → summary chips (`#replay-summary`) + ledger rows in `#replay-results` | POST `/api/lichess/compare` response |
| departure selected | row `is-open` (`replayOpen` Set, one at a time) → focus card: focus board + expected/played arrows + reason list + actions (Train / Add reply / Analyze / lichess ↗) | per-game fields `departure_*`, `expected_*` |
| focus board | `replayFocusBoardHtml` mini board at `departure_ply-1` FEN derived client-side; illegal expected move drops the arrow | `move_san_history[]` + UCIs |
| filtered | summary-chip kind filter (`replayFilter`) → "No games in this bucket" when empty | `replayGameKind` |
| no games / error | "No recent games found" / setStatus error | response / rejection |
| new-game watcher (sub-state) | `showNewGameWidget` toast on `checkLatestLichessGame`; `markLichessSeen` | GET `/api/lichess/latest?light=1` |

### 3.5 Scout (`replay:scout`)

| State | Path / trigger | Source |
|---|---|---|
| pre-start | `.scout-empty` visible, `#scout-btn` Start, profile + report hidden | no session |
| streaming | `scoutSession.state==="running"`; `is-streaming` class on stream card; `#scout-live-count` ticks; render throttled (`scheduleRender`) | `runScout` loop |
| completed | `renderScoutReport` into `#scout-results` + colour tabs + game-plan rows + charts; profile `#scout-profile` | stream end |
| error | `scoutErrorHtml` into `#scout-results` (message text from the caught error) | thrown error |
| white/black | `#scout-color` both\|white\|black filter + report colour tabs (roving tabindex) | filter + report data |
| line detail | row click → `openScoutLine` → `#scout-side` panel (one open at a time; Analyze action) | `scoutLineKey` |
| paused | `handleScoutAction`: running→stop, paused→resume; controls update | `scoutSession.state` |
| prep write-back (sub-state) | `scoutAddToPrep`/`scoutWriteLineToRep` → build mutation deps → POST `/api/build/add-moves` | picked repertoire |

### 3.6 Analyze (`analyze`)

| State | Path / trigger | Source |
|---|---|---|
| initial | `#analysis-empty` + coach idle line + demo PGN prefill; board at start | no analysis |
| evaluating | `runAnalysis` phases (jobToast load/stockfish/maia/classifying/saving/rendering); run button disabled; `#analysis-results` hidden | browser engine job |
| result | `revealAnalysisResults`: `svg#eval-chart`, classification bars, move tree, handoff → "Create repertoire from game" | `analysis` payload |
| engine unavailable | `isBrowserEngineAvailable()` false → `#run-analysis` gated (title `BROWSER_ENGINE_UNAVAILABLE`) + `#analyze-engine-banner` | crossOriginIsolated |
| history | `#history-drawer` → `loadAnalysisHistory` → recall → same result view | GET `/api/analyses` |
| variation sub-state | board moves create client-side branches (`analysisVarNodes`), reset via `resetAnalysisVariations` | local |

### 3.7 Teams (`teams`)

| State | Path / trigger | Source |
|---|---|---|
| owner | detail card: Invite/Rename/Delete/Add member all visible; delete owner-only | `detail.role` |
| admin | Invite/Rename/Add member + inline role selects; no Delete | `canManage = owner\|admin` |
| member | read-only badges + Leave on own row; Share-a-repertoire button still visible (any member may share own) | `detail.role` |
| incoming shared repertoire | `#teams-shared` rows: read-only badge + Copy (→ fork); click opens read-only Build | GET `/api/repertoires` `shared[]` |
| invite state | `#team-invite-foot` "Invite link active · expires …" when `invite.exists`; Invite button mints/rotates link → modal (Copy/Revoke/Done); `?join=code` → preview → confirm → idempotent join | `detail.invite`, `maybeHandleJoinLink` |
| empty / signed-out | "Sign in to create and join teams." / "No teams yet." / search-no-match | `appState.teams` |

### 3.8 Settings (`settings`)

| State | Path / trigger | Source |
|---|---|---|
| connected | account rows in `#settings-lichess-accounts` with `⋯` menu (Set primary / Unlink) | GET `/api/lichess` `accounts[]` |
| disconnected | "No Lichess account linked." + Link button; auto-rating label shows fallback text | `accounts[]` empty |
| auto Maia rating | `#settings-maia-auto` switch on → slider disabled; label "Auto — match my Lichess rating (~N)" / fallback variant | `maiaRatingPinned === null` |
| manual Maia rating | switch off → slider active → change POSTs `{maia_rating: N}` | `maiaRatingPinned` |
| engine status | `#settings-browser-engine-status` available/unavailable from `crossOriginIsolated`; Stockfish version from manifest; banner gating applied via `applyServerEngineGating` | runtime + manifest |
| Maia3 health | `#settings-maia-model` pill: Ready / Available on demand / Loading / Cache missing / Unavailable / Error (peek-only render); Retry runs inference; Reset cache confirms → clears IDB → reload | provider state + manifest + IDB |
| appearance | theme seg (system/light/dark) synced with hidden native select | `pref("theme")` |

---

## 4. Runtime DOM writers

Functions whose `innerHTML` / `createElement`+`appendChild` / `insertAdjacentHTML`
output changes page composition. (`replaceChildren` and `.prepend()` are not used
anywhere in non-test `web-src`.) Format: writer — target — trigger/state.

### 4.1 Shared layers (app.js)

| Writer | Target | Trigger / emitted structure |
|---|---|---|
| `Toast` (603/627; append 591) | `#toast-stack` | any `setStatus`/toast; toast card HTML |
| `EngineWidget` pvs render (1264/1273/1336/1347) | `#engine-window-pvs` | engine lines arriving; empty/error/calculating states |
| coach slots (2121/2184/2212) | `#coach-bookline`/`#coach-maia`/prose slots | PositionCoach updates |
| `BoardController.render` (2315-2341 squares via createElement/appendChild; 2336/2339 coord spans; 2728/2784 piece SVG insertAdjacentHTML; 2490-2495 drag ghost) | `#analysis-board` / `#build-board` / `#train-board` | every board state change |
| `paintEngineBanners` (3033) | `#analyze-engine-banner`, `#build-engine-banner` | engine availability / settings gating |
| command palette (3055) | `#command-palette` item list | Ctrl+K / palette open, on each keystroke |
| piece picker / prefs grid (3498/3515) | `#piece-style-picker`, `#board-prefs` | Settings Board card render |
| promotion picker (3606-3633) | overlay near board or body | pawn promotion reached (shared by all boards) |
| arrow overlay path (3726/3735) | `svg.*-annotations` | `renderAnnotations` on annotation change |
| Lichess account chooser (4207-4229) | body overlay | action needing one account among several |
| `loadAnalysisHistory` (4311-4323) | `#analysis-history` | history drawer open; loading/empty/list states |
| `openTeamDetail` members (4433/4438/4482) | `#team-members` | team row click; loading/error/rows with role tails |
| `showInviteModal` (4752-4771) | body overlay | after invite mint |
| `loadSharedRepertoires` (4884/4887/4929) | `#teams-shared` | Teams load; empty/rows/error |
| `showInputModal` (5020-5078), `showConfirmModal` (5127-5142) | body overlays | shared modal primitives |
| coverage hint/results (5240, 11046/11067) | `#coverage-gaps` | idle hint, scan done, read-only reset |
| repertoire context menu (5291) | `#repertoire-context-menu` | row menu open |
| analysis tree empty (5924) | `#analysis-moves` tree host | analysis cleared |
| build menu (6385) | `#build-menu` popover | header menu open |
| explorer popover (6619-6625) + rows (6644-6696) | `#explorer-rows` (+info popover) | inspector Explorer tab; loading/rate-limit/empty/error/rows |
| node context menu (7971) | `#node-context-menu` | tree node menu open |
| train repertoire `<select>` (8160) | `#train-repertoire-select` | repertoire list load |
| `renderPlayRepertoirePicker` (8242) | `#train-play-repertoire-menu` | play mode setup |
| `renderPlayTrail` (8608) | `#train-play-trail` | play move history |
| confetti layer (9441-9453) | session board host | celebrate moment (appendChild spans) |
| hint badge (9502/9510) | `#train-hint` badge | hint reveal/clear |
| card dots clear (9558/10112) | `#train-card-dots` | session reset/finish |
| games source tray (10593/10606/10699) | `#games-source-chips` | source selection change |
| engine dock slot (6525) | `#build-inspector` engine slot | `dockEngine`/`undockEngine` |
| download anchor (2917-2920) | transient body link | export download (not composition) |

### 4.2 Per-view modules

| File (sites) | Writers — target |
|---|---|
| `views/dashboard.js` (13) | preview pane 135-176 (`#lib-preview-board/mix/legend`, mini board + empty), steps 275/278 (`#dashboard-steps`), today 358 (`#dashboard-today`), rows 392/442 (`#dashboard-repertoires`), empty 565/582, error 658 |
| `views/scout.js` (18) | side clear 191 (`#scout-side`), engine progress 253/271, profile 414 (`#scout-profile`), report 485/1696 (`#scout-results`), v13 panel 566, dist drilldown 1626/1639, errors 1928/2026/2144 (`scoutErrorHtml`), reset clears 2069/2073/2113/2130 |
| `views/train.js` (12) | stats 24/48/50 (`#train-stat-*`, `#train-line-trail`), queue 90/98 (`#train-queue-bar/legend`), up-next 117/127/131 (`#train-upnext`), dots 170, summary 195/205/228 (`#train-summary-stats/delta`) |
| `views/teams.js` (10) | list 70/71/75/87/102/107 (`#teams-list`, `#teams-shared` clear), shared reps 142/146 (`#team-shared-repertoires`), invite footer 205/213 (`#team-invite-foot`) |
| `views/build.js` (7) | rep header 58 (`#build-rep-name`), branch bar 97/131 (`#build-branchbar`), tree meta 173 (`#build-tree-meta`), tree 189/199/231 (`#builder-tree`) |
| `views/analyze.js` (7) | class bars 109/149 (`#analysis-summary`), tree 243/250 (`#analysis-moves`), tooltip 322/381, chart reset 483 + SVG createElement/appendChild graph nodes 515-633 (`svg#eval-chart`) |
| `views/replay.js` (4) | summary 167 (`#replay-summary`), results 297/306/312 (`#replay-results`) |
| `scout-report.js` (5) | line detail 185/222 (`#scout-side`), score cell 788, WDL bar 795, badge insertAdjacentHTML 803 (patches into existing rows) |
| `views/settings.js` (2) | connections 166/169 (`#settings-lichess-accounts`); other rows use `textContent`/classList only |
| `views/shared/source-composer.js` (2) | composer overlay 263/300 + append 336 (shared Games/Scout source picker) |
| `controllers/account.js` (3) | auth modal 101/111 + append 137, account menu 228 (`#account-menu`) |
| `engine/coach-review-harness.js` (4) | review harness cards 323/329/374/441 (dev/review harness page, not the SPA shell) |

Note on escaping: writers interpolate via `escapeHtml` for server/user strings in
the paths documented in §2; this entry records where template strings are emitted,
not an assessment of each site.

---

## 5. CSS ownership

- **Eager**: `web-src/styles.css` (6,084 lines), imported `app.js:1`. Contains:
  design tokens `:root` custom properties (8-95), dark theme override (108+),
  shell/rail/topbar/tabbar, Library composition (1288+), study layout for
  Repertoire/Train (1805+, 1881+), Scout panel skeleton + toolbar + empty/stream
  states (744+), Games toolbar (744-758), modals/toasts/menus, plus media queries
  at 1279/1020/760/640 and a `prefers-reduced-motion` block.
- **Lazy stylesheets** (CSS imports inside lazy JS chunks only — no runtime
  `<link>` injection exists in the codebase):

| Sheet | Lines | Imported by | Owns (per sheet header comments + §2) |
|---|---|---|---|
| `views/analyze-chart.css` | 483 | `views/analyze.js:4` | analyze panel body, eval chart, eval bar; eager sheet keeps study grid + `.panel`; media 760 + reduced-motion |
| `views/replay.css` | 140 | `views/replay.js:4` | triage ledger + focus card; toolbar stays eager; media 1279/1020/760 |
| `views/scout.css` | 436 | `views/scout.js:4` | the report itself; panel/grid/toolbar/empty+stream states stay eager; media 1279/760 |
| `views/settings.css` | 202 | `views/settings.js:3` | settings nav/content cards; mobile nav becomes chip row |
| `views/teams.css` | 224 | `views/teams.js:6` | teams grid + detail card |

- **Breakpoint ownership**: global breakpoints live in eager `styles.css` (1279,
  1020, 760, 640); lazy sheets carry their own page-scoped media blocks listed
  above. Viewport states covered by smokes: 1440x900, 1180x900, 390x844
  (`scripts/smoke/ui-v2/run-all.mjs`).
- **Design tokens**: single `:root` set in `styles.css` 8-95 (colors, spacing,
  radii, type), dark overrides from 108; lazy sheets consume the tokens; theme
  switch (`theme.js`, `pref("theme")`) toggles `system|light|dark`.

---

## 6. Coverage map

Legend: **U** = Vitest unit (`web-src/**/*.test.js`), **S** = smoke
(`scripts/smoke/ui-v2/*`), **E** = e2e (`tests/e2e/*`), **V** = visual. Rows
follow the §3 state list. "—" = no test asserting that state was found in the
sources scanned for this library.

**Visual note**: no automated screenshot/visual assertions exist in Vitest or the
ui-v2 smokes. Full-page screenshot capture exists only in manual Playwright
scripts — `scripts/desktop-workspace-capture.mjs` (incl. `games-selected.png`),
`scripts/verify-scout-dense-real.mjs` (dense real-data scout),
`scripts/verify-workbench-layout.mjs` (`{view}-{state}-{width}.png`).

### Library
| State | U | S | E | V |
|---|---|---|---|---|
| empty | `dashboard-recommendations.test.js` (empty/next-steps/CTA) | — | — | — |
| own repertoires | `library-filters.test.js` | `library-viewport-smoke.mjs` (3 rows, Train button) | — | — |
| shared | `library-filters.test.js` (shared filter predicate) | — | — | — |
| filtered | `library-filters.test.js` (predicate + wiring) | — | — | — |
| preview / Today / steps | `dashboard-recommendations.test.js` | smoke (Today strip streak+due, steps card) | — | — |
| error | — | — | — | — |

### Repertoire
| State | U | S | E | V |
|---|---|---|---|---|
| writable | `build-branchbar.test.js`, `movetree.test.js` | `build-viewport-smoke.mjs` (header, sync chip Saved, breadcrumbs, legend) | — | — |
| shared / read-only | — | smoke shared read-only pass (lines 232-281) | — | — |
| engine on/off | `engine-loading-lifecycle.test.js` (Generate triggers Maia download) | — (Generate visible only) | — | — |
| fork state | `build-branchbar.test.js` | smoke (fork bar 2 chips, ArrowDown pick) | — | — |
| empty | — | — | — | — |
| generate / coverage | `engine-loading-lifecycle.test.js` | smoke (tab swap) | — | — |

### Train
| State | U | S | E | V |
|---|---|---|---|---|
| setup | — | `train-viewport-smoke.mjs` (mode tabs, blitz row, 2 rep options, play setup reveal) | — | — |
| active (smart) | `train-upnext.test.js` | smoke (Card 1/4, queue legend, up-next 3 rows) | `test_train_keyboard_smoke.py` | — |
| summary | `train-upnext.test.js` (`renderSmartSummary`) | — | — | — |
| smart sync | `train-sync.test.js` (groupAttempts/flushGroups retry) | — | — | — |
| play / all_lines | `train-play.test.js`, `train-opponent.test.js`, `train-lucky*.test.js`, `feeling-lucky.test.js` | smoke (play setup reveal only) | — | — |
| blitz | — | smoke (blitz row present) | — | — |
| resume | `train-resume.test.js` (`mapTrainUiSession`) | — | — | — |

### Games
| State | U | S | E | V |
|---|---|---|---|---|
| no source | — | smoke (Compare enabled-with-source, source chips) | — | — |
| populated | — | smoke (summary counts, "+1 queued", 3 rows) | — | — |
| departure selected | `replay-focus.test.js` | smoke (rows open, legend) | — | manual (`games-selected.png`) |
| focus board | `replay-focus.test.js` (FEN derive, illegal-arrow drop) | smoke (64 squares, expected/played arrows) | — | — |
| filtered | — | smoke (filter leaves 1 row) | — | — |
| no games / error / watcher | — | — | — | — |
| source composer | `ui-layout.test.js:305`, `source-composer*.test.js` | smoke (chips + Add) | — | — |

### Scout
| State | U | S | E | V |
|---|---|---|---|---|
| pre-start | `scout-init.test.js` | `scout-viewport-smoke.mjs` (pre-start panel, source chip) | — | — |
| streaming | `scout-stream-scale.test.js` | smoke (live count) | — | — |
| completed | `scout-report.test.js` | smoke (rows, profile, charts) | `test_scout_smoke.py` | manual (`verify-scout-dense-real.mjs`) |
| error | — | — | — | — |
| white/black tabs | `scout-colortabs.test.js` | smoke (2 tabs with counts, swap) | — | — |
| line detail | `scout-refutation-render.test.js` | smoke (side detail + Analyze action) | `test_scout_smoke.py::test_scout_refutation_smoke` | — |
| enrichment pipeline | `scout-explorer-enrich.test.js`, `scout-maia-*.test.js`, `scout-engine-scan.test.js` | — | — | — |
| paused / stop-resume | — | — | — | — |

### Analyze
| State | U | S | E | V |
|---|---|---|---|---|
| initial | — | `analyze-viewport-smoke.mjs` (64 squares, coach idle line) | — | — |
| evaluating → result | `analyze-chart.test.js`, `analyze-pgn.test.js`, `explain.test.js`, coach tests | smoke (run → "Analysis ready", chart, 2 class-bar rows, variation) | `test_eval_chart_smoke.py` | — |
| engine unavailable | `engine-loading-lifecycle.test.js` (engine startup ordering) | — | — | — |
| eval bar | `analyze-evalbar.test.js` | smoke (hide at ply 0 / show on scored ply) | — | — |
| history recall | — | — | — | — |

### Teams
| State | U | S | E | V |
|---|---|---|---|---|
| owner | `teams-tabs.test.js` (tab panes) | `teams-viewport-smoke.mjs` (Owner badge, Delete/Invite/Add member visible) | — | — |
| admin | — | — | — | — |
| member | — | smoke ("members can share their own repertoire" button visible) | — | — |
| incoming shared repertoire | — | smoke (incoming row + read-only badge, team name) | — | — |
| invite state | — | smoke (invite footer text, tab counts) | — | — |
| shared tab / Copy | — | smoke (shared rep row, Copy button) | — | — |
| empty / signed-out / search | — | — | — | — |
| join-link (`?join=`) | — | — | — | — |

### Settings
| State | U | S | E | V |
|---|---|---|---|---|
| connected | `settings-connections.test.js` | `settings-viewport-smoke.mjs` (real account row) | — | — |
| disconnected | `settings-connections.test.js` | — | — | — |
| auto/manual Maia rating | — | — | — | — |
| engine status | — | smoke (status "available", manifest version, crossOriginIsolated) | — | — |
| Maia3 health | `settings-maia-health.test.js` (MAIA_STATUS vocabulary) | smoke (pill renders ≠ "checking…") | — | — |
| theme/appearance | — | smoke (seg active state + real theme flip) | — | — |
| section nav | — | smoke (labels, active marker, scroll target visibility) | — | — |
| switches a11y | `ui-layout.test.js` (switch primitive) | smoke (aria-checked ↔ is-on sync) | — | — |

### Cross-cutting
| Concern | Coverage |
|---|---|
| a11y baseline | E: `tests/e2e/test_axe_baseline.py` |
| shell layout / skip link / targets | U: `ui-layout.test.js` |
| deep links `#/games`, `#/scout`, `?rep=` | U: `workspace-url.test.js` |
| promotion picker (all boards) | U: `promotion.test.js` |
| CSRF transport | (recorded in §1.8; test lives in backend suite) |
| horizontal-overflow + console-error gates | S: every ui-v2 smoke at 1440x900 / 1180x900 / 390x844 |

---

*End of frontend library. Machine-readable records: `frontend-library.json`.*
