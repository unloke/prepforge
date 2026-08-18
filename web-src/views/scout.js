// Scout UI (Replay tab card) — lazy-loaded from app.js.
// Pure fetch/parse logic stays in ../scout.js; rendering helpers in ../scout-report.js.

import {
  buildScoutAnalyzePgn,
  buildScoutSectionReport,
  buildScoutShareText,
  captureScoutExpanded,
  consumeEcoCacheEntry,
  handleScoutProfileClick,
  handleScoutResultsClick,
  renderScoutRefutationPanel,
  mergeEnginePatternsIntoSections,
  renderMiniBoardHtml as renderScoutMiniBoardHtml,
  renderScoutProfile,
  restoreScoutExpanded,
  scoutDistRowHtml,
  scoutLineDetailHtml,
  scoutLineKey,
} from "../scout-report.js";
import { createScoutInitGuard, scoutStateCarryover } from "../scout-init-guard.js";
import { renderV12Report } from "../scout-v12-report.js";
import { renderV13PanelShell, renderV13Report } from "../scout-v13-report.js";
import { CancelledError, runStreamV13 } from "../scout-v13-stream.js";

const SCOUT_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_SCOUT_E2E === "1";
import { colorRecommendation } from "../scout-stats.js";
import { buildColorRecommendationBanner } from "../scout-summary.js";
import { engineScanPatterns } from "../scout-engine.js";
import {
  MAIA_ENRICH_LOADING,
  SCOUT_MAIA_SUCCESS_TARGET,
  SCOUT_MAIA_TARGET_COUNT,
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
  PREFILTER_FAILED,
  PREFILTER_IDLE,
  PREFILTER_LOADING,
  PREFILTER_READY,
  SCOUT_PREFILTER_LIMIT,
  buildFallbackPrefilterData,
  computePrefilterScopeKey,
  mergeGlobalPrefilterRanked,
  runStockfishPrefilter,
} from "../scout-prefilter.js";
import {
  SCOUT_ERR_NETWORK,
  SCOUT_ERR_NO_GAMES,
  opponentColorBaseline,
  scoutFetchErrorMessage,
  trimRankedBranches,
} from "../scout.js";

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

function scoutErrorHtml(message, escapeHtml) {
  return `<div class="scout-error" role="alert">${escapeHtml(message)}</div>`;
}

export function createScoutView(deps) {
  const {
    escapeHtml,
    setStatus,
    switchView,
    api,
    showInputModal,
    createRepertoirePrompt,
    editRepertoire,
    boardAfterMove,
    buildProvisionalNode,
    hardFlushBuild,
    selectBuildNode,
    resolveBuildId,
    setBuildSync,
    jobToast,
    parseFenBoard,
    pieceSvg,
    getBuildState,
    getBuildNodeById,
    setBuildPending,
    pushBuildNode,
    connectLichess,
    loadPgnIntoAnalyze,
    effectiveMaiaRating,
    getLichessUsername = () => null,
    effectiveStockfishDepth = () => 16,
  } = deps;

  let scoutModule = null;
  let scoutClient = null;
  let scoutExplorerClient = null;
  let scoutExplorerModule = null;
  let scoutEngineModule = null;
  let scoutState = null;
  let scoutSession = null;
  const scoutBoundEventTargets = new WeakSet();
  let explorerEnrichTimer = null;
  let explorerEnrichSeq = 0;
  let maiaEnrichTimer = null;
  let maiaEnrichSeq = 0;
  let maiaEnrichInFlight = false;
  let maiaEnrichActiveGen = 0;
  let prefilterEnrichTimer = null;
  let prefilterEnrichSeq = 0;
  let prefilterEnrichInFlight = false;
  let prefilterEnrichActiveGen = 0;
  // Memo for maiaCandidateLines, keyed by trie identity (fresh per report rebuild).
  const maiaCandidateCache = new WeakMap();
  const prefilterCandidateCache = new WeakMap();
  let engineAggTimer = null;
  let engineAggSeq = 0;
  let scoutOpGen = 0;
  let deepScanAbort = null;
  const initGuard = createScoutInitGuard();

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

  function updateLiveCounter() {
    const el = document.getElementById("scout-live-count");
    if (el) el.textContent = String(scoutState?.games?.length || 0);
  }

  function engineProgressLabel(p) {
    if (p?.phase === "maia") {
      return p.total > 0
        ? `Reading human tendencies · ${p.done}/${p.total}`
        : "Reading human tendencies…";
    }
    return p && p.total > 0
      ? `Analyzing openings · ${p.done}/${p.total}`
      : "Analyzing openings…";
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
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const p = scoutState?.engineProgress;
    // Indeterminate until the first position settles (total unknown): show a sweeping bar
    // instead of a frozen sliver so the user can tell it's working, not stuck.
    const indeterminate = !p || !p.total;
    const pct = engineProgressPct(p);
    el.hidden = false;
    el.classList.toggle("is-indeterminate", indeterminate);
    el.setAttribute("role", "progressbar");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    if (indeterminate) {
      el.removeAttribute("aria-valuenow");
    } else {
      el.setAttribute("aria-valuenow", String(pct));
    }
    el.innerHTML = `
      <div class="scout-progress-row">
        <span class="scout-progress-label">${escapeHtml(engineProgressLabel(p))}</span>
        <span class="scout-progress-count">${indeterminate ? "" : `${pct}%`}</span>
      </div>
      <div class="scout-progress-track"><div class="scout-progress-fill" style="width:${indeterminate ? 40 : pct}%"></div></div>`;
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
      if (initGuard.isInitializing) {
        btn.textContent = "Start";
        btn.dataset.scoutAction = "start";
        btn.disabled = true;
      } else if (state === "running") {
        btn.textContent = "Stop";
        btn.dataset.scoutAction = "stop";
        btn.disabled = false;
      } else if (state === "paused") {
        btn.textContent = "Resume";
        btn.dataset.scoutAction = "resume";
        btn.disabled = false;
      } else if (state === "done") {
        btn.textContent = "Start";
        btn.dataset.scoutAction = "start";
        btn.disabled = false;
      } else {
        btn.textContent = "Start";
        btn.dataset.scoutAction = "start";
        btn.disabled = false;
      }
    }
    if (resetBtn) {
      resetBtn.hidden = state === "idle" || state === "running";
    }
    if (colorSel) {
      colorSel.disabled = state !== "idle";
    }
    if (card) {
      card.classList.toggle("is-streaming", state === "running");
    }
  }

  function syncVisibleState() {
    bindScoutEvents();
    updateScoutControls();
    updateLiveCounter();

    // v13 / v12 experimental panels paint standalone — no classic report required.
    if (isV13Mode()) paintV13Panel();
    else if (isV12Mode()) paintV12Panel();

    const results = getResultsEl();
    const profile = getProfileEl();
    if (scoutState) {
      const hasReport = !!results?.innerHTML?.trim();
      if (scoutState.games?.length && !hasReport) {
        renderScoutReport({ force: true });
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
      scoutModule.insertGameIntoTrie(white, g, "white", { anchorTs });
      scoutModule.insertGameIntoTrie(black, g, "black", { anchorTs });
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
    scoutModule.insertGameIntoTrie(scoutState.liveTries.white, game, "white", { anchorTs });
    scoutModule.insertGameIntoTrie(scoutState.liveTries.black, game, "black", { anchorTs });
    scoutState.liveTrieCount = scoutState.games.length;
  }

  function renderScoutReport({ force = false } = {}) {
    if (!scoutState) return;
    const profileEl = getProfileEl();
    const results = getResultsEl();
    const captured = results ? captureScoutExpanded(results) : null;

    if (profileEl) {
      profileEl.innerHTML = renderScoutProfile(
        scoutState.profile,
        scoutState.username,
        scoutState.activeSpeed,
        escapeHtml,
        {
          colorRecHtml: buildColorRecommendationBanner(
            colorRecommendation(scoutState.games),
            escapeHtml,
          ),
        },
      );
      profileEl.hidden = false;
    }
    scoutState.sections = {};
    scoutState.maiaResults = scoutState.maiaResults || new Map();
    if (scoutState.games?.length) {
      scoutState.maiaRatings = {
        white: medianOpponentRating(scoutState.games, "white"),
        black: medianOpponentRating(scoutState.games, "black"),
      };
    }
    const maiaOpts = {
      maiaResults: scoutState.maiaResults,
      maiaRatings: scoutState.maiaRatings,
      maiaEnrichState: scoutState.maiaEnrichState || "idle",
      prefilterEnrichState: scoutState.prefilterEnrichState || "idle",
      prefilteredLines: scoutState.prefilteredLines?.white,
    };
    const speedOpts = {
      speedFilter: scoutState.activeSpeed,
      v3Mode: isV12Mode() || isV13Mode(),
      escapeHtml,
      enginePatterns: engineScanPatterns(scoutState.engineByColor?.white),
      explorerReads: scoutState.explorerByColor?.white || null,
      engineAgg: engineAggForColor("white"),
      engineScan: engineScanForColor("white"),
      ...maiaOpts,
    };
    const whiteReport = buildScoutSectionReport(
      scoutModule,
      scoutState,
      "white",
      scoutState.lookups.black,
      { ...speedOpts, trie: liveTrieForColor("white") },
    );
    if (whiteReport.sectionData) scoutState.sections.white = whiteReport.sectionData;
    const blackReport = buildScoutSectionReport(
      scoutModule,
      scoutState,
      "black",
      scoutState.lookups.white,
      {
        ...speedOpts,
        enginePatterns: engineScanPatterns(scoutState.engineByColor?.black),
        explorerReads: scoutState.explorerByColor?.black || null,
        engineAgg: engineAggForColor("black"),
        engineScan: engineScanForColor("black"),
        prefilteredLines: scoutState.prefilteredLines?.black,
        trie: liveTrieForColor("black"),
      },
    );
    if (blackReport.sectionData) scoutState.sections.black = blackReport.sectionData;
    if (scoutState.engineByColor && Object.keys(scoutState.engineByColor).length) {
      mergeEnginePatternsIntoSections(scoutState.sections, scoutState.engineByColor, {
        speedFilter: scoutState.activeSpeed,
      });
    }
    const sections = [whiteReport.html, blackReport.html].filter(Boolean);
    const progressHtml = '<div id="scout-engine-progress" class="scout-engine-progress" hidden></div>';
    if (results) {
      results.innerHTML = sections.length
        ? progressHtml + sections.join("")
        : progressHtml + '<div class="empty-state">Not enough opening data in these games.</div>';
      if (captured) {
        restoreScoutExpanded(results, scoutState.sections, captured, {
          scoutModule,
          escapeHtml,
          ecoCache: scoutState.ecoCache,
          createElement: (tag) => document.createElement(tag),
          callbacks: {
            scoutLineDetailHtml: localScoutLineDetailHtml,
            enrichEcoForLine: enrichEcoForLineCached,
          },
        });
      }
    }
    if (force) updateLiveCounter();
    patchEngineProgressUI();
    // v12/v13 are standalone panels — classic prefilter/Maia enrichment stays v2-only.
    if (!isV12Mode() && !isV13Mode() && !isStreaming() && !isEnrichmentInFlight()) {
      schedulePrefilterEnrich();
    }
  }

  // ---- Scout UI modes -------------------------------------------------------------------------
  // "v2"  (default)      — the classic full report: stats, intel, prefilter/Maia weakness list.
  // "v12" (?scoutV12=1)  — retired manual JSON viewer (reports only if already loaded).
  // "v13" (?scoutV13=1)  — stream-native prep packages from the live game trie.

  function isV12Mode() {
    try {
      return new URLSearchParams(window.location.search).has("scoutV12");
    } catch (_) {
      return false; // no window/location (tests) → default v2
    }
  }

  function isV13Mode() {
    try {
      return new URLSearchParams(window.location.search).has("scoutV13");
    } catch (_) {
      return false;
    }
  }

  function getV12PanelEl() {
    return document.getElementById("scout-v3-results");
  }

  let v12Audits = [];
  let v13Result = null;
  let v13Running = false;
  let v13CancelRequested = false;
  let v13Progress = { stage: "", done: 0, total: 0 };

  function v12MiniBoard(fen, orientation) {
    return renderScoutMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg });
  }

  function v12ReportHtml() {
    return v12Audits.length
      ? renderV12Report(v12Audits, { escapeHtml, renderMiniBoard: v12MiniBoard })
      : "";
  }

  function paintV12Panel() {
    const el = getV12PanelEl();
    if (!el) return;
    el.hidden = false;
    const reportHtml = v12ReportHtml();
    el.innerHTML = `<div class="scout-v12-panel">
      <div class="scout-v12-panel-head">
        <strong>${escapeHtml("Tendency-aligned routes(實驗報告)")}</strong>
        <span class="scout-v12-badge">v12 experimental</span>
      </div>
      <p class="scout-v12-retired-note">${escapeHtml("手動載入 audit JSON 已停用；請改用 ?scoutV13=1 從棋手對局直接產生備戰套件。")}</p>
      <div id="scout-v12-report-host">${reportHtml}</div>
    </div>`;
  }

  function v13MiniBoard(fen, orientation) {
    return renderScoutMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg });
  }

  // v13 is per subject colour (design §4: 每色 3–4 包); "both" mode runs each colour
  // that actually has trie data instead of collapsing to one.
  function v13SubjectColors() {
    const sel = scoutState?.color;
    const wanted = sel === "white" || sel === "black" ? [sel] : ["black", "white"];
    return wanted.filter((c) => liveTrieForColor(c)?.children?.size);
  }

  function v13TrieReady() {
    return v13SubjectColors().length > 0;
  }

  function v13ProgressLabel() {
    const p = v13Progress;
    const colorNote = p.colorLabel ? `(顏色 ${p.colorLabel})` : "";
    if (p.stage === "funnel") return `備戰套件篩選中${colorNote}…`;
    if (p.stage === "candidate" && p.total) {
      return `分析候選路線 ${p.done + 1}/${p.total}${colorNote}…`;
    }
    return "產生備戰套件中…";
  }

  function paintV13Panel() {
    const el = getV12PanelEl();
    if (!el) return;
    el.hidden = false;
    const reportHtml = (v13Result || [])
      .map(({ color, result }) => {
        const heading = color === "white" ? "他執白時" : "他執黑時";
        return `<h4 class="scout-v13-color-head">${escapeHtml(heading)}</h4>${renderV13Report(
          result,
          { escapeHtml, renderMiniBoard: v13MiniBoard },
        )}`;
      })
      .join("");
    el.innerHTML = renderV13PanelShell({
      escapeHtml,
      playerName: scoutState?.username || "—",
      reportHtml,
      canGenerate: v13TrieReady(),
      running: v13Running,
      progressDone: v13Progress.done,
      progressTotal: v13Progress.total,
      progressLabel: v13ProgressLabel(),
    });
  }

  async function runV13PrepPackages() {
    if (v13Running || !scoutModule) return;
    const colors = v13SubjectColors();
    if (!colors.length) {
      setStatus("Need opponent games in the stream before generating prep packages");
      return;
    }

    v13Running = true;
    v13CancelRequested = false;
    v13Progress = { stage: "candidate", done: 0, total: 0 };
    paintV13Panel();

    // Stale-run guard: a new scout session (different player / reset) cancels this
    // run and its result must never land on the repainted panel.
    const runUsername = scoutState?.username;
    const isStale = () => v13CancelRequested || scoutState?.username !== runUsername;

    let provider = null;
    try {
      const sfDepth = effectiveStockfishDepth();
      const extDepth = Math.max(12, sfDepth - 4);
      const opponentRating =
        colors.length > 1
          ? Math.round(
              (medianOpponentRating(scoutState.games, "white") +
                medianOpponentRating(scoutState.games, "black")) / 2,
            )
          : medianOpponentRating(scoutState.games, colors[0]);
      const speed =
        scoutState.activeSpeed && scoutState.activeSpeed !== "all"
          ? scoutState.activeSpeed
          : "blitz";

      let explorerClient = scoutExplorerClient;
      let explorerAvailable = Boolean(getLichessUsername());
      if (!explorerClient) {
        try {
          const explorerMod = await import("../explorer.js");
          explorerClient = explorerMod.createExplorerClient({});
          scoutExplorerClient = explorerClient;
        } catch (_) {
          explorerAvailable = false;
        }
      }

      const engineMod = await import("../engine/stockfish-provider.js");
      const runnerMod = await import("../engine/build-generate-runner.js");
      provider = engineMod.createEngineProvider({ maxDepth: sfDepth, maxMultipv: 3 });
      const engineCandidates = runnerMod.createEngineCandidateAdapter(provider, {
        maxMultipv: 3,
        signal: {
          get aborted() {
            return isStale();
          },
        },
      });

      const explorerFetch = async (epd) => {
        if (!explorerAvailable || !explorerClient) return null;
        try {
          return await explorerClient.fetchStats("lichess", epd, { rating: opponentRating });
        } catch (_) {
          explorerAvailable = false;
          return null;
        }
      };

      const results = [];
      for (let ci = 0; ci < colors.length; ci += 1) {
        const subjectColor = colors[ci];
        const trie = liveTrieForColor(subjectColor);
        if (!trie?.children?.size) continue;
        const games = (scoutState?.games || []).filter((g) => g.color === subjectColor);
        const result = await runStreamV13({
          trie,
          subjectColor,
          opponentRating,
          games,
          deps: {
            engineCandidates: (fen, count) => engineCandidates.candidates(fen, count),
            explorerFetch,
            sfDepth,
            extDepth,
            speeds: speed,
            explorerAvailable,
          },
          shouldCancel: isStale,
          onProgress: (stage, done, total) => {
            v13Progress = {
              stage: `${stage}`,
              done,
              total,
              colorLabel: colors.length > 1 ? `${ci + 1}/${colors.length}` : "",
            };
            paintV13Panel();
          },
        });
        results.push({ color: subjectColor, result });
      }

      if (!isStale()) {
        v13Result = results;
        const totalPkgs = results.reduce((n, r) => n + r.result.report.packages.length, 0);
        setStatus(`Prep packages ready: ${totalPkgs} package(s)`);
      }
    } catch (err) {
      if (err instanceof CancelledError || isStale()) {
        setStatus("Prep package generation cancelled");
      } else {
        setStatus(`Prep package generation failed: ${err.message || err}`);
      }
    } finally {
      try {
        await provider?.close?.();
      } catch (_) {
        /* best-effort */
      }
      v13Running = false;
      paintV13Panel();
    }
  }

  // Resolve a rendered card's "auditIdx:tendencyIdx:routeIdx" key back to its route + meta.
  function v12RouteByKey(key) {
    const [a, t, r] = String(key || "").split(":").map((n) => Number.parseInt(n, 10));
    const audit = v12Audits[a];
    const route = audit?.tendencies?.[t]?.routes?.[r];
    if (!route) return null;
    return { route, meta: audit.meta || {} };
  }

  function v12RouteAsLine(route) {
    return { ucis: [...(route.ucis || [])], sans: String(route.sanLine || "").split(/\s+/).filter(Boolean) };
  }

  async function handleV12ActionClick(e) {
    const btn = e.target?.closest?.("[data-v12-action]");
    if (!btn) return false;
    const hit = v12RouteByKey(btn.dataset.v12Route);
    if (!hit) return true;
    const line = v12RouteAsLine(hit.route);
    const oppColor = hit.meta.subjectColor === "white" ? "white" : "black";
    if (btn.dataset.v12Action === "analyze") {
      scoutAnalyzeLine(line, oppColor, scoutState?.username || "Opponent");
    } else if (btn.dataset.v12Action === "build") {
      await scoutAddToPrep(line, oppColor);
    }
    return true;
  }

  function scheduleRender({ force = false } = {}) {
    if (!scoutSession) return;
    scoutSession.gamesSinceRender += 1;
    const forceEvery = scoutRenderForceEvery(scoutState?.games?.length || 0);
    if (force || scoutSession.gamesSinceRender >= forceEvery) {
      clearTimeout(scoutSession.renderTimer);
      scoutSession.renderTimer = null;
      flushRender();
      scoutSession.gamesSinceRender = 0;
      return;
    }
    if (scoutSession.renderTimer) return;
    const debounceMs = scoutRenderDebounceMs(scoutState?.games?.length || 0);
    scoutSession.renderTimer = setTimeout(() => {
      scoutSession.renderTimer = null;
      flushRender();
      scoutSession.gamesSinceRender = 0;
    }, debounceMs);
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
    if (isV13Mode()) paintV13Panel();
    if (!isStreaming()) {
      scheduleExplorerEnrich();
      scheduleEngineAggregation();
    }
  }

  function isEnrichmentInFlight() {
    return (
      (prefilterEnrichInFlight && prefilterEnrichActiveGen === prefilterEnrichSeq) ||
      (maiaEnrichInFlight && maiaEnrichActiveGen === maiaEnrichSeq)
    );
  }

  function cancelEnrichmentQueues() {
    clearTimeout(prefilterEnrichTimer);
    prefilterEnrichTimer = null;
    prefilterEnrichSeq += 1;
    clearTimeout(maiaEnrichTimer);
    maiaEnrichTimer = null;
    maiaEnrichSeq += 1;
  }

  function schedulePrefilterEnrich() {
    clearTimeout(prefilterEnrichTimer);
    const gen = ++prefilterEnrichSeq;
    prefilterEnrichTimer = setTimeout(() => {
      prefilterEnrichTimer = null;
      enrichPrefilterReads(gen);
    }, PREFILTER_ENRICH_DEBOUNCE_MS);
  }

  function scheduleMaiaEnrich() {
    clearTimeout(maiaEnrichTimer);
    const gen = ++maiaEnrichSeq;
    maiaEnrichTimer = setTimeout(() => {
      maiaEnrichTimer = null;
      enrichMaiaReads(gen);
    }, MAIA_ENRICH_DEBOUNCE_MS);
  }

  function openingBranchBundleForColor(section, oppColor) {
    if (!scoutState?.games?.length || !scoutModule?.rankedOpeningBranches) {
      return { branches: [], ancestorFreq: new Map() };
    }
    // The trie + baseline make rankedOpeningBranches select Stockfish candidates by the
    // exploitability prior (struggle × rarity × family reproducibility) instead of raw
    // frequency, and annotate each branch with prefix-resolved struggle/offModal signals.
    // Full ranked list (limit: 0), then trimRankedBranches: primary cut is the prior-signal
    // floor (drops transposition noise); min-keep fills the Maia backup pool; 300 is only a
    // pathological-corpus ceiling on the cheap trie-walk/FEN step.
    const { branches, ancestorFreq } =
      scoutModule.rankedOpeningBranches(scoutState.games, oppColor, {
        speedFilter: scoutState.activeSpeed,
        trie: section?.trie || null,
        baselineScorePct: baselineScorePctForColor(oppColor),
        limit: 0,
      }) || { branches: [], ancestorFreq: new Map() };
    return { branches: trimRankedBranches(branches), ancestorFreq };
  }

  function allOpeningLinesForColor(section, oppColor) {
    const { branches, ancestorFreq } = openingBranchBundleForColor(section, oppColor);
    scoutState.ancestorFreq = scoutState.ancestorFreq || { white: new Map(), black: new Map() };
    scoutState.ancestorFreq[oppColor] = ancestorFreq;
    return branches;
  }

  function prefilterPoolForColor(section, oppColor) {
    if (!section?.trie) return [];
    let byColor = prefilterCandidateCache.get(section.trie);
    if (byColor) {
      const hit = byColor.get(oppColor);
      if (hit) return hit;
    } else {
      byColor = new Map();
      prefilterCandidateCache.set(section.trie, byColor);
    }
    const pool = scoutState?.prefilterPools?.[oppColor] || [];
    byColor.set(oppColor, pool);
    return pool;
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
    scoutState.ancestorFreq = { white: new Map(), black: new Map() };
  }

  function syncMaiaScope() {
    if (!scoutState?.games?.length) return;
    scoutState.maiaRatings = {
      white: medianOpponentRating(scoutState.games, "white"),
      black: medianOpponentRating(scoutState.games, "black"),
    };
    const scopeKey = computeMaiaScopeKey({
      activeSpeed: scoutState.activeSpeed,
      gameCount: scoutState.games.length,
      ratings: scoutState.maiaRatings,
    });
    if (resetMaiaScopeCache(scoutState, scopeKey)) {
      scoutState.maiaAttemptsUsed = 0;
    }
  }

  /** Stockfish-ranked pool for Maia enrichment (top 12 + backup headroom). */
  function maiaCandidateLines(section, oppColor) {
    if (!section?.trie) return [];
    const pool = prefilterPoolForColor(section, oppColor);
    if (pool.length) return pool;
    let byColor = maiaCandidateCache.get(section.trie);
    if (byColor) {
      const hit = byColor.get(oppColor);
      if (hit) return hit;
    } else {
      byColor = new Map();
      maiaCandidateCache.set(section.trie, byColor);
    }
    const fallback = allOpeningLinesForColor(section, oppColor).slice(0, SCOUT_PREFILTER_LIMIT);
    byColor.set(oppColor, fallback);
    return fallback;
  }

  function displayLinesForColor(section, oppColor) {
    const display = scoutState?.prefilteredLines?.[oppColor];
    if (display?.length) return display;
    return maiaCandidateLines(section, oppColor).slice(0, SCOUT_MAIA_TARGET_COUNT);
  }

  function baselineScorePctForColor(oppColor) {
    return (
      scoutState.sections?.[oppColor]?.baselineScorePct ??
      opponentColorBaseline(scoutState.games, oppColor, {
        speedFilter: scoutState.activeSpeed,
      })
    );
  }

  function prefilterBaselineByColor() {
    return {
      white: baselineScorePctForColor("white"),
      black: baselineScorePctForColor("black"),
    };
  }

  function globalMaiaRankedPool() {
    return mergeGlobalPrefilterRanked(scoutState?.prefilterRanked || {}, {
      baselineByColor: prefilterBaselineByColor(),
    });
  }

  function snapshotStockfishDisplayLine(oppColor, lines) {
    scoutState.stockfishDisplayLines = scoutState.stockfishDisplayLines || { white: [], black: [] };
    scoutState.stockfishDisplayLines[oppColor] = lines;
  }

  function applyPrefilterFallbackForColor(section, oppColor) {
    const lines = allOpeningLinesForColor(section, oppColor);
    if (!lines.length) return;
    const fallback = buildFallbackPrefilterData(lines);
    scoutState.prefilterPools[oppColor] = fallback.pool;
    scoutState.prefilterRanked[oppColor] = fallback.ranked;
    scoutState.prefilteredLines[oppColor] = fallback.maiaLines;
    snapshotStockfishDisplayLine(oppColor, fallback.maiaLines);
    if (section?.trie) prefilterCandidateCache.delete(section.trie);
  }

  function refreshGamePlanDisplayLines() {
    if (!scoutState?.games?.length || !scoutModule) return;
    scoutState.stockfishDisplayLines = scoutState.stockfishDisplayLines || { white: [], black: [] };
    scoutState.prefilteredLines = scoutState.prefilteredLines || { white: [], black: [] };
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

  async function enrichPrefilterReads(gen) {
    if (!scoutState?.games?.length || !scoutModule) return;
    if (gen !== prefilterEnrichSeq) return;
    const scopeKey = currentPrefilterScopeKey();
    const prefilterSettled =
      scoutState.prefilterEnrichState === PREFILTER_READY ||
      scoutState.prefilterEnrichState === PREFILTER_FAILED;
    if (
      prefilterSettled &&
      scoutState.prefilterScopeKey === scopeKey &&
      globalMaiaRankedPool().length
    ) {
      scheduleMaiaEnrich();
      return;
    }

    prefilterEnrichActiveGen = gen;
    prefilterEnrichInFlight = true;
    scoutState.prefilterEnrichState = PREFILTER_LOADING;
    scoutState.engineProgress = { phase: "stockfish", done: 0, total: 0 };
    scoutState.prefilterPools = scoutState.prefilterPools || { white: [], black: [] };
    scoutState.prefilterRanked = scoutState.prefilterRanked || { white: [], black: [] };
    scoutState.prefilteredLines = scoutState.prefilteredLines || { white: [], black: [] };
    scoutState.prefilterCache = scoutState.prefilterCache || new Map();
    renderScoutReport();

    // Carry positions counted in earlier colours so the bar climbs monotonically across
    // the white→black passes instead of snapping back to 0% when black starts.
    let sfBaseDone = 0;
    let sfBaseTotal = 0;
    try {
      for (const oppColor of ["white", "black"]) {
        if (gen !== prefilterEnrichSeq) return;
        const section = scoutState.sections?.[oppColor];
        const lines = allOpeningLinesForColor(section, oppColor);
        if (!lines.length) continue;
        let lastColorProgress = { done: 0, total: 0 };
        const result = await runStockfishPrefilter(lines, {
          fenAfterLine: scoutModule.fenAfterLine,
          oppColor,
          ancestorFreq: scoutState.ancestorFreq?.[oppColor],
          baselineScorePct: baselineScorePctForColor(oppColor),
          cache: scoutState.prefilterCache,
          shouldCancel: () => gen !== prefilterEnrichSeq,
          onProgress: (p) => {
            if (gen !== prefilterEnrichSeq) return;
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
        if (gen !== prefilterEnrichSeq) return;
        scoutState.funnel = scoutState.funnel || {};
        scoutState.funnel[oppColor] = result.funnel;
        if (!result.ranked?.length) {
          applyPrefilterFallbackForColor(section, oppColor);
        } else {
          scoutState.prefilterPools[oppColor] = result.pool;
          scoutState.prefilterRanked[oppColor] = result.ranked;
          scoutState.prefilteredLines[oppColor] =
            result.maiaLines.length > 0
              ? result.maiaLines
              : lines.slice(0, SCOUT_PREFILTER_LIMIT);
          snapshotStockfishDisplayLine(oppColor, scoutState.prefilteredLines[oppColor]);
          if (section?.trie) prefilterCandidateCache.delete(section.trie);
        }
      }
      if (gen !== prefilterEnrichSeq) return;
      if (typeof console !== "undefined" && console.table) {
        const rows = {};
        for (const c of ["white", "black"]) {
          const f = scoutState.funnel?.[c];
          if (!f) continue;
          rows[c] = {
            totalLines: f.totalLines,
            scored: f.scored,
            comfortZone: f.gateDrops?.comfortZone,
            failedOrGate: f.gateDrops?.failedOrGate,
            survived: f.survived,
            afterCollapse: f.afterCollapse,
            pool: f.poolSize,
            maiaCandidates: f.maiaCandidates,
          };
        }
        console.table(rows);
        console.debug("[scout-funnel] scoreDrops", {
          white: scoutState.funnel?.white?.scoreDrops,
          black: scoutState.funnel?.black?.scoreDrops,
        });
      }
      scoutState.prefilterEnrichState = PREFILTER_READY;
      scoutState.prefilterScopeKey = scopeKey;
    } catch (_) {
      if (gen === prefilterEnrichSeq && scoutState) {
        for (const oppColor of ["white", "black"]) {
          if (scoutState.prefilterPools?.[oppColor]?.length) continue;
          const section = scoutState.sections?.[oppColor];
          applyPrefilterFallbackForColor(section, oppColor);
        }
        scoutState.prefilterEnrichState = PREFILTER_FAILED;
        scoutState.prefilterScopeKey = scopeKey;
      }
    } finally {
      if (gen === prefilterEnrichActiveGen) {
        prefilterEnrichInFlight = false;
      }
      if (gen === prefilterEnrichSeq && scoutState) {
        renderScoutReport();
        scheduleMaiaEnrich();
      }
    }
  }

  function summarizeMaiaOutcomes() {
    if (!scoutState?.maiaResults || !scoutModule) {
      return { resolved: 0, failed: 0, missing: 0, expected: 0 };
    }
    return countGlobalMaiaOutcomes(globalMaiaRankedPool(), {
      successTarget: SCOUT_MAIA_SUCCESS_TARGET,
      ...maiaPoolContext(),
    });
  }

  function stashMaiaFunnel(outcomes) {
    scoutState.funnel = scoutState.funnel || {};
    scoutState.funnel.maia = {
      globalPool: globalMaiaRankedPool().length,
      attempts: scoutState.maiaAttemptsUsed || 0,
      resolved: outcomes.resolved,
      failed: outcomes.failed,
      missing: outcomes.missing,
      expected: outcomes.expected,
    };
    console.debug("[scout-funnel] maia", scoutState.funnel.maia);
  }

  function maiaWorkRemaining() {
    if (!scoutState?.maiaResults || !scoutModule) return false;
    return globalMaiaPoolNeedsWork(globalMaiaRankedPool(), {
      successTarget: SCOUT_MAIA_SUCCESS_TARGET,
      attemptsUsed: scoutState.maiaAttemptsUsed || 0,
      ...maiaPoolContext(),
    });
  }

  async function enrichMaiaReads(gen) {
    if (!scoutState?.games?.length || !scoutModule) return;
    if (gen !== maiaEnrichSeq) return;
    if (prefilterEnrichInFlight && prefilterEnrichActiveGen === prefilterEnrichSeq) return;
    const prefilterState = scoutState.prefilterEnrichState;
    const prefilterDone =
      prefilterState === PREFILTER_READY || prefilterState === PREFILTER_FAILED;
    if (!prefilterDone || !globalMaiaRankedPool().length) return;

    scoutState.maiaResults = scoutState.maiaResults || new Map();
    scoutState.maiaCache = scoutState.maiaCache || new Map();
    syncMaiaScope();

    const needsWork = maiaWorkRemaining();
    if (!needsWork) {
      refreshGamePlanDisplayLines();
      const outcomes = summarizeMaiaOutcomes();
      stashMaiaFunnel(outcomes);
      const nextState = classifyMaiaEnrichState(outcomes);
      if (scoutState.maiaEnrichState !== nextState) {
        scoutState.maiaEnrichState = nextState;
        renderScoutReport();
      }
      // No render when state is unchanged — avoids a ~1s render loop:
      // renderScoutReport → schedulePrefilterEnrich → enrichPrefilterReads (settled)
      // → scheduleMaiaEnrich → enrichMaiaReads (no work, same state) → renderScoutReport → …
      return;
    }

    maiaEnrichActiveGen = gen;
    maiaEnrichInFlight = true;
    scoutState.maiaEnrichState = MAIA_ENRICH_LOADING;
    scoutState.maiaAttemptsUsed = scoutState.maiaAttemptsUsed || 0;
    scoutState.engineProgress = { phase: "maia", done: 0, total: 0 };
    renderScoutReport();

    try {
      const { getSharedMaia3Provider } = await import("../engine/maia3-provider.js");
      if (gen !== maiaEnrichSeq) return;
      const provider = getSharedMaia3Provider();
      const globalPool = globalMaiaRankedPool();
      if (
        globalMaiaPoolNeedsWork(globalPool, {
          successTarget: SCOUT_MAIA_SUCCESS_TARGET,
          attemptsUsed: scoutState.maiaAttemptsUsed,
          ...maiaPoolContext(),
        })
      ) {
        const { attempts } = await enrichGlobalMaiaPool(globalPool, {
          successTarget: SCOUT_MAIA_SUCCESS_TARGET,
          attemptsUsed: scoutState.maiaAttemptsUsed,
          provider,
          fenAfterLine: scoutModule.fenAfterLine,
          getRating: (oppColor) => scoutState.maiaRatings[oppColor],
          getBaselineScorePct: (oppColor) =>
            scoutState.sections?.[oppColor]?.baselineScorePct ?? 0,
          cache: scoutState.maiaCache,
          maiaResults: scoutState.maiaResults,
          shouldCancel: () => gen !== maiaEnrichSeq,
          onProgress: (p) => {
            if (gen === maiaEnrichSeq) setEngineProgress(p);
          },
        });
        if (gen !== maiaEnrichSeq) return;
        scoutState.maiaAttemptsUsed = attempts;
      }

      if (gen !== maiaEnrichSeq) return;
      refreshGamePlanDisplayLines();
      const outcomes = summarizeMaiaOutcomes();
      stashMaiaFunnel(outcomes);
      scoutState.maiaEnrichState = classifyMaiaEnrichState(outcomes);
    } catch (_) {
      if (gen === maiaEnrichSeq && scoutState) {
        for (const entry of globalMaiaRankedPool()) {
          markUnattemptedMaiaFailures([entry.line], {
            maiaResults: scoutState.maiaResults,
            rating: scoutState.maiaRatings?.[entry.oppColor],
            fenAfterLine: scoutModule.fenAfterLine,
          });
        }
        refreshGamePlanDisplayLines();
        const outcomes = summarizeMaiaOutcomes();
        stashMaiaFunnel(outcomes);
        scoutState.maiaEnrichState = classifyMaiaEnrichState(outcomes);
      }
    } finally {
      if (gen === maiaEnrichActiveGen) {
        maiaEnrichInFlight = false;
      }
      if (gen === maiaEnrichSeq && scoutState) {
        renderScoutReport();
      }
    }
  }

  function scheduleEngineAggregation() {
    clearTimeout(engineAggTimer);
    const gen = ++engineAggSeq;
    engineAggTimer = setTimeout(() => {
      engineAggTimer = null;
      computeEngineAggregation(gen);
    }, ENGINE_AGG_DEBOUNCE_MS);
  }

  async function computeEngineAggregation(gen) {
    if (!scoutState?.games?.length) return;
    if (gen !== engineAggSeq) return;
    try {
      if (!scoutEngineModule) {
        scoutEngineModule = await import("../scout-engine.js");
      }
      if (gen !== engineAggSeq) return;

      const next = {};
      for (const color of ["white", "black"]) {
        if (gen !== engineAggSeq) return;
        const scan = scoutState.engineByColor?.[color];
        if (!scan?.scanRecords?.length) continue;
        if (scan.speedFilter && scan.speedFilter !== scoutState.activeSpeed) continue;
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
      if (gen !== engineAggSeq) return;
      scoutState.engineAggByColor = next;
      if (Object.keys(next).length) {
        renderScoutReport();
      }
    } catch (_) {
      /* engine aggregation is optional */
    }
  }

  function scheduleExplorerEnrich() {
    clearTimeout(explorerEnrichTimer);
    const gen = ++explorerEnrichSeq;
    explorerEnrichTimer = setTimeout(() => {
      explorerEnrichTimer = null;
      enrichExplorerReads(gen);
    }, EXPLORER_ENRICH_DEBOUNCE_MS);
  }

  async function enrichExplorerReads(gen) {
    if (!scoutState?.games?.length || !scoutModule) return;
    if (gen !== explorerEnrichSeq) return;
    try {
      if (!scoutExplorerModule) {
        scoutExplorerModule = await import("../scout-explorer.js");
      }
      if (gen !== explorerEnrichSeq) return;
      const explorerMod = await import("../explorer.js");
      if (!scoutExplorerClient) scoutExplorerClient = explorerMod.createExplorerClient({});
      if (gen !== explorerEnrichSeq) return;

      const rating = scoutState.profile?.ratingLast ?? scoutState.profile?.ratingMax;
      scoutState.explorerByColor = scoutState.explorerByColor || {};
      let changed = false;

      for (const oppColor of ["white", "black"]) {
        if (gen !== explorerEnrichSeq) return;
        const section = scoutState.sections?.[oppColor];
        if (!section?.trie) continue;
        const positions = scoutExplorerModule.collectExplorerProbePositions(
          section.trie,
          scoutModule.fenAfterLine,
        );
        const reads = await scoutExplorerModule.fetchExplorerReads({
          fetchStats: scoutExplorerClient.fetchStats.bind(scoutExplorerClient),
          positions,
          opponentRating: rating,
          shouldCancel: () => gen !== explorerEnrichSeq,
        });
        if (gen !== explorerEnrichSeq) return;
        scoutState.explorerByColor[oppColor] = reads;
        changed = true;
      }

      if (changed && gen === explorerEnrichSeq) {
        renderScoutReport();
      }
    } catch (_) {
      /* explorer reads are optional — hide on failure */
    }
  }

  function localScoutLineDetailHtml(line, idx, oppColor, rowKind = "line") {
    return scoutLineDetailHtml(line, idx, oppColor, rowKind, {
      fenAfterLine: (ucis) => scoutModule.fenAfterLine(ucis),
      renderBoard: (fen, orientation) =>
        renderScoutMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg }),
      escapeHtml,
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
      } catch (_) {
        scoutState.ecoCache.delete(key);
      }
      return;
    }

    const pending = (async () => {
      const explorerMod = await import("../explorer.js");
      if (!scoutExplorerClient) scoutExplorerClient = explorerMod.createExplorerClient({});
      const stats = await scoutExplorerClient.fetchStats("masters", fen, {});
      return stats?.opening || null;
    })();
    scoutState.ecoCache.set(key, pending);
    try {
      const opening = await pending;
      if (opening) {
        scoutState.ecoCache.set(key, opening);
        applyEcoToLine(lineEl, opening);
      } else {
        scoutState.ecoCache.delete(key);
      }
    } catch (_) {
      scoutState.ecoCache.delete(key);
    }
  }

  function scoutAnalyzeLine(line, oppColor, username) {
    const pgn = buildScoutAnalyzePgn(line, oppColor, username);
    const input = document.getElementById("pgn-input");
    if (input) input.value = pgn;
    void loadPgnIntoAnalyze(pgn, { quiet: true }).catch(() => {});
    const drawer = document.getElementById("pgn-drawer");
    if (drawer) drawer.open = true;
    switchView("analyze");
    setStatus(`Loaded ${username}'s line — press "Analyze game" to start`);
  }

  async function scoutPickRepertoire(oppColor, { ownColor = false } = {}) {
    const myColor = ownColor ? oppColor : oppColor === "white" ? "black" : "white";
    let reps = [];
    try {
      const payload = await api("/api/repertoires");
      reps = (payload.repertoires || []).filter(
        (r) => r.is_active !== false && r.color === myColor,
      );
    } catch (error) {
      setStatus(error.message);
      return null;
    }
    const options = [
      ...reps.map((r) => ({ value: r.id, label: `${r.name} (${r.color})` })),
      { value: "__new__", label: "Create new repertoire…" },
    ];
    const result = await showInputModal({
      title: "Add line to prep",
      okLabel: "Continue",
      fields: [
        {
          name: "repertoire",
          label: "Target repertoire",
          type: "select",
          default: reps[0]?.id || "__new__",
          options,
        },
      ],
    });
    if (!result?.repertoire) return null;
    if (result.repertoire === "__new__") {
      const created = await createRepertoirePrompt({
        title: "New repertoire for scout prep",
        defaultName: scoutState?.username ? `vs ${scoutState.username}` : "Opponent prep",
        defaultColor: myColor,
        openAfter: false,
      });
      return created?.repertoire_id || null;
    }
    return result.repertoire;
  }

  async function scoutWriteLineToRep(line, repId, { reload = true } = {}) {
    if (!scoutModule) scoutModule = await import("../scout.js");
    const build = getBuildState();
    if (reload || !build || build.repertoire_id !== repId) {
      await editRepertoire(repId);
    }
    const freshBuild = getBuildState();
    if (!freshBuild || freshBuild.repertoire_id !== repId) return null;

    const lookup = scoutModule.repertoireChildLookup(freshBuild.nodes);
    const ucisToWrite = [...(line.ucis || [])];
    if (line.suggestedReply?.uci) ucisToWrite.push(line.suggestedReply.uci);
    const { covered, deepestNodeId } = scoutModule.lineCoverage(lookup, ucisToWrite);
    const remaining = ucisToWrite.slice(covered);
    let parentId = deepestNodeId;
    let parent = getBuildNodeById(parentId);
    let lastNodeId = parentId;

    for (const uci of remaining) {
      const existing = freshBuild.nodes.find((n) => n.parent_id === parentId && n.uci === uci);
      if (existing) {
        parentId = existing.id;
        parent = getBuildNodeById(parentId);
        lastNodeId = parentId;
        continue;
      }
      if (!parent) break;
      let after;
      try {
        after = await boardAfterMove(parent.fen, uci);
      } catch (_) {
        break;
      }
      const node = buildProvisionalNode(parent, uci, after);
      pushBuildNode(node);
      setBuildPending({ tempId: node.id, parentRef: parentId, uci, node });
      parentId = node.id;
      parent = node;
      lastNodeId = node.id;
      setBuildSync("dirty");
    }

    try {
      await hardFlushBuild();
    } catch (error) {
      setStatus(error.message);
      return null;
    }
    const resolvedId = resolveBuildId(lastNodeId);
    await selectBuildNode(resolvedId);
    switchView("build");
    return resolvedId;
  }

  async function scoutAddToPrep(line, oppColor, { ownColor = false } = {}) {
    const repId = await scoutPickRepertoire(oppColor, { ownColor });
    if (!repId) return;
    const nodeId = await scoutWriteLineToRep(line, repId);
    if (nodeId) setStatus(`Added line to prep — opened at ${line.sans.at(-1) || "position"}`);
  }

  async function scoutPrepareAll(lines, oppColor) {
    const unique = [];
    const seen = new Set();
    for (const line of lines) {
      const key = scoutLineKey(line.ucis);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(line);
    }
    if (!unique.length) {
      setStatus("No lines to add");
      return;
    }
    if (jobToast.isBusy()) {
      setStatus("Another job is running");
      return;
    }
    const repId = await scoutPickRepertoire(oppColor);
    if (!repId) return;

    const ctrl = new AbortController();
    jobToast.startJob({
      id: `scout-prep-${Date.now()}`,
      title: "Add Scout Lines",
      tab: "build",
      total: unique.length,
      onCancel: () => ctrl.abort(),
    });
    let done = 0;
    for (const line of unique) {
      if (ctrl.signal.aborted) break;
      jobToast.updateJob({
        current: done,
        total: unique.length,
        message: `${line.sans.at(-1) || "line"} · ${done + 1}/${unique.length}`,
      });
      await scoutWriteLineToRep(line, repId, { reload: done === 0 });
      done++;
    }
    jobToast.completeJob({
      title: "Lines added",
      message: `Wrote ${done} line${done === 1 ? "" : "s"} into prep`,
    });
  }

  async function copyScoutReport() {
    if (!scoutState) return;
    const text = buildScoutShareText(scoutState);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Scout report copied to clipboard");
    } catch (_) {
      setStatus("Could not copy — check clipboard permissions");
    }
  }

  async function scoutRunDeepScan() {
    if (!scoutState?.games?.length) {
      setStatus("Scout an opponent first");
      return;
    }
    if (jobToast.isBusy()) {
      setStatus("Another job is running");
      return;
    }
    const opGen = scoutOpGen;
    const state = scoutState;
    if (!scoutModule) {
      scoutModule = await import("../scout.js");
    }
    if (!canApplyDeepScan(opGen, state)) return;
    const engineMod = await import("../scout-engine.js");
    if (!canApplyDeepScan(opGen, state)) return;
    const ctrl = new AbortController();
    deepScanAbort = ctrl;
    const colors = ["white", "black"].filter((c) =>
      state.games.some((g) => g.color === c),
    );
    const total = colors.length;
    jobToast.startJob({
      id: `scout-deep-${Date.now()}`,
      title: "Scout Deep Scan",
      tab: "replay",
      total,
      onCancel: () => ctrl.abort(),
    });
    state.engineByColor = state.engineByColor || {};
    let done = 0;
    try {
      for (const color of colors) {
        if (!canApplyDeepScan(opGen, state) || ctrl.signal.aborted) break;
        jobToast.updateJob({
          current: done,
          total,
          message: `Scanning ${color} openings…`,
        });
        const scanResult = await engineMod.runScoutDeepScan({
          games: state.games,
          oppColor: color,
          speedFilter: state.activeSpeed,
          shouldCancel: () => !canApplyDeepScan(opGen, state) || ctrl.signal.aborted,
          onProgress: (cur, tot) => {
            jobToast.updateJob({
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
        jobToast.cancelJob("Deep scan stopped");
        return;
      }
      state.engineAggByColor = {};
      renderScoutReport({ force: true });
      scheduleEngineAggregation();
      bindScoutEvents();
      jobToast.completeJob({
        title: "Deep scan done",
        message: `Engine patterns for ${done} colour${done === 1 ? "" : "s"}`,
      });
    } catch (error) {
      if (!canApplyDeepScan(opGen, state)) {
        jobToast.cancelJob("Deep scan stopped");
        return;
      }
      if (error?.cancelled) {
        jobToast.cancelJob("Deep scan stopped");
      } else {
        jobToast.failJob(error.message || "Deep scan failed");
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

    const subDist = scoutModule.moveDistribution(childNode).slice(0, 6);
    const parentSan = distRowEl.querySelector(".scout-dist-san")?.textContent || uci;
    const rows = subDist.map((m) => scoutDistRowHtml(m, escapeHtml, { clickable: false })).join("");

    distCol.innerHTML = `
    <div class="scout-dist-drill-head muted">${escapeHtml(parentSan)} — their replies</div>
    ${rows}
    <button type="button" class="scout-btn btn ghost scout-dist-back">Back ↑</button>`;
    distCol.dataset.drillUci = uci;
  }

  function restoreDistRoot(sectionEl, oppColor) {
    const sectionData = scoutState.sections[oppColor];
    if (!sectionData) return;
    const dist = scoutModule.moveDistribution(sectionData.trie).slice(0, 4);
    const distCol = sectionEl.querySelector("[data-dist-root]");
    if (!distCol) return;
    distCol.innerHTML = dist.map((m) => scoutDistRowHtml(m, escapeHtml)).join("");
    delete distCol.dataset.drillUci;
  }

  async function mountE2eRefutationScenario(scenarioId) {
    if (SCOUT_E2E_BUILD_ENABLED) {
      return mountE2eRefutationScenarioEnabled(scenarioId);
    }
    throw new Error("Scout E2E fixtures are not enabled in this build");
  }

  async function mountE2eRefutationScenarioEnabled(scenarioId) {
    const { SCOUT_E2E_REFUTATION_SCENARIOS, scoutE2eSeedGames } = await import(
      "../scout-e2e-fixtures.js"
    );
    const scenario = SCOUT_E2E_REFUTATION_SCENARIOS[scenarioId];
    if (!scenario) {
      throw new Error(`Unknown scout E2E refutation scenario: ${scenarioId}`);
    }

    if (!scoutModule) {
      scoutModule = await import("../scout.js");
    }
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
      renderTimer: null,
      gamesSinceRender: 0,
    };
    scoutOpGen += 1;
    updateScoutControls();
    updateLiveCounter();

    const results = getResultsEl();
    if (!results) {
      throw new Error("scout-results element missing");
    }

    const { buildE2ePrepSection, normalizeE2ePrepScenarioId } = await import(
      "../scout-e2e-fixtures.js"
    );
    const normalizedId = normalizeE2ePrepScenarioId(scenarioId);
    const { html, sectionData } = buildE2ePrepSection(normalizedId, escapeHtml);
    results.innerHTML = html;
    scoutState.sections = { black: sectionData };
    const root = results.querySelector(".scout-section[data-scout-color='black']");
    if (root) root.dataset.e2eRefutation = scenarioId;
    return { scenarioId, normalizedId };
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
            scheduleExplorerEnrich();
            scheduleEngineAggregation();
            schedulePrefilterEnrich();
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
      escapeHtml,
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
        connectLichess,
      },
    });

    const results = getResultsEl();
    if (results && !scoutBoundEventTargets.has(results)) {
      scoutBoundEventTargets.add(results);
      results.addEventListener("click", async (e) => {
        await handleScoutResultsClick(e, scoutClickCtx());
      });

      results.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const lineEl = e.target.closest(".scout-line");
        const distRow = e.target.closest(".scout-dist-row[data-first-uci]");
        if (lineEl || distRow) {
          e.preventDefault();
          e.target.click();
        }
      });
    }

    const v12Panel = getV12PanelEl();
    if (v12Panel && !scoutBoundEventTargets.has(v12Panel)) {
      scoutBoundEventTargets.add(v12Panel);
      v12Panel.addEventListener("click", async (e) => {
        if (isV13Mode()) {
          if (e.target?.id === "scout-v13-generate-btn") {
            void runV13PrepPackages();
            return;
          }
          if (e.target?.id === "scout-v13-cancel-btn") {
            v13CancelRequested = true;
            return;
          }
        }
        if (!isV12Mode()) return;
        await handleV12ActionClick(e);
      });
    }
  }

  async function initScoutState(username, color, initToken) {
    if (!scoutModule) {
      scoutModule = await import("../scout.js");
      scoutClient = scoutModule.createScoutClient({});
    }
    if (!initGuard.isCurrent(initToken)) return false;

    const myReps = ((await api("/api/repertoires")).repertoires || []).filter(
      (rep) => rep.is_active !== false,
    );
    if (!initGuard.isCurrent(initToken)) return false;

    const lookups = { white: [], black: [] };
    for (const rep of myReps.slice(0, 6)) {
      try {
        const payload = await api(`/api/build/load?repertoire_id=${encodeURIComponent(rep.id)}`);
        if (!initGuard.isCurrent(initToken)) return false;
        lookups[rep.color].push({
          rep,
          lookup: scoutModule.repertoireChildLookup(payload.nodes),
        });
      } catch (_) {
        /* unreadable repertoire — skip it */
      }
    }
    if (!initGuard.isCurrent(initToken)) return false;
    const carry = scoutStateCarryover(scoutState, username);
    scoutState = {
      username,
      color,
      games: [],
      profile: { total: 0, speedCounts: {}, recentlyChanged: { white: false, black: false } },
      lookups,
      activeSpeed: carry.activeSpeed,
      engineByColor: carry.engineByColor,
      engineAggByColor: {},
      explorerByColor: carry.explorerByColor,
      sections: {},
      ecoCache: carry.ecoCache,
      maiaResults: carry.maiaResults,
      maiaCache: carry.maiaCache,
      maiaEnrichState: carry.maiaEnrichState,
      prefilterEnrichState: PREFILTER_IDLE,
      prefilterScopeKey: null,
      prefilterPools: { white: [], black: [] },
      prefilterRanked: { white: [], black: [] },
      prefilteredLines: { white: [], black: [] },
      stockfishDisplayLines: { white: [], black: [] },
      ancestorFreq: { white: new Map(), black: new Map() },
      prefilterCache: carry.prefilterCache,
      maiaAttemptsUsed: 0,
      // Persistent per-colour opening tries, grown one game at a time as the stream
      // arrives (see insertIntoLiveTries) instead of rebuilt from every game each batch.
      // Anchored to session start (later than any past game) so incremental insertion
      // matches a one-shot build on every displayed stat — see insertGameIntoTrie.
      liveTries: null,
      liveTrieAnchor: Date.now(),
      liveTrieSpeed: null,
      liveTrieCount: 0,
    };
    scoutSession = {
      username,
      color,
      controller: null,
      state: "idle",
      seenIds: new Set(),
      oldestDatestamp: null,
      renderTimer: null,
      gamesSinceRender: 0,
      userStopped: false,
      acceptedThisBatch: 0,
    };
    return true;
  }

  function isActiveSession(session) {
    return session != null && scoutSession === session;
  }

  function onScoutGame(game, session) {
    if (!scoutState || !isActiveSession(session)) return false;
    if (game.gameId && session.seenIds.has(game.gameId)) return false;
    if (game.gameId) session.seenIds.add(game.gameId);
    scoutState.games.push(game);
    insertIntoLiveTries(game);
    if (game.datestamp > 0) {
      if (session.oldestDatestamp == null || game.datestamp < session.oldestDatestamp) {
        session.oldestDatestamp = game.datestamp;
      }
    }
    session.acceptedThisBatch += 1;
    updateLiveCounter();
    scheduleRender();
    return true;
  }

  async function onStreamEnd({ accepted }, session) {
    if (!isActiveSession(session)) return;
    clearTimeout(session.renderTimer);
    session.renderTimer = null;
    session.gamesSinceRender = 0;
    session.controller = null;

    if (session.userStopped) {
      session.state = "paused";
    } else if (accepted === 0) {
      session.state = "done";
    } else {
      session.state = "paused";
    }
    session.userStopped = false;
    if (accepted > 0) {
      invalidatePrefilterState();
    }
    flushRender();
    updateScoutControls();
    updateLiveCounter();

    if (!scoutState?.games?.length && session.state === "done") {
      const results = getResultsEl();
      const message = SCOUT_ERR_NO_GAMES;
      if (results) results.innerHTML = scoutErrorHtml(message, escapeHtml);
      const profile = getProfileEl();
      if (profile) profile.hidden = true;
      setStatus(message);
      return;
    }
    if (scoutState?.games?.length) {
      const n = scoutState.games.length;
      const label =
        session.state === "done"
          ? `Scouted ${n} games for ${scoutState.username} — no more history`
          : session.state === "paused"
            ? `Paused at ${n} games — Resume for older games`
            : `Scouted ${n} games for ${scoutState.username}`;
      setStatus(label);
    }
  }

  async function runStream({ until, session: sessionArg } = {}) {
    const session = sessionArg || scoutSession;
    if (!isActiveSession(session)) return;

    const controller = new AbortController();
    session.controller = controller;
    session.state = "running";
    session.userStopped = false;
    session.acceptedThisBatch = 0;
    updateScoutControls();

    try {
      const { accepted, lastDatestamp } = await scoutClient.streamGames(session.username, {
        color: session.color,
        until,
        onGame: (game) => onScoutGame(game, session),
        signal: controller.signal,
      });
      if (!isActiveSession(session)) return;

      if (lastDatestamp != null) {
        if (session.oldestDatestamp == null || lastDatestamp < session.oldestDatestamp) {
          session.oldestDatestamp = lastDatestamp;
        }
      }
      const batchAccepted = session.acceptedThisBatch;
      await onStreamEnd({ accepted: batchAccepted ?? accepted }, session);
    } catch (error) {
      if (!isActiveSession(session)) return;
      session.controller = null;
      if (error?.name === "AbortError" || session.userStopped) {
        await onStreamEnd({ accepted: session.acceptedThisBatch }, session);
        return;
      }
      const message = scoutFetchErrorMessage(error) || error.message;
      const hasGames = !!scoutState?.games?.length;
      // Match onStreamEnd's timer cleanup so a render debounce left pending by the
      // streaming loop can't fire stale after we settle here.
      clearTimeout(session.renderTimer);
      session.renderTimer = null;
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
      } else {
        const results = getResultsEl();
        if (results) results.innerHTML = scoutErrorHtml(message, escapeHtml);
        const profile = getProfileEl();
        if (profile) profile.hidden = true;
      }
      updateScoutControls();
      setStatus(message);
    }
  }

  function stopScout() {
    if (!scoutSession || scoutSession.state !== "running") return;
    scoutSession.userStopped = true;
    scoutSession.controller?.abort();
  }

  function resetScout() {
    initGuard.invalidate();
    scoutOpGen += 1;
    deepScanAbort?.abort();
    deepScanAbort = null;
    cancelEnrichmentQueues();
    const ending = scoutSession;
    if (ending?.controller) {
      ending.userStopped = true;
      ending.controller.abort();
    }
    clearTimeout(ending?.renderTimer);
    clearTimeout(explorerEnrichTimer);
    explorerEnrichTimer = null;
    explorerEnrichSeq += 1;
    clearTimeout(engineAggTimer);
    engineAggTimer = null;
    engineAggSeq += 1;
    // A session reset invalidates any in-flight v13 package run and its result.
    v13CancelRequested = true;
    v13Running = false;
    v13Result = null;
    v12Audits = [];
    v13Progress = { stage: "", done: 0, total: 0 };
    scoutState = null;
    scoutSession = null;
    const results = getResultsEl();
    const profile = getProfileEl();
    const experimental = getV12PanelEl();
    if (results) results.innerHTML = "";
    if (profile) profile.hidden = true;
    if (experimental) {
      experimental.innerHTML = "";
      experimental.hidden = true;
    }
    updateLiveCounter();
    updateScoutControls();
    setStatus("");
  }

  async function startScout() {
    const initToken = initGuard.tryBegin();
    if (initToken == null) return;

    const usernameInput = document.getElementById("scout-username");
    const colorSel = document.getElementById("scout-color");
    const username = (usernameInput?.value || "").trim();
    if (!username) {
      initGuard.finish(initToken);
      updateScoutControls();
      setStatus("Enter an opponent's Lichess username");
      usernameInput?.focus();
      return;
    }
    const color = colorSel?.value || "both";
    const results = getResultsEl();
    const profile = getProfileEl();

    const prev = scoutSession;
    if (prev?.controller) {
      prev.userStopped = true;
      prev.controller.abort();
    }
    cancelEnrichmentQueues();
    v13CancelRequested = true;
    v13Running = false;
    v13Result = null;
    v12Audits = [];
    const experimental = getV12PanelEl();
    if (experimental && !isV12Mode() && !isV13Mode()) {
      experimental.innerHTML = "";
      experimental.hidden = true;
    }

    updateScoutControls();

    try {
      const ready = await initScoutState(username, color, initToken);
      if (!ready || !initGuard.isCurrent(initToken)) return;

      initGuard.finish(initToken);
      updateScoutControls();

      const session = scoutSession;
      if (!session || !isActiveSession(session)) return;

      if (results) {
        results.innerHTML = '<div class="muted hint">Streaming games from Lichess…</div>';
        results.classList.add("is-streaming");
      }
      if (profile) profile.hidden = true;
      updateLiveCounter();
      setStatus(`Scouting ${username}`);
      await runStream({ session });
      if (isActiveSession(session)) results?.classList.remove("is-streaming");
    } catch (error) {
      if (!initGuard.isCurrent(initToken)) return;
      const message = scoutFetchErrorMessage(error) || error.message || "Scout failed";
      scoutState = null;
      scoutSession = null;
      if (results) results.innerHTML = scoutErrorHtml(message, escapeHtml);
      if (profile) profile.hidden = true;
      setStatus(message);
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
    setStatus(`Resuming scout for ${scoutState.username}…`);
    const until = session.oldestDatestamp;
    await runStream({ until, session });
    if (isActiveSession(session)) results?.classList.remove("is-streaming");
  }

  async function handleScoutAction() {
    const action = scoutSession?.state;
    if (action === "running") {
      stopScout();
      return;
    }
    if (action === "paused") {
      await resumeScout();
      return;
    }
    await startScout();
  }

  async function runScout() {
    await handleScoutAction();
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

    const scoutName = document.getElementById("scout-username");
    if (scoutName) {
      scoutName.addEventListener("keydown", (event) => {
        if (event.key === "Enter") handleScoutAction();
      });
    }

    bindScoutEvents();
    import("../scout.js").then((mod) => {
      if (!scoutModule) scoutModule = mod;
      if (!scoutClient) scoutClient = mod.createScoutClient({});
    });

    updateScoutControls();
  }

  return {
    runScout,
    handleScoutAction,
    bindControls,
    onShow: syncVisibleState,
    ...(SCOUT_E2E_BUILD_ENABLED ? { mountE2eRefutationScenario } : {}),
    preload: () => import("../scout.js"),
  };
}
