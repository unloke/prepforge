import { html } from "./html.js";
import { bindPgnInput } from "./analyze-pgn-open.js";
import "./core/client-log.js";
import { createSyncController } from "./controllers/sync.js";
import "./styles/fonts.css";
import "./styles.css";
import { promptRenameRepertoire } from "./repertoire-rename.js";
import { paintBuildSkeleton } from "./views/build-skeleton.js";
import "./phone.css";
import "./touch.css";
import "./phone-kit.css";
import { resetViewScroll } from "./view-scroll.js";
import { bindHoldToEnd, bindSheet } from "./phone/sheet.js";
import { swapView } from "./view-swap.js";
import { prefetchViews } from "./view-prefetch.js";
import { paintPhoneTabs } from "./phone-tabs.js";
import { maybeWelcome } from "./welcome-entry.js";
import { oauthErrorFromUrl } from "./oauth-errors.js";
import { countOf } from "./plural.js";
import { createBook, ensureBookLoaded, updateBookline } from "./analyze-book-state.js";
import { announceRepertoireChanged } from "./repertoire-changes.js";
import { createCoverage, runCoverageScanUI } from "./coverage-entry.js";
import { createLibrary } from "./library-entry.js";
import { installE2eHooks } from "./e2e-hooks.js";
import { bindPhoneChrome, clearMaiaIdleTeardown, scheduleMaiaIdleTeardown } from "./phone-entry.js";
import { installMoveLinks } from "./move-links.js";
import { createSharedViewer, forkReadableRepertoire, renderReadOnlyBanner } from "./shared-viewer.js";
import { buildRole } from "./share-roles.js";
import { preloadTrainView } from "./train-entry.js";
import { setTrainBanner } from "./train-banner.js";
import { cancelLuckyDiscovery } from "./train-lucky-control.js";
import { showUndoToast } from "./undo.js";
import { analysisGameName } from "./analyze-name.js";
import { setBoardCaption } from "./board-caption.js";
import { readCsrfCookie, CSRF_HEADER } from "./csrf.js";
import { localBoardInfo } from "./chess-local.js";
import { getBuildTree, summarizeBuild } from "./build-tree.js";
import { bindUnlocks } from "./engine-unlock.js";
import { bindRailCollapseOnNavigate } from "./rail-nav.js";
import { createBoardController } from "./board/board-controller.js";
import { hideAnalysisRetrySave, refreshAnalyzeRecovery } from "./analyze-recovery.js";
import { loadReturnState, setHandoffOwner } from "./handoff-context.js";
import { activateWorkspaceTab, parseWorkspaceLocation, serializeWorkspaceLocation, trainQueueRepertoireId, workspaceLocationFromState } from "./workspace-url.js";
import { createAnalyzeRestore } from "./controllers/analyze-restore.js";
import { bindCommandPalette, closePalette, createPalette, dismissTransientOverlays, openPalette, paletteIsOpen } from "./palette.js";
import { BUILD_DOCK_TABS, buildDockFolded, buildDockTab, buildProvisionalNode,
  isBuildReadOnly, explorerDrawerOpen, explorerEvalEngine, undoLastBuildAdd, queueBuildAdd,
  reloadOpenBuildTree, renderBuilderTree, renderBuildSync, resolveBuildId, setBuildInspector, setBuildSync,
  setBuildView, setExplorerDb, startBuildLive, buildView } from "./build-entry.js";
import { isPendingActionId, restoredAuthHref, stripSignedInParam, takeAuthReturn, takePendingAction } from "./auth-gate.js";
import { normalizeSelection } from "./views/shared/source-composer.js";
import { paintDashboardSkeleton } from "./views/library-skeleton.js";
import { clearTeamDetail, loadTeamsWithShell } from "./views/teams-loading.js";
import { acceptRepertoireListing, finishRepertoireDelete, refreshRepertoireListing } from "./repertoire-listing.js";
import { retryTrainEntry, trainRouteMatches } from "./train-route-failure.js";

import { START_FEN, files, appState, analysisState, buildState, replayState, teamsState, trainState, boards, notices } from "./core/state.js";
import { provideApp } from "./core/app-context.js";
import { activeBoardController, activeViewName, api, currentOwnerId, postJson, setStatus, setStatusError } from "./core/api.js";
import { applyPref, loadPrefs, pref, syncThemeToggle, toggleTheme } from "./core/prefs.js";
import { applyTheme } from "./theme.js";
import { settleEntrances } from "./list-enter.js";
import { showConfirmModal, showInputModal } from "./core/modals.js";
import { isPopoverOpen } from "./core/dialog.js";
import { openOverflowMenu } from "./core/overflow-menu.js";
import { hooks } from "./core/hooks.js";
import { PIECE_SETS, PIECE_STYLE_KEY, boardInfo, isPromotionMove, legalMoveFor, legalTargetsFrom,
  parseFenBoard, pieceLabel, pieceSvg, renderAnnotations, renderPieceStylePicker, renderPrefsToggles,
  resolveBoardMove } from "./board/ui.js";
import { installSoundUnlock, moveCue, playSound } from "./core/sound.js";
import { engineWidget, setEngineOn, syncEngineForView, engineWantedIn, applyServerEngineGating,
  paintEngineBanners, setEngineWidgetImport } from "./core/engine.js";
import { preloadCoach } from "./coach/coach-loader.js";
import { createAccountEntry } from "./account-entry.js";
import { bindEvalChart, createAnalyzeView, ensureAnalyzeView, ensureMoveTreeRenderer, preloadAnalyzeView,
  renderAnalysisTree, analyzeView } from "./views/analyze-loader.js";
import { createAnalyzeEntry, analysisRecallSeq } from "./controllers/analyze-entry.js";

// A controller chunk loaded on first use. `via(name)` calls straight through once it
// has loaded and waits for it before that; a failed load is retried on the next call.
function lazyModule(load) {
  const lazy = { current: null, loading: null };
  lazy.load = () => (lazy.loading ||= load().then((mod) => (lazy.current = mod)).catch((error) => {
    lazy.loading = null;
    throw error;
  }));
  lazy.via = (name) => (...args) => (lazy.current
    ? lazy.current[name](...args)
    : lazy.load().then((loaded) => loaded[name](...args)));
  return lazy;
}

// Teams: loaded with the Teams view, but the shell needs its entry points
// early (the rail, a ?join= link, a resumed sign-in action).
const teamsLazy = lazyModule(() => import("./views/teams-controller.js").then((mod) => mod.createTeamsController({
  switchView, editRepertoire, refreshDashboardRepertoires, requireSignIn,
})));
const viaTeams = teamsLazy.via;
const loadTeams = () => loadTeamsWithShell(viaTeams("loadTeams"));
const hideTeamDetail = () => clearTeamDetail(teamsLazy.current?.renderTeamsList);
const createTeam = viaTeams("createTeam");

// The Library entry: its chunk, the listing load and PGN import. Bound in init,
// owned by library-entry.js.
let libraryEntry = null;
const viaLibrary = (name) => (...args) => libraryEntry[name](...args);
const refreshDashboardRepertoires = viaLibrary("refreshDashboardRepertoires");
const ensureDashboardView = viaLibrary("ensureDashboardView");
const loadDashboard = viaLibrary("loadDashboard");
const defaultRepertoireNameFromPgn = viaLibrary("defaultRepertoireNameFromPgn");
const importRepertoireFromPgnText = viaLibrary("importRepertoireFromPgnText");

// Coverage (Build inspector) and the shared-repertoire viewer: bound in init,
// owned by coverage-entry.js and shared-viewer.js.
let coverageEntry = null;
let sharedViewer = null;

// Sign-in + the Lichess identity (account-entry.js) and the Analyze entry
// points (controllers/analyze-entry.js). Both are imported at boot: the account
// chip, the auth gate, every owner-scoped action and the PGN drawer use them
// before any lazy chunk is fetched.
let accountEntry = null;
function accountService() {
  if (!accountEntry) throw new Error("Account controller is not initialized");
  return accountEntry.accountService();
}
const viaAccount = (name) => (...args) => accountEntry[name](...args);
const getStoredLichessUsername = viaAccount("getStoredLichessUsername");
const setLichessUsername = viaAccount("setLichessUsername");
const refreshAuthProviders = viaAccount("refreshAuthProviders");
const requireSignIn = viaAccount("requireSignIn");
const openAuthModal = viaAccount("openAuthModal");
const onAccountChipClick = viaAccount("onAccountChipClick");
const isAccountMenuOpen = viaAccount("isAccountMenuOpen");
const refreshAuthStatus = viaAccount("refreshAuthStatus");
const syncReplayControls = viaAccount("syncReplayControls");
const refreshLichessStatus = viaAccount("refreshLichessStatus");
const startLichessOAuth = viaAccount("startLichessOAuth");
const noteLichessActivity = viaAccount("noteLichessActivity");
const lichessAccounts = viaAccount("lichessAccounts");
const orientAnalysisForSelf = viaAccount("orientAnalysisForSelf");
const analysisSelfSide = viaAccount("analysisSelfSide");
const orientAnalysisFromPgn = viaAccount("orientAnalysisFromPgn");

let analyzeEntry = null;
const viaAnalyzeEntry = (name) => (...args) => analyzeEntry[name](...args);
const fetchMyLichessGame = viaAnalyzeEntry("fetchMyLichessGame");
const loadAnalysisHistory = viaAnalyzeEntry("loadAnalysisHistory");
const invalidateAnalysisSource = viaAnalyzeEntry("invalidateAnalysisSource");
const openAnalyzeGame = viaAnalyzeEntry("openAnalyzeGame");

// Settings: the view chunk, its readiness gate and the /api/settings actions.
const settingsLazy = lazyModule(() => import("./views/settings-controller.js").then((mod) => mod.createSettingsController({
  switchView, accountEntry, refreshLichessStatus, startLichessOAuth,
  get analyzeSession() { return analyzeLazy.current; },
  explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel,
})));
const viaSettings = settingsLazy.via;
const preloadSettingsView = viaSettings("preloadSettingsView");
const loadSettings = viaSettings("loadSettings");
const whenSettingsReady = viaSettings("whenSettingsReady");
const openSettingsSection = viaSettings("openSettingsSection");

// Scout: the report, its source tray and the Start guard. Loaded on first use;
// the shell paints the tray and wires Start at boot, so those wait for it.
const scoutLazy = lazyModule(() => import("./views/scout-controller.js").then((mod) => mod.createScoutController({
  requireSignIn, switchView, editRepertoire, createRepertoirePrompt, buildProvisionalNode,
  hardFlushBuild, selectBuildNode, resolveBuildId, setBuildSync, queueBuildAdd, loadPgnIntoAnalyze,
  startLichessOAuth, lichessAccounts,
})));
const viaScout = scoutLazy.via;
const scoutSelection = viaScout("scoutSelection");
const paintScoutSource = viaScout("paintScoutSource");
const bindScoutSource = viaScout("bindScoutSource");
const preloadScoutUi = viaScout("preloadScoutUi");
const ensureScoutView = viaScout("ensureScoutView");

// Games: the comparison, its source tray and the ledger's row actions. Loaded
// on first use; the shell needs the entry points at boot (the tray paint, the
// Check button), so every one of them waits for the chunk.
const gamesLazy = lazyModule(() => import("./views/games-controller.js").then((mod) => mod.createGamesController({
  requireSignIn, switchView, editRepertoire, isBuildReadOnly, onBuildBoardMove, trainRepertoire,
  orientAnalysisForSelf, loadPgnIntoAnalyze, showAnalysisPly, openSettingsSection, lichessAccounts,
})));
const viaGames = gamesLazy.via;
const runLichessCompare = viaGames("runLichessCompare");
const gamesSourceSelection = viaGames("gamesSourceSelection");
const paintGamesSource = viaGames("paintGamesSource");
const bindGamesSource = viaGames("bindGamesSource");
const preloadReplayView = viaGames("ensureReplayView");


let _buildGenReady = null;
function preloadBuildGen() {
  if (!_buildGenReady) {
    _buildGenReady = import("./engine/build-generate-runner.js").catch((err) => {
      _buildGenReady = null;
      throw err;
    });
  }
  return _buildGenReady;
}


const BoardController = createBoardController({
  pref, renderAnnotations, files, isPromotionMove, resolveBoardMove, legalMoveFor,
  pieceSvg, parseFenBoard, playSound, moveCue, pieceLabel, legalTargetsFrom,
});


// The engine widget loads on first open (core/engine.js keeps the facade).
setEngineWidgetImport(() => import("./controllers/engine-widget.js"));

// The repertoire editor lives in controllers/build-session.js, loaded with the Build view.
// Its wrappers resolve the lazy module on call, so they can exist before it loads
// (the sync controller below takes some of them).
const buildLazy = lazyModule(() => import("./controllers/build-session.js").then((mod) => mod.createBuildSession({
  captureBuildContext, closeRepertoireContextMenu, ensureBuildView, handleRepertoireContextAction, preloadBuildGen,
  renderBuildRepHeader,
})));
const loadBuildSession = buildLazy.load;
const viaBuildSession = buildLazy.via;
const buildBranchContext = viaBuildSession("buildBranchContext");
const buildBranchKey = viaBuildSession("buildBranchKey");
const buildGoBack = viaBuildSession("buildGoBack");
const buildGoForward = viaBuildSession("buildGoForward");
const buildGoRoot = viaBuildSession("buildGoRoot");
const buildGoToEnd = viaBuildSession("buildGoToEnd");
const createRepertoirePrompt = viaBuildSession("createRepertoirePrompt");
const hydrateBuild = viaBuildSession("hydrateBuild");
const onBuildBoardMove = viaBuildSession("onBuildBoardMove");
const openDockOptions = viaBuildSession("openDockOptions");
const openBuildMenu = viaBuildSession("openBuildMenu");
const openNodeContextMenu = viaBuildSession("openNodeContextMenu");
const paintExplorerEvals = viaBuildSession("paintExplorerEvals");
const paintInspectorScope = viaBuildSession("paintInspectorScope");
const refreshExplorerPanel = viaBuildSession("refreshExplorerPanel");
const saveBuildAnnotations = viaBuildSession("saveBuildAnnotations");
const scheduleExplorerRefresh = viaBuildSession("scheduleExplorerRefresh");
const selectBuildNode = viaBuildSession("selectBuildNode");
const setBuildDockFolded = viaBuildSession("setBuildDockFolded");

const syncController = createSyncController({ captureBuildContext, hydrateBuild });
const {
  scheduleBuildFlush, settleBuildOutbox, hardFlushBuild, beaconFlushBuild, discardBuildOps, queueTrainAttempt,
  markTrainPositionDirty, beaconFlushTrain, flushTrainSync,
  persistOutbox, restoreOutbox, flushAllPendingForSignOut,
} = syncController;


let workspaceUrlReady = false;
let workspaceNavigationSeq = 0;
let deferTrainEntry = false; function invalidateTrainEntries() { trainState.trainEntryVersion = (trainState.trainEntryVersion || 0) + 1; }
// Set when the user picks a page while boot is still awaiting auth / the
// workspace: restoreWorkspaceLocation must not then snap them back to the URL
// the page loaded with (a Scout click during boot landed on the dashboard).
let navigatedDuringBoot = false;


function syncWorkspaceUrl({ push = false } = {}) {
  if (!workspaceUrlReady || typeof window === "undefined") return;
  // The location reads the shell's view and the train, replay, build and analysis slices.
  const { training, smart, trainResult, trainPendingRoute, trainingRepertoireId } = trainState, { buildLoading, buildLoadTarget, build } = buildState, loc = workspaceLocationFromState({ currentView: appState.currentView, training, smart, trainResult, trainPendingRoute, trainingRepertoireId, replaySection: replayState.replaySection, buildLoading, buildLoadTarget, build, analysisPly: analysisState.analysisPly, analysisNodePath: analysisState.analysisNodePath });
  const href = serializeWorkspaceLocation(loc, window.location.href);
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === href) return;
  if (push) history.pushState(loc, "", href);
  else history.replaceState(loc, "", href);
}


// The URL owns the route on every reload: restoreWorkspaceLocation reads it and
// switches to it, so the static markup's view-dashboard default is only ever a
// first paint — never a route the user is sent to. What a deep link DOES need is
// for that default to be invisible, so hold the boot shell until the real view is
// painted. The hold ships hidden in index.html (nothing flashes before JS runs)
// and is shown at the top of init().
let bootHold = null;
let bootHeld = false;

function holdBootView() {
  bootHold = document.getElementById("boot-hold");
  if (bootHold) bootHold.hidden = false;
  bootHeld = !!bootHold;
  // A server that was asleep takes a while to answer: past a few seconds the
  // hold says so, instead of a spinner that reads as stuck.
  if (bootHeld) globalThis.setTimeout(() => {
    const text = bootHeld && bootHold?.querySelector?.("p");
    if (text) text.textContent = "Waking the server. This can take up to a minute.";
  }, 6000);
}

function releaseBootView() {
  if (!bootHeld) return;
  bootHeld = false;
  if (bootHold) bootHold.remove();
  bootHold = null;
}

async function restoreWorkspaceLocation() {
  if (navigatedDuringBoot) {
    // The user already moved on: stay there, re-entering the page so it loads
    // with the now-known session (it may have painted signed-out mid-boot),
    // and record it in the URL.
    switchView(appState.currentView);
    syncWorkspaceUrl();
    return;
  }
  const loc = parseWorkspaceLocation(window.location.href);
  const seq = workspaceNavigationSeq;
  // F-06 return state: coming back to Games (even after a reload) restores the
  // selected game and the active filter, so the source page is where you left it.
  const replayReturn = loadReturnState("replay");
  if (replayReturn) {
    if (typeof replayReturn.filter === "string" && replayReturn.filter) {
      replayState.replayFilter = replayReturn.filter;
    }
    if (Number.isFinite(replayReturn.openIndex)) {
      replayState.replayOpen = new Set([replayReturn.openIndex]);
    }
  }
  // Only Build's link names the repertoire its editor shows; Train's names the
  // queue's, which startTraining below loads for itself.
  if (loc.view === "build" && loc.repertoireId && appState.signedIn) {
    try {
      const payload = await api(
        `/api/build/load?repertoire_id=${encodeURIComponent(loc.repertoireId)}`,
        { responseType: "large-json" },
      );
      if (seq === workspaceNavigationSeq) {
        await hydrateBuild(payload, payload.selected_node_id);
        if (seq === workspaceNavigationSeq) trainState.trainingRepertoireId = payload.repertoire_id;
      }
    } catch (_) {
      /* stale id — still restore the view */
    }
  }
  if (seq !== workspaceNavigationSeq) {
    syncWorkspaceUrl();
    return;
  }
  if (loc.view === "replay" && loc.replaySection) {
    replayState.replaySection = loc.replaySection;
  }
  deferTrainEntry = loc.view === "train"; switchView(loc.view, { fromUrl: true }); deferTrainEntry = false;
  if (loc.view === "analyze") await restoreAnalyzeSession(loc.ply, loc.node);
  // #/train is Train Home; a link that names a repertoire opens its Due queue,
  // with that scope on the session's chip. A failed chunk leaves a retry instead of an inert skeleton.
  if (loc.view === "train" && (loc.repertoireId || loc.trainMode === "smart")) trainState.trainPendingRoute = { repertoireId: loc.repertoireId || null, trainMode: loc.trainMode || "smart" }; const enterTrain = async (stillActive) => { if (!stillActive()) return; (await loadTrainSession()).syncTrainControls(); if (!stillActive()) return; void loadTrainRepertoireOptions().catch(() => {}); if (appState.signedIn && (loc.repertoireId || loc.trainMode === "smart")) await openTrain({ mode: loc.trainMode || "smart", repertoireId: loc.repertoireId, isCurrent: stillActive }); };
  if (loc.view === "train") await retryTrainEntry(() => appState.currentView === "train" && trainRouteMatches(loc), enterTrain);
}

// The repertoire Build shows, or the one it is loading (A → B → A while B is
// still loading must open A again, not let B land).
function shownOrLoadingRepertoireId() {
  return buildState.buildLoading ? buildState.buildLoadTarget : buildState.build?.repertoire_id;
}

// Recent analyses are the owner's: shown and (when open) loaded only while
// signed in. Runs on entering Analyze and whenever the signed-in owner changes,
// so a sign-in made on the page lists that account's analyses at once.
function syncAnalysisHistoryDrawer({ entering = false } = {}) {
  const drawer = document.getElementById("history-drawer");
  if (!drawer) return;
  drawer.hidden = !appState.signedIn;
  // Opening it the first time on a desktop fires its toggle, which loads the list.
  const ship = entering && appState.signedIn && !drawer.dataset.shipped && !drawer.open && window.matchMedia?.("(min-width: 861px)").matches;
  if (entering && appState.signedIn) drawer.dataset.shipped = "1";
  if (ship) drawer.open = true;
  else if (appState.signedIn && drawer.open && (entering || appState.currentView === "analyze")) loadAnalysisHistory();
}

// In-page route changes (back/forward and location.hash) take the same path as
// boot restore: switch the view, then rebuild Train's queue for the URL's
// repertoire. Without this, ?rep= only took effect on a full reload. Coming
// back to the repertoire the queue already drills keeps the live session.
async function handleWorkspacePopstate() {
  const loc = parseWorkspaceLocation(window.location.href);
  if (loc.view === "replay" && loc.replaySection) {
    replayState.replaySection = loc.replaySection;
  }
  // Back/forward (or an edited hash) naming another repertoire opens it: the
  // editor showing a different tree than its URL survived only until a reload.
  if (loc.view === "build" && loc.repertoireId && appState.signedIn &&
      loc.repertoireId !== shownOrLoadingRepertoireId()) {
    await editRepertoire(loc.repertoireId, null, { fromUrl: true });
    return;
  }
  const trainMode = loc.trainMode || "smart", trainNeedsQueue = loc.view === "train" && appState.signedIn && (loc.repertoireId ? loc.repertoireId !== trainQueueRepertoireId(trainState) || trainMode !== trainState.trainMode : loc.trainMode === "smart" && (!trainState.smart?.mixed || trainState.trainResult)); deferTrainEntry = trainNeedsQueue; switchView(loc.view, { fromUrl: true }); deferTrainEntry = false;
  // An unknown route lands on the Library: the address says so too.
  if (loc.view === "dashboard") syncWorkspaceUrl();
  // Back/forward to an Analyze position puts the board there, the same way boot does.
  // A position off the mainline has no ply, so it is what the URL names; otherwise
  // the ply does. The path is compared against the current position's path, not an
  // internal id, so a history entry is the same fact on both sides.
  if (loc.view === "analyze") {
    const current = selectedNodePath();
    if (loc.node && loc.node !== current) await restoreAnalysisNodePath(loc.node);
    else if (!loc.node && loc.ply && loc.ply !== analysisState.analysisPly) await showAnalysisPly(loc.ply);
  }
  if (loc.view === "train" && !loc.repertoireId && !loc.trainMode) { invalidateTrainEntries(); delete trainState.trainPendingRoute; }
  if (trainNeedsQueue) await retryTrainEntry(() => appState.currentView === "train" && trainRouteMatches(loc), async (stillActive) => { void loadTrainRepertoireOptions().catch(() => {}); const opening = openTrain({ mode: trainMode, repertoireId: loc.repertoireId, isCurrent: stillActive }), entryVersion = trainState.trainEntryVersion; if ((await opening) === false && entryVersion === trainState.trainEntryVersion && stillActive()) syncWorkspaceUrl(); });
}

function setReplaySection(section, { focus = false, syncUrl = true } = {}) {
  const next = section === "scout" ? "scout" : "games";
  // Games ↔ Scout is a page change for the user even though both live in the
  // replay view: an error from one must not follow them to the other.
  if (replayState.replaySection && replayState.replaySection !== next) notices.clearStatusOnNavigate();
  replayState.replaySection = next;
  resetViewScroll();
  document.querySelectorAll("[data-replay-panel]").forEach((panel) => {
    const active = panel.dataset.replayPanel === next;
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
  });
  // The rail's Games/Scout entries are per-section; the phone bar is painted
  // by paintPhoneTabs, which knows Scout lives behind More.
  document.querySelectorAll(".tab[data-replay-section]:not([data-review-tab])").forEach((button) => {
    const active = button.dataset.replaySection === next;
    button.classList.toggle("is-active", active && appState.currentView === "replay");
    button.setAttribute("aria-current", active && appState.currentView === "replay" ? "page" : "false");
  });
  paintPhoneTabs(appState.currentView, next);
  syncPageTitle();
  // Scout is a section of Replay, and its view chunk carries its own stylesheet
  // (views/scout.css). Load it as soon as the section is shown so the pre-Start
  // panel is styled by the same rules as every other state, rather than rendering
  // on the eager sheet alone until the first click pulls the chunk in.
  if (next === "scout") preloadScoutUi().catch(() => {});
  if (focus) {
    document.querySelector(`[data-replay-panel="${next}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // The replay section is part of the deep link (#/games vs #/scout). Sync it
  // on every section change — plain pushState, not a navigation — so refresh
  // and back/forward restore the right panel without a reload loop.
  if (syncUrl && appState.currentView === "replay") syncWorkspaceUrl({ push: true });
}

// Top-bar title follows the primary navigation (prototype IA labels). The
// replay view is titled by its active section (Games vs Scout).
const VIEW_TITLES = {
  dashboard: "Library",
  build: "Repertoire",
  analyze: "Analyze",
  train: "Train",
  replay: "Games",
  teams: "Teams",
  settings: "Settings",
};

// No visible page title (the active nav item names the page): the document
// title carries it for tabs, history and screen readers.
function syncPageTitle() {
  const page = appState.currentView === "replay"
    ? (replayState.replaySection === "scout" ? "Scout" : "Games")
    : VIEW_TITLES[appState.currentView] || "";
  document.title = page ? `${page} · PrepForge Chess` : "PrepForge Chess";
  syncViewHeads();
}

// Analyze: the loaded game's name (PGN headers, else the recalled analysis) in
// the bar under the board, which is the one place on the page that names it.
// Empty while no game is loaded, so nothing stands in the bar.

function syncAnalysisGameName() {
  setBoardCaption(analysisGameName(analysisState, document.getElementById("pgn-input")?.value || ""));
}

// Per-view chrome that lives inside the pages: Analyze's game on the board, the
// Repertoire header's size summary, and (phones) the More sheet's Library mirror
// of Import.
const buildHeadTitles = new WeakMap();
function syncViewHeads() {
  document.querySelectorAll("[data-lib-mirror]").forEach((item) => { item.hidden = appState.currentView !== "dashboard"; });
  if (appState.currentView === "analyze") syncAnalysisGameName();
  const nameEl = document.getElementById("build-rep-name");
  if (!nameEl) return;
  const build = buildState.build;
  if (!build || isBuildReadOnly()) { nameEl.title = ""; return; }
  const tree = getBuildTree(build);
  let title = buildHeadTitles.get(tree);
  if (!title) {
    const { moves, lines, train } = summarizeBuild(build, tree);
    title = `${countOf(lines, "line")} · ${countOf(moves, "move")} · ${train} to train.` +
      ` ${train === 1 ? "It is your move" : "They are your moves"}, which Train drills; opponent replies aren't drilled.`;
    buildHeadTitles.set(tree, title);
  }
  if (nameEl.title !== title) nameEl.title = title;
}

function switchView(name, { fromUrl = false } = {}) {
  workspaceNavigationSeq += 1;
  const previousView = appState.currentView;
  if (!fromUrl && !workspaceUrlReady) navigatedDuringBoot = true;
  if (name !== "train" || name === "train" && !trainState.trainEntering) {
    invalidateTrainEntries();
    delete trainState.trainPendingRoute;
    cancelActiveTrainStart();
  }
  if (appState.currentView === "teams" && name !== "teams") teamsLazy.current?.invalidateRequests();
  if (appState.currentView !== name) notices.clearStatusOnNavigate();
  document.getElementById("app-rail")?.classList.add("is-nav-collapsed");
  if (name !== "analyze") {
    analyzeLazy.current?.positionCoach.cancel();
    analyzeView?.endReview?.();
  }
  appState.currentView = name;
  // Navigating is user activity; if the Lichess watch is running, switching to
  // Analyze (where a fresh game matters most) tightens the poll cadence briefly.
  noteLichessActivity();
  document.querySelectorAll(".tab").forEach((button) => {
    const replayMatch = name === "replay"
      ? button.dataset.replaySection === (replayState.replaySection || "games")
      : !button.dataset.replaySection;
    const active = button.dataset.view === name && replayMatch;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  paintPhoneTabs(name, replayState.replaySection);
  syncPageTitle();
  swapView(document.querySelectorAll(".view"), `view-${name}`, { animate: !bootHeld, onSwap: resetViewScroll });
  if (!fromUrl) syncWorkspaceUrl({ push: true });
  if (name === "replay") setReplaySection(replayState.replaySection, { syncUrl: false });
  if (name === "analyze") {
    preloadCoach().catch(() => {});
    preloadAnalyzeView().catch(() => {});
  }
  if (name === "build") {
    preloadBuildView().catch(() => {});
  }
  if (name === "train") {
    preloadTrainView().catch(() => {});
    if (!deferTrainEntry && !trainState.trainEntering) void retryTrainEntry(() => appState.currentView === "train", async () => { await loadTrainRepertoireOptions(); const loc = parseWorkspaceLocation(window.location.href), mode = loc.trainMode || "smart", needsQueue = loc.repertoireId ? loc.repertoireId !== trainQueueRepertoireId(trainState) || mode !== trainState.trainMode : loc.trainMode === "smart" && (!trainState.smart?.mixed || trainState.trainResult); if (appState.currentView === "train" && appState.signedIn && needsQueue) await openTrain({ mode, repertoireId: loc.repertoireId }); });
  }
  if (name === "replay") {
    preloadReplayView().catch(() => {});
  }
  if (name === "settings") {
    preloadSettingsView().catch(() => {});
    loadSettings();
  }
  // Warm the Analyze book (active repertoire trees) so the first explored move
  // can be matched without waiting on the lazy load.
  // Recent analyses are owner-scoped: signed out the drawer is absent; signed
  // in it ships open on a desktop, so it loads on entry (not only on a manual
  // toggle) and an idle panel offers the games to reopen instead of a coach
  // line over blank tone. On a phone it lives in the Games sheet, closed.
  if (name === "analyze") syncAnalysisHistoryDrawer({ entering: true });
  if (name === "analyze" && appState.signedIn) {
    ensureBookLoaded()
      .then(() => updateBookline())
      .catch(() => { /* best-effort */ });
  }
  // Entering dashboard loads the chunk; signed-in users refresh counters, except a
  // boot restore of the view loadSignedInWorkspace just loaded. Moves flush first.
  if (name === "dashboard") {
    ensureDashboardView().catch(() => {});
    if (appState.signedIn && !(fromUrl && previousView === name)) {
      settleBuildOutbox().then(() => loadDashboard())
        .catch(() => { /* counters refresh is best-effort */ });
    }
  }
  // Entering Teams (re)loads the caller's teams + shared list.
  if (name === "teams") {
    // Signed out, loadTeams() makes no API call and paints the sign-in state;
    // skipping it left a deep link to #/teams on the bare "Choose a team" shell.
    loadTeams().catch(() => { /* best-effort */ });
  }
  if (name === "build") scheduleExplorerRefresh();
  // One engine session, shown inside whichever view owns a board: Build's
  // Explorer or Analyze's Evaluation card. Each view remembers its own on/off;
  // views without an analysis board close it.
  syncEngineForView(name, { from: previousView });
}


// `hint` is an on-demand tooltip on a number/text field's label; `onInput`
// (values, overlay) runs on open and on every change — e.g. to repaint a live
// note (a `note` field is addressable as [data-note="<name>"]). `onSubmit`
// (values, close) lets a caller run its request while the dialog holds the
// pending state: it calls `close(values)` on success, or returns/throws to leave
// the form open for another try.


let buildLoadSeq = 0;
async function editRepertoire(repertoireId, nodeId = null, { fromUrl = false } = {}) {
  // Picking a repertoire is navigation; a URL restore must not push over its entry.
  workspaceNavigationSeq += 1;
  if (!workspaceUrlReady) navigatedDuringBoot = true;
  // Switching repertoires replaces the local Build tree — flush pending moves of
  // the current one first so they aren't dropped. An optional `nodeId` opens the
  // builder at that position (Analyze's "Open in Build" deep link).
  // The Repertoire view opens NOW with a skeleton; the tree fills in when the
  // load lands (it used to sit on the previous page for seconds).
  const loadSeq = ++buildLoadSeq;
  buildState.buildLoadRequest?.abort();
  // The repertoire this load opens. Until it lands appState.build is still the
  // previous tree, so a route back to that tree must not read as "already open".
  buildState.buildLoadTarget = repertoireId;
  setBuildLoading(true);
  if (!fromUrl) syncWorkspaceUrl({ push: true });
  let request = null;
  try {
    await hardFlushBuild();
    if (loadSeq !== buildLoadSeq) return;
    appState.sharedToken = null;
    request = new AbortController();
    buildState.buildLoadRequest = request;
    // Fetch the tree renderer alongside the repertoire, not after it arrives.
    ensureMoveTreeRenderer().catch(() => {});
    const payload = await api(
      `/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`,
      { signal: request.signal, responseType: "large-json" },
    );
    if (loadSeq !== buildLoadSeq) return;
    const target = nodeId && payload.nodes.some((n) => n.id === nodeId) ? nodeId : null;
    await hydrateBuild(payload, target || payload.selected_node_id, { revealSelection: !!target });
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false, { restore: false });
    trainState.trainingRepertoireId = payload.repertoire_id;
    // The rail remains usable during loading; the opening navigation already
    // owns the URL, so a late response must not rewrite it.
    updateBuildReadOnlyUi(payload);
  } catch (error) {
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false);
    const loc = typeof window === "undefined"
      ? {} : parseWorkspaceLocation(window.location.href);
    if (buildState.build?.repertoire_id && appState.currentView === "build" && loc.view === "build"
      && String(loc.repertoireId) === String(repertoireId)) {
      syncWorkspaceUrl();
    }
    setStatusError(error.message);
  } finally {
    if (buildState.buildLoadRequest === request) buildState.buildLoadRequest = null;
  }
}

// Repertoire loading state: switch to the view (without touching the URL —
// the opening navigation owns any history write) and show a skeleton in place
// of the previous tree. Turning it off restores whatever is actually loaded.
function setBuildLoading(on, { restore = true } = {}) {
  buildState.buildLoading = on;
  const view = document.getElementById("view-build");
  if (view) {
    view.inert = on;
    view.classList.toggle("is-loading", on);
    view.setAttribute("aria-busy", String(on));
  }
  if (!on) {
    if (!restore) return;
    const node = buildState.buildNodeById.get(buildState.buildCurrentNodeId);
    if (node && boards.build) {
      const info = localBoardInfo(node.fen);
      boards.build.setPosition({ fen: node.fen, legalMoves: info.legal_moves, lastMove: node.uci });
      boards.build.setAnnotations(node.arrows || [], node.circles || []);
    }
    renderBuildRepHeader();
    renderBuilderTree();
    syncViewHeads();
    return;
  }
  if (boards.build) {
    boards.build.setPosition({ fen: boards.build.fen, legalMoves: [], lastMove: null });
    boards.build.setAnnotations([], []);
  }
  if (appState.currentView !== "build") switchView("build", { fromUrl: true });
  paintBuildEmpty();
  paintBuildSkeleton(document);
}

function updateBuildReadOnlyUi(payload) {
  if (appState.sharedToken) return;
  if (buildRole(payload) !== "owner") {
    renderReadOnlyBanner(payload);
  } else {
    removeReadOnlyBanner();
  }
  syncCoverageReadOnlyState();
}

function removeReadOnlyBanner() {
  const banner = document.getElementById("shared-banner");
  if (banner) banner.hidden = true;
  syncCoverageReadOnlyState();
  syncViewHeads();
}

function syncCoverageReadOnlyState() {
  coverageEntry?.coverageView?.sync();
}

// "Train this repertoire", a forgotten move, coverage replies: that
// repertoire's Due queue (or just the picked moves), its name on the chip.
async function trainRepertoire(repertoireId, { targetNodeIds = [] } = {}) {
  // Start the guarded Train entry before any waiting: startTraining drains the
  // Build outbox itself, and the entry must already exist if the user leaves.
  return openTrain({ mode: "smart", repertoireId, targets: targetNodeIds });
}

// The Library row's ⋯ and the Repertoire header's ⋯ share one popover menu.
function closeRepertoireContextMenu() {
  const menu = document.getElementById("repertoire-context-menu");
  if (isPopoverOpen(menu)) menu.hidePopover();
}

function openRepertoireContextMenu(event, repertoireId, isActive) {
  openOverflowMenu(document.getElementById("repertoire-context-menu"), {
    event,
    title: event.currentTarget?.closest?.("[data-repertoire-id], .lib-row")?.querySelector?.(".name")?.textContent?.trim() || "",
    data: { "repertoire-id": repertoireId },
    items: [
      { action: "train", label: "Train this repertoire" }, { action: "edit", label: "Open in Repertoire" },
      { action: "rename", label: "Rename...", group: 1 },
      { action: "share", label: "Share...", group: 1 },
      { action: "export", label: "Export PGN", group: 1 },
      { action: "toggle-active", label: isActive ? "Disable" : "Enable", group: 1 },
      { action: "delete", label: "Delete...", danger: true, group: 2 },
    ],
    onPick: (action) => handleRepertoireContextAction(action, repertoireId, isActive),
  });
}

async function fetchRepertoireMeta(repertoireId) {
  try {
    const payload = await api("/api/repertoires");
    return payload.repertoires.find((r) => r.id === repertoireId) || null;
  } catch (_) {
    return null;
  }
}

// One Share dialog for teams, people and the link (views/share-dialog.js).
async function openShareDialog(repertoireId) {
  const { createShareDialogUi, runShareDialog } = await import("./views/share-dialog.js");
  const meta = (appState.repertoireList || []).find((r) => String(r.id) === String(repertoireId));
  const changed = await runShareDialog(repertoireId, {
    name: meta?.name || buildState.build?.name || "Repertoire",
    api,
    postJson,
    origin: window.location.origin,
    copyText: (text) => navigator.clipboard.writeText(text),
    confirm: showConfirmModal,
    setStatus,
    setStatusError,
    loadTeams: async () => {
      if (!teamsState.teams.length) teamsState.teams = (await api("/api/teams")).teams || [];
      return teamsState.teams;
    },
    ui: createShareDialogUi(),
  });
  if (changed) await refreshDashboardRepertoires();
}

async function handleRepertoireContextAction(action, repertoireId, isActive) {
  closeRepertoireContextMenu();
  try {
    if (action === "train") {
      await trainRepertoire(repertoireId);
      return;
    }
    if (action === "edit") {
      await editRepertoire(repertoireId);
      return;
    }
    if (action === "rename") {
      const meta = await fetchRepertoireMeta(repertoireId);
      await promptRenameRepertoire({
        repertoireId, name: meta?.name || "", afterSave: refreshDashboardRepertoires,
      });
      return;
    }
    if (action === "share") {
      await openShareDialog(repertoireId);
      return;
    }
    if (action === "export") return await (await import("./controllers/build-session.js")).exportBuild(repertoireId);
    if (action === "toggle-active") {
      const verb = isActive ? "Disable" : "Enable";
      await postJson("/api/repertoires/set-active", {
        repertoire_id: repertoireId, active: !isActive,
      });
      announceRepertoireChanged({ repertoireId });
      await refreshDashboardRepertoires();
      setStatus(`${verb}d repertoire`);
      return;
    }
    if (action === "delete") {
      // Undo-toast model (no type-to-confirm): hide the repertoire everywhere
      // immediately; the server delete only fires once the undo window closes.
      const repKey = String(repertoireId);
      if (appState.pendingRepDeletes.has(repKey)) return;
      const meta = await fetchRepertoireMeta(repertoireId).catch(() => null);
      appState.pendingRepDeletes.add(repKey);
      announceRepertoireChanged({ repertoireId: repKey });
      // Its queued edits go too, tombstoned so the durable outbox can't bring
      // them back. This happens at delete time (not commit time) so the doomed
      // tree can't keep taking edits.
      void discardBuildOps(repKey);
      if (String(trainState.trainingRepertoireId) === repKey) {
        trainState.trainingRepertoireId = null;
      }
      const wasOpen = !!buildState.build && String(buildState.build.repertoire_id) === repKey;
      if (wasOpen) closeOpenBuild();
      await refreshDashboardRepertoires();
      showUndoToast({
        title: "Repertoire deleted",
        message: `Removed "${meta?.name || "Repertoire"}" and every move in it.`,
        onUndo: () => {
          appState.pendingRepDeletes.delete(repKey);
          setStatus("Delete undone");
          refreshDashboardRepertoires();
          // Put it back where it was: the Repertoire page still has nothing open.
          if (wasOpen && !buildState.build && appState.currentView === "build") void editRepertoire(repertoireId);
        },
        onCommit: () => {
          // keepalive so a commit forced by beforeunload still reaches the server.
          const token = readCsrfCookie();
          fetch("/api/repertoires/delete", {
            method: "POST",
            credentials: "same-origin",
            keepalive: true,
            headers: {
              "Content-Type": "application/json",
              ...(token ? { [CSRF_HEADER]: token } : {}),
            },
            body: JSON.stringify({ repertoire_id: repertoireId }),
          })
            .then((response) => {
              // Gone on the server: the cached listing and the count drop it as
              // the pending mark that hid it is lifted.
              finishRepertoireDelete(appState, repKey, { committed: response.ok });
              if (!response.ok) {
                setStatus("Delete failed — repertoire restored", { severity: "error" });
                refreshDashboardRepertoires();
              }
            })
            .catch(() => {
              appState.pendingRepDeletes.delete(repKey);
              refreshDashboardRepertoires();
            });
        },
      });
      return;
    }
  } catch (error) {
    setStatusError(error.message);
  }
}

// The open repertoire went away (deleted): Build shows the empty start position,
// not the deleted tree's name, board and legal moves under "No repertoire".
function closeOpenBuild() {
  buildState.buildUndoDeletes = new Set();
  buildState.buildUndoCommitByMove = new Map();
  buildState.buildSyncState = "saved";
  buildState.build = null;
  buildState.buildNodeById = new Map();
  buildState.buildCurrentNodeId = null;
  if (boards.build) {
    boards.build.setPosition({ fen: START_FEN, legalMoves: localBoardInfo(START_FEN).legal_moves, lastMove: null });
    boards.build.setAnnotations([], []);
  }
  document.getElementById("build-board-label").textContent = "";
  document.getElementById("build-head-ply").textContent = "";
  renderBuildRepHeader();
  renderBuilderTree();
  renderBuildSync();
  syncViewHeads();
  syncWorkspaceUrl();
  if (engineWidget) engineWidget.onBoardChanged();
  scheduleExplorerRefresh();
}

// Analyze (runs, move list, position coach) lives in controllers/analyze-session.js,
// loaded with the Analyze view. Once loaded the wrappers below call straight through;
// before that they wait for it.
const analyzeLazy = lazyModule(() => import("./controllers/analyze-session.js").then((mod) => mod.createAnalyzeSession()));
const loadAnalyzeSession = analyzeLazy.load;
const viaAnalyzeSession = analyzeLazy.via;
const analysisTreeNav = viaAnalyzeSession("analysisTreeNav");
const reviewNav = viaAnalyzeSession("reviewNav");
const discardAnalyzeCheckpoint = viaAnalyzeSession("discardAnalyzeCheckpoint");
const hideAnalysisHandoff = viaAnalyzeSession("hideAnalysisHandoff");
const loadPgnIntoAnalyze = viaAnalyzeSession("loadPgnIntoAnalyze");
const onAnalysisBoardMove = viaAnalyzeSession("onAnalysisBoardMove");
const onCreateRepertoireFromGameClick = viaAnalyzeSession("onCreateRepertoireFromGameClick");
const playHumanPick = viaAnalyzeSession("playHumanPick");
const resetAnalysisVariations = viaAnalyzeSession("resetAnalysisVariations");
const retryAnalyzeSave = viaAnalyzeSession("retryAnalyzeSave");
const revealAnalysisResults = viaAnalyzeSession("revealAnalysisResults");
const runAnalysis = viaAnalyzeSession("runAnalysis");
const selectAnalysisNode = viaAnalyzeSession("selectAnalysisNode");
const selectAnalysisNodePath = viaAnalyzeSession("selectAnalysisNodePath");
const selectedNodePath = viaAnalyzeSession("selectedNodePath");
const showAnalysisPly = viaAnalyzeSession("showAnalysisPly");

// Restoring the Analyze position a link or session names lives in its own module
// (controllers/analyze-restore.js); this binds it to the session's entry points.
const { restoreAnalyzeSession, restoreAnalysisNodePath } = createAnalyzeRestore({
  analysisState, loadReturnState, loadPgnIntoAnalyze, showAnalysisPly,
  selectAnalysisNodePath, setStatus, recallAnalysis: viaAnalyzeEntry("recallAnalysis"),
  rebuildAnalysisVariations: viaAnalyzeSession("rebuildAnalysisVariations"),
});

export let appReadyPromise = null;

// The Analyze view chunk and its move tree (views/analyze-loader.js).
let analyzeLoader = null;


let buildModule = null;

function preloadBuildView() {
  if (!buildModule) {
    buildModule = import("./views/build.js").catch((err) => {
      buildModule = null;
      throw err;
    });
  }
  loadBuildSession().catch(() => {});
  return buildModule;
}

async function ensureBuildView() {
  // The editor module comes with the view, so its handlers call straight through.
  const [mod] = await Promise.all([preloadBuildView(), loadBuildSession()]);
  if (!buildView) {
    setBuildView(mod.createBuildView({
      appState, buildState,
      boards,
      getMoveTreeRenderer: () => analyzeLoader.moveTreeRenderer,
      ensureMoveTreeRenderer,
      selectBuildNode,
      openNodeContextMenu,
      buildBranchContext,
      isReadOnly: isBuildReadOnly,
      onTreeRendered: syncViewHeads,
      boardRenderers: { parseFenBoard, pieceSvg },
      collaborationApi: { api, postJson, hydrateBuild, showInputModal },
    }));
  }
  return buildView;
}

// The sidebar's repertoire identity line: which repertoire is open and for which
// colour. The ⋯ button next to it carries the repertoire-scoped actions. The view
// repaints Generate's visibility alongside the name.
function renderBuildRepHeader() {
  const nameEl = document.getElementById("build-rep-name");
  if (!nameEl) return;
  paintBuildEmpty();
  if (buildView) return buildView.renderBuildRepHeader();
  void ensureBuildView().then((view) => view.renderBuildRepHeader()).catch(() => {});
}

// "Start a repertoire" replaces the panel's bands while no repertoire is open.
// A class on the sidebar says so instead of a `:has(#build-empty:not([hidden]))`
// rule: that selector sat on an ancestor of the whole panel, so any crumb
// rebuilt during navigation re-styled the page (95 ms per step at 10,000
// moves). Every place that shows or hides the empty state goes through here.
function paintBuildEmpty() {
  const empty = document.getElementById("build-empty");
  const sidebar = document.getElementById("build-sidebar");
  if (empty) empty.hidden = !!buildState.build || buildState.buildLoading;
  if (sidebar) sidebar.classList.toggle("is-empty", !buildState.build && !buildState.buildLoading);
}

// What the lazy controllers ask of the shell and of each other (core/app-context.js).
provideApp({
  shell: { switchView, syncWorkspaceUrl, syncViewHeads, openSettingsSection },
  persistence: { scheduleBuildFlush, hardFlushBuild, flushTrainSync, queueTrainAttempt, markTrainPositionDirty },
  handoffs: { openAnalyzeGame, repertoiresChanged, defaultRepertoireNameFromPgn, importRepertoireFromPgnText },
});


// Train sessions (smart queue, rehearsal, practice games, Feeling Lucky) live in
// controllers/train-session.js, loaded the first time Train is used. The wrappers
// below wait for it, so a click that lands before the chunk does is not lost.
let trainSessionLoading = null;
function loadTrainSession() {
  trainSessionLoading ||= import("./controllers/train-session.js").then((mod) => mod.createTrainSession()).catch((error) => {
    trainSessionLoading = null;
    throw error;
  });
  return trainSessionLoading;
}
function cancelActiveTrainStart() {
  const canceledLucky = cancelLuckyDiscovery(trainState); if (trainState.play?.active) return;
  trainState.playStartToken = (trainState.playStartToken || 0) + 1; if (!canceledLucky && !trainState.trainStarting && !trainState.playStarting) return;
  if (trainState.playStarting) { trainState.playStarting = null; boards.train?.setPremove(null); } trainState.trainStarting = false; trainState.trainStartToken = null; setTrainBanner("move", "", "");
  void trainSessionLoading?.then((train) => train.syncTrainControls()).catch(() => {});
}
const viaTrainSession = (name) => (...args) => loadTrainSession().then((train) => train[name](...args));
const loadTrainRepertoireOptions = viaTrainSession("loadTrainRepertoireOptions");
const onFeelingLucky = viaTrainSession("onFeelingLucky");
const openTrain = (options = {}) => { invalidateTrainEntries(); const seq = trainState.trainEntryVersion, mode = options.mode || "smart", intent = mode === "smart" || mode === "all_lines" ? { repertoireId: options.repertoireId || null, trainMode: mode } : null; if (intent) trainState.trainPendingRoute = intent; const args = { ...options, isCurrent: options.isCurrent ? () => options.isCurrent() && trainState.trainEntryVersion === seq : () => trainState.trainEntryVersion === seq }; return loadTrainSession().then((train) => (args.isCurrent() ? train.openTrain(args) : Promise.resolve(false)).finally(() => { if (intent && trainState.trainPendingRoute === intent) delete trainState.trainPendingRoute; })); };
const submitTrainingMove = viaTrainSession("submitTrainingMove");

// ----- Sync indicator (Google-Docs style chip by the Build board label) -------
// The "N to train" counts come from the repertoire listing, which a finished
// training session made stale: drop the cached list and repaint every reader
// (Library rows, palette, the Repertoire header) once the fresh list lands.
async function refreshRepertoireHead() {
  const view = libraryEntry?.dashboardView;
  if (view) {
    // Also re-reads the active repertoire's tree: spaced repetition moved its
    // moves from "to train" to learned, so the header's count is stale too.
    // hydrateBuild takes the /api/build/load PAYLOAD, not an id (an id made it
    // overwrite appState.build with a string, and the very next paint of the
    // header read build.nodes.filter → "Cannot read properties of undefined").
    await Promise.all([
      view.loadDashboardRepertoires(),
      reloadOpenBuildTree(),
    ]);
  } else if (appState.signedIn) {
    const listing = refreshRepertoireListing(api, currentOwnerId(), appState.ownerGeneration || 0);
    const payload = await listing;
    if (payload && acceptRepertoireListing(listing, currentOwnerId(), appState.ownerGeneration || 0)) Object.assign(appState, {
      repertoireList: payload.repertoires || [], sharedRepertoireList: payload.shared || [], repertoireListGeneration: appState.ownerGeneration || 0,
    });
  }
  renderBuildRepHeader();
  syncViewHeads();
}

// The handoff a feature sends after it changed what the repertoire listing shows
// (a new repertoire, trained moves): every reader repaints from a fresh list.
function repertoiresChanged({ trained = false } = {}) {
  if (trained) void refreshRepertoireHead().catch(() => {});
  return refreshDashboardRepertoires();
}

// Soft drain for read-only refreshes (Library counts): sends whatever is queued
// without closing undo windows, and never throws.

// Drain every pending move before an operation that needs server truth or a real
// node id (Generate anchor, export, node actions, repertoire switch). Throws if a
// move can't be synced so the caller can abort rather than 400 on a tmp id.

function bindDropZone(element, onFile) {
  if (!element) return;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.add("drag-over");
    })
  );
  ["dragleave", "dragend"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.remove("drag-over");
    })
  );
  element.addEventListener("drop", (event) => {
    stop(event);
    element.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

// Drop a PGN file onto the Analyze textarea to load its text (ready to Analyze).
async function fillPgnInputFromFile(file) {
  const sourceSeq = invalidateAnalysisSource();
  const ownerId = currentOwnerId();
  analysisState.analysisFileSeq = sourceSeq;
  const isCurrent = () => analysisState.analysisFileSeq === sourceSeq && ownerId === currentOwnerId();
  try {
    const text = await file.text();
    if (!isCurrent()) return;
    document.getElementById("pgn-input").value = text;
    const drawer = document.querySelector("#view-analyze .drawer");
    if (drawer) drawer.open = true;
    const loaded = await loadPgnIntoAnalyze(text, { goToEnd: false, sourceSeq });
    if (!isCurrent() || !loaded) return;
    orientAnalysisFromPgn(text);
    setStatus(`Loaded ${file.name}`);
  } catch (error) {
    if (isCurrent()) setStatusError(`Could not load file: ${error.message}`);
  }
}

function captureBuildContext() {
  const repertoireId = buildState.build?.repertoire_id;
  const seq = buildLoadSeq;
  const owner = currentOwnerId();
  return () => repertoireId === buildState.build?.repertoire_id && seq === buildLoadSeq && owner === currentOwnerId();
}

// Apply one button's gated state: disable + greyed style + explanatory title,
// or restore its original title when enabled.

// NOTE: server-side engine install (Stockfish/Maia3) and the first-run install
// prompt were removed — the public flow runs Stockfish in the browser and never
// installs or runs an engine on the server. Server install endpoints remain in
// server.py for a future admin mode (gated by PREPFORGE_SERVER_ENGINE_ENABLED).

function bindEvents() {
  // A mouse click leaves focus on the rail button; the next key press (e.g. →
  // to step the board) then makes it :focus-visible, which expands the rail
  // overlay. Drop pointer focus from rail controls so only real keyboard
  // navigation (Tab) opens the rail.
  document.getElementById("app-rail")?.addEventListener("click", (event) => {
    if (event.detail === 0) return; // keyboard activation keeps its focus
    const control = event.target.closest("button");
    if (control && control.id !== "account-chip") control.blur();
  });
  // The hover-expanded rail overlays the board; picking a page collapses it
  // right away instead of waiting for the pointer to leave.
  bindRailCollapseOnNavigate(document.getElementById("app-rail"));
  document.querySelectorAll(".tab[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      dismissTransientOverlays();
      // Picking Analyze or Settings while it is shown only scrolls it back to the
      // top; switchView would read the history list or the settings again.
      if (button.classList.contains("is-active") && ["analyze", "settings"].includes(button.dataset.view)) return void resetViewScroll();
      activateWorkspaceTab(button.dataset, { setReplaySection, switchView });
    });
  });
  bindPhoneChrome({ onAccountChipClick, toggleTheme, isAccountMenuOpen });

  // Teams view actions.
  const teamsNewBtn = document.getElementById("teams-new");
  if (teamsNewBtn) teamsNewBtn.addEventListener("click", createTeam);
  document.getElementById("team-empty-new")?.addEventListener("click", createTeam);
  const teamDetailClose = document.getElementById("team-detail-close");
  if (teamDetailClose) teamDetailClose.addEventListener("click", hideTeamDetail);

  // Local-first sync (Build edits + Train SR deltas): persist pending state
  // when the tab is backgrounded (best-effort flush) and on unload (keepalive
  // fetch — sendBeacon can't carry the CSRF header the API needs). The next
  // load re-hydrates from server truth regardless, so all paths are best-effort.
  // Backgrounding also arms the Maia idle-teardown timer (see above); returning to
  // the foreground cancels it so an active session is never torn down under the user.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hardFlushBuild().catch(() => {});
      flushTrainSync().catch(() => {});
      scheduleMaiaIdleTeardown();
    } else {
      clearMaiaIdleTeardown();
    }
  });
  window.addEventListener("beforeunload", () => {
    beaconFlushBuild();
    beaconFlushTrain();
  });
  startBuildLive();
  settleEntrances();

  // Account chip (folds in the old standalone Sign out button as a menu action)
  document.getElementById("account-chip").addEventListener("click", () => onAccountChipClick());
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  // Replay tab
  document.getElementById("lichess-compare-btn").addEventListener("click", runLichessCompare);
  bindGamesSource();
  bindScoutSource();
  // Static host in the Build panel, so one binding at init covers both states.
  document.getElementById("shared-fork-btn")?.addEventListener("click", forkReadableRepertoire);
  document.getElementById("shared-train-btn")?.addEventListener("click",
    () => { if (buildState.build?.repertoire_id) void trainRepertoire(buildState.build.repertoire_id); });
  // Start is data-only. The view and its stylesheet are already loading because
  // the Scout section is on screen; this guard covers the click that lands in the
  // few ms before bindControls() attaches the real handler, so Start is never
  // dead and never runs twice.
  document.getElementById("scout-btn")?.addEventListener("click", () => {
    if (document.getElementById("scout-btn").dataset.scoutBound) return;
    preloadScoutUi()
      .then((view) => view.runScout())
      .catch((err) => setStatusError(err.message));
  });

  document.getElementById("run-analysis").addEventListener("click", runAnalysis);
  // F-03: retry just the save from the on-device checkpoint (no re-analysis).
  document.getElementById("analysis-retry-save-btn")?.addEventListener("click", () => void retryAnalyzeSave());
  document.getElementById("analysis-retry-save-discard")?.addEventListener("click", discardAnalyzeCheckpoint);
  const createRepFromGame = document.getElementById("create-repertoire-from-game");
  if (createRepFromGame) {
    createRepFromGame.addEventListener("click", () => {
      onCreateRepertoireFromGameClick().catch(() => {});
    });
  }
  const fetchMyGameBtn = document.getElementById("fetch-my-game");
  if (fetchMyGameBtn) {
    // Keep the click: with no linked account it is what starts the connect flow.
    fetchMyGameBtn.addEventListener("click", () => {
      if (fetchMyGameBtn.getAttribute("aria-disabled") === "true") {
        requireSignIn("Sign in to load your latest Lichess game", "my-last-game");
        return;
      }
      fetchMyLichessGame();
    });
    accountEntry.syncFetchMyGameButton();
  }
  // Opening the history drawer reads the list only when it has none for this
  // account yet, or a save has landed since (see loadAnalysisHistory).
  const historyDrawer = document.getElementById("history-drawer");
  if (historyDrawer) {
    historyDrawer.addEventListener("toggle", () => {
      if (historyDrawer.open && appState.signedIn) loadAnalysisHistory({ ifStale: true });
    });
  }
  // Coverage scan: explicit button — never runs implicitly (it's a Maia batch).
  // Scope and horizon live in these header controls, so a change made before
  // the lazy controller loads is still the one it scans with.
  const coverageRun = document.getElementById("coverage-run");
  if (coverageRun) coverageRun.addEventListener("click", runCoverageScanUI);
  const invalidateCoverage = () => { coverageEntry?.coverageView?.invalidate(); };
  document.querySelectorAll("#coverage-scope [data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-active")) return;
      document.querySelectorAll("#coverage-scope [data-scope]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      invalidateCoverage();
      paintInspectorScope();
    });
  });
  document.getElementById("coverage-depth")?.addEventListener("change", () => { invalidateCoverage(); paintInspectorScope(); });

  // Explorer and Coverage share one compact header row: the tabs, the options
  // button (its popover holds the database, scope and horizon) and the tab's
  // action (the Engine switch, Scan).
  const inspectorDbs = document.getElementById("inspector-dbs");
  if (inspectorDbs) {
    inspectorDbs.querySelectorAll(".explorer-db").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        // Mouse clicks drop focus so stepping moves with ← / → never draws a
        // focus ring on the toggle.
        if (event.detail !== 0) btn.blur();
        setExplorerDb(btn.dataset.db);
        inspectorDbs.querySelectorAll(".explorer-db").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-pressed", String(b === btn));
        });
        paintInspectorScope();
        refreshExplorerPanel();
      });
    });
  }
  document.getElementById("build-dock-opts")?.addEventListener("click", openDockOptions);
  // Phones show one of the line tree, Explorer or Coverage under the board.
  const panes = document.getElementById("build-panes");
  bindSheet(document.getElementById("view-build"), panes, document.getElementById("build-sheet-grab"));
  bindHoldToEnd(document.getElementById("build-parent"), document.getElementById("build-root"));
  bindHoldToEnd(document.getElementById("build-next"), document.getElementById("build-end"));
  panes?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pane]");
    if (!button) return;
    const pane = button.dataset.pane;
    // The open Explorer's tab, tapped again, picks its database.
    if (pane === "explorer" && button.getAttribute("aria-selected") === "true") return void openDockOptions();
    document.getElementById("view-build").dataset.pane = pane;
    panes.querySelectorAll("[data-pane]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    // The Explorer and Coverage panes are the inspector: a folded dock (its
    // default) would show them empty. Unfolding is not remembered for desktop.
    if (pane !== "moves") setBuildDockFolded(false, { remember: false });
    if (pane !== "moves" && buildDockTab !== pane) setBuildInspector(pane);
  });
  const dockTabs ={ explorer: "build-tool-explorer", coverage: "build-tool-coverage" };
  Object.entries(dockTabs).forEach(([name, id]) => {
    const tab = document.getElementById(id);
    if (!tab) return;
    tab.addEventListener("click", (event) => {
      // A tab on a folded dock opens the dock on that tab.
      if (buildDockFolded()) setBuildDockFolded(false);
      if (buildDockTab !== name) setBuildInspector(name);
      // A mouse click shouldn't leave a focus ring that lights up the moment
      // the user steps moves with the arrow keys.
      if (event.detail !== 0) tab.blur();
    });
    tab.addEventListener("keydown", (event) => {
      // ← / → are reserved for stepping the board everywhere in Build (a
      // clicked tab keeps focus, so a tablist arrow handler here would switch
      // Explorer → Coverage while the user is stepping moves).
      const next = event.key === "Home" ? 0 : event.key === "End" ? BUILD_DOCK_TABS.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      setBuildInspector(BUILD_DOCK_TABS[next]);
      document.getElementById(dockTabs[BUILD_DOCK_TABS[next]])?.focus();
    });
  });

  // Drag-and-drop: a PGN onto the Analyze box loads it; a PGN/JSON onto the
  // dashboard repertoires card imports it.
  bindDropZone(document.getElementById("pgn-input"), fillPgnInputFromFile);
  analyzeEntry.bindAnalyzePgnInput();
  document
    .getElementById("open-engine-widget")
    .addEventListener("click", () => setEngineOn("analyze", !engineWantedIn("analyze")));
  for (const id of ["explorer-engine-toggle", "build-engine-toggle"]) {
    document.getElementById(id)?.addEventListener("click", () => setEngineOn("build", !engineWantedIn("build")));
  }
  bindEvalChart();
  document.getElementById("analysis-start").addEventListener("click", () => {
    void analysisTreeNav("start").catch(() => {});
  });
  document.getElementById("analysis-prev").addEventListener("click", () => {
    void analysisTreeNav("prev").catch(() => {});
  });
  document.getElementById("analysis-next").addEventListener("click", () => {
    void analysisTreeNav("next").catch(() => {});
  });
  document.getElementById("analysis-end").addEventListener("click", () => {
    void analysisTreeNav("end").catch(() => {});
  });

  document.getElementById("build-root").addEventListener("click", buildGoRoot);
  document.getElementById("build-parent").addEventListener("click", buildGoBack);
  document.getElementById("build-next").addEventListener("click", buildGoForward);
  document.getElementById("build-end").addEventListener("click", buildGoToEnd);
  document.getElementById("build-menu").addEventListener("click", openBuildMenu);
  document.getElementById("build-empty-create").addEventListener("click", () => createRepertoirePrompt({ title: "New repertoire", defaultName: "New repertoire" }));
  document.getElementById("build-empty-import").addEventListener("click", () => ensureDashboardView().then(() => document.getElementById("dashboard-import-pgn")?.click()));
  document.getElementById("build-empty-open").addEventListener("click", () => switchView("dashboard"));

  createPalette({ switchView, setReplaySection, loadSettings, editRepertoire, createRepertoirePrompt,
    requireSignIn, openTrain, onFeelingLucky, toggleTheme,
    editBuildNote: (id) => buildLazy.current?.handleNodeContextAction("add_comment", id) });
  bindCommandPalette();
  installMoveLinks({ selectBuildNode, selectAnalysisNode });
  window.addEventListener("popstate", () => {
    void handleWorkspacePopstate();
  });
  // Analyze takes a PGN file as well as a paste (Library imports from a file too).
  bindPgnInput({ invalidateAnalysisSource, currentOwnerId, sourceIsCurrent: (seq) => seq === analysisRecallSeq, loadPgnIntoAnalyze, orientAnalysisFromPgn, setStatusError });
  const pgnFileBtn = document.getElementById("pgn-file-btn");
  const pgnFileInput = document.getElementById("pgn-file-input");
  if (pgnFileBtn && pgnFileInput) {
    pgnFileBtn.addEventListener("click", () => {
      pgnFileInput.value = "";
      pgnFileInput.click();
    });
    pgnFileInput.addEventListener("change", async () => {
      const file = pgnFileInput.files && pgnFileInput.files[0];
      if (!file) return;
      await fillPgnInputFromFile(file);
    });
  }

  // Board flip + skip
  document.getElementById("analysis-flip").addEventListener("click", () => boards.analysis.flip());
  document.getElementById("build-flip").addEventListener("click", () => boards.build.flip());
  document.getElementById("train-flip").addEventListener("click", () => boards.train.flip());

  // How the current focus arrived: a pointer press, or the keyboard (Tab).
  let focusFromPointer = false;
  document.addEventListener("pointerdown", () => { focusFromPointer = true; }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Tab") focusFromPointer = false; }, true);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "k") {
      event.preventDefault();
      if (paletteIsOpen()) closePalette();
      else openPalette();
      return;
    }
    // A dialog or menu owns its keys: Escape there is the browser's close.
    if (event.target.closest?.("dialog[open], :popover-open")) return;
    const active = document.activeElement;
    const inEditable = !!active && (["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName) ||
      active.isContentEditable === true);
    if (inEditable) return;
    const view = activeViewName();
    // Ctrl/Cmd+Z takes back the last move added here (its Undo card restores it).
    if (view === "build" && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      return void undoLastBuildAdd();
    }
    // Every key below is a bare (or Shift) press. With Ctrl, Cmd or Alt held it is
    // the browser's: Ctrl/Cmd+F finds in the page, Alt+← goes back. AltGr (which
    // reports Ctrl+Alt) types characters such as ? on some layouts, so it passes.
    if ((event.ctrlKey || event.metaKey || event.altKey) && !event.getModifierState?.("AltGraph")) return;
    // Arrow keys navigate the board of the view that is on screen — and only
    // there: Analyze and Build each have one; every other view has none, so ← →
    // must do nothing on it. This handler lives on the document, so it cannot be
    // released with a view; the view name is the guard instead.
    // Shift+← / Shift+→ in Analyze: the previous / next key moment (the review bar).
    if (view === "analyze" && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      void reviewNav(event.key === "ArrowLeft" ? "prev" : "next").catch(() => {});
      return;
    }
    if (event.key === "?") return void import("./shortcuts-help.js").then((m) => m.toggleShortcutsHelp(view));
    const inBuild = view === "build";
    const stepsBoard = inBuild || view === "analyze";
    const arrows = event.key === "ArrowLeft" || event.key === "ArrowRight";
    // A control the mouse focused (Engine, the review switch) would otherwise take
    // the focus ring on the first arrow press, though the arrows drive the board.
    if (stepsBoard && arrows && focusFromPointer && active && active !== document.body) active.blur();
    if (stepsBoard && arrows) {
      event.preventDefault();
      const back = event.key === "ArrowLeft";
      if (inBuild) back ? buildGoBack() : buildGoForward();
      else void analysisTreeNav(back ? "prev" : "next").catch(() => {});
    }
    // Home/End: the ends of the line. A held key repeats keydown, so one hold
    // steps the whole game instead of one move per press. In Analyze ↑/↓ are
    // the same ends, as on Lichess (Build keeps them for the fork pick below).
    const end = { Home: "start", End: "end", ...(inBuild ? {} : { ArrowUp: "start", ArrowDown: "end" }) }[event.key];
    if (stepsBoard && end) {
      event.preventDefault();
      if (inBuild) end === "start" ? buildGoRoot() : buildGoToEnd();
      else void analysisTreeNav(end).catch(() => {});
    }
    // Up/Down (and j/k) move the fork pick — which prepared continuation → will
    // play next. The on-screen fork bar and the board arrows mirror the pick.
    // With no fork at the current position they do nothing (← → step the line).
    if (inBuild && (event.key === "ArrowDown" || event.key === "j")) {
      event.preventDefault();
      buildBranchKey(1);
    }
    if (inBuild && (event.key === "ArrowUp" || event.key === "k")) {
      event.preventDefault();
      buildBranchKey(-1);
    }
    // F flips the active tab's board (Analyze / Build / Train all have one).
    if (event.key === "f" || event.key === "F") {
      const board = activeBoardController();
      if (board) {
        event.preventDefault();
        board.flip();
      }
    }
  });
}

async function init() {
  // First thing: show the boot hold so nothing auth-dependent paints a guess
  // while the session is being read (and so a deep link's route is never
  // replaced by the static markup's dashboard default in anything the user sees).
  holdBootView();
  paintDashboardSkeleton(document);
  appState.prefs = loadPrefs();
  installSoundUnlock();
  bindUnlocks();
  // The account entry and the Analyze entry points are needed before the first
  // paint (the chip, the auth gate, the PGN drawer), so both binds happen here.
  accountEntry = createAccountEntry({
    switchView, loadSettings, openSettingsSection, flushAllPendingForSignOut, persistOutbox, loadTeams,
    clearCoverage: () => coverageEntry?.coverageView?.clear(),
    get dashboardView() { return libraryEntry?.dashboardView; },
    get scoutController() { return scoutLazy.current; },
    paintGamesSource, paintScoutSource,
    get teamsController() { return teamsLazy.current; },
    get appReadyPromise() { return appReadyPromise; },
    get hideTeamDetail() { return hideTeamDetail; },
    get runAnalysis() { return runAnalysis; },
    hideAnalysisRetrySave, showUndoToast,
  });
  accountEntry.initAccountController();
  analyzeEntry = createAnalyzeEntry({
    hideAnalysisHandoff, loadPgnIntoAnalyze, resetAnalysisVariations, revealAnalysisResults, runAnalysis, showAnalysisPly,
  });

  accountEntry.bindAnalyzeEntry(analyzeEntry);
  createBook({ editRepertoire, analysisSelfSide });
  analyzeLoader = createAnalyzeView({
    loadSession: loadAnalyzeSession, showPly: showAnalysisPly,
    selectNode: selectAnalysisNode, reveal: revealAnalysisResults, selfSide: analysisSelfSide,
    gradeAttempt: viaAnalyzeSession("gradeReviewPosition"),
  });
  libraryEntry = createLibrary({
    switchView, hydrateBuild, syncViewHeads, openTrain, editRepertoire,
    openRepertoireContextMenu, createRepertoirePrompt, requireSignIn, openAuthModal,
    openSettingsSection, parseFenBoard, pieceSvg,
  });
  coverageEntry = createCoverage({
    selectBuildNode, hardFlushBuild, captureBuildContext, hydrateBuild, trainRepertoire,
    preloadBuildGen,
  });
  sharedViewer = createSharedViewer({
    requireSignIn, editRepertoire, refreshDashboardRepertoires, switchView, loadTeams,
    hydrateBuild, removeReadOnlyBanner, syncCoverageReadOnlyState, syncViewHeads, openAuthModal,
  });
  installE2eHooks({
    switchView, ensureScoutView, whenSettingsReady, lichessAccounts, syncReplayControls,
    fetchMyLichessGame, notices, revealAnalysisResults, showAnalysisPly, ensureAnalyzeView,
    get appReadyPromise() { return appReadyPromise; },
  });
  hooks.build = {
    get view() { return buildView; },
    selectBuildNode, scheduleBuildFlush, setBuildSync,
    get session() { return buildLazy.current; },
    get coverageView() { return coverageEntry?.coverageView; },
    ensureBuildView, paintExplorerEvals, paintInspectorScope, refreshExplorerPanel,
    ensureCoverageView: () => coverageEntry.ensureCoverageView(),
    syncViewHeads, updateBuildReadOnlyUi,
  };
  // First paint reads the stored theme and accent; it never writes, so opening
  // the app does not fabricate a pref blob.
  applyPref("theme");
  applyPref("accent");
  applyPref("boardTheme");
  try {
    const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    systemTheme?.addEventListener?.("change", () => {
      if (pref("theme") === "system") {
        applyTheme("system");
        syncThemeToggle();
      }
    });
  } catch (_) {
    /* matchMedia is optional in embedded/test environments */
  }
  try {
    const storedStyle = localStorage.getItem(PIECE_STYLE_KEY);
    if (storedStyle && PIECE_SETS[storedStyle]) appState.pieceStyle = storedStyle;
  } catch (_) {
    // ignore storage errors
  }
  boards.analysis = new BoardController({
    boardId: "analysis-board",
    overlayId: "analysis-annotations",
    onMove: onAnalysisBoardMove,
  });
  boards.build = new BoardController({
    boardId: "build-board",
    overlayId: "build-annotations",
    onMove: onBuildBoardMove,
    onAnnotate: saveBuildAnnotations,
  });
  boards.train = new BoardController({
    boardId: "train-board",
    overlayId: "train-annotations",
    onMove: (moveUci) => submitTrainingMove(moveUci),
    onCancel: () => { if (trainState.play) trainState.play.premove = null; },
  });
  notices.bind();
  document.getElementById("coach-maia")?.addEventListener("click", (event) => {
    const pill = event.target.closest(".hp[data-uci]");
    if (!pill) return;
    pill.blur();
    void playHumanPick(pill.dataset.uci).catch(() => {});
  });
  bindEvents();
  renderPieceStylePicker();
  renderPrefsToggles();
  // Paint the starting position on every board up front — board state is now
  // browser-computed (chess.js), so a signed-out visitor sees real pieces and can
  // explore freely instead of staring at an empty grid waiting on a 401'd /api/board.
  try {
    const startInfo = await boardInfo(START_FEN);
    boards.analysis.setPosition({ fen: START_FEN, legalMoves: startInfo.legal_moves });
    boards.build.setPosition({ fen: START_FEN, legalMoves: startInfo.legal_moves });
    boards.train.setPosition({ fen: START_FEN, legalMoves: startInfo.legal_moves });
  } catch (_) {
    /* board init is best-effort */
  }
  renderAnalysisTree();
  applyServerEngineGating();
  paintEngineBanners();

  // Learn the auth state BEFORE any owner-scoped calls. A signed-out visitor must
  // not fire /api/settings, /api/dashboard, /api/board, /api/lichess — they 401 and
  // spam the console. Gate that whole workspace load behind a real session.
  // A remembered session opens at once and is confirmed in the background; only
  // a browser with none waits for the server's answer. The hold is already up
  // (see the top of init), so a signed-in reload never shows the signed-out
  // shell. The Library is the default route and has its own skeleton, so it
  // shows as soon as the session is known; other routes hold until restored.
  const providers = refreshAuthProviders();
  if (accountService().useStoredSession()) void refreshAuthStatus();
  else await Promise.all([providers, refreshAuthStatus()]);
  setHandoffOwner(currentOwnerId());
  if (parseWorkspaceLocation(window.location.href).view === "dashboard") releaseBootView();
  // "Last game" depends on the linked Lichess account, which refreshAuthStatus
  // just told us about; paint its availability now rather than on first click.
  accountEntry.syncFetchMyGameButton();
  if (appState.signedIn) {
    await loadSignedInWorkspace();
  } else {
    renderBuilderTree();
    void loadDashboard();
  }
  // Back from a sign-in (password reload or Google redirect): clean the URL,
  // put the user back on the page they were on, and pick up the action the
  // sign-in gate interrupted (after the workspace has loaded).
  const signInReturn = prepareSignInReturn();
  // The Games tray shows a sign-in chip for guests; repaint for the session.
  paintGamesSource();
  paintScoutSource();
  workspaceUrlReady = true;
  await restoreWorkspaceLocation();
  // The URL route is live and the session is known: nothing left to guess, so
  // the hold can go and the real view shows. Drop it in its own frame so the
  // paint above and the reveal never land in the same one.
  releaseBootView();
  prefetchViews();
  // A share URL opens the read-only viewer last, so it lands on top of whatever
  // workspace state loaded — and works for signed-out visitors too.
  await sharedViewer.maybeOpenSharedView();
  // A join URL (/?join=<code>) redeems a team invite (requires sign-in).
  await sharedViewer.maybeHandleJoinLink();
  // A password-reset link (/?reset_password=<token>) opens the reset form, and a
  // Stripe return (/?billing=success|cancelled) reports the outcome once.
  accountService().openResetFromUrl();
  handleOAuthErrorFromUrl();
  handleBillingReturn();
  syncWorkspaceUrl();
  await resumeAfterSignIn(signInReturn);
  // A guest's Lichess name (the welcome's level) stays on this device.
  if (!appState.signedIn && getStoredLichessUsername()) setLichessUsername(getStoredLichessUsername());
  maybeWelcome({ switchView, setLichessUsername, lichessAccounts, saveSettings: viaSettings("saveSettings") });
}

function handleOAuthErrorFromUrl() {
  const failure = oauthErrorFromUrl(window.location.href);
  if (!failure) return false;
  try {
    window.history.replaceState(window.history.state, "", failure.cleanHref);
  } catch (_) {
    /* the notice still explains the failure */
  }
  notices.show(failure.message, {
    tone: "error",
    key: `oauth-error:${failure.code}`,
    actions: [{
      label: "Try again",
      primary: true,
      onClick: () => {
        if (failure.provider === "google") {
          openAuthModal("login", { notice: failure.message });
        } else if (appState.signedIn) {
          startLichessOAuth();
        } else {
          openAuthModal("login", { notice: "Sign in to connect Lichess." });
        }
      },
    }],
  });
  return true;
}

// Phase 1 of the sign-in return (before the route is restored). Strips
// ?signed_in=1, restores the hash route / ?join= the Google redirect dropped,
// and takes (read-and-remove) the allowlisted pending action.
function prepareSignInReturn() {
  try {
    const cleaned = stripSignedInParam(window.location.href);
    if (cleaned) window.history.replaceState(window.history.state, "", cleaned);
  } catch (_) {
    /* cosmetic */
  }
  if (!appState.signedIn) return { pending: null, returned: false };
  const authReturn = takeAuthReturn();
  const pending = takePendingAction();
  try {
    const restored = restoredAuthHref(window.location.href, {
      route: (authReturn && authReturn.route) || (pending && pending.route) || null,
      join: authReturn ? authReturn.join : null,
    });
    if (restored) window.history.replaceState(window.history.state, "", restored);
  } catch (_) {
    /* cosmetic */
  }
  return { pending, returned: !!authReturn };
}

// Resume handlers for the allowlisted pending actions (auth-gate.js). Each
// re-opens the step the guest was stopped at; nothing here runs stored code.
// Popups and file pickers need a fresh click, so those only lead the user to
// the right control instead of firing it unprompted.
const PENDING_ACTION_HANDLERS = {
  "new-repertoire": () => createRepertoirePrompt({ title: "New repertoire" }),
  "import-pgn": () => {
    switchView("dashboard");
    return libraryEntry.promptImportRepertoireFromPgn();
  },
  "new-team": () => {
    switchView("teams");
    return createTeam();
  },
  "analyze-game": (pending) => {
    switchView("analyze");
    const input = document.getElementById("pgn-input");
    // Old records or unavailable session storage have no source. Never run
    // the demo in place of a game the user asked us to review.
    input.value = pending.data?.pgn || "";
    if (!input.value) {
      const drawer = document.getElementById("pgn-drawer");
      if (drawer) drawer.open = true;
      setStatus("Signed in — paste your PGN to run the full-game review.");
      return;
    }
    // The sign-in round trip keeps #/analyze?ply=N; put the board back on that move
    // once the game is loaded instead of the start position.
    const wantPly =
      parseWorkspaceLocation(window.location.href).ply ||
      (pending.route ? parseWorkspaceLocation(`/${pending.route}`).ply : null);
    return runAnalysis({ mode: pending.data.mode, selectIndex: pending.data.selectIndex }).then(async (result) => {
      if (wantPly && analysisState.analysis && !(analysisState.analysisPly > 0)) await showAnalysisPly(wantPly);
      return result;
    });
  },
  // #/train was restored and restoreWorkspaceLocation already started it.
  train: () => {
    if (appState.currentView !== "train") switchView("train");
  },
  "games-check": () => {
    setReplaySection("games", { syncUrl: false });
    switchView("replay");
    setStatus("Signed in — press Check to compare your games with your repertoire.");
  },
  "scout-start": () => {
    setReplaySection("scout", { syncUrl: false });
    switchView("replay");
    setStatus("Signed in — add the player to scout, then press Start.");
  },
  "lichess-link": () => {
    void openSettingsSection("set-connections").catch(() => {});
    setStatus("Signed in — now link your Lichess account.");
  },
  "my-last-game": () => {
    switchView("analyze");
    if (lichessAccounts().length || appState.lichessUsername) return fetchMyLichessGame();
    setStatus("Signed in — link a Lichess account (Settings → Account) to load your games.");
    return undefined;
  },
};

// Phase 2: the workspace is loaded — run the interrupted action and say
// what came along from the guest session.
async function resumeAfterSignIn({ pending, returned } = {}) {
  if (!appState.signedIn) return;
  if (returned) noteKeptGuestSources();
  if (!pending || !isPendingActionId(pending.id)) return;
  const handler = Object.prototype.hasOwnProperty.call(PENDING_ACTION_HANDLERS, pending.id)
    ? PENDING_ACTION_HANDLERS[pending.id]
    : null;
  if (!handler) return;
  try {
    await handler(pending);
  } catch (error) {
    setStatusError(error.message);
  }
}

// Lichess usernames added as Games/Scout sources live in this browser, not
// the account, so they carry over a sign-in. Say so once instead of letting
// them appear unannounced in the account's Games and Scout.
function noteKeptGuestSources() {
  const names = new Set([
    ...normalizeSelection(gamesSourceSelection()).external,
    ...normalizeSelection(scoutSelection()).external,
  ]);
  if (!names.size) return;
  const list = [...names].slice(0, 3).join(", ") + (names.size > 3 ? ` +${names.size - 3}` : "");
  // Its own card, not the status line: the resumed action may own that.
  notices.show(`${list} — added before you signed in. Remove them from the source chips if you don't need them.`, {
    key: "kept-guest-sources",
    title: "Kept your Games/Scout sources",
    duration: 20000,
    actions: [{ label: "OK", primary: true }],
  });
}

function handleBillingReturn() {
  let url;
  try {
    url = new URL(window.location.href);
  } catch (_) {
    return;
  }
  const outcome = url.searchParams.get("billing");
  if (!outcome) return;
  url.searchParams.delete("billing");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  if (outcome === "success") {
    // The webhook is the source of truth for the plan, not this redirect (the
    // param is user-editable, and the webhook may not have landed yet). Re-fetch
    // and only claim Pro if the server actually reports Pro.
    void refreshAuthStatus().then(() => {
      if (appState.account && appState.account.plan === "pro") {
        setStatus("Thanks — your Pro plan is active.");
      } else {
        setStatus(
          "Payment received — your Pro plan is being activated. It can take a moment to show.",
        );
      }
    });
  } else if (outcome === "cancelled") {
    setStatus("Checkout cancelled — nothing was charged.", { severity: "warning" });
  }
}

// Everything that needs an authenticated session. Called from init only when
// signed in, and after a successful sign-in.
async function loadSignedInWorkspace() {
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
  settingsLazy.load().then((settings) =>
    isCurrent() ? settings.loadSettingsOnce({ render: false }) : null
  ).catch((error) => { if (isCurrent()) setStatusError(error.message); });
  // The Library paints itself when its read lands (and shows its own failure);
  // the route restore must not wait for it.
  loadDashboard().catch(() => {});
  try {
    const stored = getStoredLichessUsername();
    if (stored) setLichessUsername(stored);
  } catch (_) {
    /* ignore storage errors */
  }
  // The Play opponent book depends on a linked Lichess account.
  refreshLichessStatus()
    .then(() => trainSessionLoading?.then((train) => train.syncTrainControls()))
    .catch(() => {});
  syncReplayControls();
  syncAnalysisHistoryDrawer();
  // Boards are already seeded with the start position in init() (browser-computed),
  // so signing in doesn't need to re-fetch them.
  renderBuilderTree();
  // R-03/R-04: this OWNER's durable outbox comes back after a reload or an
  // earlier sign-out, and any flush paused waiting for sign-in re-arms.
  appState.syncPausedForAuth = false;
  const restored = await restoreOutbox();
  if (!isCurrent()) return;
  if (buildState.buildPending.length || buildState.buildPendingDeletes.length) {
    setBuildSync("dirty");
    scheduleBuildFlush();
  }
  if (restored && restored.rejected) {
    setBuildSync("rejected");
    setStatus(
      `${restored.rejected} training attempt${restored.rejected === 1 ? "" : "s"} couldn't be saved earlier and ${restored.rejected === 1 ? "is" : "are"} kept for review.`,
      { severity: "warning" },
    );
  }
  // The recovery check, like the settings read above, lands in the background:
  // neither holds the route.
  void refreshAnalyzeRecovery();
}

// The seams the core modules use to reach the views and the lazily loaded
// sessions they must not import: each one is a live read of the shell's own
// binding, so it is registered once here, after every binding exists.
hooks.settingsPainted = () => settingsLazy.current?.renderThemeControl();
hooks.strengthPainted = () => settingsLazy.current?.renderStrengthControls();
// The handler lives on the account service, not on the entry object: calling
// it on the entry threw on every 401 and the sign-in dialog never opened.
hooks.authRequired = () => accountEntry && accountService().handleAuthRequired();
hooks.explorerEvals = explorerEvalEngine;
hooks.analyzeSession = () => analyzeLazy.current;
// The one pref change a view has to react to: Coverage only shows in the
// inspector, and repainting it re-reads the Maia gate.
hooks.prefApplied = (name) => {
  if (name !== "maiaAnalysis") return;
  if (buildDockTab === "coverage") setBuildInspector("coverage");
  // The analysis layers that read the gate take Maia in place: the coach re-reads
  // the position on the board, and an open Scout report adds its Maia reads.
  const coach = analyzeLazy.current?.positionCoach;
  if (coach && activeViewName() === "analyze" && coach.fen) { coach.cancel(); coach.update(coach.fen, coach.ctx); }
  scoutLazy.current?.onMaiaGate();
};

appReadyPromise = init()
  .then(() => {
    document.documentElement.dataset.appReady = "true";
  })
  // A boot failure must not leave the hold up for good: the views underneath are
  // the honest state, and the status line names the failure.
  .catch((error) => {
    releaseBootView();
    return setStatusError(error.message);
  });
