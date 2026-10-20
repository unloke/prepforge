import { createNotices } from "../notices.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const files = ["a", "b", "c", "d", "e", "f", "g", "h"];

export const appState = {
  currentView: "dashboard",
  repertoireList: [],
  analysis: null,
  // Raw PGN from the most recent in-session Analyze run (not history recall).
  analysisSourcePgn: null,
  // A finished-but-unsaved analysis held only in memory (device storage
  // refused the checkpoint) so "Retry save" can still reach it.
  analysisUnsavedCheckpoint: null,
  analysisJobId: null,
  analysisPolling: false,
  analysisPly: 0,
  analysisBoardFen: START_FEN,
  // Study variations explored on the Analyze board: a small client-side tree
  // hanging off the analyzed mainline so the player can branch out and compare
  // lines without losing the original game.
  analysisVarNodes: new Map(),
  analysisVarCounter: 0,
  analysisCurrentNodeId: "root",
  analysisTree: null,
  // Last position fed to the coach panel: { fen, lastUci, lastSan }.
  explainContext: { fen: START_FEN, lastUci: null, lastSan: null },
  evalChartPoints: [],
  build: null,
  buildLoading: false,
  buildNodeById: new Map(),
  buildCurrentNodeId: null,
  buildBranchChoiceId: null,
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
  // Repertoire ids hidden from lists while their delete-undo window is open.
  pendingRepDeletes: new Set(),
  // Game ids hidden from the Analyze history while their delete-undo window is open.
  pendingAnalysisDeletes: new Set(),
  trainingRepertoireId: null,
  // Practice game keeps its own multi-select independent of the
  // line-rehearsal picker. `null` means the list has not been hydrated yet;
  // the first active-list load then selects every active repertoire by default.
  playRepertoireIds: null,
  playRepertoirePreferenceKey: null,
  training: null,
  // Which trainer the Start button launches: "smart" (card queue, default) or
  // "all_lines" (whole-line rehearsal for pre-game prep).
  trainMode: "smart",
  play: null,
  // One on-demand Lucky round at a time. This protects Lichess's one-request
  // at-a-time guidance and prevents two clicks from racing their Play boards.
  luckyBusy: false,
  // Live smart-queue session state (see the Smart queue trainer section).
  smart: null,
  // ---- Local-first Train sync (plan §2) -----------------------------------
  // The smart session runs entirely in the browser off the /smart/start card
  // bundle; graded first attempts + the session position flush in debounced
  // batches via POST /api/train/smart/sync.
  trainSync: {
    pending: [], // queued { session_id, node_id, correct } graded attempts
    dirty: false, // position (card_index/queue) changed since the last flush
    timer: null, // idle-debounce handle
    flushing: null, // in-flight flush promise
    retry: 0, // exponential-backoff attempt counter
  },
  // R-03: ops the server permanently refused. Kept for inspection/export —
  // restored on reload, never silently dropped, never auto-retried.
  trainRejected: [],
  // Whether the durable outbox write succeeded. False means the queue only
  // lives in this tab, which the UI must state honestly.
  outboxPersisted: true,
  outboxStorageWarned: false,
  trainSyncState: "saved", // saved | dirty | syncing | error (Train save chip)
  // The LIVE Lichess token's username (drives latest-game fetch / replay). Null when
  // the token is absent/expired even if still signed in.
  lichessUsername: null,
  // The account's stable Lichess username from auth status — persists across a token
  // drop and is what the user-name button shows. Null only for a true guest.
  accountUsername: null,
  // The account's user id (from auth status); lets the Teams view spot the caller in
  // a member list (remove-self / leave). Null for a guest.
  accountUserId: null,
  // Whether this browser's session is bound to a real PrepForge account (vs a guest).
  // Guests see the sign-in action; signed-in users get the account menu and may link
  // a Lichess account separately.
  signedIn: false,
  // Whether the session has been read yet. Until it has, `signedIn` is "unknown",
  // NOT "signed out": an owner-scoped view must hold a neutral loading state rather
  // than paint guest copy that a signed-in user would then see flashing on reload.
  authKnown: false,
  replayResults: null,
  replayFilter: null, // summary-chip filter: an outcome kind, or null = all
  replayOpen: new Set(), // at most one selected game in the inspector
  replaySection: "games",
  // Teams view: cache of the caller's teams (for the rep-share picker) and the
  // currently-expanded team's id (so a member add/remove re-renders the right one).
  teams: [],
  selectedTeamId: null,
  // Public share-link viewer (?shared=token). Team-shared read-only uses
  // build.writable === false instead — see isBuildReadOnly().
  sharedToken: null,
  pieceStyle: "berlin",
  // Maia3 strength: a Settings-pinned rating (null = AUTO), and the auto-resolved
  // rating from the linked Lichess account's public profile (null until fetched).
  maiaRatingPinned: null,
  maiaAutoRating: null,
};

export const boards = {};

export const notices = createNotices();
