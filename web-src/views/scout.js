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
import { createScoutInitGuard } from "../scout-init-guard.js";

const SCOUT_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_SCOUT_E2E === "1";
import { colorRecommendation } from "../scout-stats.js";
import { buildColorRecommendationBanner } from "../scout-summary.js";
import { engineScanPatterns } from "../scout-engine.js";
import {
  SCOUT_ERR_NETWORK,
  SCOUT_ERR_NO_GAMES,
  scoutFetchErrorMessage,
} from "../scout.js";

const RENDER_DEBOUNCE_MS = 400;
const RENDER_FORCE_EVERY = 25;
const EXPLORER_ENRICH_DEBOUNCE_MS = 800;
const ENGINE_AGG_DEBOUNCE_MS = 400;

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
  } = deps;

  let scoutModule = null;
  let scoutClient = null;
  let scoutExplorerClient = null;
  let scoutExplorerModule = null;
  let scoutEngineModule = null;
  let scoutState = null;
  let scoutSession = null;
  let scoutEventsBound = false;
  let explorerEnrichTimer = null;
  let explorerEnrichSeq = 0;
  let engineAggTimer = null;
  let engineAggSeq = 0;
  let scoutOpGen = 0;
  let deepScanAbort = null;
  const initGuard = createScoutInitGuard();

  function getResultsEl() {
    return document.getElementById("scout-results");
  }

  function getProfileEl() {
    return document.getElementById("scout-profile");
  }

  function updateLiveCounter() {
    const el = document.getElementById("scout-live-count");
    if (el) el.textContent = String(scoutState?.games?.length || 0);
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
    const speedOpts = {
      speedFilter: scoutState.activeSpeed,
      escapeHtml,
      enginePatterns: engineScanPatterns(scoutState.engineByColor?.white),
      explorerReads: scoutState.explorerByColor?.white || null,
      engineAgg: engineAggForColor("white"),
      engineScan: engineScanForColor("white"),
    };
    const whiteReport = buildScoutSectionReport(
      scoutModule,
      scoutState,
      "white",
      scoutState.lookups.black,
      speedOpts,
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
      },
    );
    if (blackReport.sectionData) scoutState.sections.black = blackReport.sectionData;
    if (scoutState.engineByColor && Object.keys(scoutState.engineByColor).length) {
      mergeEnginePatternsIntoSections(scoutState.sections, scoutState.engineByColor, {
        speedFilter: scoutState.activeSpeed,
      });
    }
    const sections = [whiteReport.html, blackReport.html].filter(Boolean);
    if (results) {
      results.innerHTML = sections.length
        ? sections.join("")
        : '<div class="empty-state">Not enough opening data in these games.</div>';
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
  }

  function scheduleRender({ force = false } = {}) {
    if (!scoutSession) return;
    scoutSession.gamesSinceRender += 1;
    if (force || scoutSession.gamesSinceRender >= RENDER_FORCE_EVERY) {
      clearTimeout(scoutSession.renderTimer);
      scoutSession.renderTimer = null;
      flushRender();
      scoutSession.gamesSinceRender = 0;
      return;
    }
    if (scoutSession.renderTimer) return;
    scoutSession.renderTimer = setTimeout(() => {
      scoutSession.renderTimer = null;
      flushRender();
      scoutSession.gamesSinceRender = 0;
    }, RENDER_DEBOUNCE_MS);
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
    scheduleExplorerEnrich();
    scheduleEngineAggregation();
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
    const drawer = document.getElementById("pgn-drawer");
    if (drawer) drawer.open = true;
    switchView("analyze");
    setStatus(`Loaded ${username}'s line — press "Analyze game" to start`);
  }

  async function scoutPickRepertoire(oppColor) {
    const myColor = oppColor === "white" ? "black" : "white";
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

  async function scoutAddToPrep(line, oppColor) {
    const repId = await scoutPickRepertoire(oppColor);
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
    if (scoutEventsBound) return;
    scoutEventsBound = true;

    const profileEl = getProfileEl();
    if (profileEl) {
      profileEl.addEventListener("click", (e) => {
        handleScoutProfileClick(e, {
          getState: () => scoutState,
          onSpeedChange: () => {
            if (scoutState) {
              scoutState.explorerByColor = {};
              scoutState.engineAggByColor = {};
            }
            renderScoutReport({ force: true });
            scheduleExplorerEnrich();
            scheduleEngineAggregation();
          },
          callbacks: {
            copyScoutReport,
            runDeepScan: scoutRunDeepScan,
          },
        });
      });
    }

    const results = getResultsEl();
    if (!results) return;

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
    const keepSpeed =
      scoutState?.username === username ? scoutState.activeSpeed : "all";
    const keepEngine =
      scoutState?.username === username ? scoutState.engineByColor || {} : {};
    const keepExplorer =
      scoutState?.username === username ? scoutState.explorerByColor || {} : {};
    scoutState = {
      username,
      color,
      games: [],
      profile: { total: 0, speedCounts: {}, recentlyChanged: { white: false, black: false } },
      lookups,
      activeSpeed: keepSpeed,
      engineByColor: keepEngine,
      engineAggByColor: {},
      explorerByColor: keepExplorer,
      sections: {},
      ecoCache: scoutState?.username === username ? scoutState.ecoCache || new Map() : new Map(),
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
      const results = getResultsEl();
      if (results && !scoutState?.games?.length) {
        results.innerHTML = scoutErrorHtml(message, escapeHtml);
      }
      const profile = getProfileEl();
      if (profile && !scoutState?.games?.length) profile.hidden = true;
      session.state = scoutState?.games?.length ? "paused" : "idle";
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
    scoutState = null;
    scoutSession = null;
    const results = getResultsEl();
    const profile = getProfileEl();
    if (results) results.innerHTML = "";
    if (profile) profile.hidden = true;
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
    ...(SCOUT_E2E_BUILD_ENABLED ? { mountE2eRefutationScenario } : {}),
    preload: () => import("../scout.js"),
  };
}