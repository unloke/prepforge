// The Build view: the open repertoire, its tree and the local-first sync queue.
// Written by the Build controllers (build-entry.js, controllers/build-session.js, controllers/sync.js) and views/build*.js.
export const buildState = {
  build: null,
  buildLoading: false,
  buildLoadTarget: null,
  buildLoadRequest: null,
  buildNodeById: new Map(),
  buildCurrentNodeId: null,
  // The owner's per-node mastery for the open tree (build-mastery.js):
  // { repertoireId, revision, byNode: Map(nodeId -> state) }, or null.
  buildMastery: null,
  buildBranchChoiceId: null,
  // The node a move just created, so the tree can show it arriving once. Cleared
  // on the next add (or on a fresh tree), never persisted: it is a cue, not state.
  buildJustAddedId: null,
  // Moves this tab added, newest last, for Ctrl/Cmd+Z ({ repertoireId, id }).
  buildAddedIds: [],
  // Opening names the Explorer reported, by position (FEN without the clocks).
  buildOpeningByFen: new Map(),
  // ---- Local-first Build sync (Phase 1) --------------------------------------
  // Moves land in the local tree instantly (no per-move round-trip) and flush to
  // the server in debounced batches via POST /api/build/add-moves.
  buildPending: [], // queued { tempId, parentRef, uci, node } awaiting a flush
  buildPendingDeletes: [], // queued subtree-root node ids awaiting a delete flush
  buildTmpCounter: 0, // monotonic source of `tmp-N` provisional ids
  buildIdMap: {}, // tmp -> real id, accumulated across reconciles this session
  buildFlushTimer: null, // idle-debounce handle
  buildFlushing: null, // in-flight flush promise (hard flush awaits it)
  buildSyncState: "saved", // saved | dirty | syncing | error
  buildSyncRetry: 0, // exponential-backoff attempt counter
  // Subtree-root ids pruned locally but still inside their undo window — not yet
  // queued for the server. A reconcile re-hydrate must re-prune these too.
  buildUndoDeletes: new Set(),
  // `${parentId}:${uci}` -> commit fn for a parked subtree delete. Lets a replay of
  // the SAME move force its delete to flush first (server still has the old node,
  // so an add ahead of the delete would dedupe into the doomed node).
  buildUndoCommitByMove: new Map(),
};
