// Scout UI (Replay tab card) — lazy-loaded from app.js.
// Pure fetch/parse logic stays in ../scout.js; rendering helpers in ../scout-report.js.

import {
  buildScoutAnalyzePgn,
  buildScoutSectionReport,
  buildScoutShareText,
  handleScoutProfileClick,
  handleScoutResultsClick,
  mergeEnginePatternsIntoSections,
  renderMiniBoardHtml as renderScoutMiniBoardHtml,
  renderScoutProfile,
  scoutDistRowHtml,
  scoutLineDetailHtml,
} from "../scout-report.js";
import {
  SCOUT_ERR_NETWORK,
  SCOUT_ERR_NO_GAMES,
  scoutFetchErrorMessage,
} from "../scout.js";

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
  } = deps;

  let scoutModule = null;
  let scoutClient = null;
  let scoutExplorerClient = null;
  let scoutState = null;
  let scoutEventsBound = false;

  function renderScoutReport() {
    if (!scoutState) return;
    const profileEl = document.getElementById("scout-profile");
    const results = document.getElementById("scout-results");
    if (profileEl) {
      profileEl.innerHTML = renderScoutProfile(
        scoutState.profile,
        scoutState.username,
        scoutState.activeSpeed,
        escapeHtml,
      );
      profileEl.hidden = false;
    }
    scoutState.sections = {};
    const speedOpts = {
      speedFilter: scoutState.activeSpeed,
      escapeHtml,
      enginePatterns: scoutState.engineByColor?.white || null,
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
        enginePatterns: scoutState.engineByColor?.black || null,
      },
    );
    if (blackReport.sectionData) scoutState.sections.black = blackReport.sectionData;
    if (scoutState.engineByColor && Object.keys(scoutState.engineByColor).length) {
      mergeEnginePatternsIntoSections(scoutState.sections, scoutState.engineByColor);
    }
    const sections = [whiteReport.html, blackReport.html].filter(Boolean);
    if (results) {
      results.innerHTML = sections.length
        ? sections.join("")
        : '<div class="empty-state">Not enough opening data in these games.</div>';
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

  async function enrichEcoForLine(lineEl, fen) {
    try {
      const explorerMod = await import("../explorer.js");
      if (!scoutExplorerClient) scoutExplorerClient = explorerMod.createExplorerClient({});
      const stats = await scoutExplorerClient.fetchStats("masters", fen, {});
      if (stats?.opening) {
        const eco = lineEl.querySelector(".scout-line-eco");
        if (eco) eco.textContent = stats.opening;
      }
    } catch (_) {
      /* best-effort */
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
    const { covered, deepestNodeId } = scoutModule.lineCoverage(lookup, line.ucis);
    const remaining = line.ucis.slice(covered);
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
      const key = line.ucis.join(">");
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
    if (!scoutModule) {
      scoutModule = await import("../scout.js");
    }
    const engineMod = await import("../scout-engine.js");
    const ctrl = new AbortController();
    const colors = ["white", "black"].filter((c) =>
      scoutState.games.some((g) => g.color === c),
    );
    const total = colors.length;
    jobToast.startJob({
      id: `scout-deep-${Date.now()}`,
      title: "Scout Deep Scan",
      tab: "replay",
      total,
      onCancel: () => ctrl.abort(),
    });
    scoutState.engineByColor = scoutState.engineByColor || {};
    let done = 0;
    try {
      for (const color of colors) {
        if (ctrl.signal.aborted) break;
        jobToast.updateJob({
          current: done,
          total,
          message: `Scanning ${color} openings…`,
        });
        const patterns = await engineMod.runScoutDeepScan({
          games: scoutState.games,
          oppColor: color,
          speedFilter: scoutState.activeSpeed,
          shouldCancel: () => ctrl.signal.aborted,
          onProgress: (cur, tot) => {
            jobToast.updateJob({
              current: done,
              total,
              message: `${color}: game ${cur}/${tot}`,
            });
          },
        });
        scoutState.engineByColor[color] = patterns;
        done++;
      }
      renderScoutReport();
      bindScoutEvents();
      jobToast.completeJob({
        title: "Deep scan done",
        message: `Engine patterns for ${done} colour${done === 1 ? "" : "s"}`,
      });
    } catch (error) {
      if (error?.cancelled) {
        jobToast.cancelJob("Deep scan stopped");
      } else {
        jobToast.failJob(error.message || "Deep scan failed");
        setStatus(error.message);
      }
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

  function bindScoutEvents() {
    if (scoutEventsBound) return;
    scoutEventsBound = true;

    const profileEl = document.getElementById("scout-profile");
    if (profileEl) {
      profileEl.addEventListener("click", (e) => {
        handleScoutProfileClick(e, {
          getState: () => scoutState,
          onSpeedChange: () => renderScoutReport(),
          callbacks: {
            copyScoutReport,
            runDeepScan: scoutRunDeepScan,
          },
        });
      });
    }

    const results = document.getElementById("scout-results");
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
        enrichEcoForLine,
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

  async function fetchAndBuildScoutState(username, count) {
    if (!scoutModule) {
      scoutModule = await import("../scout.js");
      scoutClient = scoutModule.createScoutClient({});
    }
    const games = await scoutClient.fetchGames(username, { max: count });
    const profileData = scoutModule.opponentProfile(games);
    const myReps = ((await api("/api/repertoires")).repertoires || []).filter(
      (rep) => rep.is_active !== false,
    );
    const lookups = { white: [], black: [] };
    for (const rep of myReps.slice(0, 6)) {
      try {
        const payload = await api(`/api/build/load?repertoire_id=${encodeURIComponent(rep.id)}`);
        lookups[rep.color].push({
          rep,
          lookup: scoutModule.repertoireChildLookup(payload.nodes),
        });
      } catch (_) {
        /* unreadable repertoire — skip it */
      }
    }
    scoutState = {
      username,
      games,
      profile: profileData,
      lookups,
      activeSpeed: scoutState?.username === username ? scoutState.activeSpeed : "all",
      engineByColor: scoutState?.username === username ? scoutState.engineByColor || {} : {},
      sections: {},
    };
  }

  async function runScout() {
    const usernameInput = document.getElementById("scout-username");
    const button = document.getElementById("scout-btn");
    const username = (usernameInput.value || "").trim();
    if (!username) {
      setStatus("Enter an opponent's Lichess username");
      usernameInput.focus();
      return;
    }
    const count = Math.max(20, Math.min(500, Number(document.getElementById("scout-count").value) || 100));
    const results = document.getElementById("scout-results");
    const profile = document.getElementById("scout-profile");
    button.disabled = true;
    if (results) results.innerHTML = '<div class="muted hint">Fetching games from Lichess…</div>';
    if (profile) profile.hidden = true;
    setStatus(`Scouting ${username}`);
    try {
      await fetchAndBuildScoutState(username, count);
      if (!scoutState.games.length) {
        const message = SCOUT_ERR_NO_GAMES;
        if (results) results.innerHTML = scoutErrorHtml(message, escapeHtml);
        setStatus(message);
        return;
      }
      renderScoutReport();
      bindScoutEvents();
      setStatus(`Scouted ${scoutState.games.length} games for ${username}`);
    } catch (error) {
      const message = scoutFetchErrorMessage(error) || error.message;
      if (results) results.innerHTML = scoutErrorHtml(message, escapeHtml);
      if (profile) profile.hidden = true;
      scoutState = null;
      setStatus(message);
    } finally {
      button.disabled = false;
    }
  }

  function bindControls() {
    const scoutBtn = document.getElementById("scout-btn");
    if (!scoutBtn || scoutBtn.dataset.scoutBound) return;
    scoutBtn.dataset.scoutBound = "1";
    scoutBtn.addEventListener("click", runScout);
    const scoutName = document.getElementById("scout-username");
    if (scoutName) {
      scoutName.addEventListener("keydown", (event) => {
        if (event.key === "Enter") runScout();
      });
    }
  }

  return {
    runScout,
    bindControls,
    preload: () => import("../scout.js"),
  };
}