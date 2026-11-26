import { html } from "../html.js";
// Scout UI (Replay tab card) — lazy-loaded from app.js.
// Pure fetch/parse logic stays in ../scout.js; rendering helpers in ../scout-report.js.

import "./scout.css";
import { createEnrichPipeline } from "../enrich-pipeline.js";
import { countOf, nounOf } from "../plural.js";

import {
  applyScoutColorTabs,
  buildScoutAnalyzePgn,
  buildScoutSectionReport,
  buildScoutShareText,
  captureScoutExpanded,
  consumeEcoCacheEntry,
  handleScoutColorTabClick,
  handleScoutColorTabKeydown,
  handleScoutProfileClick,
  handleScoutResultsClick,
  mergeEnginePatternsIntoSections,
  renderMiniBoardHtml as renderScoutMiniBoardHtml,
  renderScoutColorTabsHtml,
  renderScoutProfile,
  restoreScoutExpanded,
  ensureScoutLineSelection,
  scoutDistRowHtml,
  scoutDisplayDistribution,
  scoutLineDetailHtml,
} from "../scout-report.js";
import { createScoutInitGuard, scoutStateCarryover } from "../scout-init-guard.js";
import { createScoutPrepWriter } from "./scout-prep-writer.js";
import { loadScoutLookups } from "./scout-trees.js";
import { watchMaiaInit } from "../maia-init-notice.js";
import { sameFetchSources } from "./shared/source-composer.js";

const SCOUT_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_SCOUT_E2E === "1";
import { colorRecommendation } from "../scout-stats.js";
import { buildColorRecommendationBanner } from "../scout-summary.js";
import { engineScanPatterns } from "../scout-engine.js";
import {
  MAIA_ENRICH_LOADING, MAIA_ENRICH_OFF, SCOUT_MAIA_SUCCESS_TARGET,
  buildGamePlanDisplayLines,
  classifyMaiaEnrichState,
  computeMaiaScopeKey,
  countGlobalMaiaOutcomes,
  enrichGlobalMaiaPool,
  globalMaiaPoolNeedsWork,
  markUnattemptedMaiaFailures,
  medianOpponentRating,
  resetMaiaScopeCache,
} from "../scout-maia.js";
import {
  PREFILTER_FAILED, PREFILTER_IDLE, PREFILTER_LOADING, PREFILTER_READY,
  buildFallbackPrefilterData,
  computePrefilterScopeKey,
  mergeGlobalPrefilterRanked,
  prefilterCacheKey,
  runStockfishPrefilter,
} from "../scout-prefilter.js";
import {
  SCOUT_ERR_NO_GAMES,
  SCOUT_GAME_PLAN_LIMIT,
  fensAlongLine,
  gamePlanCandidates,
  opponentColorBaseline,
  scoutFetchErrorMessage,
  trimRankedBranches,
} from "../scout.js";
import { NODES_PER_GATE_READ, createPathGuard, selectGuardedRoutes } from "../scout-path-guard.js";
import { routeKey } from "../scout-preparation-value.js";
import { createPathGuardEngine } from "../scout-path-guard-engine.js";

import {
  SCOUT_STREAM_BATCH, failedSources, recordStreamResults, renderSourceWarnings, scoutErrorHtml,
  scoutLabel, scoutSourceFailureMessage, scoutStreamCapNoteHtml, sourcesToStream, streamWindow,
} from "./scout-sources.js";
import { createScoutSession, createScoutState, noteRepeatedGame, restoreScoutRun, scoutRunSnapshot, settleRefresh } from "./scout-session.js";
import { captureScoutViewState, restoreScoutViewState, scoutPrefilterFailedNoteHtml } from "./scout-render-state.js";

const RENDER_DEBOUNCE_MS = 400;
const RENDER_FORCE_EVERY_INITIAL = 25;

const PREFILTER_ENRICH_DEBOUNCE_MS = 400;

/** Games between forced full rerenders while streaming — grows with history size. */
export function scoutRenderForceEvery(gameCount) {
  const n = Number(gameCount) || 0;
  if (n < 100) return RENDER_FORCE_EVERY_INITIAL;
  if (n < 300) return 50;
  if (n < 600) return 100;
  return 200;
}

/** The plan-row enter fade is for a settled re-rank, never for the live stream. */
export function planRowEntranceEnabled(sessionState) {
  return sessionState !== "running";
}

/** Debounce delay for batched rerenders — longer waits as history grows. */
export function scoutRenderDebounceMs(gameCount) {
  const n = Number(gameCount) || 0;
  if (n < 200) return RENDER_DEBOUNCE_MS;
  if (n < 500) return 800;
  return 1200;
}
const EXPLORER_ENRICH_DEBOUNCE_MS = 800;
const ENGINE_AGG_DEBOUNCE_MS = 400;
const MAIA_ENRICH_DEBOUNCE_MS = 600;
const PATH_GUARD_DEBOUNCE_MS = 300;
// A replay that no longer matches its recorded run re-runs the guard at most this often per scope.
const PATH_GUARD_MAX_RERUNS = 3;

const perColor = (make) => ({ white: make("white"), black: make("black") });

export function createScoutView(deps) {
  const {
    setStatus,
    switchView,
    api,
    editRepertoire,
    selectBuildNode,
    notices,
    parseFenBoard,
    pieceSvg,
    loadPgnIntoAnalyze,
    maiaAnalysisEnabled = () => true,
    scoutPickedUsernames = () => [],
    // Unified sign-in gate (app.js): false + sign-in modal for a guest.
    requireSignIn = () => true,
  } = deps;
  // Scout history (scout-history.js): this account's saved runs, and a hook for the
  // History list. From deps or, in the app, useHistory() once the controller binds it.
  let { scoutHistory = null, currentOwnerId = () => null, onScoutHistorySaved = () => {} } = deps;

  let scoutModule = null;
  let scoutClient = null;
  let scoutExplorerClient = null;
  let scoutExplorerModule = null;
  let scoutEngineModule = null;
  let scoutState = null;
  let scoutSession = null;
  let scoutSourceNames = null;
  const scoutBoundEventTargets = new WeakSet();
  const prefilterEnrich = createEnrichPipeline({ debounceMs: PREFILTER_ENRICH_DEBOUNCE_MS, run: enrichPrefilterReads });
  const maiaEnrich = createEnrichPipeline({ debounceMs: MAIA_ENRICH_DEBOUNCE_MS, run: enrichMaiaReads });
  const pathGuard = createEnrichPipeline({ debounceMs: PATH_GUARD_DEBOUNCE_MS, run: rerunPathGuard });
  const engineAgg = createEnrichPipeline({ debounceMs: ENGINE_AGG_DEBOUNCE_MS, run: computeEngineAggregation });
  const explorerEnrich = createEnrichPipeline({ debounceMs: EXPLORER_ENRICH_DEBOUNCE_MS, run: enrichExplorerReads });
  const renderPipeline = createEnrichPipeline({
    debounceMs: () => scoutRenderDebounceMs(scoutState?.games?.length || 0),
    run: () => { flushRender(); if (scoutSession) scoutSession.gamesSinceRender = 0; },
  });
  let scoutOpGen = 0;
  let deepScanAbort = null;
  const initGuard = createScoutInitGuard();

  async function loadScoutModule() {
    scoutModule ||= await import("../scout.js");
    scoutClient ||= scoutModule.createScoutClient({});
    return scoutModule;
  }

  function getResultsEl() {
    return document.getElementById("scout-results");
  }

  // While games are still streaming in, only the cheap empirical report is rendered.
  // Maia inference, explorer fetches, and engine aggregation are deferred until the
  // stream pauses/stops — running them live caused score flicker (re-scoring + re-sort
  // on every batch) and severe mid-stream lag (ONNX forwards on a growing line set).
  function isStreaming() {
    return scoutSession?.state === "running";
  }

  function getProfileEl() {
    return document.getElementById("scout-profile");
  }

  function getSideEl() {
    return document.getElementById("scout-side");
  }

  // The open line's detail lives in the side panel; drop it with the report so a
  // new scout never paints against a stale selection.
  function clearScoutSide() {
    const side = getSideEl();
    if (!side) return;
    side.hidden = true;
    side.innerHTML = "";
    for (const key of ["lineKey", "color", "boardSide"]) delete side.dataset[key];
  }

  // Below 1020px the detail stacks under the plan; bring it into view on select.
  // At 768-1020 it sat ~1,400px down and opening a row showed nothing.
  function revealScoutDetail() {
    const side = getSideEl();
    if (!side || side.hidden || !window.matchMedia?.("(max-width: 1020px)").matches) return;
    side.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function scoutSelectionCtx() {
    return {
      scoutModule,
      sideEl: getSideEl(),
      ecoCache: scoutState?.ecoCache,
      createElement: (tag) => document.createElement(tag),
      callbacks: {
        scoutLineDetailHtml: localScoutLineDetailHtml,
        enrichEcoForLine: enrichEcoForLineCached,
      },
    };
  }

  function updateLiveCounter() {
    const fetched = scoutState?.games?.length || 0;
    const el = document.getElementById("scout-live-count");
    if (el) el.textContent = String(fetched);
    // "1 games fetched" — the noun is markup beside the number, so it has to
    // agree with the count too.
    const noun = document.getElementById("scout-live-noun");
    if (noun) noun.textContent = nounOf(fetched, "game");
    updateStreamPhase();
  }

  // Live progress while a fetch is in flight. The count and the phase come from
  // data the fetch already has: games accepted so far, plus which phase we are in
  // (init → streaming). The streaming card is the only surface mid-stream, before
  // the first report render exists. Only the phase is announced (role="status"
  // in index.html): the count changes with every game.
  let lastPhaseKey = "";
  function updateStreamPhase() {
    const phase = document.getElementById("scout-stream-phase");
    if (!phase) return;
    const detail = document.getElementById("scout-stream-detail");
    const initializing = initGuard.isInitializing;
    const fetched = scoutState?.games?.length || 0;
    // Fires once per streamed game; skip the DOM write when nothing changed.
    const key = `${initializing ? "init" : "fetch"}:${fetched}`;
    if (key === lastPhaseKey) return;
    lastPhaseKey = key;
    if (initializing) {
      phase.textContent = "Loading your repertoires…";
      if (detail) detail.textContent = "Loading your repertoires";
    } else if (fetched > 0) {
      phase.textContent = "Reading their games…";
      if (detail) detail.textContent = `${fetched} so far`;
    } else {
      phase.textContent = "Fetching games from Lichess…";
      if (detail) detail.textContent = "";
    }
  }

  function engineProgressLabel(p) {
    if (p?.phase === "path") return "Checking lines…";
    if (p?.phase === "maia") {
      return p.total > 0
        ? `Maia ${p.done}/${p.total}`
        : "Maia…";
    }
    return p && p.total > 0
      ? `Stockfish ${p.done}/${p.total}`
      : "Stockfish…";
  }

  function engineProgressPct(p) {
    if (!p || !p.total) return 6; // a visible sliver before the first position settles
    return Math.max(4, Math.min(100, Math.round((p.done / p.total) * 100)));
  }

  function enginePhaseActive() {
    return (
      scoutState?.prefilterEnrichState === PREFILTER_LOADING ||
      scoutState?.maiaEnrichState === MAIA_ENRICH_LOADING
    );
  }

  // Patch the progress bar in place (no full re-render) so it animates smoothly while
  // Stockfish/Maia churn through positions between the coarse report rerenders.
  function patchEngineProgressUI() {
    const el = document.getElementById("scout-engine-progress");
    if (!el) return;
    if (!enginePhaseActive()) {
      el.classList.add("is-idle");
      el.innerHTML = "";
      return;
    }
    const p = scoutState?.engineProgress;
    // Indeterminate until the first position settles (total unknown): show a sweeping bar
    // instead of a frozen sliver so the user can tell it's working, not stuck.
    const indeterminate = !p || !p.total;
    const pct = engineProgressPct(p);
    el.classList.remove("is-idle");
    el.classList.toggle("is-indeterminate", indeterminate);
    el.setAttribute("role", "progressbar");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    if (indeterminate) {
      el.removeAttribute("aria-valuenow");
    } else {
      el.setAttribute("aria-valuenow", String(pct));
    }
    el.innerHTML = html`<span class="scout-progress-label">${engineProgressLabel(p)}</span>
      <progress max="100"${indeterminate ? "" : html` value="${pct}"`} aria-label="Scout evaluation"></progress>`;
  }

  function setEngineProgress(progress) {
    if (!scoutState) return;
    scoutState.engineProgress = progress;
    patchEngineProgressUI();
  }

  function updateScoutControls() {
    const btn = document.getElementById("scout-btn");
    const resetBtn = document.getElementById("scout-reset-btn");
    const colorSel = document.getElementById("scout-color");
    const card = document.querySelector(".replay-card-scout");
    const state = scoutSession?.state || "idle";

    if (btn) {
      const action = initGuard.isInitializing ? "start"
        : state === "running" ? "stop" : state === "paused" ? "resume" : "start";
      // A full batch pauses on its own; the same button pulls the next, older one.
      const older = action === "resume" && scoutSession?.batchFull;
      btn.textContent = { start: "Start", stop: "Stop", resume: older ? "Load older" : "Resume" }[action];
      if (action === "resume") btn.title = older ? `Fetch up to ${SCOUT_STREAM_BATCH} older games per account` : "";
      btn.dataset.scoutAction = action;
      btn.disabled = initGuard.isInitializing;
    }
    if (resetBtn) {
      resetBtn.hidden = state === "idle" || state === "running";
    }
    if (colorSel) {
      // The scope is read once, when the run starts. While a scout is
      // initialising, streaming or paused (Resume keeps the run's scope), the
      // select must not take a change the run would then ignore. A finished
      // run takes it: the next Start reads it.
      colorSel.disabled = initGuard.isInitializing || state === "running" || state === "paused";
    }
    if (card) {
      // The card shows the live stream card from the moment Start is pressed:
      // the init phase (repertoire loads) happens before the first game arrives,
      // and that used to look like nothing was happening at all.
      card.classList.toggle("is-streaming", initGuard.isInitializing || state === "running");
    }
    updateLiveCounter();
  }

  function syncVisibleState() {
    syncSources();
    bindScoutEvents();
    updateScoutControls();
    updateLiveCounter();

    const results = getResultsEl();
    const profile = getProfileEl();
    if (scoutState) {
      const hasReport = !!results?.innerHTML?.trim();
      if (scoutState.games?.length && !hasReport) {
        renderScoutReport({ force: true });
      } else if (!scoutState.games?.length && !hasReport && scoutSession?.emptyStateMessage) {
        showScoutEmptyState(scoutSession, scoutSession.emptyStateMessage);
      } else {
        patchEngineProgressUI();
      }
      if (profile && scoutState.profile && profile.hidden && scoutState.games?.length) {
        renderScoutReport({ force: true });
      }
    }

    if (results) {
      results.classList.toggle("is-streaming", scoutSession?.state === "running");
    }
  }

  // Rebuild both persistent tries from all games seen so far — used when none exist yet or
  // the speed filter changed (a one-shot O(N) pass, off the streaming hot path).
  function rebuildLiveTries() {
    const speed = scoutState.activeSpeed;
    const games = scoutState.games || [];
    const anchorTs = scoutState.liveTrieAnchor || Date.now();
    scoutState.liveTrieAnchor = anchorTs;
    const white = scoutModule.createOpeningTrie();
    const black = scoutModule.createOpeningTrie();
    for (const g of games) {
      if (speed !== "all" && g.speed !== speed) continue;
      scoutModule.insertGameIntoTrie(white, g, "white", { anchorTs, maxPlies: Infinity });
      scoutModule.insertGameIntoTrie(black, g, "black", { anchorTs, maxPlies: Infinity });
    }
    scoutState.liveTries = { white, black };
    scoutState.liveTrieSpeed = speed;
    scoutState.liveTrieCount = games.length;
  }

  // The prebuilt trie for a colour, rebuilding lazily if stale (never initialised, speed
  // filter changed, or the game count drifted from what was inserted incrementally).
  function liveTrieForColor(oppColor) {
    if (!scoutState) return null;
    if (
      !scoutState.liveTries ||
      scoutState.liveTrieSpeed !== scoutState.activeSpeed ||
      scoutState.liveTrieCount !== (scoutState.games?.length || 0)
    ) {
      rebuildLiveTries();
    }
    return scoutState.liveTries?.[oppColor] || null;
  }

  // Fold one freshly-streamed game into the live tries in O(opening depth). No-op until the
  // tries have been built once (the next render builds them and syncs the count); also a
  // no-op when the game doesn't match the active speed filter, keeping parity with a rebuild.
  function insertIntoLiveTries(game) {
    if (!scoutState?.liveTries || scoutState.liveTrieSpeed !== scoutState.activeSpeed) return;
    const speed = scoutState.activeSpeed;
    if (speed !== "all" && game.speed !== speed) {
      scoutState.liveTrieCount = scoutState.games.length;
      return;
    }
    const anchorTs = scoutState.liveTrieAnchor || Date.now();
    scoutModule.insertGameIntoTrie(scoutState.liveTries.white, game, "white", { anchorTs, maxPlies: Infinity });
    scoutModule.insertGameIntoTrie(scoutState.liveTries.black, game, "black", { anchorTs, maxPlies: Infinity });
    scoutState.liveTrieCount = scoutState.games.length;
  }

  // Plan rows by colour and line, so a re-render can tell which rows are new.
  function planRowKeys(root) {
    return new Set([...root.querySelectorAll(".scout-weakness-row")].map((row) => `${row.dataset.color}|${row.dataset.lineKey}`));
  }

  // When the plan changes under the user (engine ranking, path guard), only rows that were
  // not shown before fade in, one after another; rows that stay do not move or flash.
  function markEnteringPlanRows(root, before) {
    if (!before.size) return;
    // Mid-stream every batch rebuilds the plan: staggering a new row in holds it
    // at opacity 0 (animation-fill-mode: both) for up to ~385ms, so its ~60px
    // row shows as a blank gap between rows until loading ends. The enter fade
    // is for a settled re-rank after enrichment, so skip it while streaming.
    if (!planRowEntranceEnabled(scoutSession?.state)) return;
    let n = 0;
    for (const row of root.querySelectorAll(".scout-weakness-row")) {
      if (before.has(`${row.dataset.color}|${row.dataset.lineKey}`)) continue;
      row.classList.add("is-enter");
      row.style.setProperty("--enter-index", String(n++));
    }
  }

  // One colour's report from the current state; `overrides` lets the path guard build the
  // selector input a render would use without drawing it.
  function buildSectionReport(oppColor, overrides = {}) {
    return buildScoutSectionReport(
      scoutModule,
      scoutState,
      oppColor,
      scoutState.lookups[oppColor === "white" ? "black" : "white"],
      {
        speedFilter: scoutState.activeSpeed,
        enginePatterns: engineScanPatterns(scoutState.engineByColor?.[oppColor]),
        explorerReads: scoutState.explorerByColor?.[oppColor] || null,
        engineAgg: engineAggForColor(oppColor),
        engineScan: engineScanForColor(oppColor),
        maiaResults: scoutState.maiaResults,
        maiaRatings: scoutState.maiaRatings,
        maiaEnrichState: scoutState.maiaEnrichState || "idle",
        prefilterEnrichState: scoutState.prefilterEnrichState || "idle",
        prefilteredLines: scoutState.prefilteredLines?.[oppColor],
        pathGuard: pathGuardOption(oppColor),
        trie: liveTrieForColor(oppColor),
        ...overrides,
      },
    );
  }

  function renderScoutReport({ force = false } = {}) {
    if (!scoutState) return;
    const profileEl = getProfileEl();
    const results = getResultsEl();
    const captured = results ? captureScoutExpanded(results) : null;
    const kept = [results, getSideEl()].map((root) => captureScoutViewState(root));

    if (profileEl) {
      profileEl.innerHTML = renderScoutProfile(
        scoutState.profile,
        scoutState.username,
        scoutState.activeSpeed,
        {
          usernames: scoutState.usernames,
          streaming: isStreaming(),
          colorRecHtml: scoutState.color === "white" || scoutState.color === "black" ? "" // one colour: nothing to compare
            : buildColorRecommendationBanner(
              colorRecommendation(
                scoutModule.analyzedGames(scoutState.games, null, { speedFilter: scoutState.activeSpeed }),
              ),
              { username: scoutState.username },
            ),
        },
      );
      profileEl.hidden = false;
    }
    scoutState.sections = {};
    scoutState.maiaResults ||= new Map();
    if (scoutState.games?.length) scoutState.maiaRatings = perColor((c) => medianOpponentRating(scoutState.games, c));
    const whiteReport = buildSectionReport("white");
    if (whiteReport.sectionData) scoutState.sections.white = whiteReport.sectionData;
    const blackReport = buildSectionReport("black");
    if (blackReport.sectionData) scoutState.sections.black = blackReport.sectionData;
    if (scoutState.engineByColor && Object.keys(scoutState.engineByColor).length) {
      mergeEnginePatternsIntoSections(scoutState.sections, scoutState.engineByColor, {
        speedFilter: scoutState.activeSpeed,
      });
    }
    // Built after the sections so a tab's count is the section's gameCount: the
    // raw per-colour total ignores the speed filter and counts games the trie
    // skips, which left the tab and the heading quoting different numbers.
    // Hidden while streaming (both sections build live).
    const tabsHtml = renderScoutColorTabsHtml(scoutState.profile, {
      hidden: isStreaming(),
      username: scoutState.username,
      counts: {
        white: scoutState.sections.white?.gameCount ?? 0,
        black: scoutState.sections.black?.gameCount ?? 0,
      },
    });
    const sections = [whiteReport.html, blackReport.html].filter(Boolean);
    const progressHtml = html`<div id="scout-engine-progress" class="scout-engine-progress is-idle"></div>${
      scoutStreamCapNoteHtml(scoutSession)}${scoutPrefilterFailedNoteHtml(scoutState.prefilterEnrichState === PREFILTER_FAILED)}`;
    if (results) {
      const shownBefore = planRowKeys(results);
      results.innerHTML = sections.length
        ? html`${progressHtml}${tabsHtml}${sections}`
        : html`${progressHtml}<div class="empty-state">Not enough opening data in these games.</div>`;
      patchEngineProgressUI();
      if (sections.length) applyScoutColorTabs(results);
      markEnteringPlanRows(results, shownBefore);
      if (captured) {
        restoreScoutExpanded(results, scoutState.sections, captured, scoutSelectionCtx());
      }
      if (sections.length) {
        ensureScoutLineSelection(results, scoutState.sections, scoutSelectionCtx());
      } else {
        clearScoutSide();
      }
      restoreScoutViewState(results, kept[0], { redrill: renderDistDrilldown });
      restoreScoutViewState(getSideEl(), kept[1]);
    }
    if (force) updateLiveCounter();
    patchEngineProgressUI();
    if (!isStreaming() && !isEnrichmentInFlight()) {
      prefilterEnrich.schedule();
    }
  }

  function scheduleRender({ force = false } = {}) {
    if (!scoutSession) return;
    scoutSession.gamesSinceRender += 1;
    const forceEvery = scoutRenderForceEvery(scoutState?.games?.length || 0);
    if (force || scoutSession.gamesSinceRender >= forceEvery) {
      renderPipeline.flush();
      return;
    }
    renderPipeline.schedule(true);
  }

  function engineScanForColor(color) {
    const scan = scoutState?.engineByColor?.[color];
    if (!scan?.scanRecords?.length) return null;
    if (scan.speedFilter && scan.speedFilter !== scoutState.activeSpeed) return null;
    return scan;
  }

  function engineAggForColor(color) {
    if (!engineScanForColor(color)) return null;
    return scoutState.engineAggByColor?.[color] || null;
  }

  function canApplyDeepScan(opGen, state) {
    return scoutState === state && state != null && scoutOpGen === opGen;
  }

  function flushRender() {
    if (!scoutState?.games?.length) return;
    scoutState.profile = scoutModule.opponentProfile(scoutState.games);
    scoutState.explorerByColor = {};
    scoutState.engineAggByColor = {};
    renderScoutReport();
    if (!isStreaming()) {
      explorerEnrich.schedule();
      engineAgg.schedule();
    }
  }

  function isEnrichmentInFlight() {
    return (
      prefilterEnrich.inFlight ||
      maiaEnrich.inFlight
    );
  }

  function cancelEnrichmentQueues() {
    prefilterEnrich.cancel();
    maiaEnrich.cancel();
    pathGuard.cancel();
  }

  // Everything the current report has in flight, deep scan included.
  function cancelScoutWork() {
    scoutOpGen += 1;
    deepScanAbort?.abort();
    deepScanAbort = null;
    cancelEnrichmentQueues();
    for (const pipeline of [renderPipeline, explorerEnrich, engineAgg]) pipeline.cancel();
  }



  // The recorded guard run for one colour, replayed by the report without engine reads.
  function pathGuardOption(oppColor) {
    const rec = scoutState?.pathGuard?.[oppColor];
    if (!rec) return null;
    return {
      trace: rec.trace,
      verdicts: rec.verdicts,
      onReplay: (replay) => {
        if (!replay.diverged || rec.diverged) return;
        rec.diverged = true;
        console.debug("[scout-path-guard] input changed; re-running", oppColor);
        if (rec.reruns < PATH_GUARD_MAX_RERUNS) pathGuard.schedule();
      },
    };
  }

  // Mean nodes of this colour's depth-8 leaf reads: the guard's cost estimate before its own reads.
  function meanLeafNodes(candidates) {
    let sum = 0;
    let n = 0;
    for (const line of candidates) {
      const nodes = scoutState.prefilterCache?.get(prefilterCacheKey(line.terminalFen))?.nodes;
      if (Number.isFinite(nodes) && nodes > 0) { sum += nodes; n += 1; }
    }
    return n ? sum / n : NODES_PER_GATE_READ;
  }

  /**
   * Runs the guarded selection for one colour on the exact input a render would select
   * from (`overrides` stand in for state not yet published) and records it. Returns false
   * when superseded. Engine failure leaves no record, so the v10 rows show.
   */
  async function runPathGuardForColor(oppColor, engine, isCurrent, overrides = {}) {
    const section = buildSectionReport(oppColor, { ...overrides, pathGuard: null }).sectionData;
    if (!section?.gamePlanSource?.length) return true;
    scoutState.pathGuard ||= { white: null, black: null };
    scoutState.pathGuardVerdicts ||= { white: new Map(), black: new Map() };
    const prev = scoutState.pathGuard[oppColor];
    const baseline = section.baselineScorePct;
    const candidates = gamePlanCandidates(section.gamePlanSource, baseline, { oppColor });
    const verdicts = scoutState.pathGuardVerdicts[oppColor];
    const guard = createPathGuard({ engine, fensFor: fensAlongLine, oppColor, leafMeanNodes: meanLeafNodes(candidates), verdicts });
    const started = Date.now();
    let result;
    try {
      result = await selectGuardedRoutes(candidates, { baseline, limit: SCOUT_GAME_PLAN_LIMIT }, guard);
    } catch (err) {
      if (!isCurrent()) return false;
      console.warn("[scout-path-guard] skipped:", err?.message || err);
      scoutState.pathGuard[oppColor] = null;
      return true;
    }
    if (!isCurrent()) return false;
    const flags = { safe: 0, unverified: 0, risk: 0 };
    for (const row of result.picked) flags[row.pathStatus] = (flags[row.pathStatus] || 0) + 1;
    const v10Keys = new Set(result.control.map(routeKey));
    const stats = {
      ...result.stats, ms: Date.now() - started, anchorRejections: result.anchorRejections, flags,
      changedRows: result.picked.filter((row) => !v10Keys.has(routeKey(row))).length,
      v10: result.control.map(routeKey), shown: result.picked.map((row) => [routeKey(row), row.pathStatus]),
    };
    scoutState.pathGuard[oppColor] = {
      trace: guard.trace, verdicts, stats, diverged: false,
      reruns: prev?.diverged ? prev.reruns + 1 : 0,
    };
    console.debug("[scout-path-guard]", oppColor, stats);
    return true;
  }

  async function rerunPathGuard(gen) {
    if (!scoutState?.games?.length || !scoutModule || isStreaming()) return;
    if (gen !== pathGuard.generation || scoutState.prefilterEnrichState !== PREFILTER_READY) return;
    const isCurrent = () => gen === pathGuard.generation && Boolean(scoutState);
    const engine = createPathGuardEngine({ shouldCancel: () => !isCurrent() });
    let changed = false;
    try {
      for (const oppColor of ["white", "black"]) {
        const rec = scoutState.pathGuard?.[oppColor];
        if (!rec?.diverged || rec.reruns >= PATH_GUARD_MAX_RERUNS) continue;
        if (!(await runPathGuardForColor(oppColor, engine, isCurrent))) return;
        changed = true;
      }
    } finally {
      await engine.close();
      if (changed && isCurrent()) renderScoutReport();
    }
  }


  function allOpeningLinesForColor(section, oppColor) {
    if (!scoutState?.games?.length || !scoutModule?.rankedOpeningBranches) {
      return [];
    }
    // The trie + baseline rank observed routes by measured struggle and family evidence.
    // Opponent-only conditional reach removes routes they are unlikely to enter before
    // Stockfish runs; our own chosen moves do not lower that reach.
    // Bound the engine queue using personal preparation value.
    const { branches } =
      scoutModule.rankedOpeningBranches(scoutState.games, oppColor, {
        speedFilter: scoutState.activeSpeed,
        trie: section?.trie || null,
        baselineScorePct: baselineScorePctForColor(oppColor),
        limit: 0,
      }) || { branches: [] };
    return trimRankedBranches(branches);
  }

  function currentPrefilterScopeKey() {
    return computePrefilterScopeKey({
      username: scoutState.username,
      activeSpeed: scoutState.activeSpeed,
      games: scoutState.games,
    });
  }

  function invalidatePrefilterState() {
    if (!scoutState) return;
    scoutState.prefilterEnrichState = PREFILTER_IDLE;
    scoutState.prefilterScopeKey = null;
    scoutState.prefilterPools = { white: [], black: [] };
    scoutState.prefilterRanked = { white: [], black: [] };
    scoutState.prefilteredLines = { white: [], black: [] };
    scoutState.stockfishDisplayLines = { white: [], black: [] };
    scoutState.pathGuard = { white: null, black: null };
  }

  function syncMaiaScope() {
    if (!scoutState?.games?.length) return;
    scoutState.maiaRatings = perColor((c) => medianOpponentRating(scoutState.games, c));
    const scopeKey = computeMaiaScopeKey({
      activeSpeed: scoutState.activeSpeed,
      gameCount: scoutState.games.length,
      games: scoutState.games,
      ratings: scoutState.maiaRatings,
    });
    if (resetMaiaScopeCache(scoutState, scopeKey)) {
      scoutState.maiaAttemptsUsed = 0;
    }
  }

  function baselineScorePctForColor(oppColor) {
    return (
      scoutState.sections?.[oppColor]?.baselineScorePct ??
      opponentColorBaseline(scoutState.games, oppColor, {
        speedFilter: scoutState.activeSpeed,
      })
    );
  }

  function globalMaiaRankedPool() {
    return mergeGlobalPrefilterRanked(scoutState?.prefilterRanked || {}, {
      baselineByColor: perColor(baselineScorePctForColor),
    });
  }

  function snapshotStockfishDisplayLine(oppColor, lines) {
    scoutState.stockfishDisplayLines ||= { white: [], black: [] };
    scoutState.stockfishDisplayLines[oppColor] = lines;
  }

  function applyPrefilterFallbackForColor(section, oppColor) {
    const lines = allOpeningLinesForColor(section, oppColor);
    if (!lines.length) return;
    const fallback = buildFallbackPrefilterData(lines);
    scoutState.prefilterPools[oppColor] = fallback.pool;
    scoutState.prefilterRanked[oppColor] = fallback.ranked;
    scoutState.prefilteredLines[oppColor] = fallback.ranked.map(entry => entry.line);
    snapshotStockfishDisplayLine(oppColor, scoutState.prefilteredLines[oppColor]);
  }

  function refreshGamePlanDisplayLines() {
    if (!scoutState?.games?.length || !scoutModule) return;
    scoutState.stockfishDisplayLines ||= { white: [], black: [] };
    scoutState.prefilteredLines ||= { white: [], black: [] };
    for (const oppColor of ["white", "black"]) {
      const stockfish = scoutState.stockfishDisplayLines[oppColor]?.length
        ? scoutState.stockfishDisplayLines[oppColor]
        : scoutState.prefilteredLines[oppColor];
      scoutState.prefilteredLines[oppColor] = buildGamePlanDisplayLines({
        rankedEntries: scoutState.prefilterRanked?.[oppColor] || [],
        stockfishDisplayLines: stockfish,
        maiaResults: scoutState.maiaResults,
        rating: scoutState.maiaRatings?.[oppColor],
        fenAfterLine: scoutModule.fenAfterLine,
      });
    }
  }

  function maiaPoolContext() {
    return {
      maiaResults: scoutState.maiaResults,
      getRating: (oppColor) => scoutState.maiaRatings?.[oppColor],
      fenAfterLine: scoutModule.fenAfterLine,
    };
  }

  function prefilterSettled() {
    return [PREFILTER_READY, PREFILTER_FAILED].includes(scoutState.prefilterEnrichState);
  }

  async function enrichPrefilterReads(gen) {
    if (!scoutState?.games?.length || !scoutModule || isStreaming()) return;
    if (gen !== prefilterEnrich.generation) return;
    const scopeKey = currentPrefilterScopeKey();
    if (prefilterSettled() && scoutState.prefilterScopeKey === scopeKey) {
      if (globalMaiaRankedPool().length) maiaEnrich.schedule();
      return;
    }

    scoutState.prefilterEnrichState = PREFILTER_LOADING;
    scoutState.engineProgress = { phase: "stockfish", done: 0, total: 0 };
    scoutState.prefilterPools ||= { white: [], black: [] };
    scoutState.prefilterRanked ||= { white: [], black: [] };
    scoutState.prefilteredLines ||= { white: [], black: [] };
    scoutState.prefilterCache ||= new Map();
    renderScoutReport();

    // Carry positions counted in earlier colours so the bar climbs monotonically across
    // the white→black passes instead of snapping back to 0% when black starts.
    let sfBaseDone = 0;
    let sfBaseTotal = 0;
    // The path guard reads each colour's lines before they are published, so the first
    // engine-ranked plan on screen is already the guarded one.
    const guardCurrent = () => gen === prefilterEnrich.generation && Boolean(scoutState);
    const guardEngine = createPathGuardEngine({ shouldCancel: () => !guardCurrent() });
    try {
      for (const oppColor of ["white", "black"]) {
        if (gen !== prefilterEnrich.generation) return;
        const section = scoutState.sections?.[oppColor];
        const lines = allOpeningLinesForColor(section, oppColor);
        if (!lines.length) continue;
        let lastColorProgress = { done: 0, total: 0 };
        const result = await runStockfishPrefilter(lines, {
          fenAfterLine: scoutModule.fenAfterLine,
          oppColor,
          baselineScorePct: baselineScorePctForColor(oppColor),
          cache: scoutState.prefilterCache,
          shouldCancel: () => gen !== prefilterEnrich.generation,
          onProgress: (p) => {
            if (gen !== prefilterEnrich.generation) return;
            lastColorProgress = p;
            setEngineProgress({
              phase: "stockfish",
              done: sfBaseDone + p.done,
              total: sfBaseTotal + p.total,
            });
          },
        });
        sfBaseDone += lastColorProgress.done;
        sfBaseTotal += lastColorProgress.total;
        if (gen !== prefilterEnrich.generation) return;
        scoutState.funnel ||= {};
        scoutState.funnel[oppColor] = result.funnel;
        if (!result.ranked?.length && (!result.funnel ||
          result.funnel.scoreDrops?.noEval === result.funnel.totalLines)) {
          applyPrefilterFallbackForColor(section, oppColor);
        } else {
          const rankedLines = result.ranked.map(entry => entry.line);
          setEngineProgress({ phase: "path", done: 0, total: 0 });
          const done = await runPathGuardForColor(oppColor, guardEngine, guardCurrent,
            { prefilteredLines: rankedLines, prefilterEnrichState: PREFILTER_READY });
          if (!done) return;
          scoutState.prefilterPools[oppColor] = result.pool;
          scoutState.prefilterRanked[oppColor] = result.ranked;
          scoutState.prefilteredLines[oppColor] = rankedLines;
          snapshotStockfishDisplayLine(oppColor, scoutState.prefilteredLines[oppColor]);
        }
      }
      if (gen !== prefilterEnrich.generation) return;
      scoutState.prefilterEnrichState = PREFILTER_READY;
      scoutState.prefilterScopeKey = scopeKey;
    } catch (error) {
      if (gen === prefilterEnrich.generation && scoutState) {
        console.warn("[scout-prefilter] failed:", error?.message || error);
        for (const oppColor of ["white", "black"]) {
          if (scoutState.prefilterPools?.[oppColor]?.length) continue;
          const section = scoutState.sections?.[oppColor];
          applyPrefilterFallbackForColor(section, oppColor);
        }
        // Settled for this scope, so renders don't re-run it in a loop; the
        // report's Retry (retryPrefilter) clears the scope to read again.
        scoutState.prefilterEnrichState = PREFILTER_FAILED;
        scoutState.prefilterScopeKey = scopeKey;
      }
    } finally {
      await guardEngine.close();
      prefilterEnrich.settled(gen);
      if (gen === prefilterEnrich.generation && scoutState) {
        renderScoutReport();
        maiaEnrich.schedule();
      }
    }
  }

  function retryPrefilter() {
    if (!scoutState || isStreaming() || scoutState.prefilterEnrichState !== PREFILTER_FAILED) return;
    scoutState.prefilterScopeKey = null;
    scoutState.prefilterEnrichState = PREFILTER_IDLE;
    renderScoutReport();
    prefilterEnrich.schedule();
  }

  // Redraws the plan from the Maia reads so far, records the funnel, and returns the
  // enrichment state those reads add up to.
  function settledMaiaState() {
    refreshGamePlanDisplayLines();
    const outcomes = countGlobalMaiaOutcomes(globalMaiaRankedPool(), {
      successTarget: SCOUT_MAIA_SUCCESS_TARGET,
      ...maiaPoolContext(),
    });
    const { resolved, failed, missing, expected } = outcomes;
    scoutState.funnel ||= {};
    scoutState.funnel.maia = {
      globalPool: globalMaiaRankedPool().length,
      attempts: scoutState.maiaAttemptsUsed || 0,
      resolved, failed, missing, expected,
    };
    return classifyMaiaEnrichState(outcomes);
  }

  function maiaWorkRemaining() {
    return globalMaiaPoolNeedsWork(globalMaiaRankedPool(), {
      successTarget: SCOUT_MAIA_SUCCESS_TARGET,
      attemptsUsed: scoutState.maiaAttemptsUsed || 0,
      ...maiaPoolContext(),
    });
  }

  async function enrichMaiaReads(gen) {
    // Scout's Maia enrichment is an explicitly Maia-powered read of the
    // opponent's human-likeness. When analysis-layer Maia is OFF the report
    // states the requirement instead of silently changing shape.
    if (!maiaAnalysisEnabled()) {
      if (scoutState && scoutState.maiaEnrichState !== MAIA_ENRICH_OFF) {
        scoutState.maiaEnrichState = MAIA_ENRICH_OFF;
        renderScoutReport();
      }
      return;
    }
    if (!scoutState?.games?.length || !scoutModule || isStreaming()) return;
    if (gen !== maiaEnrich.generation) return;
    if (prefilterEnrich.inFlight) return;
    if (!prefilterSettled() || !globalMaiaRankedPool().length) return;

    scoutState.maiaResults ||= new Map();
    scoutState.maiaCache ||= new Map();
    syncMaiaScope();

    if (!maiaWorkRemaining()) {
      const nextState = settledMaiaState();
      if (scoutState.maiaEnrichState !== nextState) {
        scoutState.maiaEnrichState = nextState;
        renderScoutReport();
      }
      // No render when state is unchanged — avoids a ~1s render loop:
      // renderScoutReport → schedulePrefilterEnrich → enrichPrefilterReads (settled)
      // → scheduleMaiaEnrich → enrichMaiaReads (no work, same state) → renderScoutReport → …
      return;
    }

    scoutState.maiaEnrichState = MAIA_ENRICH_LOADING;
    scoutState.maiaAttemptsUsed ||= 0;
    scoutState.engineProgress = { phase: "maia", done: 0, total: 0 };
    renderScoutReport();

    try {
      const { getSharedMaia3Provider } = await import("../engine/maia3-provider.js");
      if (gen !== maiaEnrich.generation) return;
      const provider = getSharedMaia3Provider();
      const maiaNotice = watchMaiaInit(provider, {
        notices,
        onRetry: () => maiaEnrich.schedule(),
      });
      try {
        if (maiaWorkRemaining()) {
          const { attempts } = await enrichGlobalMaiaPool(globalMaiaRankedPool(), {
            successTarget: SCOUT_MAIA_SUCCESS_TARGET,
            attemptsUsed: scoutState.maiaAttemptsUsed,
            provider,
            fenAfterLine: scoutModule.fenAfterLine,
            getRating: (oppColor) => scoutState.maiaRatings[oppColor],
            getBaselineScorePct: (oppColor) =>
              scoutState.sections?.[oppColor]?.baselineScorePct ?? 0,
            cache: scoutState.maiaCache,
            maiaResults: scoutState.maiaResults,
            shouldCancel: () => gen !== maiaEnrich.generation,
            onProgress: (p) => {
              if (gen === maiaEnrich.generation) setEngineProgress(p);
            },
          });
          if (gen !== maiaEnrich.generation) return;
          scoutState.maiaAttemptsUsed = attempts;
        }
        maiaNotice.succeed();
      } catch (error) {
        maiaNotice.fail(error);
        throw error;
      }

      if (gen !== maiaEnrich.generation) return;
      scoutState.maiaEnrichState = settledMaiaState();
    } catch {
      if (gen === maiaEnrich.generation && scoutState) {
        for (const entry of globalMaiaRankedPool()) {
          markUnattemptedMaiaFailures([entry.line], {
            maiaResults: scoutState.maiaResults,
            rating: scoutState.maiaRatings?.[entry.oppColor],
            fenAfterLine: scoutModule.fenAfterLine,
          });
        }
        scoutState.maiaEnrichState = settledMaiaState();
      }
    } finally {
      maiaEnrich.settled(gen);
      if (gen === maiaEnrich.generation && scoutState) {
        renderScoutReport();
      }
    }
  }


  async function computeEngineAggregation(gen) {
    if (!scoutState?.games?.length || isStreaming()) return;
    if (gen !== engineAgg.generation) return;
    try {
      if (!scoutEngineModule) {
        scoutEngineModule = await import("../scout-engine.js");
      }
      if (gen !== engineAgg.generation) return;

      const next = {};
      for (const color of ["white", "black"]) {
        if (gen !== engineAgg.generation) return;
        const scan = engineScanForColor(color);
        if (!scan) continue;
        const scope = scoutEngineModule.selectEngineScope(scoutState.games, {
          color,
          speedFilter: scoutState.activeSpeed,
          maxGames: scan.maxGames,
        });
        next[color] = scoutEngineModule.aggregateEngineByFamily(scan.scanRecords, {
          eligibleGames: scope.games.length,
          eligibleGameIds: scope.gameIds,
          scanGameIds: scan.gameIds || scan.scanRecords.map((r) => r.gameId).filter(Boolean),
          scopeLimited: scope.scopeLimited,
          maxGames: scope.maxGames,
        });
      }
      if (gen !== engineAgg.generation) return;
      scoutState.engineAggByColor = next;
      if (Object.keys(next).length) {
        renderScoutReport();
      }
    } catch {
      /* engine aggregation is optional */
    }
  }


  async function enrichExplorerReads(gen) {
    if (!scoutState?.games?.length || !scoutModule || isStreaming()) return;
    if (gen !== explorerEnrich.generation) return;
    try {
      if (!scoutExplorerModule) {
        scoutExplorerModule = await import("../scout-explorer.js");
      }
      if (gen !== explorerEnrich.generation) return;
      const client = await explorerClient();
      if (gen !== explorerEnrich.generation) return;

      const rating = scoutState.profile?.ratingLast ?? scoutState.profile?.ratingMax;
      scoutState.explorerByColor ||= {};
      let changed = false;

      for (const oppColor of ["white", "black"]) {
        if (gen !== explorerEnrich.generation) return;
        const section = scoutState.sections?.[oppColor];
        if (!section?.trie) continue;
        const positions = scoutExplorerModule.collectExplorerProbePositions(
          section.trie,
          scoutModule.fenAfterLine,
          { oppColor },
        );
        const reads = await scoutExplorerModule.fetchExplorerReads({
          fetchStats: client.fetchStats.bind(client),
          positions,
          opponentRating: rating,
          shouldCancel: () => gen !== explorerEnrich.generation,
        });
        if (gen !== explorerEnrich.generation) return;
        scoutState.explorerByColor[oppColor] = reads;
        changed = true;
      }

      if (changed && gen === explorerEnrich.generation) {
        renderScoutReport();
      }
    } catch {
      // The report says the masters comparison is missing instead of just
      // dropping it (renderScoutExplorerReads).
      // A colour already read in this run keeps its read.
      if (gen !== explorerEnrich.generation || !scoutState) return;
      const failed = { available: false, reason: "error" };
      scoutState.explorerByColor = { white: failed, black: failed, ...scoutState.explorerByColor };
      renderScoutReport();
    }
  }

  async function explorerClient() {
    return scoutExplorerClient || import("../explorer.js")
      .then(({ createExplorerClient }) => (scoutExplorerClient ||= createExplorerClient({})));
  }

  function localScoutLineDetailHtml(line, idx, oppColor, rowKind = "line") {
    return scoutLineDetailHtml(line, idx, oppColor, rowKind, {
      fenAfterLine: (ucis) => scoutModule.fenAfterLine(ucis),
      renderBoard: (fen, orientation, lastUci) =>
        renderScoutMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg }, lastUci),
      baseline: scoutState?.sections?.[oppColor]?.baselineScorePct ?? null,
    });
  }

  function applyEcoToLine(lineEl, opening) {
    const ecoEl = lineEl?.querySelector?.(".scout-line-eco");
    if (ecoEl && opening) ecoEl.textContent = opening;
  }

  async function enrichEcoForLineCached(lineEl, fen, lineKey) {
    const key = lineKey || lineEl?.dataset?.lineKey;
    if (!key || !scoutState?.ecoCache) return;

    const cached = scoutState.ecoCache.get(key);
    if (cached) {
      try {
        const opening = await consumeEcoCacheEntry(cached);
        if (opening) applyEcoToLine(lineEl, opening);
        else scoutState.ecoCache.delete(key);
      } catch {
        scoutState.ecoCache.delete(key);
      }
      return;
    }

    const pending = explorerClient()
      .then((client) => client.fetchStats("masters", fen, {}))
      .then((stats) => stats?.opening || null);
    scoutState.ecoCache.set(key, pending);
    try {
      const opening = await pending;
      if (opening) {
        scoutState.ecoCache.set(key, opening);
        applyEcoToLine(lineEl, opening);
      } else {
        scoutState.ecoCache.delete(key);
      }
    } catch {
      scoutState.ecoCache.delete(key);
    }
  }

  function scoutAnalyzeLine(line, oppColor, username) {
    const pgn = buildScoutAnalyzePgn(line, oppColor, username);
    const input = document.getElementById("pgn-input");
    if (input) input.value = pgn;
    // A line Analyze can't take used to report "Loaded" anyway. An invalid PGN
    // is reported before the load's first await, a failed load after it.
    let failed = false;
    const fail = () => { failed = true; setStatus("Couldn't open this line in Analyze.", { severity: "error" }); };
    void loadPgnIntoAnalyze(pgn, { quiet: true, onInvalid: fail }).catch(fail);
    const drawer = document.getElementById("pgn-drawer");
    if (drawer) drawer.open = true;
    switchView("analyze");
    if (!failed) setStatus(`Loaded ${username}'s line. Press Review to start.`);
  }

  // Scout → Build writes (views/scout-prep-writer.js).
  const prepWriter = createScoutPrepWriter({ ...deps,
    loadScoutModule: async () => { await loadScoutModule(); return scoutModule; },
    getScoutState: () => scoutState,
  });
  const scoutAddToPrep = prepWriter.addToPrep;
  const scoutPrepareAll = prepWriter.prepareAll;

  async function copyScoutReport() {
    if (!scoutState) return;
    const text = buildScoutShareText(scoutState);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Scout report copied to clipboard");
    } catch {
      setStatus("Could not copy. Check clipboard permissions.");
    }
  }

  async function scoutRunDeepScan() {
    if (!scoutState?.games?.length) {
      setStatus("Scout an opponent first");
      return;
    }
    // Mid-stream it would scan only the games read so far, beside the stream's own work.
    if (isStreaming()) return setStatus("Deep scan starts once the games have loaded");
    if (notices.isBusy()) {
      setStatus("Another job is running");
      return;
    }
    const opGen = scoutOpGen;
    const state = scoutState;
    await loadScoutModule();
    if (!canApplyDeepScan(opGen, state)) return;
    const engineMod = await import("../scout-engine.js");
    if (!canApplyDeepScan(opGen, state)) return;
    const ctrl = new AbortController();
    deepScanAbort = ctrl;
    const colors = ["white", "black"].filter((c) =>
      state.games.some((g) => g.color === c),
    );
    const total = colors.length;
    notices.startJob({
      id: `scout-deep-${Date.now()}`,
      title: "Scout Deep Scan",
      tab: "replay",
      total,
      onCancel: () => ctrl.abort(),
    });
    state.engineByColor ||= {};
    // One eval cache for both colours: a position searched for one is not searched again.
    const evalCache = engineMod.createScanEvalCache();
    let done = 0;
    try {
      for (const color of colors) {
        if (!canApplyDeepScan(opGen, state) || ctrl.signal.aborted) break;
        notices.updateJob({
          current: done,
          total,
          message: `Scanning ${color} openings…`,
        });
        const scanResult = await engineMod.runScoutDeepScan({
          games: state.games,
          oppColor: color,
          speedFilter: state.activeSpeed,
          evalCache,
          shouldCancel: () => !canApplyDeepScan(opGen, state) || ctrl.signal.aborted,
          onProgress: (cur, tot) => {
            notices.updateJob({
              current: done,
              total,
              message: `${color}: game ${cur}/${tot}`,
            });
          },
        });
        if (!canApplyDeepScan(opGen, state) || ctrl.signal.aborted) break;
        state.engineByColor[color] = scanResult;
        done++;
      }
      if (!canApplyDeepScan(opGen, state) || ctrl.signal.aborted) {
        notices.cancelJob("Deep scan stopped");
        return;
      }
      state.engineAggByColor = {};
      renderScoutReport({ force: true });
      engineAgg.schedule();
      bindScoutEvents();
      notices.completeJob({
        title: "Deep scan done",
        message: `Engine patterns for ${countOf(done, "colour")}`,
      });
    } catch (error) {
      if (!canApplyDeepScan(opGen, state)) {
        notices.cancelJob("Deep scan stopped");
        return;
      }
      if (error?.cancelled) {
        notices.cancelJob("Deep scan stopped");
      } else {
        notices.failJob(error.message || "Deep scan failed");
        setStatus(error.message);
      }
    } finally {
      if (deepScanAbort === ctrl) deepScanAbort = null;
    }
  }

  function renderDistDrilldown(distRowEl, sectionEl, oppColor) {
    const uci = distRowEl.dataset.firstUci;
    if (!uci) return;
    const sectionData = scoutState.sections[oppColor];
    if (!sectionData) return;
    const distCol = sectionEl.querySelector("[data-dist-root]");
    if (!distCol) return;

    let childNode = null;
    for (const [key, node] of sectionData.trie.children) {
      if (key.startsWith(`${uci}|`)) {
        childNode = node;
        break;
      }
    }
    if (!childNode) return;

    const subDist = scoutDisplayDistribution(childNode, scoutModule.moveDistribution, { limit: 6 });
    const parentSan = distRowEl.querySelector(".scout-dist-san")?.textContent || uci;
    const rows = subDist.map((m) => scoutDistRowHtml(m, { clickable: false }));

    // The replies to their first move are their OPPONENTS' moves; the score is
    // still theirs.
    distCol.innerHTML = html`
    <div class="scout-dist-drill-head muted" title="Opponent replies and player score">1.${parentSan}</div>
    ${rows}
    <button type="button" class="scout-btn btn ghost scout-dist-back">Back ↑</button>`;
    distCol.dataset.drillUci = uci;
  }

  function restoreDistRoot(sectionEl, oppColor) {
    const sectionData = scoutState.sections[oppColor];
    if (!sectionData) return;
    const dist = scoutDisplayDistribution(sectionData.trie, scoutModule.moveDistribution);
    const distCol = sectionEl.querySelector("[data-dist-root]");
    if (!distCol) return;
    distCol.innerHTML = html`${dist.map((m) => scoutDistRowHtml(m))}`;
    delete distCol.dataset.drillUci;
  }

  // Only exposed when SCOUT_E2E_BUILD_ENABLED (see the returned API).
  async function mountE2eRefutationScenario(scenarioId) {
    const { SCOUT_E2E_REFUTATION_SCENARIOS, scoutE2eSeedGames, buildE2ePrepSection } = await import(
      "../scout-e2e-fixtures.js"
    );
    if (!SCOUT_E2E_REFUTATION_SCENARIOS[scenarioId]) {
      throw new Error(`Unknown scout E2E refutation scenario: ${scenarioId}`);
    }

    await loadScoutModule();
    bindScoutEvents();

    const seedGames = scoutE2eSeedGames();
    scoutState = {
      games: seedGames,
      activeSpeed: "all",
      username: "e2e-fixture",
      profile: scoutModule.opponentProfile(seedGames),
      lookups: { white: [], black: [] },
      sections: {},
      explorerByColor: {},
      engineByColor: {},
      engineAggByColor: {},
      ecoCache: new Map(),
    };
    scoutSession = {
      state: "done",
      gamesSinceRender: 0,
    };
    scoutOpGen += 1;
    updateScoutControls();
    updateLiveCounter();

    const results = getResultsEl();
    const profileEl = getProfileEl();
    if (!results || !profileEl) throw new Error("Scout results or profile element missing");
    profileEl.innerHTML = renderScoutProfile(scoutState.profile, scoutState.username, scoutState.activeSpeed);
    profileEl.hidden = false;

    const { html: markup, sectionData } = buildE2ePrepSection(scenarioId);
    results.innerHTML = markup;
    scoutState.sections = { black: sectionData };
    const root = results.querySelector(".scout-section[data-scout-color='black']");
    if (root) root.dataset.e2eRefutation = scenarioId;
    return { scenarioId, normalizedId: scenarioId };
  }

  function bindScoutEvents() {
    const profileEl = getProfileEl();
    if (profileEl && !scoutBoundEventTargets.has(profileEl)) {
      scoutBoundEventTargets.add(profileEl);
      profileEl.addEventListener("click", (e) => {
        handleScoutProfileClick(e, {
          getState: () => scoutState,
          onSpeedChange: () => {
            if (scoutState) {
              scoutState.explorerByColor = {};
              scoutState.engineAggByColor = {};
              invalidatePrefilterState();
              scoutState.maiaAttemptsUsed = 0;
            }
            cancelEnrichmentQueues();
            renderScoutReport({ force: true });
            explorerEnrich.schedule();
            engineAgg.schedule();
            prefilterEnrich.schedule();
          },
          callbacks: {
            copyScoutReport,
            runDeepScan: scoutRunDeepScan,
          },
        });
      });
    }

    const scoutClickCtx = () => ({
      getState: () => scoutState,
      scoutModule,
      callbacks: {
        restoreDistRoot,
        renderDistDrilldown,
        scoutPrepareAll,
        scoutAddToPrep,
        scoutAnalyzeLine,
        copyScoutReport,
        editRepertoire,
        selectBuildNode,
        scoutLineDetailHtml: localScoutLineDetailHtml,
        enrichEcoForLine: enrichEcoForLineCached,
        runDeepScan: scoutRunDeepScan,
        revealScoutDetail,
      },
      getSideEl,
    });

    const results = getResultsEl();
    if (results && !scoutBoundEventTargets.has(results)) {
      scoutBoundEventTargets.add(results);
      results.addEventListener("click", async (e) => {
        // Prototype colour tabs: visibility-only switch, no re-render — the
        // side panel follows to the new colour's open line.
        if (handleScoutColorTabClick(e, results)) {
          ensureScoutLineSelection(results, scoutState?.sections, scoutSelectionCtx());
          return;
        }
        if (e.target.closest?.("[data-scout-load-older]")) return void handleScoutAction();
        if (e.target.closest?.("[data-scout-retry-prefilter]")) return retryPrefilter();
        await handleScoutResultsClick(e, scoutClickCtx());
      });

      results.addEventListener("keydown", (e) => {
        // Colour tabs: ArrowLeft/ArrowRight switch (visibility-only).
        if (handleScoutColorTabKeydown(e, results)) {
          ensureScoutLineSelection(results, scoutState?.sections, scoutSelectionCtx());
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        // A line's moves and a move row are role="button" elements and need
        // the synthetic click. A real button (Add to prep) activates itself;
        // clicking it here too could fire its action a second time.
        if (e.target.matches?.(".scout-line-toggle, .scout-dist-row[data-first-uci]")) {
          e.preventDefault();
          e.target.click();
        }
      });
    }

    const side = getSideEl();
    if (side && !scoutBoundEventTargets.has(side)) {
      scoutBoundEventTargets.add(side);
      side.addEventListener("click", (e) => handleScoutResultsClick(e, scoutClickCtx()));
    }
  }

  async function initScoutState(usernames, color, initToken) {
    await loadScoutModule();
    if (!initGuard.isCurrent(initToken)) return false;

    // Every active repertoire counts toward coverage. A one-colour scout needs
    // only the repertoires of the colour you play against them.
    const lookups = await loadScoutLookups({ api, repertoireChildLookup: scoutModule.repertoireChildLookup, color });
    if (!initGuard.isCurrent(initToken)) return false;
    const carry = scoutStateCarryover(scoutState, scoutLabel(usernames));
    scoutState = createScoutState({ usernames, color, lookups, carry });
    scoutSession = createScoutSession({ usernames, color });
    return true;
  }

  function isActiveSession(session) {
    return session != null && scoutSession === session;
  }

  function onScoutGame(game, session) {
    if (!scoutState || !isActiveSession(session)) return false;
    if (game.scoutUsername && game.datestamp > 0) {
      const previous = session.oldestDatestampByUser[game.scoutUsername];
      session.oldestDatestampByUser[game.scoutUsername] = previous == null
        ? game.datestamp : Math.min(previous, game.datestamp);
    }
    if (game.gameId && session.seenIds.has(game.gameId)) { noteRepeatedGame(session, game); return false; }
    if (game.gameId) session.seenIds.add(game.gameId);
    // Tag the source identity so merged "self" reports stay attributable.
    if (game.sourceAccount == null && game.scoutUsername) {
      game.sourceAccount = game.scoutUsername;
    }
    scoutState.games.push(game);
    insertIntoLiveTries(game);
    session.acceptedThisBatch += 1;
    // R-05: per-source counts feed the coverage chips.
    if (game.scoutUsername) {
      session.acceptedByUser[game.scoutUsername] =
        (session.acceptedByUser[game.scoutUsername] || 0) + 1;
    }
    updateLiveCounter();
    scheduleRender();
    return true;
  }

  async function onStreamEnd({ accepted }, session) {
    if (!isActiveSession(session)) return;
    renderPipeline.cancel();
    session.gamesSinceRender = 0;
    session.controller = null;

    session.state = session.hasMore ? "paused" : "done";
    session.userStopped = false;
    if (accepted > 0) {
      invalidatePrefilterState();
    }
    flushRender();
    saveToHistory(session);
    updateScoutControls();
    updateLiveCounter();

    if (!scoutState?.games?.length && session.state === "done") {
      showScoutEmptyState(session, scoutSourceFailureMessage(session) || SCOUT_ERR_NO_GAMES);
    }
  }

  // A run that ends with games goes to the History list. A browser cache: a save
  // that fails changes nothing, and the next Start simply streams everything.
  function saveToHistory(session) {
    const owner = currentOwnerId();
    if (!scoutHistory || !owner || !scoutState?.games?.length || !isActiveSession(session)) return;
    const snapshot = scoutRunSnapshot(scoutState, session);
    Promise.resolve().then(() => scoutHistory.save(owner, snapshot))
      .then((ok) => { if (ok) onScoutHistorySaved(); }).catch(() => {});
  }

  function showScoutEmptyState(session, message) {
    const results = getResultsEl();
    session.emptyStateMessage = message;
    const failedUsers = failedSources(session);
    if (results) results.innerHTML = scoutErrorHtml(failedUsers.length ? "Couldn't scout this player" : "No games to scout", message, failedUsers.length > 0);
    results?.querySelector?.("#scout-retry-failed")?.addEventListener("click", () => retryFailedSources(session));
    const profile = getProfileEl();
    if (profile) profile.hidden = true;
  }

  // Not while a fetch runs: a second stream on the same session would replace
  // its controller, and Stop would then only stop one of the two.
  function retryFailedSources(session) {
    const failedUsers = failedSources(session);
    if (!failedUsers.length || session.state === "running") return false;
    const results = getResultsEl();
    results?.classList.add("is-streaming");
    void runStream({ session, only: failedUsers }).finally(() => {
      if (isActiveSession(session)) results?.classList.remove("is-streaming");
    });
    return true;
  }

  // A stream supersedes every read of the report it grows: those wait for the
  // stream to stop, and one left running would publish mid-stream (Maia included).
  function cancelForStream() {
    cancelEnrichmentQueues();
    explorerEnrich.cancel();
    engineAgg.cancel();
    document.getElementById("scout-cap-note")?.remove();
    if (scoutState?.prefilterEnrichState === PREFILTER_LOADING) scoutState.prefilterEnrichState = PREFILTER_IDLE;
    if (scoutState?.maiaEnrichState === MAIA_ENRICH_LOADING) scoutState.maiaEnrichState = "idle";
  }

  async function runStream({ session: sessionArg, only } = {}) {
    const session = sessionArg || scoutSession;
    if (!isActiveSession(session)) return;

    const usernames = sourcesToStream(session, only);
    const controllers = usernames.map(() => new AbortController());
    session.controller = {
      abort: () => controllers.forEach((c) => c.abort()),
    };
    session.state = "running";
    session.userStopped = false;
    session.acceptedThisBatch = 0;
    cancelForStream();
    updateScoutControls();

    try {
      const settled = await Promise.allSettled(
        usernames.map((username, i) =>
          scoutClient.streamGames(username, {
            color: session.color,
            // R-05: each source's own cursor only (another source's would skip
            // its history); a restored source first reads the games since its save.
            ...streamWindow(session, username),
            // Big accounts (thousands of games) arrive in batches instead of one
            // unbounded stream that locks the page.
            max: SCOUT_STREAM_BATCH,
            onGame: (game) => {
              game.scoutUsername = username;
              return onScoutGame(game, session);
            },
            signal: controllers[i].signal,
          })
        )
      );
      if (!isActiveSession(session)) return;

      recordStreamResults(session, usernames, settled, {
        aborted: controllers.map((c) => c.signal.aborted),
        errorMessage: (reason) => scoutFetchErrorMessage(reason) || reason?.message || "failed",
      });
      settleRefresh(scoutState, session);
      // R-05: partial failure with results — the report stands, but the gap is
      // visible (persistent warning above the report, not just a toast).
      renderSourceWarnings(session, { results: getResultsEl(), hasGames: Boolean(scoutState?.games?.length),
        onRetry: () => retryFailedSources(session) });
      await onStreamEnd({ accepted: session.acceptedThisBatch }, session);
    } catch (error) {
      if (!isActiveSession(session)) return;
      session.controller = null;
      if (error?.name === "AbortError" || session.userStopped) {
        session.hasMore = true;
        await onStreamEnd({ accepted: session.acceptedThisBatch }, session);
        return;
      }
      const message = scoutFetchErrorMessage(error) || error.message;
      const hasGames = !!scoutState?.games?.length;
      // Match onStreamEnd's timer cleanup so a render debounce left pending by the
      // streaming loop can't fire stale after we settle here.
      renderPipeline.cancel();
      session.gamesSinceRender = 0;
      session.state = hasGames ? "paused" : "idle";
      if (hasGames) {
        // The stream dropped mid-fetch (non-abort) but we already have a rendered
        // report. Run the SAME deferred enrichment (Maia/explorer/engine) the clean
        // stream-end path runs — otherwise the report is permanently stuck on
        // empirical-only scores, because enrichment is gated behind a non-streaming
        // render that this error path would otherwise never trigger.
        if (session.acceptedThisBatch > 0) {
          invalidatePrefilterState();
        }
        flushRender();
        saveToHistory(session);
      } else {
        showScoutEmptyState(session, scoutSourceFailureMessage(session) || message);
      }
      updateScoutControls();
    }
  }

  function stopStream(session) {
    if (!session?.controller) return;
    session.userStopped = true;
    session.controller.abort();
  }

  function resetScout() {
    initGuard.invalidate();
    stopStream(scoutSession);
    cancelScoutWork();
    scoutState = null;
    scoutSession = null;
    scoutSourceNames = null;
    document.getElementById("scout-source-warnings")?.remove();
    const results = getResultsEl();
    const profile = getProfileEl();
    if (results) {
      results.innerHTML = "";
      results.classList.remove("is-streaming");
      // The open colour tab belongs to this report: a next report without that
      // colour would otherwise open on no section at all.
      delete results.dataset.scoutTab;
    }
    if (profile) profile.hidden = true;
    clearScoutSide();
    lastPhaseKey = "";
    updateLiveCounter();
    updateScoutControls();
    setStatus("");
  }

  // Self can change when accounts are linked/unlinked in Settings, without a
  // source-composer write. This also invalidates an initialization in flight.
  function syncSources() {
    // Sources can change while this panel is hidden (a composer opened from
    // elsewhere), where the unmount cleanup does not run: clear here instead.
    if (scoutSourceNames && !sameFetchSources(scoutSourceNames, scoutPickedUsernames())) {
      resetScout();
      if (!scoutPickedUsernames().length) setStatus("");
    }
  }

  async function startScout() {
    // Scout reads your repertoires and the account-scoped Explorer proxy; a
    // guest gets the sign-in gate instead of a "not authenticated" banner.
    if (!requireSignIn("Sign in to scout an opponent", "scout-start")) return;
    const initToken = initGuard.tryBegin();
    if (initToken == null) return;

    const colorSel = document.getElementById("scout-color");
    // Single source of truth: the shared Source Composer selection (Self group
    // + linked picks + composer external usernames unioned). The standalone
    // username textbox is gone — no typed fallback.
    const usernames = scoutPickedUsernames();
    if (!usernames.length) {
      initGuard.finish(initToken);
      updateScoutControls();
      setStatus("No Scout sources selected. Open Add and pick Self, an account, or a username.");
      return;
    }
    const color = colorSel?.value || "both";
    scoutSourceNames = usernames.slice();
    const results = getResultsEl();
    const profile = getProfileEl();
    // A saved run of these sources and colour opens at once (read beside the repertoires).
    const owner = currentOwnerId();
    const savedRun = scoutHistory && owner
      ? Promise.resolve().then(() => scoutHistory.load(owner, scoutHistory.key(usernames, color))).catch(() => null) : null;

    stopStream(scoutSession);
    // Every stage of the previous report: an explorer read or engine
    // aggregation still in flight would otherwise publish into the new report.
    cancelScoutWork();

    updateScoutControls();

    try {
      const ready = await initScoutState(usernames, color, initToken);
      if (!ready || !initGuard.isCurrent(initToken)) return;

      initGuard.finish(initToken);
      updateScoutControls();

      const session = scoutSession;
      if (!session || !isActiveSession(session)) return;

      if (results) {
        results.innerHTML = "";
        results.classList.add("is-streaming");
        delete results.dataset.scoutTab;
      }
      clearScoutSide();
      if (profile) profile.hidden = true;
      const saved = await savedRun;
      if (!isActiveSession(session)) return;
      if (restoreScoutRun(scoutState, session, saved)) flushRender();
      updateLiveCounter();
      await runStream({ session });
      if (isActiveSession(session)) results?.classList.remove("is-streaming");
    } catch (error) {
      if (!initGuard.isCurrent(initToken)) return;
      const message = scoutFetchErrorMessage(error) || error.message || "Scout failed";
      scoutState = null;
      scoutSession = null;
      if (results) results.innerHTML = scoutErrorHtml("Scout stopped", message);
      if (profile) profile.hidden = true;
    } finally {
      initGuard.finish(initToken);
      updateScoutControls();
    }
  }

  async function resumeScout() {
    const session = scoutSession;
    if (!session || !scoutState) return;
    const results = getResultsEl();
    if (results) results.classList.add("is-streaming");
    await runStream({ session });
    if (isActiveSession(session)) results?.classList.remove("is-streaming");
  }

  async function handleScoutAction() {
    const action = scoutSession?.state;
    if (action === "running") stopStream(scoutSession);
    else if (action === "paused") await resumeScout();
    else await startScout();
  }

  function bindControls() {
    const scoutBtn = document.getElementById("scout-btn");
    if (!scoutBtn || scoutBtn.dataset.scoutBound) return;
    scoutBtn.dataset.scoutBound = "1";
    scoutBtn.addEventListener("click", handleScoutAction);

    const resetBtn = document.getElementById("scout-reset-btn");
    if (resetBtn && !resetBtn.dataset.scoutBound) {
      resetBtn.dataset.scoutBound = "1";
      resetBtn.addEventListener("click", resetScout);
    }

    bindScoutEvents();
    void loadScoutModule();

    updateScoutControls();
  }

  return {
    runScout: handleScoutAction, handleScoutAction, bindControls,
    // History → Open: a new Start of the sources and colour the controller just set.
    startScout,
    useHistory(next) { ({ scoutHistory, currentOwnerId, onScoutHistorySaved = () => {} } = next); },
    __testHandleAddToPrep: scoutAddToPrep,
    __testHandlePrepareAll: scoutPrepareAll,
    onShow: syncVisibleState,
    // Sources changed under a finished or running report (app.js).
    discardReport: resetScout,
    syncSources,
    // Maia analysis turned on: an open report takes its Maia reads now.
    onMaiaGate() { if (scoutState?.games?.length) maiaEnrich.schedule(); },
    ...(SCOUT_E2E_BUILD_ENABLED ? { mountE2eRefutationScenario } : {}),
    preload: () => import("../scout.js"),
  };
}
