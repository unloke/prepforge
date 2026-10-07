import { html } from "../html.js";
import { MAX_PLAN_CHANGES } from "../generated/shared-constants.js";

import { formatEngineEval } from "../engine-eval.js";
// Repertoire editor: the tree and board, the Explorer panel, the inspector dock, node
// menus and Generate. Lazy-loaded by app.js with the Build view. Saving edits (the Build
// outbox and its flushes) stays in app.js so it can run before this loads and on unload.

import {
  _buildGenReady, buildDockTab, buildView, coverageView, explorerClient, explorerDb,
  explorerModule,
} from "../app.js";
import { localBoardInfo } from "../chess-local.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { isBrowserEngineAvailable } from "../engine/stockfish-provider.js";
import { nodeMenuHeading } from "../node-menu.js";
import { countOf } from "../plural.js";
import { normalizeRepertoireColor, repertoireColorField } from "../repertoire-color.js";

let activeViewName, api, appState, boardAfterMove, boardInfo, boards, BROWSER_ENGINE_UNAVAILABLE,
  buildDockFolded, buildOpMatchesRepertoire, buildProvisionalNode, captureBuildContext,
  closeRepertoireContextMenu, currentOwnerId, deleteBuildNodeLocal, downloadText,
  effectiveMaiaRating, effectiveStockfishDepth, engineLifecycleMark, engineWidget,
  ensureBuildView, ensureExplorerClient, EXPLORER_EVAL_MAX_LINES,
  explorerDrawerOpen, explorerEvalEngine, handleRepertoireContextAction, hardFlushBuild,
  hasPendingBuildOpsFor, invalidateBook, isBuildReadOnly, jobToast, normalizeUci,
  openSettingsSection, optimisticBoardMove, postJson, preloadBuildGen,
  reapplyPendingBuildDeletes, reapplyPendingBuildNodes, refreshDashboardRepertoires,
  renderBuilderTree, renderBuildRepHeader, renderBuildSync, requireSignIn, resolveBuildId,
  sameFenPosition, scheduleBuildFlush, setBuildSync, setStatus, setStatusError, showInputModal,
  START_FEN, STOCKFISH_MAX_DEPTH, STOCKFISH_MIN_DEPTH, switchView, syncWorkspaceUrl;

export function createBuildSession(deps) {
  ({
    activeViewName, api, appState, boardAfterMove, boardInfo, boards,
    BROWSER_ENGINE_UNAVAILABLE, buildDockFolded, buildOpMatchesRepertoire, buildProvisionalNode,
    captureBuildContext, closeRepertoireContextMenu, currentOwnerId, deleteBuildNodeLocal,
    downloadText, effectiveMaiaRating, effectiveStockfishDepth, engineLifecycleMark,
    engineWidget, ensureBuildView, ensureExplorerClient, EXPLORER_EVAL_MAX_LINES,
    explorerDrawerOpen, explorerEvalEngine, handleRepertoireContextAction, hardFlushBuild,
    hasPendingBuildOpsFor, invalidateBook, isBuildReadOnly, jobToast, normalizeUci,
    openSettingsSection, optimisticBoardMove, postJson, preloadBuildGen,
    reapplyPendingBuildDeletes, reapplyPendingBuildNodes, refreshDashboardRepertoires,
    renderBuilderTree, renderBuildRepHeader, renderBuildSync, requireSignIn, resolveBuildId,
    sameFenPosition, scheduleBuildFlush, setBuildSync, setStatus, setStatusError,
    showInputModal, START_FEN, STOCKFISH_MAX_DEPTH, STOCKFISH_MIN_DEPTH, switchView,
    syncWorkspaceUrl,
  } = deps);
  initBuildDockLayout();
  return {
    buildBranchContext, buildBranchKey, buildGoBack, buildGoForward, buildGoRoot, buildGoToEnd,
    closeNodeContextMenu, createRepertoirePrompt, generateFromCurrentNode, hydrateBuild,
    initBuildDockLayout, onBuildBoardMove, onInspectorInfo, openBuildMenu, openNodeContextMenu,
    paintExplorerEvals, paintInspectorScope, refreshExplorerPanel, saveBuildAnnotations,
    scheduleExplorerRefresh, selectBuildNode, setBuildDockFolded,
  };
}


// Browser Build → Generate (Phase 3c) ceilings. Deliberately conservative: the
// recursion runs on the USER's machine (deep × branches is slow) and a large tree
// risks exceeding the server apply-plan caps (≤2000 changes / depth ≤64). The
// modal enforces these; MAX_PLAN_CHANGES comes from the server limits
// so we fail with an actionable message instead of a raw 400 after the work is done.
const GEN_MAX_PLY_DEPTH = 20;

async function hydrateBuild(payload, selectedNodeId = null) {
  // Opening/switching to a DIFFERENT repertoire must not throw away local-first
  // sync state: callers hard-flush before switching, and anything still queued
  // (a restored queue, a flush that failed) is tagged with its target and kept
  // (R-02). A reconcile re-hydrate keeps the same id, so its pending queue +
  // id map survive — that's the load-bearing distinction for the in-flight case.
  const prevRepId = appState.build && appState.build.repertoire_id;
  if (payload.repertoire_id !== prevRepId) {
    clearTimeout(appState.buildFlushTimer);
    appState.buildFlushTimer = null;
    // R-02: opening a repertoire only changes what is DISPLAYED. Ops queued
    // for ANOTHER tree (restored after a reload, or left by a failed flush)
    // stay on the device for their own repertoire; ops for THIS tree are
    // re-applied onto the fresh payload below.
    // Stale undo windows from the old repertoire become no-ops (their commit
    // guards on repertoire id), but their ids must not prune the new tree.
    appState.buildUndoDeletes = new Set();
    appState.buildUndoCommitByMove = new Map();
    // buildIdMap is additive and tmp ids are tab-unique, so it stays: another
    // tree's queued children still need their parent translated.
    appState.buildSyncState = "saved";
    appState.buildSyncRetry = 0;
  }
  appState.build = payload;
  appState.buildNodeById = new Map(payload.nodes.map((node) => [node.id, node]));
  // Derived analysis must match this exact local tree, including optimistic edits.
  coverageView?.sync();
  invalidateBook();
  // Orient only when a repertoire opens — a reconcile re-hydrate after an
  // autosave must not undo the user's manual flip (or rebuild the grid mid-drag).
  if (boards.build && payload.repertoire_id !== prevRepId) {
    boards.build.setOrientation(payload.color === "black" ? "black" : "white");
  }
  renderBuildRepHeader();
  const nextNodeId = selectedNodeId || payload.selected_node_id || payload.nodes[0]?.id;
  await selectBuildNode(nextNodeId);
  // R-02: put this repertoire's unsynced local edits back onto the tree the
  // server just sent, and re-prune what is queued for deletion.
  reapplyPendingBuildNodes(
    appState.buildPending.filter((m) => buildOpMatchesRepertoire(m, payload.repertoire_id)),
    appState.buildIdMap,
  );
  reapplyPendingBuildDeletes();
  if (hasPendingBuildOpsFor(payload.repertoire_id)) {
    setBuildSync("dirty");
    scheduleBuildFlush();
  }
  renderBuildSync();
  syncWorkspaceUrl();
}

// The ⋯ menu in the Repertoire header: the same repertoire actions as the
// Library row's ⋯ (minus "Open in Repertoire" — you are here), plus the
// page-only Export PGN and New repertoire. Reuses the shared context-menu
// element and the Library's action handler so the two menus cannot drift.
function buildMenuItems({ hasRep, isActive }) {
  return [
    ...(hasRep
      ? [
          ["train", "Start training"],
          ["build-rename", "Rename..."],
          ["build-export-pgn", "Export PGN"],
          ["share-link", "Share link..."],
          ["share-team", "Share with team..."],
          ["toggle-active", isActive ? "Disable" : "Enable"],
          ["delete", "Delete..."],
        ]
      : []),
    ["build-new-rep", "New repertoire..."],
  ];
}

function openBuildMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById("repertoire-context-menu");
  if (!menu) return;
  const hasRep = !!appState.build && !isBuildReadOnly();
  const repId = hasRep ? appState.build.repertoire_id : null;
  const meta = hasRep
    ? (appState.repertoireList || []).find((r) => String(r.id) === String(repId))
    : null;
  const isActive = !meta || meta.is_active !== false;
  const items = buildMenuItems({ hasRep, isActive });
  menu.innerHTML = html`${items
    .map(
      ([action, label]) =>
        html`<button type="button" data-action="${action}"${action === "build-new-rep" && hasRep ? html` class="menu-sep-before"` : ""}>${label}</button>`
    )}`;
  menu.hidden = false;
  const anchor = event.currentTarget.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8)}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      closeRepertoireContextMenu();
      const action = button.dataset.action;
      if (action === "build-rename") await renameRepertoire();
      else if (action === "build-export-pgn") await exportBuild("pgn");
      else if (action === "build-new-rep") {
        await createRepertoirePrompt({ title: "New repertoire", defaultName: "New repertoire" });
      } else if (repId) {
        await handleRepertoireContextAction(action, repId, isActive);
      }
    });
  });
}

async function renameRepertoire() {
  if (!appState.build) {
    setStatus("Open a repertoire first");
    return;
  }
  const result = await showInputModal({
    title: "Rename repertoire",
    okLabel: "Save",
    fields: [{ name: "name", label: "New name", default: appState.build.name }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Name is empty");
    return;
  }
  try {
    const payload = await postJson("/api/build/rename", {
      repertoire_id: appState.build.repertoire_id,
      name,
    });
    await hydrateBuild(payload, appState.buildCurrentNodeId);
    setStatus(`Renamed to ${name}`);
  } catch (error) {
    setStatusError(error.message);
  }
}

async function selectBuildNode(nodeId) {
  if (!appState.buildNodeById.has(nodeId)) return;
  appState.buildCurrentNodeId = nodeId;
  // Landing on a position resets the fork pick to the mainline continuation.
  appState.buildBranchChoiceId = null;
  const node = appState.buildNodeById.get(nodeId);
  const info = await boardInfo(node.fen);
  boards.build.setPosition({
    fen: node.fen,
    legalMoves: info.legal_moves,
    lastMove: node.uci,
  });
  boards.build.setAnnotations(node.arrows || [], node.circles || []);
  const label =
    node.depth === 0
      ? `${appState.build.name} · ${appState.build.color}`
      : `${node.move_number}${node.move_side === "black" ? "..." : "."} ${node.san}`;
  document.getElementById("build-board-label").textContent = label;
  renderBuilderTree();
  if (engineWidget) engineWidget.onBoardChanged();
  scheduleExplorerRefresh();
}
let explorerTimer = null;
let explorerSeq = 0;

// ---- Inspector dock: fold + drag-to-resize ---------------------------------
// The seam between the move tree and the inspector is a drag handle; the height
// (and whether the dock is folded down to its tab strip) is a per-browser
// layout convenience, so it lives in localStorage, never in synced prefs.
const BUILD_DOCK_HEIGHT_KEY = "pf.buildDock.height";
const BUILD_DOCK_FOLDED_KEY = "pf.buildDock.folded";
const BUILD_DOCK_MIN = 150; // tabs + tools row + a couple of Explorer rows
const BUILD_DOCK_TREE_MIN = 90; // matches .tree-wrap min-height

function readDockStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDockStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    /* private mode / blocked storage: the layout just isn't remembered */
  }
}

// Largest dock that still leaves the move tree its minimum inside the panel.
function buildDockMaxHeight() {
  const dock = document.getElementById("build-inspector");
  const panel = dock && dock.parentElement;
  if (!panel) return 600;
  let others = 0;
  for (const child of panel.children) {
    if (child === dock || child.id === "builder-tree") continue;
    others += child.getBoundingClientRect().height;
  }
  return Math.max(BUILD_DOCK_MIN, panel.clientHeight - others - BUILD_DOCK_TREE_MIN);
}

function applyBuildDockHeight(px) {
  const dock = document.getElementById("build-inspector");
  if (!dock) return null;
  const clamped = Math.round(Math.min(Math.max(px, BUILD_DOCK_MIN), buildDockMaxHeight()));
  dock.style.flexBasis = `${clamped}px`;
  return clamped;
}

function setBuildDockFolded(folded, { remember = true } = {}) {
  const dock = document.getElementById("build-inspector");
  if (!dock) return;
  const was = dock.classList.contains("is-folded");
  dock.classList.toggle("is-folded", folded);
  const fold = document.getElementById("build-dock-fold");
  if (fold) {
    const label = folded ? "Unfold the inspector" : "Fold the inspector";
    fold.setAttribute("aria-expanded", String(!folded));
    fold.setAttribute("aria-label", label);
    fold.title = label;
  }
  if (remember) writeDockStore(BUILD_DOCK_FOLDED_KEY, folded ? "1" : null);
  if (was === folded) return;
  // Folding parks the Explorer fetch and the row-eval worker; unfolding catches up.
  if (!folded && buildDockTab === "explorer") refreshExplorerPanel();
  void explorerEvalEngine.sync();
}

function initBuildDockLayout() {
  const dock = document.getElementById("build-inspector");
  const resizer = document.getElementById("build-dock-resizer");
  const fold = document.getElementById("build-dock-fold");
  if (!dock || !resizer) return;
  const stored = Number(readDockStore(BUILD_DOCK_HEIGHT_KEY));
  if (Number.isFinite(stored) && stored > 0) dock.style.flexBasis = `${Math.round(stored)}px`;
  setBuildDockFolded(readDockStore(BUILD_DOCK_FOLDED_KEY) === "1", { remember: false });
  fold?.addEventListener("click", (event) => {
    setBuildDockFolded(!buildDockFolded());
    if (event.detail !== 0) fold.blur();
  });

  let drag = null;
  const onMove = (event) => {
    if (!drag) return;
    const want = drag.startHeight + (drag.startY - event.clientY);
    // Dragging well below the minimum folds the dock; dragging back up unfolds.
    if (want < BUILD_DOCK_MIN * 0.5) {
      if (!buildDockFolded()) setBuildDockFolded(true);
      return;
    }
    if (buildDockFolded()) setBuildDockFolded(false);
    drag.height = applyBuildDockHeight(want);
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.height) writeDockStore(BUILD_DOCK_HEIGHT_KEY, drag.height);
    drag = null;
    resizer.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-dock");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startHeight = buildDockFolded() ? BUILD_DOCK_MIN * 0.5 : dock.getBoundingClientRect().height;
    drag = { startY: event.clientY, startHeight, height: null };
    resizer.classList.add("is-dragging");
    document.body.classList.add("is-resizing-dock");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  resizer.addEventListener("dblclick", () => setBuildDockFolded(!buildDockFolded()));
  resizer.addEventListener("keydown", (event) => {
    // Up/Down are the fork picker's keys elsewhere in Build; on the focused
    // handle they resize instead, so they stop here.
    const step = event.shiftKey ? 96 : 32;
    let delta = 0;
    if (event.key === "ArrowUp") delta = step;
    else if (event.key === "ArrowDown") delta = -step;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setBuildDockFolded(!buildDockFolded());
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (buildDockFolded()) {
      if (delta > 0) setBuildDockFolded(false);
      return;
    }
    const height = applyBuildDockHeight(dock.getBoundingClientRect().height + delta);
    if (height) writeDockStore(BUILD_DOCK_HEIGHT_KEY, height);
  });
}

function engineScoreCp(pv) {
  if (pv.mate_in !== null && pv.mate_in !== undefined) {
    return pv.mate_in > 0 ? 100000 - pv.mate_in : -100000 - pv.mate_in;
  }
  return Number(pv.score_cp) || 0;
}

// Paint each Explorer row's Eval cell from the eval worker's lines. Evals are
// White's view (like the bar); the colour says how much the mover gives up
// versus the best move: the main engine line when it is on this position,
// else the best candidate.
function paintExplorerEvals(snapshot, mainSnapshot = null) {
  const rows = document.getElementById("explorer-rows");
  if (!rows || !rows.classList.contains("has-eval")) return;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  const fen = (node && node.fen) || START_FEN;
  const live = !!snapshot && !snapshot.error && sameFenPosition(snapshot.fen, fen);
  const failed = !!snapshot && !!snapshot.error;
  const pvs = live && Array.isArray(snapshot.pvs)
    ? snapshot.pvs.filter((pv) => Array.isArray(pv.pv_uci) && pv.pv_uci.length)
    : [];
  const byUci = new Map();
  pvs.forEach((pv) => {
    const key = normalizeUci(pv.pv_uci[0]);
    if (!byUci.has(key)) byUci.set(key, pv);
  });
  const sign = live && snapshot.side_to_move === "black" ? -1 : 1;
  // Mover's-view reference: the best of the candidates and the main line.
  let best = pvs.length ? Math.max(...pvs.map((pv) => engineScoreCp(pv) * sign)) : 0;
  const mainPv =
    mainSnapshot && !mainSnapshot.error && sameFenPosition(mainSnapshot.fen, fen)
      ? (mainSnapshot.pvs || [])[0]
      : null;
  if (pvs.length && mainPv && Array.isArray(mainPv.pv_uci) && mainPv.pv_uci.length) {
    best = Math.max(best, engineScoreCp(mainPv) * sign);
  }
  // A row the cap never asked about is genuinely "not scored"; a row we asked about
  // that has no PV yet is still calculating. `beyondCap` is what the worker could
  // never score, so the cap tooltip is only ever shown for those rows.
  const rowCount = rows.querySelectorAll(".explorer-row").length;
  const beyondCap = rowCount > EXPLORER_EVAL_MAX_LINES;
  const settled = live && (snapshot.running === false || pvs.length >= EXPLORER_EVAL_MAX_LINES);
  rows.querySelectorAll(".explorer-row").forEach((row) => {
    const cell = row.querySelector(".explorer-eval");
    if (!cell) return;
    cell.classList.remove("is-best", "is-ok", "is-weak");
    if (failed) {
      cell.textContent = "—";
      cell.title = `Engine unavailable: ${snapshot.error}`;
      return;
    }
    const pv = byUci.get(normalizeUci(row.dataset.uci));
    if (!pv) {
      cell.textContent = settled || beyondCap ? "—" : "…";
      cell.title = beyondCap
        ? `Not scored: only the ${EXPLORER_EVAL_MAX_LINES} most-played moves are evaluated`
        : settled
          ? "Not scored — the engine returned no line for this move"
          : "Calculating…";
      return;
    }
    cell.textContent = formatEngineEval(pv.score_cp, pv.mate_in);
    const drop = best - engineScoreCp(pv) * sign;
    cell.classList.add(drop <= 20 ? "is-best" : drop <= 80 ? "is-ok" : "is-weak");
    cell.title = `Stockfish, depth ${pv.depth || snapshot.current_depth || 0}`;
  });
}

// Compact scope line for the ⓘ popover: what the panel shows, nothing more.
function inspectorScopeText() {
  if (buildDockTab === "coverage") {
    return "Share of human play at your rating that reaches a move your prepared mainline does not answer, within the horizon. Pruned or unmodelled lines count as unchecked.";
  }
  if (explorerDb !== "lichess") return "Master games.";
  const rating = effectiveMaiaRating();
  const buckets =
    explorerModule && typeof explorerModule.ratingBucketsFor === "function"
      ? explorerModule.ratingBucketsFor(rating)
      : null;
  return buckets && buckets.length
    ? `Players near ~${rating} (pool ${buckets.join(", ")}).`
    : `Players near ~${rating}.`;
}

function paintInspectorScope() {
  const info = document.getElementById("inspector-info");
  if (info) info.title = inspectorScopeText();
}

function onInspectorInfo() {
  const text = inspectorScopeText();
  const info = document.getElementById("inspector-info");
  if (!info) return;
  let pop = document.getElementById("inspector-info-pop");
  if (pop) {
    pop.remove();
    return;
  }
  pop = document.createElement("div");
  pop.className = "inspector-info-pop";
  pop.id = "inspector-info-pop";
  pop.setAttribute("role", "status");
  pop.textContent = text;
  const head = document.getElementById("build-dock-tools") || info.parentElement;
  head.appendChild(pop);
  // Anchor under the ⓘ itself (not the toolbar's far edge), clamped so the
  // bubble never spills past the toolbar's right side.
  const headRect = head.getBoundingClientRect();
  const infoRect = info.getBoundingClientRect();
  const left = Math.max(
    0,
    Math.min(infoRect.left - headRect.left - 8, headRect.width - pop.offsetWidth)
  );
  pop.style.left = `${Math.round(left)}px`;
  pop.style.right = "auto";
  window.setTimeout(() => pop?.remove(), 4000);
}

// Arrow-keying through a line fires selectBuildNode per ply; one trailing fetch
// 350ms after the player settles is plenty (and most settles hit the cache).
function scheduleExplorerRefresh() {
  if (!explorerDrawerOpen()) return;
  window.clearTimeout(explorerTimer);
  explorerTimer = window.setTimeout(refreshExplorerPanel, 350);
}

async function refreshExplorerPanel() {
  const rows = document.getElementById("explorer-rows");
  if (!rows || !explorerDrawerOpen()) return;
  const node =
    appState.buildCurrentNodeId && appState.buildNodeById.get(appState.buildCurrentNodeId);
  const fen = node ? node.fen : null;
  if (!fen) {
    rows.innerHTML = html`<div class="muted hint">Open a repertoire to see real-game stats.</div>`;
    // No rows can belong to a position now, so park the search instead of
    // leaving the old one burning a core at full depth.
    void explorerEvalEngine.sync();
    return;
  }
  renderExplorerScope();
  const seq = ++explorerSeq;
  const db = explorerDb;
  // Same database, new position: keep the previous rows on screen (dimmed and
  // inert via .is-stale) until the new ones land, so stepping through a line
  // doesn't flash a one-line "Loading…" that collapses the panel and makes the
  // dock's scrollbar blink. Switching database still clears: the previous
  // database's rows left on screen read as Masters and Players "mixing".
  const keepRows = rows.dataset.db === db && !!rows.querySelector(".explorer-row");
  rows.dataset.db = db;
  // Rows stop being actionable here, but the re-render below that would re-sync
  // the eval engine only lands after the network round-trip. Park the search now
  // so the previous position is not still searched at full depth meanwhile.
  delete rows.dataset.fen;
  void explorerEvalEngine.sync();
  const openingEl = document.getElementById("explorer-opening");
  if (keepRows) {
    rows.classList.add("is-stale");
    rows.setAttribute("aria-busy", "true");
  } else {
    if (openingEl) openingEl.textContent = "";
    rows.classList.remove("is-stale");
    rows.innerHTML = html`<div class="muted hint">Loading ${db === "lichess" ? "Players" : "Masters"}…</div>`;
  }
  try {
    if (!explorerModule) {
      rows.innerHTML = html`<div class="muted hint">Loading explorer…</div>`;
      await ensureExplorerClient();
      renderExplorerScope(); // now that ratingBucketsFor is available, show the pool
    }
    const stats = await explorerClient.fetchStats(db, fen, {
      rating: effectiveMaiaRating(),
    });
    if (seq !== explorerSeq || db !== explorerDb || !explorerDrawerOpen()) return; // superseded
    renderExplorerRows(stats, fen);
  } catch (error) {
    if (seq !== explorerSeq || db !== explorerDb) return;
    rows.classList.remove("is-stale");
    rows.removeAttribute("aria-busy");
    if (openingEl) openingEl.textContent = "";
    const label = db === "lichess" ? "Players" : "Masters";
    if (explorerModule && error instanceof explorerModule.ExplorerRateLimited) {
      const secs = Math.max(1, Math.ceil(error.retryInMs / 1000));
      rows.innerHTML = html`<div class="muted hint">Lichess asks for a short pause - try again in ~${secs}s.</div>`;
    } else if (/link your lichess account/i.test(error.message || "")) {
      // Retrying cannot help until an account is linked: offer the link.
      rows.innerHTML =
        html`<div class="muted hint">The ${label} explorer reads Lichess with your linked account. <button type="button" class="btn sm" data-explorer-link>Link Lichess</button></div>`;
      rows.querySelector("[data-explorer-link]")?.addEventListener("click", () => {
        openSettingsSection("set-connections").catch(() => {});
      });
    } else {
      rows.innerHTML =
        html`<div class="muted hint">${label} explorer unavailable: ${error.message} <button type="button" class="btn sm ghost" data-explorer-retry>Retry</button></div>`;
      rows.querySelector("[data-explorer-retry]")?.addEventListener("click", () => refreshExplorerPanel());
    }
  }
}

// Compact scope: folded into the ⓘ popover (inspectorScopeText). The panel
// itself stays rows-only so moves own the height.
function renderExplorerScope() {
  paintInspectorScope();
}

function renderExplorerRows(stats, fen) {
  const rows = document.getElementById("explorer-rows");
  if (!rows) return;
  const openingEl = document.getElementById("explorer-opening");
  if (openingEl) openingEl.textContent = stats.opening || "";
  rows.dataset.fen = fen || "";
  rows.classList.remove("is-stale");
  rows.removeAttribute("aria-busy");
  if (!stats.moves.length) {
    rows.innerHTML = html`<div class="muted hint">No games reached this position - true novelty territory.</div>`;
    void explorerEvalEngine.sync();
    return;
  }
  // Dot the continuations already in the repertoire at this node, so gaps between
  // "what people actually play" and "what I've prepared" jump out.
  const current = appState.buildCurrentNodeId;
  const inRep = new Set(
    (appState.build ? appState.build.nodes : [])
      .filter((n) => n.parent_id === current && n.depth > 0)
      .map((n) => n.uci),
  );
  const inRepNorm = new Set([...inRep].map(normalizeUci));
  const canAdd = !isBuildReadOnly();
  rows.innerHTML =
    html`<div class="explorer-head" aria-hidden="true"><span>Move</span><span class="explorer-eval">Eval</span><span>Games</span><span>White / Draw / Black</span></div>${stats.moves
      .map((m) => {
        const has = inRep.has(m.uci) || inRepNorm.has(normalizeUci(m.uci));
        const games = explorerModule.formatGames(m.total);
        const thin = explorerThinSample(m);
        const action = has ? `Go to ${m.san}` : canAdd ? `Add ${m.san} to repertoire` : m.san;
        const seg = (cls, label, value) =>
          html`<span class="${cls}" style="width:${value}%" title="${label} ${value}%">${explorerSegLabel(value)}</span>`;
        return html`
    <div class="explorer-row${thin ? " is-thin" : ""}${has ? " is-in" : ""}" data-uci="${m.uci}">
      <button type="button" class="explorer-pick" data-explorer-pick aria-label="${action} (${countOf(games, "game")}, White ${m.whitePct}%, draw ${m.drawPct}%, Black ${m.blackPct}%)">
        <span class="explorer-san">${m.san}${has ? html`<span class="explorer-inrep" title="In your repertoire">&#9679;</span>` : ""}</span>
      </button>
      <span class="explorer-eval">&hellip;</span>
      <span class="explorer-games">${games}</span>
      <span class="explorer-bar" aria-hidden="true">${seg("explorer-bar-w", "White wins", m.whitePct)}${seg("explorer-bar-d", "Draws", m.drawPct)}${seg("explorer-bar-b", "Black wins", m.blackPct)}</span>
    </div>`;
      })}`;
  rows.querySelectorAll(".explorer-row").forEach((row) => {
    const uci = row.dataset.uci;
    // The whole row is the action; the Move button inside is the focusable
    // handle and its click bubbles here.
    row.addEventListener("click", () => {
      void onExplorerRowClick(rows, uci).catch(() => {});
      row.querySelector("[data-explorer-pick]")?.blur();
    });
  });
  explorerEvalEngine.repaint();
  void explorerEvalEngine.sync();
}

// Explorer bars are always full width: the W/D/B split is what a row is read
// for, and the game count beside it says how far to trust it. Thin samples are
// dimmed rather than shortened.
const EXPLORER_THIN_SAMPLE = 10;
function explorerThinSample(m) {
  return Math.max(0, Number(m.total) || 0) < EXPLORER_THIN_SAMPLE;
}

// A percent label only where the segment is wide enough to hold it; narrower
// segments keep the figure in their tooltip.
function explorerSegLabel(pct) {
  return pct >= 12 ? `${pct}%` : "";
}

// Explorer rows: a click adds the move to the repertoire and goes there; a move
// already in the repertoire just navigates to it.

function buildChildForUci(parentId, uci) {
  const want = normalizeUci(uci);
  return (appState.build ? appState.build.nodes : []).find(
    (n) => n.parent_id === parentId && n.depth > 0 && (n.uci === uci || normalizeUci(n.uci) === want),
  );
}

async function onExplorerRowClick(rows, uci) {
  const rowsFen = rows.dataset.fen;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  const currentFen = node ? node.fen : boards.build && boards.build.fen;
  if (!node || !rowsFen || !sameFenPosition(rowsFen, currentFen)) return;
  const existing = buildChildForUci(node.id, uci);
  if (existing) {
    await selectBuildNode(existing.id);
    return;
  }
  await onExplorerRowAdd(rows, uci);
}

// Add from an Explorer row. Rows belong to the position they were fetched
// for. A second click (a double click, or a click while the next position's
// stats load) must not replay the old position's move from the new one: that
// was the "Illegal move" toast. The first click consumes the rows; they come
// back live only if the move didn't land (cancelled or rejected) and the board
// is still on their position.
async function onExplorerRowAdd(rows, uci) {
  const rowsFen = rows.dataset.fen;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  const currentFen = node ? node.fen : boards.build && boards.build.fen;
  if (!rowsFen || !sameFenPosition(rowsFen, currentFen)) return;
  delete rows.dataset.fen;
  rows.classList.add("is-stale");
  try {
    await onBuildBoardMove(uci);
  } finally {
    const now = appState.buildNodeById.get(appState.buildCurrentNodeId);
    const nowFen = now ? now.fen : boards.build && boards.build.fen;
    if (!rows.dataset.fen && sameFenPosition(rowsFen, nowFen)) {
      rows.dataset.fen = rowsFen;
      rows.classList.remove("is-stale");
    }
  }
}

function buildRootId() {
  const nodes = appState.build ? appState.build.nodes : [];
  const root = nodes.find((n) => n.depth === 0);
  return root ? root.id : nodes[0]?.id || null;
}

function buildMainlineChild(nodeId) {
  if (!appState.build) return null;
  const kids = appState.build.nodes.filter((n) => n.parent_id === nodeId);
  if (!kids.length) return null;
  return kids.find((k) => k.is_mainline) || kids[0];
}

function buildGoRoot() {
  const id = buildRootId();
  if (id) selectBuildNode(id);
}

function buildGoBack() {
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  if (node && node.parent_id) selectBuildNode(node.parent_id);
}

function buildGoForward() {
  // At a fork, → plays the picked continuation (mainline unless ↑/↓ changed it);
  // anywhere else it just walks the line.
  const ctx = buildBranchContext();
  if (ctx) {
    selectBuildNode(ctx.choiceId);
    return;
  }
  const child = buildMainlineChild(appState.buildCurrentNodeId);
  if (child) selectBuildNode(child.id);
}

function buildGoToEnd() {
  let cur = appState.buildCurrentNodeId;
  let child = buildMainlineChild(cur);
  while (child) {
    cur = child.id;
    child = buildMainlineChild(cur);
  }
  if (cur && cur !== appState.buildCurrentNodeId) selectBuildNode(cur);
}

// The next-move branches from a node (its children), mainline first.
function buildChildrenOf(nodeId) {
  if (!appState.build || !nodeId) return [];
  return appState.build.nodes
    .filter((n) => n.parent_id === nodeId)
    .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
}

// The fork picker. ONE mental model everywhere: you stand on a position, and when
// your prep has two or more continuations from it, the bar (and the board arrows)
// show the choice of NEXT moves. ↑/↓ move the pick, →/Enter plays it, click plays
// it directly. To revisit the alternatives of a move you already played, step back
// with ← — the fork is right there. (The old design flipped between "alternatives
// at this move" and "next-move branches" depending on the node, which meant the
// same keys did different things at different times.)
function buildBranchContext() {
  if (!appState.build || !appState.buildCurrentNodeId) return null;
  const options = buildChildrenOf(appState.buildCurrentNodeId);
  if (options.length < 2) return null; // no fork: plain ← → walking
  const picked = options.find((n) => n.id === appState.buildBranchChoiceId) || options[0];
  return { options, choiceId: picked.id };
}

// ↑/↓ move the pick around the fork's options without leaving the position;
// the bar and the board arrows follow. With no fork they are inert.
function buildBranchKey(direction) {
  const ctx = buildBranchContext();
  if (!ctx) return;
  const idx = ctx.options.findIndex((n) => n.id === ctx.choiceId);
  const next = ctx.options[(idx + direction + ctx.options.length) % ctx.options.length];
  appState.buildBranchChoiceId = next.id;
  renderBuildBranchBar();
}

// The on-screen fork picker: one chip per prepared continuation, the picked one
// lit, mirrored by arrows on the board (the picked arrow drawn stronger).
function renderBuildBranchBar() {
  if (buildView) return buildView.renderBuildBranchBar();
  void ensureBuildView().then((view) => view.renderBuildBranchBar()).catch(() => {});
}

async function saveBuildAnnotations(arrows, circles) {
  if (activeViewName() !== "build" || isBuildReadOnly()) return;
  if (!appState.build || !appState.buildCurrentNodeId) return;
  const ownerId = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isOwner = () => ownerId === currentOwnerId() && generation === appState.ownerGeneration;
  const build = appState.build;
  const repertoireId = build.repertoire_id;
  const selectedId = appState.buildCurrentNodeId;
  const idMap = appState.buildIdMap;
  const resolvedId = () => idMap?.[selectedId] || selectedId;
  const slots = appState.buildAnnotationSlots ||= new Map();
  const key = JSON.stringify([ownerId, generation, repertoireId, resolvedId()]);
  let slot = slots.get(key);
  const node = appState.buildNodeById.get(resolvedId());
  if (!slot) {
    slot = { confirmed: { arrows: (node?.arrows || []).slice(), circles: (node?.circles || []).slice() }, latest: null, task: null };
    slots.set(key, slot);
  }
  slot.latest = { arrows: arrows.slice(), circles: circles.slice() };
  if (node) Object.assign(node, slot.latest);
  if (slot.task) return slot.task;
  const previousSave = appState.buildAnnotationsSaving;
  const task = (async () => {
    if (previousSave) await previousSave;
    while (slot.latest && isOwner()) {
      let snapshot;
      try {
        await hardFlushBuild();
        if (!isOwner()) return;
        snapshot = slot.latest;
        slot.latest = null;
        const current = appState.build?.repertoire_id === repertoireId;
        const nodeId = resolvedId();
        const payload = await postJson("/api/build/annotations", {
          repertoire_id: repertoireId, node_id: nodeId, ...snapshot,
          base_revision: current ? appState.build.revision : build.revision,
        });
        if (Number.isInteger(payload?.revision)) build.revision = Math.max(build.revision || 0, payload.revision);
        slot.confirmed = snapshot;
      } catch (error) {
        if (!isOwner()) return;
        setStatusError(`Annotations not saved: ${error.message}`);
        // A failed prerequisite flush has not consumed latest yet.
        if (!snapshot) slot.latest = null;
      }
      if (!isOwner()) return;
      // Only the newest visible draft can repaint this position. An earlier
      // success advances confirmation/revision without replaying an old drawing.
      if (appState.build?.repertoire_id === repertoireId) {
        const visible = slot.latest || slot.confirmed;
        const currentNode = appState.buildNodeById.get(resolvedId());
        if (currentNode) Object.assign(currentNode, visible);
        if (resolveBuildId(appState.buildCurrentNodeId) === resolvedId()) boards.build.setAnnotations(visible.arrows, visible.circles);
      }
    }
  })();
  slot.task = task;
  appState.buildAnnotationsSaving = task;
  try { await task; }
  finally {
    slots.delete(key);
    if (appState.buildAnnotationsSaving === task) appState.buildAnnotationsSaving = null;
  }
}

function canonicalBuildUci(fen, uci) {
  const normalized = normalizeUci(uci);
  // A rook/queen can legally move along these same squares. Only translate
  // king-to-rook notation when the raw move is not legal in this position.
  return normalized !== uci && !localBoardInfo(fen).legal_moves.includes(uci) ? normalized : uci;
}

async function onBuildBoardMove(moveUci) {
  if (appState.buildLoading) return;
  // Explorer castling uses king-to-rook UCI; the board, local tree and
  // durable queue all use the standard king destination instead.
  const moveParent = appState.buildNodeById.get(appState.buildCurrentNodeId);
  moveUci = canonicalBuildUci(moveParent?.fen || boards.build.fen, moveUci);
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  // Show the move immediately. Snapshot the pre-move position so a failed local
  // apply (or a cancelled repertoire-creation prompt) can roll the board back.
  // The first-move case (no repertoire yet) skips the optimistic render — it
  // opens a modal instead.
  const prevFen = boards.build.fen;
  const prevLegal = boards.build.legalMoves;
  const hadRep = appState.build && appState.buildCurrentNodeId;
  const optimistic = hadRep ? await optimisticBoardMove(boards.build, prevFen, moveUci) : false;
  const rollback = () => {
    if (optimistic && prevFen) {
      boards.build.setPosition({ fen: prevFen, legalMoves: prevLegal, lastMove: null });
    }
  };

  // Bootstrap: the very first move on an empty workspace still creates the
  // repertoire server-side (a modal), then we play onto its real root locally.
  if (!hadRep) {
    // A guest's move would need a repertoire to live in: show the sign-in
    // gate (with its reason) instead of a "Cancelled" for a choice never made.
    if (!requireSignIn("Sign in to save moves to a repertoire", "new-repertoire")) {
      rollback();
      return;
    }
    let created;
    try {
      created = await createRepertoirePrompt({
        title: "Start a new repertoire",
        defaultName: "New repertoire",
      });
    } catch (error) {
      rollback();
      setStatusError(error.message);
      return;
    }
    if (!created) {
      setStatus("Cancelled · playing the move would create a new repertoire");
      rollback();
      return;
    }
  }

  const parentId = appState.buildCurrentNodeId;
  const parent = appState.buildNodeById.get(parentId);
  if (!parent) {
    rollback();
    return;
  }

  // Replaying a move whose old subtree is still inside its undo window: that delete
  // hasn't reached the server yet, so the server still has the old child. Commit the
  // delete NOW so it flushes BEFORE this re-add lands in the same batch — otherwise
  // add-moves dedupes the replay into the still-living old node, and the queued
  // delete then destroys it (taking the replayed move with it). This is the
  // delete-before-add invariant, enforced across the undo-window boundary.
  const parkedDeleteCommit = appState.buildUndoCommitByMove.get(`${parentId}:${moveUci}`);
  if (parkedDeleteCommit) parkedDeleteCommit();

  // Dedupe (parity with the server): replaying an existing line just navigates to
  // the child — no provisional node, no dirty state.
  const existing = appState.build.nodes.find(
    (n) => n.parent_id === parentId && canonicalBuildUci(parent.fen, n.uci) === moveUci
  );
  if (existing) {
    await selectBuildNode(existing.id);
    return;
  }

  let after;
  try {
    after = await boardAfterMove(parent.fen, moveUci);
  } catch (_) {
    rollback();
    setStatus("Illegal move");
    return;
  }

  const node = buildProvisionalNode(parent, moveUci, after);
  appState.build.nodes.push(node);
  appState.buildNodeById.set(node.id, node);
  appState.buildPending.push({
    tempId: node.id,
    base_revision: appState.build?.revision,
    parentRef: parentId,
    uci: moveUci,
    node,
    // R-02: the target travels with the op, so a reload/restored queue can
    // never be flushed into whichever repertoire happens to be open.
    repertoire_id: appState.build ? appState.build.repertoire_id : null,
  });
  await selectBuildNode(node.id);
  setBuildSync("dirty");
  scheduleBuildFlush();
}

async function createRepertoirePrompt({ title, defaultName, openAfter = true, defaultColor = "white" } = {}) {
  if (!requireSignIn("Sign in to create a repertoire", "new-repertoire")) return null;
  const result = await showInputModal({
    title: title || "New repertoire",
    okLabel: "Create",
    fields: [
      { name: "name", label: "Name", default: defaultName || "New repertoire" },
      repertoireColorField(defaultColor),
    ],
  });
  if (!result) return null;
  const name = (result.name || "").trim() || "New repertoire";
  const color = normalizeRepertoireColor(result.color);
  try {
    const payload = await postJson("/api/repertoires/create", { name, color });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    if (openAfter) switchView("build");
    setStatus(`Created ${name}`);
    await refreshDashboardRepertoires();
    return payload;
  } catch (error) {
    setStatusError(error.message);
    return null;
  }
}

// Rough up-front size of a Build → Generate run, for the dialog's estimate and the
// progress bar's ceiling. Your side always gets one move (the engine's best); each
// opponent position keeps the replies humans play at least `mainThreshold` of the time
// on the mainline path and `branchThreshold` inside side branches. The reply count per
// position is a heuristic over typical Maia distributions (~3 at 10%, ~1.7 at 30%).
// A 20% buffer lets the bar finish a touch early.
function estimateBuildGenerateTotal({ plyDepth, mainThreshold, branchThreshold, userToMove = true }) {
  const depth = Math.max(1, Number(plyDepth) || 1);
  const repliesAt = (share) => Math.min(6, 1 + 0.2 / Math.max(0.01, Number(share) || 0.1));
  const mainReplies = repliesAt(mainThreshold ?? GEN_DEFAULT_MAIN_PCT / 100);
  const branchReplies = repliesAt(branchThreshold ?? GEN_DEFAULT_BRANCH_PCT / 100);
  let branchNodes = 0; // nodes off the mainline path at the current ply
  let total = 0;
  for (let ply = 1; ply <= depth; ply++) {
    const userPly = userToMove ? ply % 2 === 1 : ply % 2 === 0;
    if (!userPly) branchNodes = branchNodes * branchReplies + (mainReplies - 1);
    total += 1 + branchNodes; // the mainline node plus everything branched off it
  }
  return Math.max(4, Math.ceil(total * 1.2));
}

// Generate dialog: every knob in plain view, no presets. Depth is counted in full
// moves (one of yours plus their reply); the tree always ends on your answer.
// Opponent coverage has two cut-offs: on the mainline path and inside side branches. Kept conservative: the recursion runs locally and a huge tree risks the
// server apply-plan caps. See GEN_MAX_* / MAX_PLAN_CHANGES.
const GEN_MAX_OWN_MOVES = GEN_MAX_PLY_DEPTH / 2;
const GEN_DEFAULT_OWN_MOVES = 6;
const GEN_DEFAULT_MAIN_PCT = 10;
const GEN_DEFAULT_BRANCH_PCT = 30;

function generateDialogFields() {
  return [
    {
      name: "own_moves",
      label: `Full moves deep (1-${GEN_MAX_OWN_MOVES})`,
      hint: "A full move is one of yours plus their reply.",
      type: "number",
      default: GEN_DEFAULT_OWN_MOVES,
      min: 1,
      max: GEN_MAX_OWN_MOVES,
    },
    {
      name: "main_pct",
      label: "Cover mainline replies played at least (%)",
      hint: "Opponent moves below this share of human games are left out.",
      type: "number",
      default: GEN_DEFAULT_MAIN_PCT,
      min: 1,
      max: 50,
    },
    {
      name: "branch_pct",
      label: "Cover branch replies played at least (%)",
      hint: "Same cut-off, applied inside side branches.",
      type: "number",
      default: GEN_DEFAULT_BRANCH_PCT,
      min: 1,
      max: 50,
    },
    // Defaults to the player's own strength (Settings → Playing strength), so the
    // tree leans toward replies THEIR opponents actually play.
    {
      name: "maia_rating",
      label: "Opponent rating (600-2600)",
      type: "number",
      default: effectiveMaiaRating(),
      min: 600,
      max: 2600,
      step: 50,
    },
    // Per-position Stockfish search depth for this run; Settings holds the default.
    {
      name: "engine_depth",
      label: `Engine depth (${STOCKFISH_MIN_DEPTH}-${STOCKFISH_MAX_DEPTH})`,
      type: "number",
      default: effectiveStockfishDepth(),
      min: STOCKFISH_MIN_DEPTH,
      max: STOCKFISH_MAX_DEPTH,
    },
    { name: "estimate", label: "", type: "note" },
  ];
}

function clampGenerateInt(raw, min, max, fallback) {
  const n = Math.round(Number(String(raw ?? "").trim() || NaN));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// `userToMove`: whose turn it is at the anchor. Your first move starts the tree
// there, so N moves of yours take 2N-1 plies; otherwise the opponent's reply
// comes first and they take 2N. Either way the tree ends on your answer.
function readGenerateOptions(values, { userToMove = true } = {}) {
  const ownMoves = clampGenerateInt(values.own_moves, 1, GEN_MAX_OWN_MOVES, GEN_DEFAULT_OWN_MOVES);
  const plyDepth = Math.min(GEN_MAX_PLY_DEPTH, userToMove ? 2 * ownMoves - 1 : 2 * ownMoves);
  return {
    plyDepth,
    userToMove,
    mainThreshold: clampGenerateInt(values.main_pct, 1, 50, GEN_DEFAULT_MAIN_PCT) / 100,
    branchThreshold: clampGenerateInt(values.branch_pct, 1, 50, GEN_DEFAULT_BRANCH_PCT) / 100,
    maiaRating: clampGenerateInt(values.maia_rating, 600, 2600, effectiveMaiaRating()),
    engineDepth: clampGenerateInt(
      values.engine_depth,
      STOCKFISH_MIN_DEPTH,
      STOCKFISH_MAX_DEPTH,
      effectiveStockfishDepth(),
    ),
  };
}

// Rough range from the same model that sizes the progress bar. Moves already in the
// repertoire are reused, so the real number is often lower (said in the tooltip).
function generateEstimateRange(options) {
  const ceiling = estimateBuildGenerateTotal(options);
  const nice = (n) => (n >= 50 ? Math.round(n / 10) * 10 : n >= 20 ? Math.round(n / 5) * 5 : Math.round(n));
  const low = Math.max(1, nice(ceiling * 0.4));
  const high = Math.max(low + 1, nice(ceiling));
  return { low, high };
}

function generateEstimateText(options) {
  const { low, high } = generateEstimateRange(options);
  return `About ${low}–${high} new moves`;
}

async function generateFromCurrentNode() {
  // True click origin for [engine-lifecycle] timing: recorded before any
  // toast/status/rAF so click → feedback-paint measures the real delay.
  const tGenerate = engineLifecycleMark("build-generate-click");
  // Phase 3c: generation runs in the BROWSER. Stockfish (our turn) + Maia3
  // (opponent) drive the recursion locally into a tree-mutation plan; the server
  // only re-validates + persists via /api/build/generate/apply-plan. No server
  // compute, no fallback.
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  if (!isBrowserEngineAvailable()) {
    setStatusError(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  const isCurrent = captureBuildContext();
  const generationBuild = appState.build;
  let nodeId = appState.buildCurrentNodeId;
  if (!appState.build || !nodeId) {
    setStatus("Open or create a repertoire first");
    return;
  }
  if (jobToast.isBusy()) {
    setStatus("Another job is already running", { severity: "warning" });
    return;
  }
  // apply-plan anchors on a REAL node id — a tmp anchor would 400. Drain any
  // pending local moves first, then re-resolve the (now-real) anchor id.
  try {
    await hardFlushBuild();
    if (!isCurrent()) return;
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  nodeId = resolveBuildId(nodeId);
  const ownColor = appState.build.color === "black" ? "black" : "white";
  const anchorFen = appState.buildNodeById.get(nodeId)?.fen || "";
  const userToMove = (anchorFen.split(" ")[1] === "b" ? "black" : "white") === ownColor;
  const values = await showInputModal({
    title: "Generate moves from this position",
    okLabel: "Generate",
    fields: generateDialogFields(),
    onInput: (current, overlay) => {
      const note = overlay.querySelector('[data-note="estimate"]');
      if (!note) return;
      note.textContent = generateEstimateText(readGenerateOptions(current, { userToMove }));
      note.title = "Fewer where your repertoire already has the moves";
    },
  });
  if (!values || !isCurrent()) return;
  const generateOptions = readGenerateOptions(values, { userToMove });
  const { plyDepth, mainThreshold, branchThreshold, maiaRating, engineDepth } = generateOptions;

  const jobId = `browser-generate-${Date.now()}`;
  const generatedRepertoireId = appState.build.repertoire_id;
  const generatedBaseRevision = appState.build.revision;
  // Cancel model has two phases. GENERATION (local, before the POST) is
  // cancellable: jobToast's Stop aborts the controller, the recursion checks the
  // signal, and an explicit re-check below bails before the POST — so Stop here
  // persists NOTHING. SAVING (the apply-plan POST) is NOT cancellable: an atomic
  // server apply can't be un-persisted by aborting the fetch, so we remove the
  // Stop button before the POST rather than imply a cancel that wouldn't hold.
  const controller = new AbortController();
  // Believable progress: estimate a ceiling, advance a little whenever the planner adds
  // nodes, and — when the engine is busy but quiet — inch forward on a timer so the bar
  // never looks stuck. It is capped just below `total` until generation truly finishes,
  // so it can't fake completion. `lastInitAt` lets the Maia cold-download own the toast.
  const progress = {
    done: 0,
    total: estimateBuildGenerateTotal(generateOptions),
    plannedMoves: 0,
  };
  let lastInitAt = 0;
  let nudgeTimer = null;
  try {
    setStatus("Loading engines and generating moves");
    jobToast.startJob({
      id: jobId,
      title: "Generating moves",
      tab: "build",
      dock: document.getElementById("build-job-dock"),
      total: progress.total,
      onCancel: () => controller.abort(),
    });

    nudgeTimer = setInterval(() => {
      if (!jobToast.isBusy()) return;
      if (Date.now() - lastInitAt < 2000) return; // let Maia cold-init progress own the toast
      progress.done = Math.min(progress.total - 3, progress.done + 1);
      jobToast.updateJob({
        current: progress.done,
        total: progress.total,
        message: progress.plannedMoves
          ? `building tree · +${progress.plannedMoves} moves`
          : "searching candidate moves",
      });
    }, 1800);

    // Yield so the toast/status above paints before the module import below
    // blocks the main thread on fetch + evaluate. The runner import and the
    // shared Maia warmup (worker spawn + ~46 MB weight fetch + ORT session)
    // start in the same tick and proceed in parallel; the pipeline awaits the
    // same shared ready promise only when it reaches the first Maia inference,
    // so one Generate never spawns a second worker/session or re-downloads.
    // The timeout keeps a hidden tab (no animation frames) from stalling the run.
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
      setTimeout(resolve, 100);
    });
    engineLifecycleMark("build-feedback-paint", tGenerate);
    const maiaReady = getSharedMaia3Provider().warmup();
    engineLifecycleMark("build-maia-init-start", tGenerate);
    const { runBrowserBuildGenerate } = await (_buildGenReady || preloadBuildGen());
    engineLifecycleMark("build-runner-import-done", tGenerate);
    if (maiaReady && typeof maiaReady.then === "function") {
      // Do NOT block the Stockfish-led opening moves on this: just note when
      // the shared init lands, so timing shows the parallel window. The first
      // Maia inference inside the runner awaits the same promise.
      maiaReady.then(
        () => engineLifecycleMark("build-maia-ready", tGenerate),
        () => engineLifecycleMark("build-maia-ready-error", tGenerate),
      );
    }
    engineLifecycleMark("build-inference-start", tGenerate);
    const plan = await runBrowserBuildGenerate({
      build: generationBuild,
      rootNodeId: nodeId,
      ownColor,
      plyDepth,
      maiaRating,
      mainThreshold,
      branchThreshold,
      // Per-position Stockfish search depth (NOT the tree's ply depth).
      depth: engineDepth,
      signal: controller.signal,
      // Reuse ONE warm Maia worker/session across Generate runs (Stage 4b) — the first run
      // downloads + caches the ~46 MB model, later runs skip both the fetch and the session
      // create. The orchestrator borrows it and never terminates it. Build
      // Generate is a Maia-by-design capability (human-like opponent branches),
      // independent of the Analyze-layer Maia analysis switch.
      maiaProvider: getSharedMaia3Provider(),
      onProgress: (added) => {
        // `added` is planned nodes, not engine work — so don't map it 1:1 onto the bar.
        // Each report nudges forward a bit, capped just short of `total`.
        progress.plannedMoves = added;
        progress.done = Math.min(
          progress.total - 2,
          Math.max(progress.done + 1, Math.ceil(added * 0.75)),
        );
        jobToast.updateJob({
          current: progress.done,
          total: progress.total,
          message: progress.plannedMoves
            ? `expanding branches · +${added} moves`
            : "expanding branches",
        });
      },
      // Real lifecycle stream from the planner. We only use it to keep the MESSAGE honest
      // about what the engine is doing right now ("searching candidates" vs "consulting
      // Maia") — the bar itself stays on the estimated-unit scale that onProgress and the
      // nudge timer drive, so a chatty stream can't fake completion. Skipped while the Maia
      // cold-init owns the toast (its download % is more useful there).
      onEvent: (ev) => {
        if (!jobToast.isBusy()) return;
        if (Date.now() - lastInitAt < 2000) return;
        if (ev && ev.type === "search") {
          const base = progress.plannedMoves ? `+${progress.plannedMoves} moves · ` : "";
          jobToast.updateJob({
            message:
              ev.engine === "maia"
                ? `${base}consulting Maia for human replies`
                : `${base}searching candidate moves`,
          });
        }
      },
      // Cold-init weight download/verify/session progress (only on the first run / a cache
      // miss). A warm run emits nothing, so the node-building message above just takes over.
      // Zero-progress maia-init phase on purpose: byte-sized current/total would ratchet
      // activeTotal to ~46M and peg the bar near 95%; the download % rides in the message
      // instead while the bar scans until tree generation resumes onProgress ticks.
      onMaiaInitProgress: ({ phase, loaded, total }) => {
        lastInitAt = Date.now();
        if (phase === "download") {
          const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: `downloading Maia model · ${pct}%`,
          });
        } else if (phase === "cache") {
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: "loading cached Maia model",
          });
        } else if (phase === "verify") {
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: "verifying Maia model",
          });
        } else if (phase === "session") {
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: "starting Maia engine",
          });
        }
      },
    });
    if (nudgeTimer) {
      clearInterval(nudgeTimer);
      nudgeTimer = null;
    }

    // Stop pressed during generation (or in the final stretch before we got
    // here) must mean NOTHING is persisted: bail before the POST. The recursion
    // also checks the signal, but it can resolve a tick after the last check.
    if (controller.signal.aborted) {
      const err = new Error("Generation stopped");
      err.name = "AbortError";
      throw err;
    }

    const changeCount = (plan.changes && plan.changes.length) || 0;
    if (changeCount > MAX_PLAN_CHANGES) {
      // The server would reject this with a 400; fail with an actionable message
      // before wasting the round trip.
      throw new Error(
        `That produced ${changeCount} changes, more than the server accepts ` +
          `(${MAX_PLAN_CHANGES}). Lower the ply depth or branch count and try again.`,
      );
    }

    // Committing to the save now. Aborting the apply-plan fetch can't un-persist
    // an atomic server apply, so the saving phase is NOT cancellable: remove the
    // Stop button (synchronously, before the awaited POST, so no late click can
    // land in the gap) rather than let the UI imply a cancel that wouldn't hold.
    jobToast.updateJob({
      current: progress.total,
      total: progress.total,
      message: "saving",
    });
    jobToast.lockJob("saving — finishing up");
    const payload = await postJson(
      "/api/build/generate/apply-plan",
      {
        repertoire_id: generatedRepertoireId,
        base_revision: generatedBaseRevision,
        root_node_id: nodeId,
        plan,
      },
      { signal: controller.signal },
    );
    if (isCurrent()) await hydrateBuild(payload, nodeId);
    const summary = payload.summary || {};
    setStatus(
      `Generated from ${appState.buildNodeById.get(nodeId)?.san || "node"} · +${summary.added_nodes || 0} new`
    );
    jobToast.completeJob({
      title: "Generation done",
      message: `+${summary.added_nodes || 0} new moves`,
      onClick: () => switchView("build"),
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || error.cancelled)) {
      // Aborted before the POST: nothing persisted, existing tree still rendered.
      setStatus("Generation stopped");
      jobToast.cancelJob("Generation stopped");
    } else {
      setStatusError(error.message);
      jobToast.failJob(error.message);
    }
  } finally {
    if (nudgeTimer) clearInterval(nudgeTimer);
  }
}

function openNodeContextMenu(event, nodeId) {
  event.preventDefault();
  if (isBuildReadOnly()) return;
  const node = appState.buildNodeById.get(nodeId);
  if (!node) return;
  const menu = document.getElementById("node-context-menu");
  const sections = [
    {
      title: "Position",
      items: [
        ["generate", "Generate from here"],
      ],
    },
    {
      title: "Branch",
      items: [
        ["set_mainline", node.is_mainline ? "Mainline (active)" : "Set as mainline"],
        ["mark_prepared", node.is_prepared ? "Unmark prepared" : "Mark prepared"],
        ["disable_branch", node.is_enabled ? "Disable branch" : "Re-enable branch"],
      ],
    },
    {
      title: "Annotate",
      items: [
        ["add_comment", "Comment..."],
        ["add_tag", "Tag..."],
      ],
    },
    {
      title: "Copy / Export",
      items: [
        ["copy_fen", "Copy FEN"],
        ["copy_line_pgn", "Copy line PGN"],
        ["export_branch_pgn", "Export branch PGN"],
      ],
    },
    {
      title: "Danger",
      items: [["delete", "Delete this move"]],
    },
  ];
  const safeId = nodeId;
  menu.innerHTML =
    html`<div class="context-target" data-testid="context-target">${nodeMenuHeading(node)}</div>${sections
    .map(
      (section) =>
        html`<div class="context-section">${section.title}</div>${section.items
          .map(
            ([action, label]) =>
              html`<button type="button" data-action="${action}" data-node-id="${safeId}">${label}</button>`
          )
          }`
    )}`;
  menu.hidden = false;
  markNodeMenuTarget(nodeId);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () =>
      handleNodeContextAction(button.dataset.action, button.dataset.nodeId)
    );
  });
}

async function handleNodeContextAction(action, nodeId) {
  closeNodeContextMenu();
  let node = appState.buildNodeById.get(nodeId);
  if (!node) return;
  // Delete is local-first (and confirmation-free): prune the subtree from the
  // client tree immediately and let the debounced flush tell the server. No
  // hard flush — the delete queue handles tmp/real resolution itself.
  if (action === "delete") {
    await deleteBuildNodeLocal(nodeId);
    return;
  }
  // Every other action references the node by id on the server (or, for generate,
  // anchors apply-plan on it). Drain pending local moves so a tmp id is real, then
  // resolve this node's id (it may have just been minted locally) + re-read it.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  nodeId = resolveBuildId(nodeId);
  node = appState.buildNodeById.get(nodeId) || node;
  try {
    if (action === "generate") {
      // The flush above may have reconciled/removed this node. Never anchor Generate
      // on a node that no longer exists (it would open a modal that silently can't
      // apply). Select through the normal path so board + tree + current id stay in sync.
      if (!appState.buildNodeById.has(nodeId)) {
        setStatus("That position is no longer in your repertoire — try again");
        return;
      }
      await selectBuildNode(nodeId);
      await generateFromCurrentNode();
      return;
    }
    if (action === "export_branch_pgn") {
      await exportBuild("pgn", nodeId);
      return;
    }
    if (action === "copy_fen") {
      await navigator.clipboard.writeText(node.fen);
      setStatus("FEN copied");
      return;
    }
    if (action === "copy_line_pgn") {
      const payload = await postJson("/api/build/export", {
        repertoire_id: appState.build.repertoire_id,
        format: "pgn",
        node_id: nodeId,
      });
      await navigator.clipboard.writeText(payload.content);
      setStatus("Line PGN copied");
      return;
    }
    let value = null;
    if (action === "add_comment") {
      const result = await showInputModal({
        title: "Comment",
        okLabel: "Save",
        fields: [
          { name: "comment", label: "Comment", type: "textarea", default: node.comment || "" },
        ],
      });
      if (!result) return;
      value = result.comment;
    } else if (action === "add_tag") {
      const result = await showInputModal({
        title: "Add tag",
        okLabel: "Add",
        fields: [{ name: "tag", label: "Tag name", default: "" }],
      });
      if (!result) return;
      value = (result.tag || "").trim();
      if (!value) {
        setStatus("Tag is empty");
        return;
      }
    }
    const payload = await postJson("/api/build/action", {
      repertoire_id: appState.build.repertoire_id,
      node_id: nodeId,
      action,
      value,
    });
    await hydrateBuild(payload, nodeId);
    setStatus("Node updated");
  } catch (error) {
    setStatusError(error.message);
  }
}

function closeNodeContextMenu() {
  document.getElementById("node-context-menu").hidden = true;
  markNodeMenuTarget(null);
}

// Outline the tree move the context menu acts on while it is open.
function markNodeMenuTarget(nodeId) {
  document.querySelectorAll(".mtree-move.is-menu-target").forEach((el) => el.classList.remove("is-menu-target"));
  if (nodeId == null) return;
  const id = String(nodeId);
  document.querySelectorAll(".mtree-move[data-node-id]").forEach((el) => {
    if (el.dataset.nodeId === id) el.classList.add("is-menu-target");
  });
}

async function exportBuild(format, nodeId = null) {
  if (!appState.build) {
    setStatus("Open a repertoire first");
    return;
  }
  const repertoireId = appState.build.repertoire_id;
  const ownerId = currentOwnerId();
  // Export reads server-side tree state (and may scope to a node id) — sync first.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  if (ownerId !== currentOwnerId()) return;
  if (nodeId) nodeId = resolveBuildId(nodeId);
  // Full tree-with-variations PGN for top-level "Export PGN" calls
  if (format === "pgn" && !nodeId) {
    const payload = await api(
      `/api/repertoires/export-pgn?repertoire_id=${encodeURIComponent(repertoireId)}`
    );
    if (ownerId !== currentOwnerId()) return;
    downloadText(payload.filename, payload.mime, payload.content);
    setStatus(`Downloaded ${payload.filename}`);
    return;
  }
  const payload = await postJson("/api/build/export", {
    repertoire_id: repertoireId,
    format,
    node_id: nodeId,
  });
  if (ownerId !== currentOwnerId()) return;
  downloadText(payload.filename, payload.mime, payload.content);
  setStatus(`Downloaded ${payload.filename}`);
}
