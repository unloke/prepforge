// Train and Play: the active drill or game, the smart queue and its sync queue.
// Written by the Train controllers (controllers/train-*.js, train-*.js) and views/train.js.
export const trainState = {
  trainRepertoireOptionsError: "",
  trainHomeReady: false,
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
  luckyRun: null,
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
  trainSyncState: "saved", // saved | dirty | syncing | error (Train save chip)
};
