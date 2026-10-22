import { html } from "./html.js";
import { appState, boards } from "./core/state.js";
import { OUTBOX_TAB_ID, activeViewName, api, currentOwnerId, setStatus, setStatusError } from "./core/api.js";
import { effectiveStockfishDepth, pref } from "./core/prefs.js";
import { isBrowserEngineAvailable, createEngineProvider } from "./engine/stockfish-provider.js";
import { EXPLORER_EVAL_MAX_LINES, engineWantedIn, engineWidget } from "./core/engine.js";
import { hooks } from "./core/hooks.js";
import { showUndoToast } from "./undo.js";
import { createBuildLive } from "./build-live.js";

// The sync controller and the Build session are created by the shell after this
// module binds; both arrive through hooks.build. selectBuildNode and
// scheduleBuildFlush are the shell's lazy wrappers, so they come as getters too.

// Repertoire: the opening Explorer panel and its row-eval worker, the inspector
// (Explorer / Coverage), the move tree and the local-first Build queue (temp
// ids, provisional nodes, undo-parked deletes). The editor itself is
// controllers/build-session.js; this module is what the shell, the sync
// controller and the views share, and it is loaded at boot because saving an
// edit runs before any view chunk.
// ----- Opening explorer (Build sidebar) ---------------------------------------
// Real-game stats for the current Build position, fetched straight from Lichess's
// public CORS-open explorer — the PrepForge server never proxies a byte. The
// module is dynamically imported on first open so its code stays out of the boot
// bundle; the client inside it handles caching, request dedup, and 429 cooldown
// (see explorer.js). Here we only debounce navigation and skip work while closed.

export let explorerModule = null;
export let explorerClient = null;
let explorerLoading = null;
// One explorer client for Build and practice games, imported on first use.
export function isBuildReadOnly() {
  return !!(
    appState.sharedToken || (appState.build && appState.build.writable === false)
  );
}

export function ensureExplorerClient() {
  explorerLoading ||= import("./explorer.js").then((mod) => {
    explorerModule = mod;
    explorerClient = mod.createExplorerClient({});
    return explorerClient;
  }).catch((error) => {
    explorerLoading = null;
    throw error;
  });
  return explorerLoading;
}
export let explorerDb = "masters";

export function explorerDrawerOpen() {
  const panel = document.getElementById("explorer-drawer");
  return !!(panel && !panel.hidden && !buildDockFolded() && activeViewName() === "build");
}

export const BUILD_DOCK_TABS = ["explorer", "coverage"];
export let buildDockTab = "explorer";

export function setExplorerDb(next) { explorerDb = next === "lichess" ? "lichess" : "masters"; }
export function setBuildDockTab(name) { buildDockTab = name; }

export function buildDockFolded() {
  const dock = document.getElementById("build-inspector");
  return !!(dock && dock.classList.contains("is-folded"));
}

// ---- Explorer row evals ------------------------------------------------------
// A second Stockfish worker, separate from the live engine lines: it searches the
// same position at the same depth, restricted (UCI `searchmoves`) to exactly the
// Explorer's candidate moves with one PV per candidate. The main widget keeps its
// own line count, so its best line reaches full depth as fast as a single-PV
// search; the row evals cost one extra worker, only while Build's Explorer is
// showing with the engine on.
class ExplorerEvalEngine {
  constructor() {
    this.engine = null;
    this.engineDepth = null;
    this.key = null; // fen + candidate moves of the running search
    this.snapshot = null;
    this.pollTimer = null;
  }

  wanted() {
    return (
      activeViewName() === "build" &&
      engineWantedIn("build") &&
      buildDockTab === "explorer" &&
      explorerDrawerOpen()
    );
  }

  // Candidate moves on screen for the current node, most-played first.
  _candidates() {
    const rows = document.getElementById("explorer-rows");
    const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
    const fen = (node && node.fen) || null;
    if (!rows || !fen || !sameFenPosition(rows.dataset.fen, fen)) return null;
    const moves = [];
    rows.querySelectorAll(".explorer-row").forEach((row) => {
      const uci = normalizeUci(row.dataset.uci);
      if (uci && !moves.includes(uci)) moves.push(uci);
    });
    return moves.length ? { fen, moves: moves.slice(0, EXPLORER_EVAL_MAX_LINES) } : null;
  }

  _ensureEngine() {
    const depth = effectiveStockfishDepth();
    if (this.engine && this.engineDepth === depth) return;
    this.stop();
    this.engine = createEngineProvider({ maxDepth: depth, maxMultipv: EXPLORER_EVAL_MAX_LINES, priority: "interactive" });
    this.engineDepth = depth;
  }

  // Start, retarget or stop the search to match what the Explorer shows now.
  async sync() {
    if (!this.wanted()) {
      this.stop();
      this.repaint();
      return;
    }
    const want = this._candidates();
    if (!want) {
      // No rows belong to a live position (mid-fetch, empty, or failed). The search
      // on the old position must actually STOP, not just be forgotten — otherwise it
      // burns a core at full depth on an off-screen position with nothing left to
      // poll it. Park it (worker stays warm; `_ensureEngine` rebuilds if it is gone).
      this.key = null;
      this.snapshot = null;
      this._stopPolling();
      if (this.engine) {
        try {
          this.engine.stopSearch();
        } catch (_) {
          /* best-effort */
        }
      }
      this.repaint();
      return;
    }
    this._ensureEngine();
    const key = `${want.fen}|${want.moves.join(",")}|${this.engineDepth}`;
    if (key === this.key) return;
    this.key = key;
    this.snapshot = null;
    this._stopPolling();
    this.repaint();
    const engine = this.engine;
    try {
      const snapshot = await engine.update({
        fen: want.fen,
        multipv: want.moves.length,
        searchmoves: want.moves,
      });
      if (engine !== this.engine || key !== this.key) return;
      this._accept(snapshot);
      if (snapshot.running !== false) this._poll();
    } catch (error) {
      if (engine !== this.engine || key !== this.key) return;
      this.snapshot = { error: error.message };
      this.repaint();
    }
  }

  _accept(snapshot) {
    this.snapshot = snapshot;
    this.repaint();
    if (snapshot && snapshot.running === false) this._stopPolling();
  }

  _poll() {
    this._stopPolling();
    const engine = this.engine;
    const key = this.key;
    this.pollTimer = setInterval(() => {
      if (engine !== this.engine || key !== this.key) {
        this._stopPolling();
        return;
      }
      this._accept(engine.snapshot());
    }, 450);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stop() {
    this._stopPolling();
    this.key = null;
    this.snapshot = null;
    if (this.engine) {
      const engine = this.engine;
      this.engine = null;
      this.engineDepth = null;
      Promise.resolve()
        .then(() => engine.close())
        .catch(() => {});
    }
  }

  repaint() {
    // The Explorer rows exist only once the Build editor has loaded.
    if (hooks.build?.session) {
      hooks.build.paintExplorerEvals(this.snapshot, engineWidget.isOpen() ? engineWidget.lastSnapshot : null);
    }
  }
}
export const explorerEvalEngine = new ExplorerEvalEngine();

// Explorer reports castling king-to-rook (e1h1); Stockfish king-two-squares.
const CASTLE_UCI = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" };
export function normalizeUci(uci) {
  const key = String(uci || "").toLowerCase();
  return CASTLE_UCI[key] || key;
}

export function sameFenPosition(a, b) {
  if (!a || !b) return false;
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

export function setBuildInspector(tool) {
  const tab = BUILD_DOCK_TABS.includes(tool) ? tool : buildDockTab;
  const panels = {
    explorer: document.getElementById("explorer-drawer"),
    coverage: document.getElementById("coverage-drawer"),
  };
  const buttons = {
    explorer: document.getElementById("build-tool-explorer"),
    coverage: document.getElementById("build-tool-coverage"),
  };
  buildDockTab = tab;
  BUILD_DOCK_TABS.forEach((name) => {
    const on = name === tab;
    if (panels[name]) panels[name].hidden = !on;
    const button = buttons[name];
    if (!button) return;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  });
  const dbs = document.getElementById("inspector-dbs");
  const engineSwitch = document.getElementById("explorer-engine-switch");
  if (dbs) dbs.hidden = tab !== "explorer";
  if (engineSwitch) engineSwitch.hidden = tab !== "explorer";
  for (const id of ["coverage-scope", "coverage-depth", "coverage-run"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = tab !== "coverage";
  }
  hooks.build?.paintInspectorScope();
  if (tab === "explorer") hooks.build?.refreshExplorerPanel();
  if (tab === "coverage") void hooks.build?.ensureCoverageView().then((view) => { view.sync(); view.paint(); }).catch((error) => setStatusError(error.message));
  void explorerEvalEngine.sync();
}

export function renderBuilderTreeEmptyState() {
  const container = document.getElementById("builder-tree");
  const branchBar = document.getElementById("build-branchbar");
  const meta = document.getElementById("build-tree-meta");
  if (!container) return;
  if (meta) {
    meta.hidden = true;
    meta.innerHTML = "";
  }
  container.innerHTML =
    html`<div class="tree-empty">No repertoire open. Pick one from the Library, or play a move to start.</div>`;
  if (branchBar) branchBar.hidden = true;
  if (boards.build) boards.build.setBranchArrows([]);
  hooks.build?.paintGenerateVisibility();
  hooks.build?.syncViewHeads();
}

export function renderBuilderTree() {
  hooks.build?.coverageView?.sync();
  if (!appState.build) {
    renderBuilderTreeEmptyState();
    return;
  }
  if (hooks.build?.view) return hooks.build.view.renderBuilderTree();
  void hooks.build?.ensureBuildView().then((view) => view.renderBuilderTree()).catch(() => {});
}

// ===== Local-first Build sync ================================================
// Local-first Build sync, Phase 1. A played move mutates the local tree
// immediately and is queued; a debounced batch flush reconciles with the server,
// which owns id assignment + flag recomputation. The client never waits on the
// network to render a move (降延遲) and writes are batched (降消耗).

// R-04: the temp id is the outbox's operation identity — mergeById dedupes adds
// and tombstones settle by it. A bare per-tab counter would restart at 1 in
// EVERY tab, so two tabs of the same account mint the same "tmp-1" for different
// moves; the merge would then treat the second tab's new move as the first
// tab's already-settled op and drop it from the durable queue (silent data
// loss on close). The tab id keeps ids unique per tab while still matching the
// server's 'tmp-' prefix rule.
export function mintBuildTmpId() {
  return `tmp-${OUTBOX_TAB_ID}-${++appState.buildTmpCounter}`;
}

// True when the parent already has at least one enabled child — used to decide a
// provisional move's display-only `is_mainline` (first move wins). The server
// recomputes the authoritative value on reconcile.
export function someEnabledChildOf(parentId) {
  if (!appState.build) return false;
  return appState.build.nodes.some((n) => n.parent_id === parentId && n.is_enabled);
}

// Resolve a possibly-stale `tmp-` id to its real id once a flush has reconciled
// the tree. Queued deletes are `{ id, repertoire_id }` entries (see
// queueBuildDelete) so they carry their target too; plain ids still work.
export function resolveBuildId(ref) {
  const id = ref && typeof ref === "object" ? ref.id : ref;
  return (id && appState.buildIdMap[id]) || id;
}

// R-02: every queued op records WHICH repertoire it belongs to. A flush may
// only send ops for the repertoire it is flushing; anything else stays queued
// for its own tree, so restored work can never land in the wrong opening.
export function buildOpMatchesRepertoire(entry, repertoireId) {
  return String(entry.repertoire_id) === String(repertoireId);
}

export function queueBuildDelete(nodeId) {
  appState.buildPendingDeletes.push({
    id: nodeId,
    repertoire_id: appState.build ? appState.build.repertoire_id : null,
  });
}

// Insert a provisional node and queue its add. R-02: the target repertoire
// travels with the op, so a restored queue never lands in another tree.
export function queueBuildAdd(node) {
  appState.build.nodes.push(node);
  appState.buildNodeById.set(node.id, node);
  appState.buildPending.push({
    tempId: node.id,
    parentRef: node.parent_id,
    uci: node.uci,
    node,
    repertoire_id: appState.build.repertoire_id,
  });
}

export function hasPendingBuildOpsFor(repertoireId) {
  return (
    appState.buildPending.some((m) => buildOpMatchesRepertoire(m, repertoireId)) ||
    appState.buildPendingDeletes.some((entry) => buildOpMatchesRepertoire(entry, repertoireId))
  );
}

// Re-read the open repertoire's tree from the server. This is the one hydrateBuild
// entry point that is not a user navigation (a finished Train session changed
// spaced-repetition state, so the Repertoire head's "to train" count is stale).
//
// hydrateBuild takes the /api/build/load PAYLOAD and assigns it to appState.build.
// Handing it a repertoire id put a string in appState.build, and the next paint of
// the header read build.nodes.filter — "Cannot read properties of undefined".
//
// The round-trip is a window in which the world can move: another repertoire can be
// opened, the account can change, or a queued edit can be acknowledged (which
// re-hydrates the tree and advances its revision). Adopting the older payload then
// would paint a tree the user already left and drop the edit that just landed, so
// any of those changes abandons the read. A failed read leaves the current tree
// alone: a stale count beats a half-loaded builder.
export async function reloadOpenBuildTree() {
  const build = appState.build;
  const repertoireId = build && build.repertoire_id;
  if (!repertoireId || !appState.signedIn || !hooks.build?.session) return false;
  const revision = build.revision;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  try {
    const payload = await api(`/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`);
    const unchanged =
      appState.signedIn &&
      owner === currentOwnerId() &&
      generation === appState.ownerGeneration &&
      // Same tree object AND same revision: a confirmed edit both replaces the
      // object and moves the revision, and the payload predates either.
      appState.build === build &&
      build.revision === revision &&
      build.repertoire_id === repertoireId;
    if (!unchanged) return false;
    const selection = appState.buildCurrentNodeId;
    const kept = payload.nodes.some((node) => node.id === selection);
    await hooks.build.session.hydrateBuild(payload, kept ? selection : null);
    return true;
  } catch (_) {
    return false;
  }
}

// The open repertoire follows edits made on other devices and tabs.
export function startBuildLive() {
  createBuildLive({
    api, appState, reload: reloadOpenBuildTree, activeView: activeViewName, notify: setStatus, tabId: OUTBOX_TAB_ID,
    hydrate: (payload, selection) => hooks.build.session.hydrateBuild(payload, selection),
    select: (nodeId) => hooks.build.selectBuildNode(nodeId),
  }).start();
}

// Build a provisional Build node matching the serializer shape (workspace_view.py
// opening_item_to_json) so it renders and is selectable exactly like a real one.
// Flags here are display-only; the server overwrites them on reconcile.
export function buildProvisionalNode(parent, uci, after) {
  const parts = String(parent.fen || "").split(" ");
  const moveSide = parts[1] === "b" ? "black" : "white";
  const moveNumber = Number(parts[5]) || parent.move_number || 1;
  const repColor = appState.build && appState.build.color === "black" ? "black" : "white";
  return {
    id: mintBuildTmpId(),
    parent_id: parent.id,
    depth: (parent.depth || 0) + 1,
    san: after.move.san,
    uci,
    fen: after.board.fen,
    fen_before: parent.fen,
    fen_after: after.board.fen,
    move_number: moveNumber,
    ply: (parent.ply || 0) + 1,
    move_side: moveSide,
    side_to_move: after.move.side_to_move,
    source: "manual",
    is_mainline: !someEnabledChildOf(parent.id),
    is_prepared: moveSide === repColor,
    is_enabled: true,
    maia_probability: null,
    engine_evaluation: null,
    tags: [],
    comment: "",
    arrows: [],
    circles: [],
    mastery: null,
  };
}

// Re-insert still-pending provisional nodes onto the freshly hydrated tree (which
// dropped them when it rebuilt buildNodeById from the server payload). Insertion
// order preserves parent-before-child, so a tmp parent re-inserted earlier in the
// loop is already present for its child.
export function reapplyPendingBuildNodes(pending, idMap) {
  if (!pending.length) return;
  for (const entry of pending) {
    const node = entry.node;
    // Idempotent: hydrateBuild and the flush reconcile both call this for the
    // same queue, and re-inserting a node would duplicate it in the tree.
    if (!node || appState.buildNodeById.has(node.id)) continue;
    const realParent = idMap[entry.parentRef] || entry.parentRef;
    entry.parentRef = realParent;
    node.parent_id = realParent;
    const parent = appState.buildNodeById.get(realParent);
    if (parent) node.depth = (parent.depth || 0) + 1;
    // Dedupe: the server may have already materialised this child (e.g. the same
    // line existed). If so, adopt the real id and drop the provisional.
    const dup = appState.build.nodes.find(
      (n) => n.parent_id === realParent && n.uci === node.uci && n.id !== node.id
    );
    if (dup) {
      appState.buildIdMap[node.id] = dup.id;
      continue;
    }
    appState.build.nodes.push(node);
    appState.buildNodeById.set(node.id, node);
  }
  renderBuilderTree();
}

// Collect a subtree (the flat list keys children by parent_id) and remove it
// from the local tree. Returns the removed ids; rendering is the caller's job.
export function pruneLocalBuildSubtree(rootId) {
  const doomed = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of appState.build.nodes) {
      if (!doomed.has(n.id) && doomed.has(n.parent_id)) {
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  appState.build.nodes = appState.build.nodes.filter((n) => !doomed.has(n.id));
  for (const id of doomed) appState.buildNodeById.delete(id);
  return doomed;
}

// Re-prune subtrees whose delete is still queued after a hydrate resurrected
// them (the server hasn't seen the delete yet). Mirrors reapplyPendingBuildNodes
// for the delete half of the local-first queue.
export function reapplyPendingBuildDeletes() {
  // Undo-window prunes count too: the server still has those subtrees, so a
  // hydrate resurrects them just like queued-but-unflushed deletes.
  const ids = [
    ...appState.buildPendingDeletes.filter((entry) =>
      buildOpMatchesRepertoire(entry, appState.build.repertoire_id),
    ),
    ...appState.buildUndoDeletes,
  ];
  if (!appState.build || !ids.length) return;
  let pruned = false;
  for (const id of ids) {
    const resolved = resolveBuildId(id);
    const node = appState.buildNodeById.get(resolved);
    if (!node) continue;
    const parentId = node.parent_id;
    const doomed = pruneLocalBuildSubtree(resolved);
    pruned = true;
    if (doomed.has(appState.buildCurrentNodeId) && appState.buildNodeById.has(parentId)) {
      hooks.build.selectBuildNode(parentId);
    }
  }
  if (pruned) renderBuilderTree();
}

// Local-first delete (no confirmation by design — pruning lines is a routine
// Build edit, and the flush model makes it cheap): drop the subtree from the
// client tree immediately, cancel any pending adds inside it, and queue the
// subtree root for the debounced delete flush. A node that never reached the
// server (its add is still pending) is cancelled outright — no server op at all.
export async function deleteBuildNodeLocal(nodeId) {
  const node = appState.buildNodeById.get(nodeId);
  if (!node || !appState.build) return;
  if (!node.parent_id) {
    setStatus("Can't delete the starting position");
    return;
  }
  const repId = appState.build.repertoire_id;
  const parentId = node.parent_id;
  const prevSelection = appState.buildCurrentNodeId;
  const prevBranchChoice = appState.buildBranchChoiceId;
  const nodesBefore = appState.build.nodes;
  const doomed = pruneLocalBuildSubtree(nodeId);
  const removedNodes = nodesBefore.filter((n) => doomed.has(n.id));
  // Park pending adds inside the subtree with the undo entry. If the root itself
  // was one of them the server never saw it, so no delete needs to flush for it;
  // descendants of a real root are deleted server-side by the subtree delete anyway.
  const rootWasLocalOnly = appState.buildPending.some((m) => m.tempId === nodeId);
  const parkedAdds = appState.buildPending.filter((m) => doomed.has(m.tempId));
  appState.buildPending = appState.buildPending.filter((m) => !doomed.has(m.tempId));
  if (appState.buildBranchChoiceId && doomed.has(appState.buildBranchChoiceId)) {
    appState.buildBranchChoiceId = null;
  }
  if (doomed.has(appState.buildCurrentNodeId)) {
    await hooks.build.selectBuildNode(parentId);
  } else {
    renderBuilderTree();
  }
  hooks.build.syncViewHeads();
  // The delete doesn't queue for the server until the undo window closes; until
  // then it lives in buildUndoDeletes so a reconcile re-hydrate re-prunes it.
  appState.buildUndoDeletes.add(nodeId);
  // Keyed by the deleted move's slot so a replay of the SAME move can commit this
  // delete first (see onBuildBoardMove). The slot is freed in both settle paths.
  const undoMoveKey = `${parentId}:${node.uci}`;
  const extra = doomed.size > 1 ? ` (+${doomed.size - 1} after it)` : "";
  // One notice only: the inline Undo card beside the tree (no extra status
  // toast), so nothing lands on top of the Explorer.
  const undoCommit = showUndoToast({
    host: document.getElementById("build-undo"),
    title: "Move deleted",
    message: `${node.san || "Move"}${extra} removed`,
    onCommit: () => {
      appState.buildUndoCommitByMove.delete(undoMoveKey);
      appState.buildUndoDeletes.delete(nodeId);
      if (!appState.build || appState.build.repertoire_id !== repId) return;
      if (!rootWasLocalOnly) queueBuildDelete(nodeId);
      if (appState.buildPending.length || appState.buildPendingDeletes.length) {
        hooks.build.setBuildSync("dirty");
        hooks.build.scheduleBuildFlush();
      }
    },
    onUndo: async () => {
      appState.buildUndoCommitByMove.delete(undoMoveKey);
      appState.buildUndoDeletes.delete(nodeId);
      if (!appState.build || appState.build.repertoire_id !== repId) return;
      for (const n of removedNodes) {
        if (!appState.buildNodeById.has(n.id)) {
          appState.build.nodes.push(n);
          appState.buildNodeById.set(n.id, n);
        }
      }
      for (const m of parkedAdds) {
        // The parent may have reconciled tmp -> real while the add was parked.
        m.parentRef = resolveBuildId(m.parentRef);
        m.node.parent_id = m.parentRef;
        appState.buildPending.push(m);
      }
      if (
        !appState.buildBranchChoiceId &&
        prevBranchChoice &&
        appState.buildNodeById.has(prevBranchChoice)
      ) {
        appState.buildBranchChoiceId = prevBranchChoice;
      }
      if (prevSelection && appState.buildNodeById.has(prevSelection)) {
        await hooks.build.selectBuildNode(prevSelection);
      } else {
        renderBuilderTree();
      }
      hooks.build.syncViewHeads();
      if (parkedAdds.length) {
        hooks.build.setBuildSync("dirty");
        hooks.build.scheduleBuildFlush();
      }
      setStatus(`Restored ${node.san || "move"}`);
    },
  });
  appState.buildUndoCommitByMove.set(undoMoveKey, undoCommit);
}
