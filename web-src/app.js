import { html, raw } from "./html.js";
import { MAX_FETCH } from "./generated/shared-constants.js";

import { createSyncController } from "./controllers/sync.js";
import "./styles.css";
import "./phone.css";
import { createToastStack } from "./controllers/toast-stack.js";
import { buildArrowHeadPath, buildArrowPath, endsUnder } from "./board-arrows.js";
import { classBadgeSymbol } from "./move-grades.js";
import { countOf } from "./plural.js";
// One per-position analysis store (engine/position-analysis-store.js) behind the
// Engine panel, the Coach and the whole-game pass.
let analysisStoreReady;
function analysisStore() {
  return analysisStoreReady ||= import("./engine/position-analysis-store.js")
    .then(({ createPositionAnalysisStore }) => createPositionAnalysisStore({
      getMaia: () => (maiaAnalysisEnabled() ? getSharedMaia3Provider() : null),
      sanLine: sanLineFromUci,
      savedEval: (fen) => appState.analysis?.position_evals?.[fen],
    }));
}

function createSharedEvaluationProvider(options) {
  let handle = null;
  let seq = 0;
  const select = async (request) => {
    const token = ++seq;
    const store = await analysisStore();
    if (token !== seq) return null;
    handle ||= store.createHandle(options);
    return handle.open(request);
  };
  return { open: select, update: select, snapshot: () => handle?.snapshot(),
    close: async () => { seq += 1; await handle?.close(); } };
}
import { advanceBuildRevision, queuedBuildRevision, rebaseQueuedBuildRevision, withBuildRevision } from "./build-revision.js";
import {
  createEngineProvider,
  isBrowserEngineAvailable,
} from "./engine/stockfish-provider.js";
import {
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
  peekSharedMaia3Provider,
} from "./engine/maia3-provider.js";
import { createCsrfTokenSource, headersWithCsrf, readCsrfCookie, CSRF_HEADER } from "./csrf.js";
import { localBoardInfo, localBoardAfterMove, localSanLine, isStartFen } from "./chess-local.js";
import { applyTheme } from "./theme.js";
import { bindRailCollapseOnNavigate } from "./rail-nav.js";
import { parsePgn } from "./analyze-pgn.js";
import { createBoardController } from "./board/board-controller.js";
import { isReviewedMove, pgnPlayers, selfSide } from "./analyze-orient.js";
import { classifySyncError } from "./sync-errors.js";
import { apiErrorMessage } from "./api-errors.js";
import { withRequestDeadline } from "./sync-queue.js";
import { normalizeRepertoireColor, repertoireColorField } from "./repertoire-color.js";
import { trainStartDisabled } from "./train-start.js";
import { coachTipMayReplace, wrongMoveTip } from "./train-hint.js";
import { syncChipVariant } from "./sync-chip.js";
import { nodeMenuHeading } from "./node-menu.js";
import { clearCheckpoint, evalMapFrom, loadCheckpoint, markCheckpointSaved, saveCheckpoint } from "./analyze-checkpoint.js";
import {
  loadReturnState,
  pendingHandoffs,
  rememberHandoff,
  saveReturnState,
  setHandoffOwner,
  takeHandoff,
  transitionHandoff,
  trackPreparationPractice,
} from "./handoff-context.js";
import { describeMove } from "./explain.js";
import {
  activateWorkspaceTab,
  parseWorkspaceLocation,
  serializeWorkspaceLocation,
  workspaceLocationFromState,
} from "./workspace-url.js";
import {
  pickOpponentReply,
  playPositionAfterReply,
  replyReasonNote,
  unavailableExplorer,
} from "./train-opponent.js";
import {
  resolvePlayColor,
  formatPlayTrail,
  takebackToUserMove,
  playSessionPgn,
} from "./train-play.js";
import { engineUnavailableBanner, engineBannerHtml } from "./engine-banner.js";
import { fetchLichessProfile } from "./lichess-profile.js";
import {
  buildPaletteItems,
  filterPaletteItems,
  renderPaletteItems,
} from "./command-palette.js";
import { createAccountController } from "./controllers/account.js";
import {
  AUTH_REQUIRED_MESSAGE,
  isAuthError,
  isAuthRequiredMessage,
  isPendingActionId,
  isSessionAuthFailure,
  restoredAuthHref,
  stripSignedInParam,
  takeAuthReturn,
  takePendingAction,
} from "./auth-gate.js";
import { shouldClearStatusOnNavigate } from "./status-pill.js";
import {
  openSourceComposer,
  normalizeSelection,
  selectionChips,
  resolveFetchUsernames,
  sameFetchSources,
} from "./views/shared/source-composer.js";
let _coachReady = null;
function loadTrainResume() {
  return import("./train-resume.js");
}

function preloadCoach() {
  if (!_coachReady) {
    _coachReady = import("./coach/bundle.js").catch((err) => {
      _coachReady = null;
      throw err;
    });
  }
  return _coachReady;
}

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

// Front-end error beacon (stability plan #1): report uncaught errors so we have a
// server-side window into browser crashes. Best-effort — sendBeacon never throws
// back into the app, and the endpoint is CSRF-exempt + needs no auth.
function reportClientError(payload) {
  try {
    navigator.sendBeacon(
      "/api/clientlog",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  } catch {
    /* best-effort, never throw from the reporter itself */
  }
}
window.addEventListener("error", (e) => {
  reportClientError({
    kind: "error",
    message: e.message,
    src: e.filename,
    line: e.lineno,
    col: e.colno,
    stack: e.error && e.error.stack,
    ua: navigator.userAgent,
    coi: !!self.crossOriginIsolated,
    t: Date.now(),
  });
});
// A deploy renames every hashed chunk, so a tab opened before it fails its next
// lazy import. Reload once to pick up the new build; the timestamp guard stops a
// loop when a chunk is genuinely missing (and no storage means no reload).
window.addEventListener("vite:preloadError", () => {
  const key = "prepforge.chunk_reload_at";
  try {
    if (Date.now() - (Number(sessionStorage.getItem(key)) || 0) < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
});
window.addEventListener("unhandledrejection", (e) => {
  reportClientError({
    kind: "rejection",
    message: String((e.reason && e.reason.message) || e.reason),
    stack: e.reason && e.reason.stack,
    ua: navigator.userAgent,
    coi: !!self.crossOriginIsolated,
    t: Date.now(),
  });
});

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
// Piece artwork sets. Each value is the inner SVG markup for a 0 0 45 45
// viewBox; fill/stroke come from CSS (.piece). "berlin" is a cleaner,
// traditional Staunton silhouette (the default); "classic" is the original
// minimalist set, kept as an alternative.
const PIECE_SETS = {
  berlin: {
    p: html`<circle cx="22.5" cy="13.5" r="4.5"></circle><path d="M19 20.2h7l1.4 8.2h-9.8z"></path><path d="M15.5 31.5h14c1.8 1.4 3 3.4 3.4 6H12.1c.4-2.6 1.6-4.6 3.4-6z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    n: html`<path d="M13 38h23v3H11z"></path><path d="M15.5 34c1.1-6.8 4.9-9.4 8.2-13.1-3 .4-6.5-.5-8.9-2.4 1-6.4 6.6-10.4 13-9 5.7 1.3 9 6.1 8.4 12.4L34 34z"></path><path d="M18.1 15.6l3.9-5.3 1.2 5.5z" class="piece-cut"></path><circle cx="28.2" cy="15.1" r="1.25" class="piece-cut"></circle><path d="M22.4 20.5c2.4 1.1 5.1 1 7.5-.2" class="piece-line"></path>`,
    b: html`<circle cx="22.5" cy="8.7" r="2.5"></circle><path d="M22.5 12c-4 3.7-7.1 8.8-7.1 14.1 0 3.8 3 6.2 7.1 6.2s7.1-2.4 7.1-6.2c0-5.3-3.1-10.4-7.1-14.1z"></path><path d="M26.7 16.2l-8.4 9.4" class="piece-line"></path><path d="M14 34h17c1.1 1 1.8 2.1 2 3.6H12c.2-1.5.9-2.6 2-3.6z"></path><path d="M10.8 38.2h23.4v2.8H10.8z"></path>`,
    r: html`<path d="M12.5 9.5h5v3.6h3.4V9.5h3.2v3.6h3.4V9.5h5v8.6H29v11.3l3.2 3.3v3H12.8v-3l3.2-3.3V18.1h-3.5z"></path><path d="M16.5 21h12M16.3 31h12.4" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    q: html`<circle cx="9.5" cy="13.2" r="2.2"></circle><circle cx="16.8" cy="9.5" r="2.2"></circle><circle cx="22.5" cy="8" r="2.4"></circle><circle cx="28.2" cy="9.5" r="2.2"></circle><circle cx="35.5" cy="13.2" r="2.2"></circle><path d="M10.2 16.2l4.3 15.5h16l4.3-15.5-6.6 8-2.8-11.2-2.9 12.2-2.9-12.2-2.8 11.2z"></path><path d="M13.5 32.2h18c.9.8 1.4 1.8 1.5 3H12c.1-1.2.6-2.2 1.5-3z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    k: html`<path d="M22.5 5.5v7M19.2 8.8h6.6" class="piece-line"></path><path d="M17.8 14.5h9.4l1.4 6.7c2.2 1.7 3.6 4.2 3.6 7.1 0 2.3-1 4.1-2.8 5.2H15.6c-1.8-1.1-2.8-2.9-2.8-5.2 0-2.9 1.4-5.4 3.6-7.1z"></path><path d="M17.3 20.8h10.4M16.2 33.8h12.6" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
  },
  classic: {
    p: html`<circle cx="22.5" cy="13" r="6"></circle><path d="M16 22h13l3 11H13z"></path><path d="M12 36h21v4H12z"></path>`,
    n: html`<path d="M14 36h22v4H11z"></path><path d="M16 34c1-10 8-11 7-19-3 1-6 1-9-1 3-6 9-8 15-5 5 3 7 8 6 14l-2 11z"></path><circle cx="29" cy="14" r="1.4" class="piece-cut"></circle>`,
    b: html`<circle cx="22.5" cy="10" r="4.5"></circle><path d="M15 31c0-7 5-12 7.5-18C25 19 30 24 30 31z"></path><path d="M13 35h19v5H13z"></path><path d="M19 20l7-7" class="piece-line"></path>`,
    r: html`<path d="M12 9h6v4h4V9h6v4h5v8H12z"></path><path d="M15 21h15v14H15z"></path><path d="M11 35h23v5H11z"></path>`,
    q: html`<circle cx="12" cy="12" r="3.5"></circle><circle cx="22.5" cy="9" r="3.5"></circle><circle cx="33" cy="12" r="3.5"></circle><path d="M12 17l5 16h11l5-16-8 7-2.5-9-2.5 9z"></path><path d="M13 35h19v5H13z"></path>`,
    k: html`<path d="M21 7h3v7h6v3h-6v6h-3v-6h-6v-3h6z"></path><path d="M15 31c1-8 5-12 7.5-14C25 19 29 23 30 31z"></path><path d="M13 35h19v5H13z"></path>`,
  },
};

const PIECE_STYLE_KEY = "prepforge.piece_style";
const PIECE_STYLE_LABELS = { berlin: "Staunton Pro", classic: "Classic" };

function activePieceSet() {
  return PIECE_SETS[appState.pieceStyle] || PIECE_SETS.berlin;
}

const PREFS_KEY = "prepforge.prefs";
const DEFAULT_PREFS = {
  theme: "system",
  coordinates: true,
  lastMovePulse: true,
  flipAnim: true,
  moveAnim: true,
  sounds: true,
  bestArrow: true,
  // Live engine on/off, remembered per view: Build shows it inside the
  // Explorer (an eval per candidate), Analyze inside the Evaluation card.
  engineBuild: false,
  engineAnalyze: false,
  // Analysis-layer gate for the Maia3 human model. OFF by default: the Analyze
  // pipeline skips its Maia pass (classifier / human probability / coach
  // intuition / brilliant signals) and no analysis-layer Maia inference runs —
  // Stockfish analysis runs either way. Independent product capabilities that
  // ARE Maia by design (Train Play opponent fallback, Build human-like
  // branches) keep their existing behavior and never consult this.
  // Replaces the old "Detect brilliant moves" toggle: with Maia analysis ON,
  // brilliant signals ride the analysis pipeline.
  maiaAnalysis: false,
};
const PREF_LABELS = {
  coordinates: "Board coordinates",
  lastMovePulse: "Last-move pulse",
  flipAnim: "Flip animation",
  moveAnim: "Move animation",
  sounds: "Move / capture sounds",
  bestArrow: "Engine best-move arrow",
};

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

function pref(name) {
  return appState.prefs ? appState.prefs[name] : DEFAULT_PREFS[name];
}

// Analysis-layer gate for the Maia3 human model. When OFF, the Analyze
// pipeline skips its Maia pass and no analysis-layer caller (classifier /
// human probability / coach intuition / brilliant signals) initializes the
// provider or runs inference. Independent product capabilities that ARE Maia
// by design (Train Play opponent fallback, Build human-like branches) keep
// their existing behavior. Stockfish paths never consult this.
function maiaAnalysisEnabled() {
  return !!pref("maiaAnalysis");
}

function setPref(name, value) {
  appState.prefs[name] = value;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(appState.prefs));
  } catch (_) {
    // ignore storage errors
  }
  applyPref(name);
}

function applyPref(name) {
  if (name === "theme") {
    applyTheme(pref("theme"));
    syncThemeToggle();
  }
  if (name === "coordinates") {
    Object.values(boards).forEach((b) => b && b.applyCoordinates && b.applyCoordinates());
  }
  if (name === "bestArrow" && !pref("bestArrow")) {
    Object.values(boards).forEach((b) => {
      if (b && b.setEngineArrow) b.setEngineArrow(null);
      if (b && b.setBetterArrow) b.setBetterArrow(null);
    });
  }
  if (name === "maiaAnalysis" && buildDockTab === "coverage") {
    // Repaint the inspector; Coverage scans only on an explicit click.
    setBuildInspector("coverage");
  }
}

// Rail (and phone More sheet) theme toggle: flips the effective theme (an
// explicit light/dark choice). Settings keeps the full System / Light / Dark control.
function syncThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  setPref("theme", dark ? "light" : "dark");
  settingsView?.renderThemeControl?.();
}

// Draw the engine's top move as a green arrow on whichever board is showing
// the analysed position; clear it everywhere else.
function setEngineBestArrow(uci) {
  const active = activeBoardController();
  Object.values(boards).forEach((b) => {
    if (!b || !b.setEngineArrow) return;
    if (b === active && pref("bestArrow") && uci) b.setEngineArrow(uci);
    else b.setEngineArrow(null);
  });
}

// Tiny synthesized SFX so we don't ship audio assets. type: move | capture | check.
// move/capture mimic a wooden piece hitting the board: a short filtered noise
// "click" plus a low body "thump". Capture layers a second, harder knock so it
// reads as two pieces colliding.
let _audioCtx = null;

// The noise burst for a knock of this length, made once: filling it sample by
// sample on every move cost more than the rest of the sound.
const _knockNoiseBuffers = new Map();
function _knockNoise(ctx, dur) {
  let buffer = _knockNoiseBuffers.get(dur);
  if (buffer) return buffer;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    // Sharp attack, quick exponential-ish decay so it sounds like a tap.
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
  }
  _knockNoiseBuffers.set(dur, buffer);
  return buffer;
}

// One wooden knock = noise burst through a bandpass (the contact click) +
// a fast pitch-dropping sine (the low body). Returns nothing; best-effort.
function _woodKnock(ctx, when, opts) {
  const { dur, noiseFreq, noiseQ, noiseGain, bodyFreq, bodyGain } = opts;

  const noise = ctx.createBufferSource();
  noise.buffer = _knockNoise(ctx, dur);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = noiseFreq;
  bp.Q.value = noiseQ;
  const nGain = ctx.createGain();
  nGain.gain.value = noiseGain;
  noise.connect(bp);
  bp.connect(nGain);
  nGain.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(bodyFreq, when);
  osc.frequency.exponentialRampToValueAtTime(bodyFreq * 0.5, when + dur);
  const oGain = ctx.createGain();
  oGain.gain.setValueAtTime(0.0001, when);
  oGain.gain.exponentialRampToValueAtTime(bodyGain, when + 0.004);
  oGain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(oGain);
  oGain.connect(ctx.destination);

  noise.start(when);
  noise.stop(when + dur + 0.02);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

function playSound(type) {
  if (!pref("sounds")) return;
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _audioCtx = new AC();
    }
    const ctx = _audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;

    if (type === "check") {
      // Keep a clear tonal alert for check, not a wood knock.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "triangle";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.16);
      return;
    }

    if (type === "capture") {
      // Two hard knocks: pieces colliding, then settling on the square.
      _woodKnock(ctx, now, {
        dur: 0.05,
        noiseFreq: 2400,
        noiseQ: 0.7,
        noiseGain: 0.55,
        bodyFreq: 240,
        bodyGain: 0.5,
      });
      _woodKnock(ctx, now + 0.045, {
        dur: 0.08,
        noiseFreq: 1500,
        noiseQ: 0.9,
        noiseGain: 0.4,
        bodyFreq: 170,
        bodyGain: 0.42,
      });
      return;
    }

    // Plain move: one soft wooden tap.
    _woodKnock(ctx, now, {
      dur: 0.07,
      noiseFreq: 2600,
      noiseQ: 1.1,
      noiseGain: 0.32,
      bodyFreq: 250,
      bodyGain: 0.3,
    });
  } catch (_) {
    // audio is best-effort
  }
}

const appState = {
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
  // ---- Local-first Build sync (docs/local-first-sync-plan.md Phase 1) ----------
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
  buildRejected: [],
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

// ---- Maia3 strength resolution ---------------------------------------------------
// A pinned Settings value wins; otherwise AUTO matches the player's own Lichess
// rating (public profile, cached locally for a day); otherwise the model default.
// Personalizes the coach's human-feel reads and the Build → Generate default.
const MAIA_FALLBACK_RATING = 1500; // mirrors engine/maia3-provider DEFAULT_RATING
const MAIA_AUTO_CACHE_KEY = "prepforge.maia_auto_rating";
const MAIA_AUTO_TTL_MS = 24 * 60 * 60 * 1000;

function effectiveMaiaRating() {
  if (Number.isFinite(appState.maiaRatingPinned)) return appState.maiaRatingPinned;
  if (Number.isFinite(appState.maiaAutoRating)) return appState.maiaAutoRating;
  return MAIA_FALLBACK_RATING;
}

// ---- Stockfish depth resolution -------------------------------------------------
// Settings is the single source of truth for how deep each browser-Stockfish search
// runs — the PER-POSITION search depth, NOT the Build tree's ply depth. Every local
// Stockfish consumer (Engine widget, Position coach, Build → Generate, Coverage
// complete) reads this so the slider in Settings actually steers them. Mirrors the
// Settings slider clamp (1-30) and falls back to 16 when unset.
const STOCKFISH_FALLBACK_DEPTH = 16;
const STOCKFISH_MIN_DEPTH = 1;
const STOCKFISH_MAX_DEPTH = 30;

function effectiveStockfishDepth() {
  const raw = appState.settings && Number(appState.settings.stockfish_depth);
  const depth = Number.isFinite(raw) ? raw : STOCKFISH_FALLBACK_DEPTH;
  return Math.max(STOCKFISH_MIN_DEPTH, Math.min(STOCKFISH_MAX_DEPTH, Math.round(depth)));
}

// Best-effort: resolve the player's strength from the linked Lichess account's public
// profile (CORS-open, no token, one tiny GET a day thanks to the cache). Uses the
// most-played live perf so a blitz player gets their blitz number, not a provisional
// classical one. Failure just leaves AUTO at the fallback — never throws.
async function refreshAutoMaiaRating() {
  const username = appState.lichessUsername;
  if (!username) {
    appState.maiaAutoRating = null;
    return;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(MAIA_AUTO_CACHE_KEY) || "null");
    if (cached && cached.username === username && Date.now() - cached.at < MAIA_AUTO_TTL_MS) {
      appState.maiaAutoRating = cached.rating;
      settingsView?.renderStrengthControls();
      return;
    }
  } catch (_) { /* corrupt cache — refetch */ }
  try {
    const profile = await fetchLichessProfile(username);
    if (!Number.isFinite(profile.maiaRating)) return;
    appState.maiaAutoRating = profile.maiaRating;
    try {
      localStorage.setItem(
        MAIA_AUTO_CACHE_KEY,
        JSON.stringify({ username, rating: profile.maiaRating, at: Date.now() }),
      );
    } catch (_) { /* storage full — fine, refetch next time */ }
    settingsView?.renderStrengthControls();
  } catch (_) { /* offline or blocked — AUTO falls back silently */ }
}

// Shown when a browser-only compute action (whole-game Analyze, Build → Generate)
// can't run because the browser engine is unavailable (page not cross-origin
// isolated). Both run browser-only — there is no server fallback.
const BROWSER_ENGINE_UNAVAILABLE =
  "Browser engine unavailable — open in a cross-origin-isolated browser to run engines locally";

const boards = {};

const jobToast = createToastStack();

// ===== Undo notifications =====================================================
// Destructive actions apply to the UI instantly but only reach the server once
// the undo window closes — no type-to-confirm friction, and a mid-window Undo
// costs zero server requests. Commits are forced (commitPendingUndos) before
// anything that needs server truth or before the page goes away.
const UNDO_TOAST_MS = 5000;
const pendingUndoCommits = new Set();

function showUndoToast({ title, message, onUndo, onCommit, host = null }) {
  if (host) return showInlineUndo(host, { title, message, onUndo, onCommit });
  let settled = false;
  let toast = null;
  const commit = () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    try {
      onCommit();
    } catch (_) {
      /* best-effort */
    }
    if (toast) toast.dismiss();
  };
  pendingUndoCommits.add(commit);
  toast = jobToast.notify({
    title,
    message,
    actions: [
      {
        label: "Undo",
        primary: true,
        onClick: () => {
          if (settled) return;
          settled = true;
          pendingUndoCommits.delete(commit);
          try {
            onUndo();
          } catch (_) {
            /* best-effort */
          }
        },
      },
    ],
  });
  // Hovering the card pauses the countdown (Toast's pointer gating), so the
  // window never closes while the user is reaching for Undo.
  toast._arm(UNDO_TOAST_MS, commit);
  return commit;
}

// The same undo window rendered inside a view (`host`) instead of the toast
// stack — Build's move delete uses it so the card sits with the move tree
// rather than over the Explorer. One window per host: a newer delete commits
// the older one first. Hover pauses the countdown, like the toast.
function showInlineUndo(host, { title, message, onUndo, onCommit }) {
  if (host._undoCommit) host._undoCommit();
  let settled = false;
  let timer = null;
  let remaining = UNDO_TOAST_MS;
  let startedAt = 0;
  const close = () => {
    window.clearTimeout(timer);
    if (host._undoCommit === commit) {
      host._undoCommit = null;
      host.hidden = true;
      host.innerHTML = "";
    }
  };
  const commit = () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    close();
    try {
      onCommit();
    } catch (_) {
      /* best-effort */
    }
  };
  const arm = () => {
    startedAt = Date.now();
    timer = window.setTimeout(commit, remaining);
  };
  pendingUndoCommits.add(commit);
  host._undoCommit = commit;
  host.innerHTML =
    html`<span class="inline-undo-text"><b>${title}</b> ${message || ""}</span><button type="button" class="btn sm" data-inline-undo>Undo</button>`;
  host.hidden = false;
  host.onpointerenter = () => {
    if (settled) return;
    window.clearTimeout(timer);
    remaining = Math.max(800, remaining - (Date.now() - startedAt));
  };
  host.onpointerleave = () => {
    if (!settled) arm();
  };
  host.querySelector("[data-inline-undo]").addEventListener("click", () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    close();
    try {
      onUndo();
    } catch (_) {
      /* best-effort */
    }
  });
  arm();
  return commit;
}

// Close every open undo window NOW. Called before hard flushes (an operation
// needs server truth) and on page hide/unload (the commits use keepalive-safe
// requests where needed).
function commitPendingUndos() {
  for (const commit of [...pendingUndoCommits]) commit();
}

let loadedEngineWidget = null;
let engineWidgetLoading = null;
let engineWidgetOpenSeq = 0;
function loadEngineWidget() {
  engineWidgetLoading ||= import("./controllers/engine-widget.js").then((mod) => {
    loadedEngineWidget = mod.createEngineWidget({
      effectiveStockfishDepth, createSharedEvaluationProvider, activeViewName, appState,
      boards, START_FEN, setEngineBestArrow, setStatusError, setEngineOn,
      activeBoardController, explorerEvalEngine, getAnalyzeSession: () => analyzeSession,
    });
    return loadedEngineWidget;
  }).catch((error) => {
    engineWidgetLoading = null;
    throw error;
  });
  return engineWidgetLoading;
}
const engineWidget = {
  isOpen: () => loadedEngineWidget?.isOpen() || false,
  isPreviewing: () => loadedEngineWidget?.isPreviewing() || false,
  stepPreview: (action) => loadedEngineWidget?.stepPreview(action) || false,
  get lastSnapshot() { return loadedEngineWidget?.lastSnapshot || null; },
  onBoardChanged: () => loadedEngineWidget?.onBoardChanged(),
  async onDepthSettingChanged() { await loadedEngineWidget?.onDepthSettingChanged(); },
  // Outside a preview this is only called on a view switch, which also
  // supersedes an open still waiting on the import.
  exitPreview() {
    engineWidgetOpenSeq += 1;
    loadedEngineWidget?.exitPreview();
  },
  close() {
    engineWidgetOpenSeq += 1;
    return loadedEngineWidget?.close();
  },
  async openForCurrent() {
    const seq = ++engineWidgetOpenSeq;
    const view = activeViewName();
    let widget = loadedEngineWidget;
    try {
      widget ||= await loadEngineWidget();
    } catch (_) {
      if (seq === engineWidgetOpenSeq) setStatusError("Engine failed to load. Reload the page to try again.");
      return;
    }
    if (seq !== engineWidgetOpenSeq || view !== activeViewName() || !engineWantedIn(view)) return;
    return widget.openForCurrent();
  },
};

function sanLineFromUci(fen, pvUci) {
  return localSanLine(fen, pvUci);
}

// A saved eval's PV in SAN, worked out once per saved entry: stepping through a
// game reads the same entries again and again.
const savedPvSan = new WeakMap();

let _phaseCoachMod = null;
function loadPhaseCoach() {
  if (!_phaseCoachMod) _phaseCoachMod = import("./coach/phase-coach.js");
  return _phaseCoachMod;
}

async function maiaPhaseCoach({ fen, expectedUci, expectedSan, playedUci }) {
  const m = await loadPhaseCoach();
  let predictions = [];
  // Analysis-layer gate: with Maia analysis OFF the tip stays phase-generic
  // (no provider init, no inference).
  if (maiaAnalysisEnabled()) {
    try {
      const provider = getSharedMaia3Provider();
      predictions = await provider.predictions({ fen, rating: effectiveMaiaRating() });
    } catch (_) {
      /* engine off → still return a phase-generic tip */
    }
  }
  return m.buildPhaseCoach({
    fen,
    predictions,
    expectedUci,
    expectedSan,
    playedUci,
    rating: effectiveMaiaRating(),
  });
}

// ---------------------------------------------------------------------------
// Analyze ↔ repertoire sync ("the book"). Lazily loads the user's ACTIVE
// repertoire trees once per visit and, on every Analyze position change, walks
// the explored move path against them (path-based, like the recap's departure
// detection — transpositions intentionally don't count). The coach only speaks
// on the in-book → out-of-book TRANSITION: if a branch was never prepped the
// in-book state never held, so nothing nags (and in-book shows nothing at all).
//   - opponent leaves the book → "Add it in Build" inline action at the
//     departure node
//   - the player leaves their own book → "Add to training" records one recall miss
//     (POST /api/train/record-miss) so the move leads the next smart session
// ---------------------------------------------------------------------------
const bookState = {
  generation: 0,
  loaded: false,
  loading: null,
  reps: [], // { id, name, color, rootId, children: Map("parentId|uci" -> node), kids: Map(parentId -> [node]) }
};

// Build edits make this copy stale; drop it so the next Analyze look refetches.
function invalidateBook() {
  bookState.generation++;
  bookState.loaded = false;
  bookState.loading = null;
  bookState.reps = [];
}

let bookActionsPromise = null;
function loadBookActions() {
  bookActionsPromise ||= import("./analyze-book.js").then(({ createBookActions }) => createBookActions({
    bookState, appState, currentOwnerId, api, loadCoach: () => (_coachReady || preloadCoach()),
    rememberHandoff, postJson, setStatus, setStatusError, editRepertoire,
  })).catch((error) => { bookActionsPromise = null; throw error; });
  return bookActionsPromise;
}

async function ensureBookLoaded() {
  return (await loadBookActions()).ensureBookLoaded();
}

async function updateBookline() {
  return (await loadBookActions()).updateBookline();
}

const BoardController = createBoardController({
  pref, renderAnnotations, files, isPromotionMove, resolveBoardMove, legalMoveFor,
  pieceSvg, parseFenBoard, playSound, pieceLabel, legalTargetsFrom,
});

// Engine-loading lifecycle marks (dev/E2E timing only): records monotonic
// timestamps per (job) so the parallel init windows — Build runner import vs
// Maia ready, Analyze Stockfish vs Maia init — are observable without touching
// any engine result. No-op payload, never awaited by the pipeline.
const engineLifecycleMarks = new Map();
function engineLifecycleMark(name, origin = performance.now()) {
  const at = Math.round(performance.now() - origin);
  if (!engineLifecycleMarks.has(name)) engineLifecycleMarks.set(name, []);
  engineLifecycleMarks.get(name).push(at);
  try {
    console.debug("[engine-lifecycle]", name, `${at}ms`);
  } catch (_) { /* logging only */ }
  return origin;
}
const STATUS_PROGRESS_SHOW_DELAY = 700;

// True while a 401 is being turned into the sign-in modal, so the modal's own
// fallback warning can't loop back through here.
let routingAuthStatus = false;

function setStatus(message, { severity = "info" } = {}) {
  const status = document.getElementById("app-status");
  if (!status) return;
  const closeBtn = document.getElementById("app-status-close");
  const text = String(message || "");
  // A guest (or expired session) hit an account-only endpoint: the sign-in
  // modal with an explanation replaces the backend's "not authenticated".
  if (!routingAuthStatus && accountController && isAuthRequiredMessage(text)) {
    routingAuthStatus = true;
    try {
      accountController.handleAuthRequired();
    } finally {
      routingAuthStatus = false;
    }
    return;
  }
  const slot = document.getElementById("topbar-status-slot");
  status.textContent = text;
  status.title = text;
  // The floating status pill only shows messages set after load (not the
  // static "Ready" placeholder); it hides again when the text clears.
  // "Ready" is the idle state, not news: it clears the pill instead.
  const normalizedSeverity = ["info", "success", "warning", "error"].includes(severity)
    ? severity
    : "info";
  const isError = normalizedSeverity === "error";
  // In-progress messages ("Loading...") usually resolve within a moment; only
  // surface one if it is still the current message after a beat, so quick
  // steps never flash a pill in the corner.
  const inProgress = !isError && /(\.\.\.|…)$/.test(text);
  if (typeof window !== "undefined") window.clearTimeout(setStatus._showTimer);
  const showNow = !!text && text !== "Ready" && !inProgress;
  status.classList.toggle("is-fresh", showNow);
  if (slot) slot.classList.toggle("is-idle", !showNow);
  // Pills are dropped on navigation (clearStaleStatusOnNavigate); note when
  // this one was raised so a message set by the navigation itself stays.
  setStatus._at = text ? Date.now() : 0;
  if (inProgress && typeof window !== "undefined") {
    setStatus._showTimer = window.setTimeout(() => {
      if (status.textContent === text) {
        status.classList.add("is-fresh");
        if (slot) slot.classList.remove("is-idle");
      }
    }, STATUS_PROGRESS_SHOW_DELAY);
  }
  status.setAttribute("role", isError ? "alert" : "status");
  status.setAttribute("aria-live", isError ? "assertive" : "polite");
  status.dataset.severity = normalizedSeverity;
  status.dataset.state = isError ? "error" : "ready";
  if (typeof window === "undefined") return;
  window.clearTimeout(setStatus._timer);
  if (closeBtn) closeBtn.hidden = !isError || !text;
  if (text && !isError) {
    setStatus._timer = window.setTimeout(() => {
      if (status.textContent !== text) return;
      clearStatus();
    }, normalizedSeverity === "warning" ? 6000 : 4000);
  }
}

// Empty the floating status pill and hide its slot (no leftover empty pill).
function clearStatus() {
  const status = document.getElementById("app-status");
  if (typeof window !== "undefined") {
    window.clearTimeout(setStatus._timer);
    window.clearTimeout(setStatus._showTimer);
  }
  setStatus._at = 0;
  if (status) {
    status.textContent = "";
    status.title = "";
    status.classList.remove("is-fresh");
    status.dataset.severity = "info";
    status.dataset.state = "ready";
  }
  document.getElementById("topbar-status-slot")?.classList.add("is-idle");
  const closeBtn = document.getElementById("app-status-close");
  if (closeBtn) closeBtn.hidden = true;
}

// A pill belongs to the page it was raised on: leaving that page drops it,
// unless it was raised a moment ago by the very action that is navigating.
const STATUS_NAV_GRACE_MS = 400;
function clearStaleStatusOnNavigate() {
  if (shouldClearStatusOnNavigate(setStatus._at, Date.now(), STATUS_NAV_GRACE_MS)) clearStatus();
}

// Keep the floating status pill out of the way: it rides above the job-toast
// stack (never on top of it), is click-through unless it holds an error, and
// fades to a ghost while the pointer is over its spot — so a message never
// blocks the button underneath it.
function bindStatusPillAvoidance() {
  const slot = document.getElementById("topbar-status-slot");
  const stack = document.getElementById("toast-stack");
  if (!slot || typeof window === "undefined") return;
  if (stack && typeof ResizeObserver === "function") {
    const sync = () => {
      const h = stack.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--toast-stack-h", `${Math.round(h)}px`);
    };
    new ResizeObserver(sync).observe(stack);
    sync();
  }
  let frame = 0;
  let last = null;
  const evaluate = () => {
    frame = 0;
    if (!last) return;
    const status = document.getElementById("app-status");
    const isError = status && status.dataset.state === "error";
    const r = slot.getBoundingClientRect();
    const pad = 18;
    const near =
      !isError &&
      r.width > 0 &&
      last.x >= r.left - pad &&
      last.x <= r.right + pad &&
      last.y >= r.top - pad &&
      last.y <= r.bottom + pad;
    slot.classList.toggle("is-ghost", near);
  };
  document.addEventListener(
    "pointermove",
    (event) => {
      last = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(evaluate);
    },
    { passive: true }
  );
}

function setStatusError(message) {
  setStatus(message, { severity: "error" });
}

const getCsrfToken = createCsrfTokenSource();

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { timeoutMs = method === "GET" ? 30_000 : 90_000, signal: callerSignal, responseType = "json", ...fetchOptions } = options;
  return withRequestDeadline(async (signal) => {
  // Merge caller headers over the JSON default, then attach the CSRF token on
  // unsafe methods (bootstrapping /api/csrf if the cookie isn't set yet). The
  // FastAPI backend 403s any unsafe request that doesn't echo the cookie.
  const headers = await headersWithCsrf(
    method,
    { "Content-Type": "application/json", ...(options.headers || {}) },
    getCsrfToken,
  );
  signal.throwIfAborted();
  const response = await fetch(path, {
    credentials: "same-origin",
    ...fetchOptions,
    signal,
    headers,
  });
  if (response.ok && responseType === "blob") return response.blob();
  // Read as text first so a non-JSON body (a 500 "Internal Server Error", a 502
  // from the proxy, an HTML error page) surfaces a clear message instead of a raw
  // "Unexpected token 'I' ... is not valid JSON" from response.json().
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      if (!response.ok) {
        const err = new Error(`Server error ${response.status} ${response.statusText}`.trim());
        err.status = response.status;
        throw err;
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  }
  // Keep structured FastAPI detail for conflict recovery and flatten it for display.
  if (!response.ok) {
    const detail = payload.detail;
    // A session 401 reads as an explanation, not the backend's "not
    // authenticated"; setStatus turns it into the sign-in modal.
    const authRequired = isSessionAuthFailure(response.status, detail);
    const message = authRequired
      ? AUTH_REQUIRED_MESSAGE
      : apiErrorMessage(response.status, detail);
    const err = new Error(message);
    err.status = response.status; // lets callers (e.g. Build sync) tell 4xx from 5xx/network
    err.detail = detail;
    if (authRequired) err.authRequired = true;
    if (response.headers && typeof response.headers.get === "function") {
      err.retryAfter = response.headers.get("retry-after");
    }
    throw err;
  }
  return payload;
  }, { signal: callerSignal, timeoutMs, method });
}

// ----- Durable outbox (R-03) -----------------------------------------------
// Build and Train share an owner-scoped IndexedDB outbox.
// crash, or sign-out can't silently drop work the user already did. Operation
// identity survives (Build temp ids, Train attempt UUIDs) — replays after a
// lost response are recognized server-side instead of double-counted.
const OUTBOX_TAB_ID = Math.random().toString(36).slice(2);

function currentOwnerId() {
  return appState.accountUserId || null;
}

// Build-session wrappers resolve the lazy module on call, so they can exist before it loads
// (the sync controller below takes some of them).
const viaBuildSession = (name) => (...args) => (buildSession
  ? buildSession[name](...args)
  : loadBuildSession().then((loaded) => loaded[name](...args)));
const buildBranchContext = viaBuildSession("buildBranchContext");
const buildBranchKey = viaBuildSession("buildBranchKey");
const buildGoBack = viaBuildSession("buildGoBack");
const buildGoForward = viaBuildSession("buildGoForward");
const buildGoRoot = viaBuildSession("buildGoRoot");
const buildGoToEnd = viaBuildSession("buildGoToEnd");
const createRepertoirePrompt = viaBuildSession("createRepertoirePrompt");
const generateFromCurrentNode = viaBuildSession("generateFromCurrentNode");
const hydrateBuild = viaBuildSession("hydrateBuild");
const onBuildBoardMove = viaBuildSession("onBuildBoardMove");
const onInspectorInfo = viaBuildSession("onInspectorInfo");
const openBuildMenu = viaBuildSession("openBuildMenu");
const openNodeContextMenu = viaBuildSession("openNodeContextMenu");
const paintExplorerEvals = viaBuildSession("paintExplorerEvals");
const paintInspectorScope = viaBuildSession("paintInspectorScope");
const refreshExplorerPanel = viaBuildSession("refreshExplorerPanel");
const saveBuildAnnotations = viaBuildSession("saveBuildAnnotations");
const scheduleExplorerRefresh = viaBuildSession("scheduleExplorerRefresh");
const selectBuildNode = viaBuildSession("selectBuildNode");
const setBuildDockFolded = viaBuildSession("setBuildDockFolded");

const syncController = createSyncController({
  appState, currentOwnerId, captureBuildContext, buildOpMatchesRepertoire, resolveBuildId, queuedBuildRevision,
  rebaseQueuedBuildRevision, postJson, setBuildSync, hasPendingBuildOpsFor, hydrateBuild, reapplyPendingBuildNodes,
  reapplyPendingBuildDeletes, selectBuildNode, setStatusError, setStatus, commitPendingUndos, readCsrfCookie,
  CSRF_HEADER, setTrainSyncState, localDateString, OUTBOX_TAB_ID,
});
const {
  scheduleBuildFlush, settleBuildOutbox, hardFlushBuild, beaconFlushBuild, queueTrainAttempt,
  markTrainPositionDirty, scheduleTrainSync, beaconFlushTrain, flushBuildMoves, flushTrainSync,
  persistOutbox, restoreOutbox, flushAllPendingForSignOut,
} = syncController;

async function postJson(path, body, options = {}) {
  const build = appState.build;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const requestBody = withBuildRevision(path, body, build);
  const before = build?.revision;
  const mutation = requestBody?.base_revision !== undefined;
  const previous = mutation ? appState.buildMutationSaving : null;
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) throw new Error("Account changed");
    // A queued request may follow our own acknowledged write. Preserve older
    // conflict bases; rebase only the revision current when this call was made.
    if (mutation && build === appState.build && requestBody.repertoire_id === build?.repertoire_id && requestBody.base_revision === before) {
      requestBody.base_revision = build.revision;
    }
    const payload = await api(path, { method: "POST", body: JSON.stringify(requestBody || {}), ...options });
    if (mutation && requestBody.repertoire_id === build?.repertoire_id && appState.build === build && owner === currentOwnerId() && generation === appState.ownerGeneration) {
      advanceBuildRevision(build, payload, [...appState.buildPending, ...appState.buildPendingDeletes]);
    }
    return payload;
  })();
  if (mutation) appState.buildMutationSaving = task;
  try { return await task; }
  finally { if (appState.buildMutationSaving === task) appState.buildMutationSaving = null; }
}

function downloadText(filename, mime, content) {
  const blob = new Blob([content], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "prepforge-export.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function activeViewName() {
  const el = document.querySelector(".view.is-active");
  return el ? el.id.replace("view-", "") : "analyze";
}

function activeBoardController() {
  const name = activeViewName();
  if (name === "analyze") return boards.analysis || null;
  return boards[name] || null;
}

let workspaceUrlReady = false;
let workspaceNavigationSeq = 0;
// Set when the user picks a page while boot is still awaiting auth / the
// workspace: restoreWorkspaceLocation must not then snap them back to the URL
// the page loaded with (a Scout click during boot landed on the dashboard).
let navigatedDuringBoot = false;
let paletteItems = [];
let paletteActive = 0;
let paletteA11yCleanup = null;

function activateModal(overlay, { initialFocus = null, additionalRoots = [] } = {}) {
  const previouslyFocused = document.activeElement;
  const background = [...document.body.children].filter(
    (child) => child !== overlay && !additionalRoots.includes(child) && !child.inert,
  );
  for (const child of background) child.inert = true;

  const dialog = overlay.matches('[role="dialog"]')
    ? overlay
    : overlay.querySelector('[role="dialog"]');
  if (dialog && !dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
    const title = dialog.querySelector(".modal-title");
    if (title) {
      title.id ||= `modal-title-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dialog.setAttribute("aria-labelledby", title.id);
    }
  }

  const focusable = () => [overlay, ...additionalRoots].flatMap((root) => [...root.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )]).filter((el) => !el.hidden && el.getClientRects().length > 0);
  const onKeyDown = (event) => {
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const keyTarget = additionalRoots.length ? document : overlay;
  keyTarget.addEventListener("keydown", onKeyDown);
  queueMicrotask(() => (initialFocus || focusable()[0] || dialog || overlay).focus?.());

  let cleaned = false;
  const cleanup = ({ restoreFocus = true } = {}) => {
    if (cleaned) return;
    cleaned = true;
    keyTarget.removeEventListener("keydown", onKeyDown);
    for (const child of background) child.inert = false;
    overlay.remove = nativeRemove;
    if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
  };
  const nativeRemove = overlay.remove.bind(overlay);
  overlay.remove = () => {
    cleanup();
    nativeRemove();
  };
  return cleanup;
}

function syncWorkspaceUrl({ push = false } = {}) {
  if (!workspaceUrlReady || typeof window === "undefined") return;
  const loc = workspaceLocationFromState(appState);
  const href = serializeWorkspaceLocation(loc, window.location.href);
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === href) return;
  if (push) history.pushState(loc, "", href);
  else history.replaceState(loc, "", href);
}

function paintEngineBanners() {
  const model = engineUnavailableBanner({
    available: isBrowserEngineAvailable(),
    isolated: !!self.crossOriginIsolated,
  });
  const markup = engineBannerHtml(model, {  });
  for (const id of ["analyze-engine-banner", "build-engine-banner"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !model.visible;
    el.innerHTML = markup;
  }
}

function paletteIsOpen() {
  const el = document.getElementById("command-palette");
  return !!(el && !el.hidden);
}

function closePalette() {
  const el = document.getElementById("command-palette");
  if (el) {
    el.hidden = true;
    document.getElementById("palette-input")?.setAttribute("aria-expanded", "false");
  }
  if (paletteA11yCleanup) paletteA11yCleanup();
  paletteA11yCleanup = null;
}

function paintPalette() {
  const box = document.getElementById("palette-results");
  if (!box) return;
  box.innerHTML = renderPaletteItems(paletteItems, paletteActive);
  const input = document.getElementById("palette-input");
  const active = box.querySelector('[aria-selected="true"]');
  if (input) {
    if (active) input.setAttribute("aria-activedescendant", active.id);
    else input.removeAttribute("aria-activedescendant");
  }
}

async function openPalette() {
  const el = document.getElementById("command-palette");
  if (!el) return;
  let repertoires = appState.repertoireList || [];
  if (appState.signedIn) {
    try {
      const payload = await api("/api/repertoires");
      repertoires = payload.repertoires || [];
      appState.repertoireList = repertoires;
    } catch (_) {
      /* keep the last cached list */
    }
  }
  paletteItems = filterPaletteItems(buildPaletteItems({ repertoires }), "");
  paletteActive = 0;
  el.hidden = false;
  const input = document.getElementById("palette-input");
  if (input) {
    input.value = "";
    input.setAttribute("aria-expanded", "true");
  }
  paintPalette();
  paletteA11yCleanup = activateModal(el, { initialFocus: input });
}

function dismissTransientOverlays() {
  // Tab/command-palette navigation always wins over transient overlays: the
  // overlay click / Escape paths share this teardown so no orphaned keydown
  // listener survives a navigation-driven dismissal.
  const overlay = document.querySelector(".modal-overlay.auth-overlay");
  if (overlay) {
    if (typeof overlay._closeAuthModal === "function") overlay._closeAuthModal();
    else overlay.remove();
  }
  if (paletteIsOpen()) closePalette();
}

async function runPaletteItem(item) {
  closePalette();
  if (!item) return;
  if (item.kind === "view") {
    dismissTransientOverlays();
    switchView(item.view);
    if (item.section) setReplaySection(item.section);
    if (item.view === "settings") loadSettings();
    return;
  }
  if (item.kind === "repertoire" && item.repertoireId) {
    editRepertoire(item.repertoireId);
    return;
  }
  if (item.action === "new-repertoire") {
    createRepertoirePrompt();
    return;
  }
  if (item.action === "start-training") {
    switchView("train");
    // A guest gets the sign-in gate only; a live game on the board stays as it is.
    if (!appState.signedIn) {
      requireSignIn("Sign in to start training", "train");
      return;
    }
    const livePlay = appState.play && appState.play.active && (appState.play.history || []).length > 0;
    if (livePlay) {
      const ok = await showConfirmModal({
        title: "Leave this game?",
        body: "The current game will be abandoned.",
        okLabel: "Start training",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
    }
    if (appState.trainMode === "play") goToSmartTraining();
    else startTraining();
    return;
  }
  if (item.action === "play-human") {
    switchView("train");
    const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
    if (playBtn) playBtn.click();
    document.getElementById("start-play")?.click();
    return;
  }
  if (item.action === "feeling-lucky") {
    dismissTransientOverlays();
    switchView("train");
    const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
    if (playBtn) playBtn.click();
    onFeelingLucky();
    return;
  }
  if (item.action === "analyze") {
    switchView("analyze");
    return;
  }
  if (item.action === "toggle-theme") toggleTheme();
}

function bindCommandPalette() {
  const root = document.getElementById("command-palette");
  const input = document.getElementById("palette-input");
  const results = document.getElementById("palette-results");
  const opener = document.getElementById("open-palette");
  if (opener) opener.addEventListener("click", () => openPalette());
  if (root) {
    root.addEventListener("click", (event) => {
      if (event.target === root) closePalette();
    });
  }
  if (input) {
    input.addEventListener("input", () => {
      paletteItems = filterPaletteItems(
        buildPaletteItems({ repertoires: appState.repertoireList || [] }),
        input.value,
      );
      paletteActive = 0;
      paintPalette();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        paletteActive = Math.min(paletteItems.length - 1, paletteActive + 1);
        paintPalette();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        paletteActive = Math.max(0, paletteActive - 1);
        paintPalette();
      } else if (event.key === "Enter") {
        event.preventDefault();
        // The item may open a dialog with its own document keydown handler
        // (sign-in submits on Enter); this keystroke must not reach it.
        event.stopPropagation();
        runPaletteItem(paletteItems[paletteActive]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    });
  }
  if (results) {
    results.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-index]");
      if (!btn) return;
      runPaletteItem(paletteItems[Number(btn.dataset.index)]);
    });
  }
}

async function restoreWorkspaceLocation() {
  if (navigatedDuringBoot) {
    // The user already moved on: stay there, re-entering the page so it loads
    // with the now-known session (it may have painted signed-out mid-boot),
    // and record it in the URL.
    switchView(appState.currentView);
    syncWorkspaceUrl();
    if (appState.currentView === "train" && appState.signedIn) {
      await startTraining(appState.trainMode, { fresh: false });
    }
    return;
  }
  const loc = parseWorkspaceLocation(window.location.href);
  const seq = workspaceNavigationSeq;
  // F-06 return state: coming back to Games (even after a reload) restores the
  // selected game and the active filter, so the source page is where you left it.
  const replayReturn = loadReturnState("replay");
  if (replayReturn) {
    if (typeof replayReturn.filter === "string" && replayReturn.filter) {
      appState.replayFilter = replayReturn.filter;
    }
    if (Number.isFinite(replayReturn.openIndex)) {
      appState.replayOpen = new Set([replayReturn.openIndex]);
    }
  }
  if (loc.repertoireId && appState.signedIn) {
    try {
      const payload = await api(
        `/api/build/load?repertoire_id=${encodeURIComponent(loc.repertoireId)}`,
      );
      if (seq === workspaceNavigationSeq) {
        await hydrateBuild(payload, payload.selected_node_id);
        if (seq === workspaceNavigationSeq) appState.trainingRepertoireId = payload.repertoire_id;
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
    appState.replaySection = loc.replaySection;
  }
  switchView(loc.view, { fromUrl: true });
  if (loc.view === "analyze" && loc.ply && appState.analysis) {
    await showAnalysisPly(loc.ply);
  }
  if (loc.view === "train" && appState.signedIn) {
    await startTraining(appState.trainMode, { fresh: false });
  }
}

function setReplaySection(section, { focus = false, syncUrl = true } = {}) {
  const next = section === "scout" ? "scout" : "games";
  // Games ↔ Scout is a page change for the user even though both live in the
  // replay view: an error from one must not follow them to the other.
  if (appState.replaySection && appState.replaySection !== next) clearStaleStatusOnNavigate();
  appState.replaySection = next;
  document.querySelectorAll("[data-replay-panel]").forEach((panel) => {
    const active = panel.dataset.replayPanel === next;
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
  });
  document.querySelectorAll(".tab[data-replay-section]").forEach((button) => {
    const active = button.dataset.replaySection === next;
    button.classList.toggle("is-active", active && appState.currentView === "replay");
    button.setAttribute("aria-current", active && appState.currentView === "replay" ? "page" : "false");
  });
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
    ? (appState.replaySection === "scout" ? "Scout" : "Games")
    : VIEW_TITLES[appState.currentView] || "";
  document.title = page ? `${page} · PrepForge Chess` : "PrepForge Chess";
  syncViewHeads();
}

// Analyze head: the loaded game's identity (PGN headers, else the recalled
// analysis) in the panel head.
function analyzeHeaderTags(pgnText) {
  const tags = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\]\s*$/gm;
  let match;
  while ((match = re.exec(pgnText)) !== null) tags[match[1]] = match[2];
  return tags;
}

function syncAnalyzeHead() {
  const title = document.getElementById("analysis-game-title");
  const meta = document.getElementById("analysis-game-meta");
  if (!title || !meta) return;
  const analysis = appState.analysis;
  // Only name a game the board actually shows: the prefilled demo PGN sitting unloaded in
  // the source box must not title an empty board "PrepForge vs Demo".
  const loaded = !!(analysis && ((analysis.moves && analysis.moves.length) || analysis.initialFen));
  const tags = loaded ? analyzeHeaderTags(document.getElementById("pgn-input")?.value || "") : {};
  const known = (v) => (v && !/^[?*.\s]+$/.test(v) ? v : "");
  const white = known(tags.White) || known(analysis?.white);
  const black = known(tags.Black) || known(analysis?.black);
  const plies = analysis?.moves?.length || 0;
  title.textContent = white || black ? `${white || "?"} vs ${black || "?"}` : "Analysis board";
  const bits = [known(tags.Result) || known(analysis?.result), known(tags.Event) || known(analysis?.event), known(tags.Date)]
    .filter(Boolean);
  meta.textContent = bits.length
    ? bits.join(" · ")
    : plies
      ? `${plies} half-move${plies === 1 ? "" : "s"}`
      : "";
}

// Per-view heads that live inside the pages: Analyze's game identity, the
// Repertoire header's size summary, and (phones) the More sheet's Library
// mirror of Import.
function syncViewHeads() {
  document.querySelectorAll("[data-lib-mirror]").forEach((item) => {
    item.hidden = appState.currentView !== "dashboard";
  });
  if (appState.currentView === "analyze") syncAnalyzeHead();
  const stats = document.getElementById("build-rep-stats");
  if (!stats) return;
  const build = appState.build;
  if (!build || isBuildReadOnly()) {
    stats.textContent = "";
    stats.title = "";
  } else {
    const played = build.nodes.filter((n) => n.depth > 0);
    const parents = new Set(build.nodes.map((n) => n.parent_id));
    const lines = played.filter((n) => !parents.has(n.id)).length;
    // "to train" is the Library's count too: your own enabled moves — the
    // ones Train drills (opponent replies are context, not cards).
    const train = countBuildMovesToTrain(build);
    stats.textContent =
      `${lines} line${lines === 1 ? "" : "s"} · ${played.length} move${played.length === 1 ? "" : "s"}` +
      ` · ${train} to train`;
    stats.title = `${countOf(played.length, "move")} in the tree; ${train} of them are your moves, which Train drills. Opponent replies aren't drilled.`;
  }
  stats.hidden = !stats.textContent;
}

// Own-side moves on the enabled tree (a disabled node hides its subtree) —
// mirrors the server's trainable count shown on the Library row.
function countBuildMovesToTrain(build) {
  const byId = new Map(build.nodes.map((n) => [n.id, n]));
  const enabledMemo = new Map();
  const reachable = (node) => {
    if (!node) return true;
    if (enabledMemo.has(node.id)) return enabledMemo.get(node.id);
    const ok = node.is_enabled !== false && reachable(byId.get(node.parent_id));
    enabledMemo.set(node.id, ok);
    return ok;
  };
  return build.nodes.filter((n) => n.depth > 0 && n.move_side === build.color && reachable(n)).length;
}

function switchView(name, { fromUrl = false } = {}) {
  workspaceNavigationSeq += 1;
  if (!fromUrl && !workspaceUrlReady) navigatedDuringBoot = true;
  if (appState.currentView === "teams" && name !== "teams") {
    teamsView?.invalidateRequests();
    sharedRepertoiresSeq++;
    teamDetailSeq++;
  }
  if (appState.currentView !== name) clearStaleStatusOnNavigate();
  if (name !== "analyze") analyzeSession?.positionCoach.cancel();
  if (appState.currentView !== name && engineWidget) engineWidget.exitPreview();
  appState.currentView = name;
  // Navigating is user activity; if the Lichess watch is running, switching to
  // Analyze (where a fresh game matters most) tightens the poll cadence briefly.
  noteLichessActivity();
  document.querySelectorAll(".tab").forEach((button) => {
    const replayMatch = name === "replay"
      ? button.dataset.replaySection === (appState.replaySection || "games")
      : !button.dataset.replaySection;
    const active = button.dataset.view === name && replayMatch;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  // Mobile bottom bar: Review lights up on either replay section (Games or
  // Scout); More lights up for the destinations its sheet carries.
  document.querySelectorAll("[data-review-tab]").forEach((button) => {
    const active = name === "replay";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  const moreBtn = document.getElementById("more-nav-btn");
  if (moreBtn) {
    const active = ["analyze", "teams", "settings"].includes(name);
    moreBtn.classList.toggle("is-active", active);
    moreBtn.setAttribute("aria-current", active ? "page" : "false");
  }
  syncPageTitle();
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  if (!fromUrl) syncWorkspaceUrl({ push: true });
  if (name === "replay") setReplaySection(appState.replaySection, { syncUrl: false });
  if (name === "analyze") {
    preloadCoach().catch(() => {});
    preloadAnalyzeView().catch(() => {});
  }
  if (name === "build") {
    preloadCoach().catch(() => {});
    preloadBuildView().catch(() => {});
    // No Maia warmup here by design: the ~46 MB weights only start downloading
    // after an explicit Generate click (see generateFromCurrentNode), so merely
    // browsing Build never triggers engine/model loading.
    preloadBuildGen().catch(() => {});
  }
  if (name === "train") {
    preloadTrainView().catch(() => {});
    loadTrainRepertoireOptions();
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
  // in it ships open, so it loads on entry (not only on a manual toggle).
  if (name === "analyze") {
    const historyDrawer = document.getElementById("history-drawer");
    if (historyDrawer) {
      historyDrawer.hidden = !appState.signedIn;
      if (appState.signedIn && historyDrawer.open) loadAnalysisHistory();
    }
  }
  if (name === "analyze" && appState.signedIn) {
    ensureBookLoaded()
      .then(() => updateBookline())
      .catch(() => { /* best-effort */ });
  }
  // Entering dashboard loads the view chunk; signed-in users also refresh counters.
  if (name === "dashboard") {
    ensureDashboardView().catch(() => {});
    if (appState.signedIn) {
      // Moves added in Repertoire sit in the debounced outbox for a moment;
      // send them first so the listing's move counts include them.
      settleBuildOutbox()
        .then(() => loadDashboard())
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
  syncEngineForView(name);
}

function parseFenBoard(fen) {
  const squares = {};
  fen.split(" ")[0].split("/").forEach((rankText, rankIndex) => {
    let fileIndex = 0;
    const rank = 8 - rankIndex;
    for (const char of rankText) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
      } else {
        squares[`${files[fileIndex]}${rank}`] = char;
        fileIndex += 1;
      }
    }
  });
  return squares;
}

const PIECE_LABEL_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

function pieceLabel(piece) {
  const name = PIECE_LABEL_NAMES[piece.toLowerCase()] || "piece";
  return `${piece === piece.toUpperCase() ? "white" : "black"} ${name}`;
}

function pieceSvg(piece) {
  const colorClass = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  // eslint-disable-next-line local/trusted-raw -- SVG paths come from the authored piece sets above.
  return html`<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${raw(activePieceSet()[piece.toLowerCase()])}</g></svg>`;
}

function setPieceStyle(style) {
  if (!PIECE_SETS[style]) return;
  appState.pieceStyle = style;
  try {
    localStorage.setItem(PIECE_STYLE_KEY, style);
  } catch (_) {
    // ignore storage errors (private mode)
  }
  Object.values(boards).forEach((board) => board && board.redrawPieces && board.redrawPieces());
  renderPieceStylePicker();
}

function renderPieceStylePicker() {
  const host = document.getElementById("piece-style-picker");
  if (!host) return;
  // A tiny sample of each set on board squares, so the choice is visible
  // before (and after) picking — the label alone didn't say what you'd get.
  const sample = ["K", "Q", "N", "p"];
  host.innerHTML = html`${Object.keys(PIECE_SETS)
    .map((style) => {
      const active = style === appState.pieceStyle;
      const set = PIECE_SETS[style];
      const previews = sample
        .map((pc) => {
          const colorClass = pc === pc.toUpperCase() ? "piece-white" : "piece-black";
          // eslint-disable-next-line local/trusted-raw -- Preview paths come from the same authored SVG piece sets.
          return html`<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${raw(set[pc.toLowerCase()])}</g></svg>`;
        });
      return (
        html`<button type="button" class="seg-btn piece-style-option${active ? " is-active" : ""}" data-style="${style}" aria-pressed="${active}"><span class="piece-style-preview" aria-hidden="true">${previews}</span><span class="piece-style-name">${PIECE_STYLE_LABELS[style] || style}</span></button>`
      );
    })}`;
  host.querySelectorAll(".piece-style-option").forEach((btn) => {
    btn.addEventListener("click", () => setPieceStyle(btn.dataset.style));
  });
}

function renderPrefsToggles() {
  const host = document.getElementById("board-prefs");
  if (!host) return;
  host.innerHTML = html`${Object.keys(PREF_LABELS)
    .map((key) => {
      const on = pref(key) ? " is-on" : "";
      const label = PREF_LABELS[key] || key;
      return (
        html`<div class="pf-row"><span class="pf-row-text"><span class="pf-row-label">${label}</span></span><button type="button" class="pf-switch${on}" data-pref="${key}" role="switch" aria-checked="${pref(key)}" aria-label="${label}"><span class="pf-knob"></span></button></div>`
      );
    })}`;
  host.querySelectorAll(".pf-switch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.pref;
      setPref(key, !pref(key));
      btn.classList.toggle("is-on", pref(key));
      btn.setAttribute("aria-checked", String(pref(key)));
    });
  });
}

function legalTargetsFrom(square, moves) {
  return moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4));
}

function legalMoveFor(from, to, moves) {
  return moves.find((move) => move.startsWith(`${from}${to}`));
}

const PROMOTION_PIECES = ["q", "r", "b", "n"];
const PROMOTION_LABELS = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };

function promotionOptions(from, to, moves) {
  return PROMOTION_PIECES.map((piece) => `${from}${to}${piece}`).filter((uci) =>
    moves.includes(uci)
  );
}

// True when `from→to` is a pawn promotion: more than one 5-char UCI shares the
// from/to prefix, or a single 5-char UCI does. Callers gate the picker on this
// so normal moves keep the instant click/drag path with zero UI.
function isPromotionMove(from, to, moves) {
  return moves.some(
    (move) => move.startsWith(`${from}${to}`) && move.length > 4
  );
}

// Shared promotion picker for Analyze / Build / Train boards (mouse, touch and
// keyboard). Mounts a small popover on the target square offering
// Queen / Rook / Bishop / Knight rendered with the active piece set; Queen is
// the initial focus but nothing is committed until the player chooses —
// Escape or an outside click cancels and leaves the position untouched.
// Returns a Promise resolving to the chosen 5-char UCI, or null on cancel.
export function showPromotionPicker({ from, to, moves, anchorBoard, color }) {
  return new Promise((resolve) => {
    const options = promotionOptions(from, to, moves);
    if (options.length === 0) {
      resolve(null);
      return;
    }
    if (options.length === 1) {
      resolve(options[0]);
      return;
    }
    const boardEl =
      typeof anchorBoard === "string"
        ? document.getElementById(anchorBoard)
        : anchorBoard && anchorBoard.board
          ? anchorBoard.board
          : anchorBoard || null;
    const dismiss = (value) => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onOutside = (event) => {
      if (!overlay.contains(event.target)) {
        event.preventDefault();
        dismiss(null);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss(null);
      }
    };
    const overlay = document.createElement("div");
    overlay.className = "promotion-picker-overlay";
    const side = color === "black" ? "black" : "white";
    overlay.innerHTML = html`
      <div class="promotion-picker" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
        ${options
          .map(
            (uci) => html`
          <button type="button" class="promotion-option" data-uci="${uci}"
            aria-label="Promote to ${PROMOTION_LABELS[uci[4]] || uci[4]}">
            ${pieceSvg(side === "white" ? uci[4].toUpperCase() : uci[4])}
            <span class="promotion-name">${PROMOTION_LABELS[uci[4]] || uci[4]}</span>
          </button>`
          )}
      </div>
    `;
    const buttons = [...overlay.querySelectorAll(".promotion-option")];
    buttons.forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        dismiss(btn.dataset.uci);
      });
    });
    if (boardEl && boardEl.parentElement) {
      boardEl.parentElement.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
      activateModal(overlay);
    }
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    const queenBtn = buttons[0];
    if (queenBtn) queenBtn.focus({ preventScroll: true });
  });
}

// Promotion-aware resolution shared by click / drag / keyboard-square paths.
// Plain moves resolve synchronously; promotions open the picker and resolve
// async. `play` is invoked exactly once with the final UCI (or never, on
// cancel) so board handlers keep a single onMove entry point.
function resolveBoardMove({ from, to, moves, board, play }) {
  if (!isPromotionMove(from, to, moves)) {
    const move = legalMoveFor(from, to, moves);
    if (move) play(move);
    return;
  }
  const sideIsBlack = (() => {
    try {
      const rank = board && board.fen ? board.fen.split(" ")[1] : "w";
      return rank === "b";
    } catch (_) {
      return false;
    }
  })();
  const boardEl = board && board.board ? board.board : null;
  void showPromotionPicker({
    from,
    to,
    moves,
    anchorBoard: boardEl,
    color: sideIsBlack ? "black" : "white",
  }).then((uci) => {
    if (uci) play(uci);
  });
}

function renderAnnotations(
  overlay,
  arrows,
  orientation = "white",
  engineArrow = null,
  branchArrows = [],
  branchPick = null,
  betterArrow = null
) {
  overlay.setAttribute("viewBox", "0 0 100 100");
  overlay.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const valid = (uci) => typeof uci === "string" && uci.length >= 4 && uci.slice(0, 2) !== uci.slice(2, 4);
  // Colours and stroke come from CSS tokens (.annot-arrow rules) so board
  // arrows stay in step with the rest of the theme.
  const drawn = [];
  const drawArrow = (parent, arrow, kind, opts) => {
    const from = squareCenter(arrow.slice(0, 2), orientation);
    const to = squareCenter(arrow.slice(2, 4), orientation);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", buildArrowPath(from, to, opts));
    path.setAttribute("class", `annot-arrow annot-${kind}`);
    parent.appendChild(path);
    drawn.push({ from, to, kind, opts, idle: parent !== overlay });
  };
  // Paint order is importance order, so a stronger mark is never buried under a weaker
  // one: idle fork options → the picked option → the engine-also-likes-this option →
  // the better move → your own arrows → the engine's move.
  const engine = valid(engineArrow) ? engineArrow : null;
  const branches = [...new Set((branchArrows || []).filter(valid))];
  const pick = branches.includes(branchPick) ? branchPick : null;
  // Idle options share one translucent group, so where two cross the overlap does not
  // darken into a third, stronger-looking arrow; they are also drawn slimmer.
  const idle = branches.filter((u) => u !== pick && u !== engine);
  if (idle.length) {
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", "annot-branches");
    idle.forEach((u) => drawArrow(group, u, "branch", { scale: 0.78 }));
    overlay.appendChild(group);
  }
  if (pick && pick !== engine) drawArrow(overlay, pick, "branch is-pick");
  // The engine's move is one of the fork options: one arrow, the engine's fill inside the
  // option's outline, instead of a green arrow hiding the option underneath.
  const engineIsBranch = !!engine && branches.includes(engine);
  if (engineIsBranch) drawArrow(overlay, engine, `branch is-engine${engine === pick ? " is-pick" : ""}`);
  if (valid(betterArrow) && betterArrow !== engine) drawArrow(overlay, betterArrow, "better");
  arrows.forEach((arrow) => drawArrow(overlay, arrow, "user"));
  // A line option you also drew yourself: its dashed outline on top, so the option
  // doesn't vanish under your arrow.
  branches.filter((u) => u !== engine && arrows.includes(u)).forEach((u) => drawArrow(overlay, u, "branch is-echo"));
  // Slimmer than a user arrow, so one you drew on the same move still shows around it.
  if (engine && !engineIsBranch) drawArrow(overlay, engine, "engine", { scale: 0.7 });
  // Two moves along one line from the same square (Bd3 and Bc4): the longer arrow's shaft
  // covers the shorter one, so the shorter one's head is drawn again on top — one shaft,
  // a head at each stop.
  drawn.forEach((a, i) => {
    if (!drawn.slice(i + 1).some((b) => endsUnder(a, b))) return;
    const head = document.createElementNS(NS, "path");
    head.setAttribute("d", buildArrowHeadPath(a.from, a.to, a.opts));
    head.setAttribute("class", `annot-arrow annot-${a.kind} annot-stop${a.idle ? " is-idle" : ""}`);
    overlay.appendChild(head);
  });
}

function squareCenter(square, orientation = "white") {
  const file = files.indexOf(square[0]);
  const rank = Number(square[1]);
  const fileSlot = orientation === "white" ? file : 7 - file;
  const rankSlot = orientation === "white" ? 8 - rank : rank - 1;
  return {
    x: fileSlot * 12.5 + 6.25,
    y: rankSlot * 12.5 + 6.25,
  };
}

// Board legality/state is computed in the browser (chess.js) — no server hop, no
// auth needed. Kept async so every existing `await boardInfo(...)` call site is
// untouched; they resolve instantly. See chess-local.js for the why.
async function boardAfterMove(fen, moveUci) {
  return localBoardAfterMove(fen, moveUci);
}

async function boardInfo(fen) {
  return localBoardInfo(fen);
}

// Optimistically land a just-dragged move on `board` using the local chess
// engine, before any server round-trip confirms it. Without this the board
// drag system restores the piece to its origin on drop and only re-renders the
// move once the handler awaits the network — so the piece visibly snaps back,
// then jumps forward a round-trip later. The handlers below all re-issue
// setPosition with the authoritative FEN afterwards; when that FEN matches the
// optimistic one (the common case) it's a no-op, so there's no second animation
// or sound. The board is locked (no legal moves) until that authoritative
// render lands, so a second drop can't race the in-flight request. Best-effort:
// a failed local apply just leaves the pre-move position for the server to fix.
async function optimisticBoardMove(board, fenBefore, moveUci) {
  if (!board || !fenBefore || !moveUci) return false;
  try {
    const after = await boardAfterMove(fenBefore, moveUci);
    board.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: moveUci });
    return true;
  } catch (_) {
    return false;
  }
}

// Deep-link into the smart queue (it already front-loads due reviews).
function goToSmartTraining(statusMessage) {
  switchView("train");
  appState.trainMode = "smart";
  const btn = document.querySelector('#train-modes .train-mode[data-mode="smart"]');
  if (btn) btn.click();
  setStatus(statusMessage || "Starting trainer");
  // Dashboard "Train now" used to dump the user on an idle Train tab. Start
  // (or resume) the smart queue immediately so one click is a real session.
  startTraining("smart", { fresh: false }).catch(() => {});
}

// ----- Dashboard tab — lazy view chunk ----------------------------------------
let dashboardModulePromise = null;
let dashboardView = null;

function preloadDashboardView() {
  if (!dashboardModulePromise) {
    dashboardModulePromise = import("./views/dashboard.js").catch((err) => {
      dashboardModulePromise = null;
      throw err;
    });
  }
  return dashboardModulePromise;
}

async function ensureDashboardView() {
  const mod = await preloadDashboardView();
  if (!dashboardView) {
    dashboardView = mod.createDashboardView({
      appState,
      api,
      postJson,
      setStatus,
      setStatusError,
      localDateString,
      goToSmartTraining,
      editRepertoire,
      openRepertoireContextMenu,
      createRepertoirePrompt,
      hydrateBuild,
      showInputModal,
      promptImportRepertoireFromPgn,
      requireSignIn,
      openSignIn: () => openAuthModal("login"),
      onLibraryStateChange: syncViewHeads,
      goToView: switchView,
      openSettingsSection,
      // Library preview mini-board: FEN decode + the product's piece SVGs over
      // the real listing root_fen. Pure DOM helpers — no engine, no board.
      previewRenderers: { parseFenBoard, pieceSvg },
    });
    dashboardView.bind();
  }
  return dashboardView;
}

async function loadDashboard() {
  let view;
  try {
    view = await ensureDashboardView();
    if (appState.signedIn) await view.loadDashboard();
    else view.renderSignedOut();
  } catch (error) {
    // An import failure happens before the view can clear the initial spinner.
    if (!view) {
      const card = document.querySelector("#view-dashboard .lib-list");
      for (const name of ["is-loading", "is-empty", "is-error"]) {
        card?.classList.toggle(name, name !== "is-loading");
      }
      const host = document.getElementById("dashboard-repertoires");
      if (host) {
        host.innerHTML = html`<div class="empty-state" role="alert"><h3>Could not load your library.</h3><p>${error.message}</p><button type="button" class="btn" data-library-retry>Try again</button></div>`;
        host.querySelector("[data-library-retry]")?.addEventListener("click", loadDashboard);
      }
    }
    setStatusError(error.message);
  }
}

// Refresh the repertoire list only when the dashboard chunk is already loaded —
// never pull the chunk just to update invisible DOM after CRUD elsewhere.
function refreshDashboardRepertoires() {
  if (!dashboardView) return Promise.resolve();
  return dashboardView.loadDashboardRepertoires();
}

function defaultRepertoireNameFromPgn(pgnText) {
  const pgn = String(pgnText || "");
  const event = pgn.match(/\[Event\s+"([^"]+)"/i);
  if (event) return event[1].trim().slice(0, 80);
  const white = pgn.match(/\[White\s+"([^"]+)"/i);
  const black = pgn.match(/\[Black\s+"([^"]+)"/i);
  if (white && black) return `${white[1].trim()} vs ${black[1].trim()}`.slice(0, 80);
  return "Imported game";
}

async function importRepertoireFromPgnText(pgnText, { name, color }) {
  const payload = await postJson("/api/repertoires/import-pgn", {
    pgn: pgnText,
    name,
    color,
  });
  await hydrateBuild(payload, payload.selected_node_id);
  appState.trainingRepertoireId = payload.repertoire_id;
  await refreshDashboardRepertoires();
  return payload;
}

async function promptImportRepertoireFromPgn(pgnText, { defaultName = "Imported game", switchToBuild = false } = {}) {
  const meta = await showInputModal({
    title: "Import PGN as repertoire",
    okLabel: "Import",
    fields: [
      { name: "name", label: "Name", default: defaultName },
      repertoireColorField("white"),
    ],
  });
  if (!meta) return null;
  const name = (meta.name || "").trim() || "Imported";
  const color = normalizeRepertoireColor(meta.color);
  try {
    const payload = await importRepertoireFromPgnText(pgnText, { name, color });
    if (switchToBuild) switchView("build");
    setStatus(
      switchToBuild
        ? `Repertoire “${payload.name}” created — edit it in Repertoire`
        : `Imported ${payload.name}`,
    );
    return payload;
  } catch (error) {
    setStatusError(error.message);
    throw error;
  }
}

let accountController = null;

function initAccountController() {
  accountController = createAccountController({
    appState,
    api,
    postJson,
    setStatus,
    showConfirmModal,
    refreshAutoMaiaRating,
    onLichessConnected: startLichessGameWatch,
    // The Library setup checklist ticks "Link Lichess" from the live accounts.
    // The Games/Scout source trays resolve "Self" against the same list: painted
    // before it arrived they read "No sources" while Start still fetched every
    // linked account, so repaint them from the live list too.
    onLichessAccountsChanged: () => {
      dashboardView?.refreshSetup?.();
      scoutView?.syncSources();
      paintGamesSource();
      paintScoutSource();
    },
    onOpenSettings: () => {
      switchView("settings");
      loadSettings();
    },
    onOpenAccount: () => {
      void openSettingsSection("set-account");
    },
    beforeSignOut: flushAllPendingForSignOut,
    onOwnerChanged: () => {
      setHandoffOwner(currentOwnerId());
      coverageView?.clear();
      appState.settingsRequestSeq = (appState.settingsRequestSeq || 0) + 1;
      appState.settingsReadSeq = (appState.settingsReadSeq || 0) + 1;
      appState.settingsSaving = null;
      appState.buildMutationSaving = null;
      analysisHistorySeq++;
      sharedRepertoiresSeq++;
      appState.teamsRequestSeq = (appState.teamsRequestSeq || 0) + 1;
      appState.teams = [];
      appState.teamsCache = null;
      appState.analysisRetryCheckpoint = null;
      appState.analysisUnsavedCheckpoint = null;
      hideAnalysisRetrySave();
      for (const id of ["analysis-history", "teams-list", "teams-shared"]) {
        const host = document.getElementById(id);
        if (host) host.innerHTML = "";
      }
      hideTeamDetail();
      dashboardView?.renderSignedOut();
    },
  });
}

function accountService() {
  if (!accountController) throw new Error("Account controller is not initialized");
  return accountController;
}

function getStoredLichessUsername() {
  return accountService().getStoredLichessUsername();
}

function setLichessUsername(username) {
  return accountService().setLichessUsername(username);
}

// Which sign-in methods the server offers (Google when configured; email/password
// always). Fetched once; drives which buttons the auth modal shows.
async function refreshAuthProviders() {
  return accountService().refreshAuthProviders();
}

// Owner-scoped actions (create/import a repertoire, teams, analysis) call server endpoints
// that require an account and return 401 for guests. Guard them up front so a guest gets the
// sign-in modal instead of filling out a form only to hit a cryptic 401 in the status bar.
// `reason` is shown inside the modal; `pendingActionId` (allowlisted in
// auth-gate.js) resumes the action after sign-in — see resumePendingAction.
function requireSignIn(reason = "Sign in (or create an account) to continue", pendingActionId = null, pendingData = null) {
  return accountService().requireSignIn(reason, pendingActionId, pendingData);
}

// The sign-in / create-account modal. Google (when configured) is the primary path;
// email/password is the always-available fallback. Options ({ notice,
// pendingAction, resetToken }) pass straight through to the controller.
function openAuthModal(mode = "login", options = {}) {
  return accountService().openAuthModal(mode, options);
}

// Guest → the chip is a single Connect action (straight to OAuth). Signed in → the
// chip toggles the account menu.
function onAccountChipClick(anchor = null, options = {}) {
  return accountService().onAccountChipClick(anchor, options);
}

function closeAccountMenu(options = {}) {
  return accountService().closeAccountMenu(options);
}

function isAccountMenuOpen() {
  return accountService().isAccountMenuOpen();
}

// Ask the server whether this browser's session is a real account or a guest, and
// capture the account's stable username for the user-name button.
async function refreshAuthStatus() {
  return accountService().refreshAuthStatus();
}

function syncReplayControls() {
  try {
    accountService().syncReplayControls();
  } catch (_) {
    /* controller may not be initialised yet */
  }
  paintGamesSource();
  paintScoutSource();
}

// Pull the server's stored Lichess connection state. This is not a PrepForge sign-out;
// the browser remains bound to the account.
async function refreshLichessStatus() {
  return accountService().refreshLichessStatus();
}

// Open Lichess sign-in in a popup; the callback page postMessages back, and we
// also poll status as a fallback if the message is blocked.
function startLichessOAuth() {
  return accountService().startLichessOAuth();
}

// Background watch for "you just finished a game". Design goals (vs the old
// "latest id != last_seen → pop", which fired for ANY historical game on a fresh
// app load):
//   1. Silent baseline: on watch start we record the current latest game id
//      WITHOUT popping, so opening the app never resurfaces an old game.
//   2. Recency gate: only auto-pop a game whose true FINISH time (Lichess
//      lastMoveAt) is within LICHESS_RECENT_WINDOW_MS, so a stale baseline can
//      never surface an hours-old game. Strict: a game with no usable timestamp
//      is never auto-popped — it gets a non-intrusive status hint instead.
//   3. Adaptive cadence: short polling right after activity (focus, tab visible,
//      navigation) or on Analyze; back off to a low idle frequency otherwise —
//      instead of a fixed 90s timer that runs even on a hidden tab.
const LICHESS_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h: "recently finished"
const LICHESS_POLL_ACTIVE_MS = 25 * 1000; // short cadence while active / on Analyze
const LICHESS_POLL_IDLE_MS = 3 * 60 * 1000; // idle back-off
const LICHESS_ACTIVE_WINDOW_MS = 3 * 60 * 1000; // how long activity keeps us "active"

function startLichessGameWatch() {
  stopLichessGameWatch();
  appState.lichessWatchStartedAt = Date.now();
  appState.lichessBaselineId = null;
  appState.lichessLastActivity = Date.now();
  // Re-check promptly when the user returns to the tab/window (and treat it as
  // activity so the cadence tightens). Bound once; refs kept for clean removal.
  appState.lichessOnFocus = () => {
    noteLichessActivity();
    checkLatestLichessGame();
  };
  appState.lichessOnVisible = () => {
    if (document.visibilityState === "visible") appState.lichessOnFocus();
  };
  window.addEventListener("focus", appState.lichessOnFocus);
  document.addEventListener("visibilitychange", appState.lichessOnVisible);
  // Establish the silent baseline shortly after connecting, then start polling.
  window.setTimeout(async () => {
    await checkLatestLichessGame({ baselineOnly: true });
    scheduleLichessPoll();
  }, 5000);
}

function stopLichessGameWatch() {
  if (appState.lichessPollTimer) {
    window.clearTimeout(appState.lichessPollTimer);
    appState.lichessPollTimer = null;
  }
  if (appState.lichessOnFocus) {
    window.removeEventListener("focus", appState.lichessOnFocus);
    appState.lichessOnFocus = null;
  }
  if (appState.lichessOnVisible) {
    document.removeEventListener("visibilitychange", appState.lichessOnVisible);
    appState.lichessOnVisible = null;
  }
  appState.lichessBaselineId = null;
}

// Record user activity so the poll cadence stays short for a short window after.
function noteLichessActivity() {
  appState.lichessLastActivity = Date.now();
}

// Self-rescheduling poll: short cadence while recently active or on Analyze (where
// a just-finished game is most relevant), otherwise a low idle frequency. Skips the
// work entirely while the tab is hidden (the focus/visibility handlers catch up).
function scheduleLichessPoll() {
  if (appState.lichessPollTimer) window.clearTimeout(appState.lichessPollTimer);
  if (!appState.lichessUsername) return;
  const recentlyActive =
    Date.now() - (appState.lichessLastActivity || 0) < LICHESS_ACTIVE_WINDOW_MS;
  const active = recentlyActive || appState.currentView === "analyze";
  const delay = active ? LICHESS_POLL_ACTIVE_MS : LICHESS_POLL_IDLE_MS;
  appState.lichessPollTimer = window.setTimeout(async () => {
    if (document.visibilityState !== "hidden") await checkLatestLichessGame();
    scheduleLichessPoll();
  }, delay);
}

// Tri-state recency: true = finished within the window, false = finished but stale,
// null = no usable timestamp. We keep null distinct so the caller can degrade to a
// non-intrusive hint rather than guessing (strict gate — never auto-pop on unknown).
function finishedRecently(finishedAt) {
  if (!finishedAt) return null;
  const t = Date.parse(finishedAt);
  if (Number.isNaN(t)) return null;
  return Date.now() - t <= LICHESS_RECENT_WINDOW_MS;
}

// baselineOnly: record the current latest id without popping (used once at watch
// start so the pre-existing latest game is never treated as "just finished").
async function checkLatestLichessGame({ baselineOnly = false } = {}) {
  if (!appState.lichessUsername) return;
  let latest;
  try {
    // Lightweight NDJSON metadata probe (no move text) — fast, and enough to decide
    // whether to surface the nudge. The full PGN is fetched only if the user acts on it.
    latest = await api("/api/lichess/latest?light=1");
  } catch (_) {
    return;
  }
  if (!latest.has_game) return;
  if (baselineOnly || appState.lichessBaselineId === null) {
    // First sighting this session: adopt as baseline, never pop.
    appState.lichessBaselineId = latest.lichess_id;
    return;
  }
  const isNewerThanBaseline = latest.lichess_id !== appState.lichessBaselineId;
  // Advance the baseline regardless, so we evaluate each newly-latest game once.
  appState.lichessBaselineId = latest.lichess_id;
  if (!isNewerThanBaseline || !latest.is_new) return;
  const recent = finishedRecently(latest.finished_at);
  if (recent === true) {
    showNewGameWidget(latest);
  } else if (recent === null) {
    // Passed the baseline + is_new gates but we can't confirm it finished recently.
    // Strict gate: don't pop the widget — just surface a quiet, dismissible hint.
    setStatus(
      `New Lichess game synced: ${latest.white || "?"} vs ${latest.black || "?"}`
    );
  }
  // recent === false: a genuinely older game; stay silent.
}

// Surface a "you just finished a game" nudge. It lives in the shared toast
// stack (so it never overlaps the job cards or engine window) and auto-cleans
// itself after a while if the player ignores it.
function showNewGameWidget(game) {
  if (appState.newGameWidgetId === game.lichess_id) return;
  appState.newGameWidgetId = game.lichess_id;
  const sub =
    `${game.white || "?"} vs ${game.black || "?"}` +
    `${game.result ? " · " + game.result : ""}`;
  const toast = jobToast.notify({
    id: `newgame-${game.lichess_id}`,
    title: "You just finished a game!",
    message: sub,
    actions: [
      {
        label: "Dismiss",
        primary: false,
        onClick: () => {
          appState.newGameWidgetId = null;
          markLichessSeen(game.lichess_id);
        },
      },
      {
        label: "Analyze",
        primary: true,
        onClick: async () => {
          appState.newGameWidgetId = null;
          markLichessSeen(game.lichess_id);
          switchView("analyze");
          // Pull the full PGN now (the probe above skipped move text).
          let pgn = game.pgn || "";
          if (!pgn) {
            try {
              const full = await api("/api/lichess/latest");
              pgn = full.pgn || "";
            } catch (_) {
              /* fall through with empty pgn */
            }
          }
          document.getElementById("pgn-input").value = pgn;
          await runAnalysis();
        },
      },
    ],
  });
  // Auto-dismiss after ~45s of being ignored; the pointer-gating keeps it alive
  // while the user is actually interacting with it. Mark the game seen so the
  // watcher doesn't keep re-surfacing the same finished game.
  if (toast) toast._arm(45000, () => {
    appState.newGameWidgetId = null;
    markLichessSeen(game.lichess_id);
    toast.dismiss();
  });
}

async function markLichessSeen(lichessId) {
  if (!lichessId) return;
  try {
    await postJson("/api/lichess/seen", { lichess_id: lichessId });
  } catch (_) {
    /* ignore */
  }
}

// Linked Lichess identities for one-time per-action selection. `null` = not yet
// loaded; `[]` = none linked. Identity-changing actions (My last game,
// Replay compare, new-game watcher) resolve through resolveLichessAccountId():
// zero → connect flow, one → use it directly, many → compact chooser.
function lichessAccounts() {
  const accounts = appState.lichessAccounts;
  return Array.isArray(accounts) ? accounts : [];
}

function lichessPrimaryAccount() {
  const accounts = lichessAccounts();
  return accounts.find((a) => a.is_primary) || accounts[0] || null;
}

// One-time account chooser for a single action: compact modal listing linked
// identities, Primary defaulted/highlighted, closes on select or cancel.
// Resolves to the chosen account id, or null when cancelled.
function chooseLichessAccount(actionLabel) {
  const accounts = lichessAccounts();
  const primary = lichessPrimaryAccount();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const rows = accounts
      .map(
        (account) => html`
      <button type="button" class="btn ghost account-choice${account.is_primary ? " is-primary" : ""}" data-account-id="${account.id}">
        ${account.username}${account.is_primary ? " — Primary" : ""}
      </button>`,
      );
    overlay.innerHTML = html`
      <div class="modal account-chooser" role="dialog" aria-modal="true" aria-label="${actionLabel}">
        <div class="modal-title">${actionLabel}</div>
        <div class="modal-body">
          <p class="modal-copy">Which Lichess account should this use? Primary is preselected.</p>
          <div class="account-chooser-list">${rows}</div>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const cleanup = () => overlay.remove();
    const close = (value) => {
      cleanup();
      resolve(value);
    };
    const primaryBtn = primary && overlay.querySelector(`[data-account-id="${primary.id}"]`);
    if (primaryBtn) primaryBtn.focus();
    overlay.addEventListener("click", (event) => {
      const choice = event.target.closest("[data-account-id]");
      if (choice) {
        close(choice.dataset.accountId);
        return;
      }
      if (event.target === overlay || event.target.closest('[data-action="cancel"]')) {
        close(null);
      }
    });
    document.addEventListener(
      "keydown",
      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          document.removeEventListener("keydown", onKey);
          close(null);
        }
      },
      { once: false },
    );
  });
}

// Resolve which linked identity an identity-changing action should read:
// null = caller must run the connect flow first; otherwise an account id
// (single account → immediate, multiple → one-time chooser, primary default).
async function resolveLichessAccountId(actionLabel) {
  const accounts = lichessAccounts();
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0].id;
  const primary = lichessPrimaryAccount();
  const chosen = await chooseLichessAccount(actionLabel);
  return chosen || null;
}

// "My game" button: pull the newest game across ALL linked Lichess identities
// ("self") straight into the PGN box — no chooser. account_id is only for
// explicit single-account callers; the default path aggregates.
// Point Analyze's board at the user's side of a game they played: match either
// player name against every linked Lichess identity (plus the account the game
// came from). Leaves the orientation alone when neither side is recognisably Self.
function orientAnalysisForSelf(white, black, extraNames = []) {
  if (!boards.analysis) return;
  const side = selfSide(white, black, [
    appState.lichessUsername,
    ...lichessAccounts().map((a) => a.username),
    ...extraNames,
  ]);
  if (side) boards.analysis.setOrientation(side);
}

// Which side of the Analyze game is the user ("white" | "black" | null): the PGN box's
// White/Black tags, else the recalled analysis, matched against linked Lichess names.
function analysisSelfSide() {
  const tags = analyzeHeaderTags(document.getElementById("pgn-input")?.value || "");
  const analysis = appState.analysis || {};
  return selfSide(tags.White || analysis.white, tags.Black || analysis.black, [
    appState.lichessUsername,
    ...lichessAccounts().map((a) => a.username),
  ]);
}

// Same, for a PGN the user pasted or dropped: read its White/Black headers.
// Only re-orients when the pair of names changes, so the debounced re-parse on
// every keystroke never undoes a manual flip.
let lastOrientedPgnPlayers = "";
function orientAnalysisFromPgn(text) {
  const { white, black } = pgnPlayers(text);
  const key = `${white}\n${black}`;
  if (!white && !black) return;
  if (key === lastOrientedPgnPlayers) return;
  lastOrientedPgnPlayers = key;
  orientAnalysisForSelf(white, black);
}

async function fetchMyLichessGame(accountId = null) {
  // Your games come from the Lichess account linked to your PrepForge account.
  if (!requireSignIn("Sign in to load your latest Lichess game", "my-last-game")) return;
  if (!appState.lichessUsername && !lichessAccounts().length) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  setStatus("Fetching your latest game...");
  let latest;
  try {
    latest = await api(`/api/lichess/latest${query}`);
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  if (!latest.has_game) {
  setStatus("No recent games found", { severity: "warning" });
    return;
  }
  document.getElementById("pgn-input").value = latest.pgn || "";
  // Show the game in the move list right away, then analyze it in the same step —
  // "My last game" means "review my last game", not "paste it and wait for me".
  await loadPgnIntoAnalyze(latest.pgn || "", { goToEnd: false, quiet: true }).catch(() => {});
  orientAnalysisForSelf(latest.white, latest.black, [latest.source_account]);
  lastOrientedPgnPlayers = `${latest.white || ""}\n${latest.black || ""}`;
  if (latest.lichess_id) markLichessSeen(latest.lichess_id);
  const source = latest.source_account ? ` · from ${latest.source_account}` : "";
  setStatus(`Loaded ${latest.white || "?"} vs ${latest.black || "?"}${source} · analyzing`);
  await runAnalysis();
}

// Analyze "History": list previously analyzed games; click to recall a saved
// report without re-running the engine.
// A save adds a row to "Recent analyses": refresh the open drawer so it never
// keeps saying "No saved analyses yet" beside the review just saved.
function refreshAnalysisHistoryIfOpen() {
  const drawer = document.getElementById("history-drawer");
  if (appState.signedIn && drawer && drawer.open) void loadAnalysisHistory();
}

let analysisHistorySeq = 0;
async function loadAnalysisHistory() {
  const seq = ++analysisHistorySeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === analysisHistorySeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const host = document.getElementById("analysis-history");
  if (!host) return;
  host.innerHTML = html`<div class="muted hint">Loading...</div>`;
  const rows = new Map();
  let cursor = null, loading = false;
  async function loadPage() {
    if (loading || !isCurrent()) return;
    loading = true;
    const button = host.querySelector("[data-history-more]");
    if (button) button.disabled = true;
    try {
      const payload = await api(`/api/analyses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!isCurrent()) return;
      for (const row of payload.analyses || []) rows.set(row.game_id, row);
      cursor = payload.next_cursor || null;
      const scroll = host.scrollTop;
      host.innerHTML = html`${[...rows.values()].map((a) =>
        html`<button class="history-item" data-game-id="${a.game_id}"><span class="hi-players">${a.white || "?"} vs ${a.black || "?"}</span><span class="hi-meta">${a.result || ""} · ${localDayOf(a.analyzed_at)}</span></button>`
      )}` || html`<div class="muted hint">No saved analyses yet.</div>`;
      if (cursor) host.innerHTML += html`<button class="btn sm" data-history-more>Load more</button>`;
      host.scrollTop = scroll;
      host.querySelectorAll(".history-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (isCurrent()) recallAnalysis(btn.dataset.gameId, rows.get(btn.dataset.gameId));
        });
      });
      host.querySelector("[data-history-more]")?.addEventListener("click", loadPage);
    } catch (error) {
      if (!isCurrent()) return;
      if (rows.size) {
        if (button) button.textContent = "Retry load more";
        setStatusError(error.message);
      } else host.innerHTML = html`<div class="empty-state">${error.message}</div>`;
    } finally {
      loading = false;
      if (button && isCurrent()) button.disabled = false;
    }
  }
  await loadPage();
}

// All Analyze sources share an order: a recall, paste or new review must not
// let an older request (including a lazy view load) replace the latest game.
let analysisRecallSeq = 0;

function invalidateAnalysisSource() {
  appState.analysisFileSeq = null;
  clearTimeout(analyzePgnInputTimer);
  return ++analysisRecallSeq;
}

async function recallAnalysis(gameId, listItem = null) {
  const seq = invalidateAnalysisSource();
  setStatus("Loading saved analysis...");
  appState.analysisSourcePgn = null;
  hideAnalysisHandoff();
  try {
    const payload = await api(`/api/analyses/${encodeURIComponent(gameId)}`);
    const view = await ensureAnalyzeView();
    if (seq !== analysisRecallSeq) return;
    // The saved result carries no player names; the history row does. Without
    // them the head fell back to "Analysis board" for a named game.
    for (const key of ["white", "black", "result"]) {
      if (!payload[key] && listItem?.[key]) payload[key] = listItem[key];
    }
    appState.analysis = payload;
    // Mirror the recalled game into the PGN box for further exploration.
    // Clear it before rendering: the head reads its tags first, and a leftover
    // (e.g. the demo PGN) would title the recalled game "PrepForge vs Demo".
    const pgnInput = document.getElementById("pgn-input");
    if (pgnInput) pgnInput.value = "";
    orientAnalysisForSelf(payload.white, payload.black);
    lastOrientedPgnPlayers = `${payload.white || ""}\n${payload.black || ""}`;
    resetAnalysisVariations();
    await showAnalysisPly(0);
    if (seq !== analysisRecallSeq) return;
    view.renderAnalysis(payload);
    syncViewHeads();
    revealAnalysisResults();
    // The list sits at the panel's foot; open the new game at its summary.
    document.querySelector("#analyze-sidebar .panel-scroll")?.scrollTo({ top: 0 });
    await syncPgnFromTree();
    if (seq !== analysisRecallSeq) return;
    setStatus(`Recalled analysis: ${payload.moves.length} plies`);
  } catch (error) {
    if (seq !== analysisRecallSeq) return;
    setStatusError(error.message);
  }
}

// ---- Teams (Phase 5 UI) -----------------------------------------------------
// A team is a free, read-only sharing group: a repertoire owner shares to it
// (POST /api/repertoires/share) and every member can *read* (never edit) it.
// This view lists the caller's teams, drills into one to manage membership, and
// surfaces repertoires shared *to* the caller. Open to everyone — no Pro gate.

const TEAM_ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

function teamRoleLabel(role) {
  return TEAM_ROLE_LABELS[role] || role;
}

function teamById(teamId) {
  return appState.teams.find((tm) => tm.id === teamId) || null;
}

let teamsModule = null;
let teamsView = null;

function preloadTeamsView() {
  if (!teamsModule) {
    teamsModule = import("./views/teams.js").catch((err) => {
      teamsModule = null;
      throw err;
    });
  }
  return teamsModule;
}

async function ensureTeamsView() {
  const mod = await preloadTeamsView();
  if (!teamsView) {
    teamsView = mod.createTeamsView({
      appState,
      api,
      hideTeamDetail,
      openTeamDetail,
      loadSharedRepertoires,
      editRepertoire,
      unshareRepertoireFromTeam,
      copySharedRepertoire,
      teamRoleLabel,
      postJson,
      setStatus,
      setStatusError,
      activateModal,
      showConfirmModal,
      requireSignIn,
    });
  }
  return teamsView;
}

async function loadTeams() {
  return (await ensureTeamsView()).loadTeams();
}

function renderTeamsList() {
  if (teamsView) return teamsView.renderTeamsList();
  void ensureTeamsView().then((view) => view.renderTeamsList()).catch(() => {});
}

function hideTeamDetail() {
  appState.selectedTeamId = null;
  const card = document.getElementById("team-detail-card");
  if (card) card.hidden = true;
  renderTeamsList();
}

let teamDetailSeq = 0;
async function openTeamDetail(teamId) {
  const seq = ++teamDetailSeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === teamDetailSeq && appState.selectedTeamId === teamId && owner === currentOwnerId() && generation === appState.ownerGeneration;
  appState.selectedTeamId = teamId;
  renderTeamsList(); // reflect the selected row
  for (const id of ["team-add-member", "team-detail-invite", "team-share-rep", "team-detail-rename", "team-detail-delete"]) {
    const button = document.getElementById(id);
    if (button) { button.hidden = true; button.onclick = null; }
  }
  const name = document.getElementById("team-detail-name");
  if (name) name.textContent = "Loading?";
  const role = document.getElementById("team-detail-role");
  if (role) role.textContent = "";
  const shares = document.getElementById("team-shared-repertoires");
  if (shares) shares.innerHTML = "";
  teamsView?.renderTeamTabCounts({ members: 0, repertoires: 0 });
  teamsView?.renderTeamInviteFooter(null);
  const card = document.getElementById("team-detail-card");
  const membersEl = document.getElementById("team-members");
  if (!card || !membersEl) return;
  card.hidden = false;
  membersEl.innerHTML = html`<div class="empty-state">Loading…</div>`;
  let detail;
  try {
    detail = await api(`/api/teams/${encodeURIComponent(teamId)}`);
  } catch (error) {
    if (!isCurrent()) return;
    membersEl.innerHTML = html`<div class="empty-state">${error.message}</div>`;
    return;
  }
  if (!isCurrent()) return;
  const myRole = detail.role;
  const canManage = myRole === "owner" || myRole === "admin";
  document.getElementById("team-detail-name").textContent = detail.name;
  const roleBadge = document.getElementById("team-detail-role");
  if (roleBadge) {
    roleBadge.textContent = teamRoleLabel(myRole);
    roleBadge.className = `team-role-badge r-${myRole}`;
  }
  const addBtn = document.getElementById("team-add-member");
  if (addBtn) {
    addBtn.hidden = !canManage;
    addBtn.onclick = () => addTeamMember(teamId);
  }
  const inviteBtn = document.getElementById("team-detail-invite");
  if (inviteBtn) {
    inviteBtn.hidden = !canManage;
    inviteBtn.onclick = () => teamInvite(teamId);
  }
  const shareBtn = document.getElementById("team-share-rep");
  if (shareBtn) {
    // Any member may share one of their OWN repertoires with the team.
    shareBtn.hidden = false;
    shareBtn.onclick = () => shareRepertoireIntoTeam(teamId);
  }
  const renameBtn = document.getElementById("team-detail-rename");
  if (renameBtn) {
    renameBtn.hidden = !canManage;
    renameBtn.onclick = () => renameTeam(teamId, detail.name);
  }
  const deleteBtn = document.getElementById("team-detail-delete");
  if (deleteBtn) {
    deleteBtn.hidden = myRole !== "owner";
    deleteBtn.onclick = () => deleteTeam(teamId, detail.name);
  }
  const members = detail.members || [];
  // Tab counts from the real payload (prototype puts them on the tabs) + the
  // manager-only invite footer, both before the member rows render.
  if (teamsView) {
    teamsView.renderTeamTabCounts({ members: members.length });
    teamsView.renderTeamInviteFooter(detail);
  }
  membersEl.innerHTML = html`${members
    .map((m) => {
      const name = m.display_name || m.lichess_username || "Member";
      const sub = m.lichess_username ? html`<span class="sub">· ${m.lichess_username}</span>` : "";
      const initial = Array.from(m.display_name || m.lichess_username || "M")[0].toUpperCase();
      const isMe = m.user_id === appState.accountUserId;
      const isOwner = m.role === "owner";
      const uid = m.user_id;
      const uname = m.display_name || m.lichess_username || "Member";
      // Owner row is fixed. Managers get an inline role control on every other row
      // (incl. their own, so an admin can step down) plus remove; a plain member only
      // sees a read-only badge and a Leave button on their own row. The server
      // enforces all of this too.
      let tail;
      if (isOwner) {
        tail = html`<span class="team-role-badge r-owner">${teamRoleLabel("owner")}</span>`;
      } else if (canManage) {
        const opts = ["member", "admin"]
          .map(
            (r) =>
              html`<option value="${r}"${m.role === r ? " selected" : ""}>${teamRoleLabel(r)}</option>`
          );
        const removeBtn = html`<button type="button" class="ib team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="${isMe ? "1" : "0"}"${isMe ? "" : html` title="Remove member"`}>${isMe ? "Leave" : "×"}</button>`;
        tail = html`<select class="team-role-select" data-user-id="${uid}" aria-label="Role for ${uname}">${opts}</select>${removeBtn}`;
      } else {
        const leaveBtn = isMe
          ? html`<button type="button" class="ib team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="1">Leave</button>`
          : "";
        tail = html`<span class="team-role-badge r-${m.role}">${teamRoleLabel(m.role)}</span>${leaveBtn}`;
      }
      return html`
        <div class="mem-row team-member-row">
          <span class="avatar sm" aria-hidden="true">${initial}</span>
          <span class="mem-id"><span class="name">${name}${isMe ? html` <span class="sub">(you)</span>` : ""}</span>${sub}</span>
          <span class="team-member-tail">${tail}</span>
        </div>`;
    })}`;
  membersEl.querySelectorAll(".team-role-select").forEach((sel) => {
    sel.addEventListener("change", () =>
      updateMemberRole(teamId, sel.dataset.userId, sel.value)
    );
  });
  membersEl.querySelectorAll(".team-remove").forEach((btn) => {
    btn.addEventListener("click", () =>
      removeTeamMember(teamId, btn.dataset.userId, btn.dataset.userName, btn.dataset.self === "1")
    );
  });
  renderTeamSharedRepertoires(teamId, detail.shared_repertoires || []);
}

function renderTeamSharedRepertoires(teamId, sharedReps) {
  if (teamsView) return teamsView.renderTeamSharedRepertoires(teamId, sharedReps);
  void ensureTeamsView()
    .then((view) => view.renderTeamSharedRepertoires(teamId, sharedReps))
    .catch(() => {});
}

async function unshareRepertoireFromTeam(teamId, repertoireId, name) {
  const confirmed = await showConfirmModal({
    title: `Stop sharing "${name}"?`,
    body: "Team members will lose read access. You can share it again later.",
    okLabel: "Unshare",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await postJson("/api/repertoires/share", {
      repertoire_id: repertoireId,
      visibility: "private",
    });
    setStatus(`"${name}" is private again`);
    await refreshDashboardRepertoires();
    await openTeamDetail(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
}

async function createTeam() {
  if (!requireSignIn("Sign in to create a team", "new-team")) return;
  const result = await showInputModal({
    title: "New team",
    okLabel: "Create",
    fields: [{ name: "name", label: "Team name", default: "" }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Team name is empty");
    return;
  }
  try {
    const team = await postJson("/api/teams", { name });
    appState.selectedTeamId = team.id;
    // A fresh team starts empty: land on the Members tab (the empty Shared
    // tab would read as a glitch).
    teamsView?.selectTeamPane?.("members");
    setStatus(`Created team "${name}"`, { severity: "success" });
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function renameTeam(teamId, currentName) {
  const result = await showInputModal({
    title: "Rename team",
    okLabel: "Save",
    fields: [{ name: "name", label: "Team name", default: currentName }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Name is empty");
    return;
  }
  try {
    await api(`/api/teams/${encodeURIComponent(teamId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    setStatus(`Renamed to "${name}"`);
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function deleteTeam(teamId, name) {
  const confirmed = await showConfirmModal({
    title: "Delete team?",
    body: `"${name}" will be removed and all shared repertoires will become private again. Members lose access.`,
    okLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(`/api/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
    hideTeamDetail();
    setStatus(`Deleted team "${name}"`);
    await loadTeams();
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function addTeamMember(teamId) {
  const result = await showInputModal({
    title: "Add member",
    okLabel: "Add",
    fields: [
      { name: "lichess_username", label: "Their Lichess username", default: "" },
      {
        name: "role",
        label: "Role",
        type: "select",
        default: "member",
        options: [
          { value: "member", label: "Member" },
          { value: "admin", label: "Admin (can manage members)" },
        ],
      },
      {
        type: "note",
        label:
          "They need a PrepForge account with Lichess linked. No account yet? Send them the invite link instead.",
      },
    ],
  });
  if (!result) return;
  const handle = (result.lichess_username || "").trim();
  if (!handle) {
    setStatus("Lichess username is empty");
    return;
  }
  try {
    await postJson(`/api/teams/${encodeURIComponent(teamId)}/members`, {
      lichess_username: handle,
      role: result.role || "member",
    });
    setStatus(`Added ${handle}`);
    await loadTeams();
  } catch (error) {
    // The server returns an actionable message (e.g. "...send them an invite link").
    setStatusError(error.message);
  }
}

async function updateMemberRole(teamId, userId, role) {
  try {
    await api(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) }
    );
    setStatus(role === "admin" ? "Promoted to admin" : "Set to member");
  } catch (error) {
    setStatusError(error.message);
  }
  // Re-render either way: on success to reflect any rights change, on failure to
  // revert the <select> back to the server's truth.
  await openTeamDetail(teamId);
}

async function removeTeamMember(teamId, userId, label, isSelf) {
  const confirmed = await showConfirmModal({
    title: isSelf ? "Leave team?" : "Remove member?",
    body: isSelf
      ? "You'll lose access to repertoires shared with this team. You can be re-added later."
      : `Remove ${label} from the team? They'll lose access to its shared repertoires.`,
    okLabel: isSelf ? "Leave" : "Remove",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    setStatus(isSelf ? "Left team" : `Removed ${label}`);
    if (isSelf) {
      hideTeamDetail();
      teamsView?.selectTeamPane?.("members");
    }
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

// The team's shareable join link. Opening the dialog reads the link's status and
// never rotates it; minting a new code is an explicit, confirmed action inside
// the dialog (views/team-invite.js).
async function teamInvite(teamId) {
  try {
    await (await ensureTeamsView()).openInviteDialog(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
  await openTeamDetail(teamId);
}

// In-team "add a repertoire": share one of the caller's OWN repertoires with this
// team. A repertoire can be shared with one team at a time, so picking one already
// shared elsewhere moves it here.
async function shareRepertoireIntoTeam(teamId) {
  let reps = [];
  try {
    const payload = await api("/api/repertoires");
    reps = payload.repertoires || [];
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  const candidates = reps.filter((r) => !(r.visibility === "team" && r.team_id === teamId));
  if (!candidates.length) {
    setStatus(
      reps.length ? "All your repertoires are already shared here" : "You have no repertoires to share"
    );
    return;
  }
  const result = await showInputModal({
    title: "Share a repertoire",
    okLabel: "Share",
    fields: [
      {
        name: "repertoire",
        label: "Repertoire",
        type: "select",
        default: candidates[0].id,
        options: candidates.map((r) => ({
          value: r.id,
          label: r.visibility === "team" ? `${r.name} (shared elsewhere → moves here)` : r.name,
        })),
      },
      {
        type: "note",
        label: "Members get read-only access. A repertoire can be shared with one team at a time.",
      },
    ],
  });
  if (!result || !result.repertoire) return;
  try {
    await postJson("/api/repertoires/share", {
      repertoire_id: result.repertoire,
      team_id: teamId,
      visibility: "team",
    });
    setStatus("Shared with the team");
    await refreshDashboardRepertoires();
    await openTeamDetail(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
}

// Copy a team-shared repertoire the caller doesn't own into their own account.
async function copySharedRepertoire(repertoireId) {
  try {
    const result = await postJson("/api/repertoires/fork", { repertoire_id: repertoireId });
    setStatus(`Copied "${result.name}" to your repertoires`);
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatusError(error.message);
  }
}

let sharedRepertoiresSeq = 0;
async function loadSharedRepertoires() {
  const seq = ++sharedRepertoiresSeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === sharedRepertoiresSeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const container = document.getElementById("teams-shared");
  if (!container) return;
  try {
    const payload = await api("/api/repertoires");
    if (!isCurrent()) return;
    const shared = payload.shared || [];
    if (!shared.length) {
      container.innerHTML =
        html`<div class="empty-state">Nothing shared with you yet.</div>`;
      return;
    }
    container.innerHTML = html`${shared
      .map((item) => {
        const id = item.id;
        const name = item.name;
        const color = item.color || "white";
        const team = teamById(item.team_id);
        const via = `via ${team ? team.name : "a team"}`;
        return html`
          <div class="mem-row shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
            <span class="color-dot ${color}"></span>
            <span class="mem-id">
              <span class="name">${name}</span>
              <span class="sub">· ${via}</span>
            </span>
            <span class="team-member-tail">
              <span class="team-role-badge">read-only</span>
              <button type="button" class="btn sm team-copy" data-rep-id="${id}">Copy</button>
            </span>
          </div>`;
      })}`;
    container.querySelectorAll(".shared-rep-row").forEach((row) => {
      const open = () => openSharedRepertoire(row.dataset.repertoireId);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".team-copy")) return;
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
    container.querySelectorAll(".team-copy").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        copySharedRepertoire(btn.dataset.repId);
      });
    });
  } catch (error) {
    if (!isCurrent()) return;
    container.innerHTML = html`<div class="empty-state">${error.message}</div>`;
  }
}

async function openSharedRepertoire(repertoireId) {
  await editRepertoire(repertoireId);
}

// Rep context-menu action: share (or unshare) one of the caller's OWN repertoires
// with a team. Needs the caller's team list; if they have none, nudge them to the
// Teams view to make one first.
async function shareRepertoireWithTeam(repertoireId) {
  try {
    if (!appState.teams.length) {
      const payload = await api("/api/teams");
      appState.teams = payload.teams || [];
    }
  } catch (_) {
    /* fall through with whatever we have */
  }
  if (!appState.teams.length) {
    const go = await showConfirmModal({
      title: "No teams yet",
      body: "You need a team to share a repertoire with. Create one now?",
      okLabel: "Go to Teams",
      cancelLabel: "Cancel",
    });
    if (go) {
      switchView("teams");
      loadTeams();
    }
    return;
  }
  const result = await showInputModal({
    title: "Share with team",
    okLabel: "Apply",
    fields: [
      {
        name: "team",
        label: "Share with",
        type: "select",
        default: appState.teams[0].id,
        options: [
          { value: "", label: "Private (don't share)" },
          ...appState.teams.map((tm) => ({
            value: tm.id,
            label: tm.name,
          })),
        ],
      },
      {
        type: "note",
        label:
          "Members get read-only access. A repertoire can be shared with one team at a time.",
      },
    ],
  });
  if (!result) return;
  try {
    if (result.team) {
      await postJson("/api/repertoires/share", {
        repertoire_id: repertoireId,
        team_id: result.team,
        visibility: "team",
      });
      const team = appState.teams.find((tm) => tm.id === result.team);
      setStatus(`Shared with ${team ? team.name : "team"}`);
    } else {
      await postJson("/api/repertoires/share", {
        repertoire_id: repertoireId,
        visibility: "private",
      });
      setStatus("Repertoire is now private");
    }
  } catch (error) {
    setStatusError(error.message);
  }
}



// `hint` is an on-demand tooltip on a number/text field's label; `onInput`
// (values, overlay) runs on open and on every change — e.g. to repaint a live
// note (a `note` field is addressable as [data-note="<name>"]).
function showInputModal({ title, fields, okLabel = "OK", onInput = null, cancel = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const fieldHtml = (field) => {
        const safeName = field.name;
        const safeLabel = field.label || field.name;
        const safeValue = field.default == null ? "" : String(field.default);
        if (field.type === "note") {
          // Read-only informational line (no input, never collected).
          return html`<p class="modal-note muted" data-note="${safeName}">${safeLabel}</p>`;
        }
        if (field.type === "textarea") {
          return html`
            <label class="modal-field">
              <span>${safeLabel}</span>
              <textarea name="${safeName}" data-field>${safeValue}</textarea>
            </label>
          `;
        }
        if (field.type === "select") {
          const options = (field.options || [])
            .map((opt) => {
              const value = typeof opt === "string" ? opt : opt.value;
              const label = typeof opt === "string" ? opt : (opt.label || opt.value);
              const selected = String(field.default || "") === String(value) ? " selected" : "";
              return html`<option value="${value}"${selected}>${label}</option>`;
            });
          return html`
            <label class="modal-field">
              <span>${safeLabel}</span>
              <select name="${safeName}" data-field>${options}</select>
            </label>
          `;
        }
        const inputType = field.type === "number" ? "number" : "text";
        const numericAttrs =
          field.type === "number"
            ? html` min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}"`
            : "";
        const hint = field.hint ? html` title="${field.hint}"` : "";
        return html`
          <label class="modal-field"${hint}>
            <span>${safeLabel}</span>
            <input name="${safeName}" type="${inputType}" value="${safeValue}"${numericAttrs} data-field />
          </label>
        `;
    };
    const inputsHtml = fields.map(fieldHtml);
    overlay.innerHTML = html`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${inputsHtml}</div>
        <div class="modal-footer">
          ${cancel ? html`<button class="btn ghost" data-action="cancel" type="button">Cancel</button>` : ""}
          <button class="btn primary" data-action="ok" type="button">${okLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const firstInput = overlay.querySelector("[data-field]");
    if (firstInput) {
      firstInput.focus();
      if (firstInput.select) firstInput.select();
    }

    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const close = (values) => {
      cleanup();
      resolve(values);
    };
    const collect = () => {
      const values = {};
      overlay.querySelectorAll("[data-field]").forEach((el) => {
        values[el.name] = el.value;
      });
      return values;
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      } else if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") {
        event.preventDefault();
        close(collect());
      }
    };
    document.addEventListener("keydown", onKey);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => close(collect()));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
    if (typeof onInput === "function") {
      const fire = () => {
        try {
          onInput(collect(), overlay);
        } catch (_) {
          /* a live hint must never break the form */
        }
      };
      overlay.addEventListener("input", fire);
      overlay.addEventListener("change", fire);
      fire();
    }
  });
}

function showConfirmModal({
  title,
  body,
  okLabel = "OK",
  cancelLabel = "Cancel",
  tone = "primary",
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const okClass = tone === "danger" ? "danger" : "primary";
    overlay.innerHTML = html`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">
          <p class="modal-copy">${body}</p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">${cancelLabel}</button>
          <button class="btn ${okClass}" data-action="ok" type="button">${okLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const okBtn = overlay.querySelector('[data-action="ok"]');
    cancelBtn.focus();
    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const close = (value) => {
      cleanup();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      } else if (event.key === "Enter" && document.activeElement === okBtn) {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("keydown", onKey);
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
  });
}

function isBuildReadOnly() {
  return !!(
    appState.sharedToken || (appState.build && appState.build.writable === false)
  );
}

let buildLoadSeq = 0;
async function editRepertoire(repertoireId, nodeId = null) {
  // Picking a repertoire is navigation; its loading skeleton defers URL sync.
  workspaceNavigationSeq += 1;
  if (!workspaceUrlReady) navigatedDuringBoot = true;
  // Switching repertoires replaces the local Build tree — flush pending moves of
  // the current one first so they aren't dropped. An optional `nodeId` opens the
  // builder at that position (Analyze's "Open in Build" deep link).
  // The Repertoire view opens NOW with a skeleton; the tree fills in when the
  // load lands (it used to sit on the previous page for seconds).
  const loadSeq = ++buildLoadSeq;
  setBuildLoading(true);
  try {
    await hardFlushBuild();
  } catch (error) {
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false);
    setStatusError(error.message);
    return;
  }
  if (loadSeq !== buildLoadSeq) return;
  appState.sharedToken = null;
  try {
    const payload = await api(
      `/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`
    );
    if (loadSeq !== buildLoadSeq) return;
    const target = nodeId && payload.nodes.some((n) => n.id === nodeId) ? nodeId : null;
    await hydrateBuild(payload, target || payload.selected_node_id);
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false, { restore: false });
    appState.trainingRepertoireId = payload.repertoire_id;
    // The rail remains usable during loading; a response must not pull the
    // user back after they have navigated to another page.
    syncWorkspaceUrl();
    updateBuildReadOnlyUi(payload);
  } catch (error) {
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false);
    setStatusError(error.message);
  }
}

// Repertoire loading state: switch to the view (without touching the URL —
// the caller syncs it once the tree is in) and show a skeleton in place of the
// previous tree. Turning it off restores whatever is actually loaded.
function setBuildLoading(on, { restore = true } = {}) {
  appState.buildLoading = on;
  const view = document.getElementById("view-build");
  if (view) {
    view.inert = on;
    view.classList.toggle("is-loading", on);
    view.setAttribute("aria-busy", String(on));
  }
  if (!on) {
    if (!restore) return;
    const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
    if (node && boards.build) {
      const info = localBoardInfo(node.fen);
      boards.build.setPosition({ fen: node.fen, legalMoves: info.legal_moves, lastMove: node.uci });
    }
    renderBuildRepHeader();
    renderBuilderTree();
    syncViewHeads();
    return;
  }
  if (boards.build) {
    boards.build.setPosition({ fen: boards.build.fen, legalMoves: [], lastMove: null });
  }
  if (appState.currentView !== "build") switchView("build", { fromUrl: true });
  const empty = document.getElementById("build-empty");
  if (empty) empty.hidden = true;
  const nameEl = document.getElementById("build-rep-name");
  if (nameEl) nameEl.innerHTML = html`<span class="skeleton-text">Loading repertoire…</span>`;
  const stats = document.getElementById("build-rep-stats");
  if (stats) stats.hidden = true;
  const meta = document.getElementById("build-tree-meta");
  if (meta) meta.innerHTML = "";
  const tree = document.getElementById("builder-tree");
  if (tree) {
    tree.innerHTML =
      html`<div class="tree-skeleton" role="status" aria-label="Loading repertoire">${[72, 56, 84, 48, 64, 40].map((w) => html`<span style="width:${w}%"></span>`)}</div>`;
  }
}

function updateBuildReadOnlyUi(payload) {
  if (appState.sharedToken) return;
  if (payload.writable === false) {
    renderReadOnlyBanner(payload);
    setStatus(`Viewing shared repertoire "${payload.name}" (read-only)`);
  } else {
    removeReadOnlyBanner();
    setStatus(`Editing ${payload.name}`);
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
  coverageView?.sync();
}

async function trainRepertoire(repertoireId, options = {}) {
  // Training reads the server's repertoire tree — make sure any pending Build edits
  // are persisted before we leave the builder.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  appState.trainingRepertoireId = repertoireId;
  switchView("train");
  await startTraining(options.targetNodeIds?.length ? "smart" : undefined, {
    ...options, repertoireId,
  });
}

let repertoireMenuOpener = null;
let repertoireMenuOpenerId = null;

function openRepertoireContextMenu(event, repertoireId, isActive) {
  event.preventDefault();
  const menu = document.getElementById("repertoire-context-menu");
  closeRepertoireContextMenu(false);
  repertoireMenuOpener = event.currentTarget || document.activeElement;
  repertoireMenuOpenerId = repertoireId;
  repertoireMenuOpener?.setAttribute("aria-expanded", "true");
  const safeId = repertoireId;
  const items = [
    ["train", "Start training"],
    ["edit", "Open in Repertoire"],
    ["rename", "Rename..."],
    ["share-link", "Share link..."],
    ["share-team", "Share with team..."],
    ["toggle-active", isActive ? "Disable" : "Enable"],
    ["delete", "Delete..."],
  ];
  menu.innerHTML = html`${items
    .map(
      ([action, label]) =>
        html`<button type="button" role="menuitem" tabindex="-1" data-action="${action}" data-repertoire-id="${safeId}">${label}</button>`
    )}`;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  // From the ⋯ button: drop down under it, right edges aligned, so the menu stays
  // over the row instead of running past the card. A right-click opens at the cursor.
  const opener = event.type === "contextmenu" ? null : event.currentTarget;
  const anchor = opener && opener.getBoundingClientRect ? opener.getBoundingClientRect() : null;
  const wantLeft = anchor ? anchor.right - rect.width : event.clientX;
  const wantTop = anchor ? anchor.bottom + 4 : event.clientY;
  const left = Math.max(8, Math.min(wantLeft, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(wantTop, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () =>
      handleRepertoireContextAction(button.dataset.action, button.dataset.repertoireId, isActive)
    );
  });
  const buttons = [...menu.querySelectorAll("button")];
  menu.onkeydown = (event) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      closeRepertoireContextMenu();
    }
  };
  buttons[0]?.focus();
}

function closeRepertoireContextMenu(restoreFocus = true) {
  const menu = document.getElementById("repertoire-context-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  repertoireMenuOpener?.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    // A list re-render replaces the ⋯ button: find its successor by repertoire id.
    const target = repertoireMenuOpener?.isConnected
      ? repertoireMenuOpener
      : repertoireMenuOpenerId
        ? [...document.querySelectorAll("[data-row-menu]")].find((el) => el.dataset.rowMenu === repertoireMenuOpenerId)
        : null;
    target?.focus();
  }
  repertoireMenuOpener = null;
  repertoireMenuOpenerId = null;
}

async function fetchRepertoireMeta(repertoireId) {
  try {
    const payload = await api("/api/repertoires");
    return payload.repertoires.find((r) => r.id === repertoireId) || null;
  } catch (_) {
    return null;
  }
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
      const result = await showInputModal({
        title: "Rename repertoire",
        okLabel: "Save",
        fields: [{ name: "name", label: "New name", default: meta?.name || "" }],
      });
      if (!result) return;
      const name = (result.name || "").trim();
      if (!name) {
        setStatus("Name is empty");
        return;
      }
      await postJson("/api/build/rename", { repertoire_id: repertoireId, name });
      await refreshDashboardRepertoires();
      setStatus(`Renamed to ${name}`);
      return;
    }
    if (action === "share-link") {
      const payload = await postJson("/api/repertoires/share-link", {
        repertoire_id: repertoireId,
      });
      const url = `${window.location.origin}${payload.url}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (_) {
        /* clipboard blocked — the modal below still shows the URL */
      }
      await showInputModal({
        title: copied ? "Share link copied!" : "Share link",
        okLabel: "Done",
        // Nothing to cancel: the link already exists.
        cancel: false,
        fields: [
          {
            name: "url",
            label: "View-only link",
            default: url,
          },
        ],
      });
      return;
    }
    if (action === "share-team") {
      await shareRepertoireWithTeam(repertoireId);
      return;
    }
    if (action === "toggle-active") {
      const verb = isActive ? "Disable" : "Enable";
      await postJson("/api/repertoires/set-active", {
        repertoire_id: repertoireId,
        active: !isActive,
      });
      invalidateBook(); // the active set defines Analyze's book
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
      invalidateBook();
      if (appState.build && String(appState.build.repertoire_id) === repKey) {
        // Drop any local-first sync state — flushing into a deleted rep is pointless
        // and a pending timer would fire against a now-null tree. This happens at
        // delete time (not commit time) so the doomed tree can't keep taking edits.
        clearTimeout(appState.buildFlushTimer);
        appState.buildFlushTimer = null;
        appState.buildPending = [];
        appState.buildPendingDeletes = [];
        appState.buildUndoDeletes = new Set();
        appState.buildUndoCommitByMove = new Map();
        appState.buildIdMap = {};
        appState.buildSyncState = "saved";
        appState.build = null;
        appState.buildNodeById = new Map();
        appState.buildCurrentNodeId = null;
        renderBuilderTree();
        renderBuildSync();
        document.getElementById("build-board-label").textContent = "No repertoire";
      }
      if (String(appState.trainingRepertoireId) === repKey) {
        appState.trainingRepertoireId = null;
      }
      await refreshDashboardRepertoires();
      showUndoToast({
        title: "Repertoire deleted",
        message: `"${meta?.name || "Repertoire"}" and every move in it will be removed.`,
        onUndo: () => {
          appState.pendingRepDeletes.delete(repKey);
          setStatus("Delete undone");
          refreshDashboardRepertoires();
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
              appState.pendingRepDeletes.delete(repKey);
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

// F-03: "Retry save" affordance for a finished-but-unsaved analysis.
function showAnalysisRetrySave(checkpoint, message) {
  appState.analysisRetryCheckpoint = checkpoint;
  const bar = document.getElementById("analysis-retry-save");
  if (!bar) return;
  const text = document.getElementById("analysis-retry-save-text");
  if (text) {
    const white = checkpoint.pgn?.match(/\[White "([^"\n]*)"\]/)?.[1];
    const black = checkpoint.pgn?.match(/\[Black "([^"\n]*)"\]/)?.[1];
    const game = white || black ? `${white || "?"} vs ${black || "?"}` : checkpoint.gameId;
    text.textContent = checkpoint.serverSaved
      ? `${game} · Analysis saved. Device cleanup failed, retry cleanup.`
      : `${game} · ${message || "Unsaved analysis"} · ${checkpoint.inMemoryOnly ? "Kept in this page only" : "Kept on this device"}`;
  }
  const button = document.getElementById("analysis-retry-save-btn");
  if (button) button.textContent = checkpoint.serverSaved ? "Retry cleanup" : "Retry save";
  bar.hidden = false;
}

function hideAnalysisRetrySave() {
  const bar = document.getElementById("analysis-retry-save");
  if (bar) bar.hidden = true;
}

async function refreshAnalyzeRecovery() {
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const seq = appState.analysisRecoverySeq = (appState.analysisRecoverySeq || 0) + 1;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration && seq === appState.analysisRecoverySeq;
  let checkpoint = appState.analysisUnsavedCheckpoint?.ownerId === owner ? appState.analysisUnsavedCheckpoint : await loadCheckpoint(null, owner);
  while (checkpoint && isCurrent()) {
    if (!checkpoint.serverSaved && !checkpoint.inMemoryOnly) {
      try {
        const status = await api(`/api/analyses/${encodeURIComponent(checkpoint.gameId)}/saves/${encodeURIComponent(checkpoint.requestId)}/status`);
        if (!isCurrent()) return;
        checkpoint.serverSaved = status.saved;
      } catch (error) {
        if (isCurrent()) showAnalysisRetrySave(checkpoint, `Save status unconfirmed: ${error.message}`);
        return;
      }
    }
    if (checkpoint.serverSaved) {
      if (!await clearCheckpoint(checkpoint.gameId, owner, checkpoint.requestId)) {
        if (isCurrent()) showAnalysisRetrySave(checkpoint);
        return;
      }
      if (!isCurrent()) return;
      checkpoint = await loadCheckpoint(null, owner);
    } else {
      showAnalysisRetrySave(checkpoint);
      return;
    }
  }
  if (isCurrent()) {
    appState.analysisRetryCheckpoint = null;
    hideAnalysisRetrySave();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Analyze (runs, move list, position coach) lives in controllers/analyze-session.js,
// loaded with the Analyze view. Once loaded the wrappers below call straight through;
// before that they wait for it.
let analyzeSession = null;
let analyzeSessionLoading = null;
function loadAnalyzeSession() {
  analyzeSessionLoading ||= import("./controllers/analyze-session.js").then((mod) => {
    analyzeSession = mod.createAnalyzeSession({
      accountService, activeViewName, analysisSelfSide, analysisStore, api, appState,
      boardAfterMove, boardInfo, boards, BROWSER_ENGINE_UNAVAILABLE, currentOwnerId,
      defaultRepertoireNameFromPgn, effectiveMaiaRating, effectiveStockfishDepth,
      engineLifecycleMark, engineWidget, ensureAnalyzeView, hideAnalysisRetrySave,
      importRepertoireFromPgnText, invalidateAnalysisSource, jobToast, loadPhaseCoach,
      maiaAnalysisEnabled, postJson, pref, preloadCoach, refreshAnalysisHistoryIfOpen,
      refreshAnalyzeRecovery, renderAnalysisTree, renderAnalysisTreeEmptyState, requireSignIn,
      sanLineFromUci, savedPvSan, setEngineBestArrow, setStatus, setStatusError,
      showAnalysisRetrySave, showConfirmModal, showInputModal, START_FEN, switchView,
      syncAnalysisEvalCard, syncPgnFromTree, syncViewHeads, syncWorkspaceUrl, updateBookline,
    });
    return analyzeSession;
  }).catch((error) => {
    analyzeSessionLoading = null;
    throw error;
  });
  return analyzeSessionLoading;
}
const viaAnalyzeSession = (name) => (...args) => (analyzeSession
  ? analyzeSession[name](...args)
  : loadAnalyzeSession().then((loaded) => loaded[name](...args)));
const analysisTreeNav = viaAnalyzeSession("analysisTreeNav");
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
const showAnalysisPly = viaAnalyzeSession("showAnalysisPly");

let analyzeModule = null;
let analyzeView = null;
let moveTreeModule = null;
let moveTreeRenderer = null;
// Resolved once init() fully finishes (including restoreWorkspaceLocation).
// The E2E hooks await this so a seeded view isn't switched away mid-boot.
let appReadyPromise = null;

function preloadAnalyzeView() {
  if (!analyzeModule) {
    analyzeModule = import("./views/analyze.js").catch((err) => {
      analyzeModule = null;
      throw err;
    });
  }
  loadAnalyzeSession().catch(() => {});
  return analyzeModule;
}

async function ensureAnalyzeView() {
  // The Analyze module comes with the view, so its handlers call straight through.
  const [mod] = await Promise.all([preloadAnalyzeView(), loadAnalyzeSession()]);
  if (!analyzeView) {
    analyzeView = mod.createAnalyzeView({
      appState,
      START_FEN,
      showAnalysisPly,
      selectAnalysisNode,
      revealAnalysisResults,
      onEvalChartRendered: () => syncAnalysisEvalCard(),
    });
  }
  return analyzeView;
}

function preloadMoveTreeRenderer() {
  if (!moveTreeModule) {
    moveTreeModule = import("./views/shared/movetree.js").catch((err) => {
      moveTreeModule = null;
      throw err;
    });
  }
  return moveTreeModule;
}

async function ensureMoveTreeRenderer() {
  const mod = await preloadMoveTreeRenderer();
  if (!moveTreeRenderer) {
    moveTreeRenderer = mod.createMoveTreeRenderer();
  }
  return moveTreeRenderer;
}

function analysisTreeHasContent(movesArg) {
  const moves = movesArg || (appState.analysis ? appState.analysis.moves : []);
  if (moves && moves.length) return true;
  return !!(appState.analysisVarNodes && appState.analysisVarNodes.size);
}

function renderAnalysisTreeEmptyState() {
  const container = document.getElementById("analysis-moves");
  if (!container) return;
  appState.analysisTree = null;
  container.innerHTML =
    html`<div class="empty-state">Play on the board, or analyze a PGN.</div>`;
}

function renderAnalysisTree(movesArg) {
  if (!analysisTreeHasContent(movesArg)) {
    renderAnalysisTreeEmptyState();
    return;
  }
  if (analyzeView) return analyzeView.renderAnalysisTree(movesArg);
  void ensureAnalyzeView()
    .then((view) => view.renderAnalysisTree(movesArg))
    .catch(() => {});
}

// ----- Analyze PGN ↔ move-list two-way sync ------------------------------------
// The PGN drawer and the move list are two views of one game. Typing legal moves
// into the PGN box rebuilds the move list (and drives the board); playing moves on
// the board (or stepping into variations) rewrites the PGN box. The two directions
// are event-driven and guarded against feedback loops:
//   • board / move-list → PGN  : syncPgnFromTree() — skipped while the textarea is
//     focused, so a user mid-edit is never clobbered.
//   • PGN box → board / list   : loadPgnIntoAnalyze() — fired (debounced) on the
//     textarea `input` event and called directly by every importer.
// A plain typed/pasted game carries no engine classifications, so its move list
// shows neutral dots and an empty eval chart until the user presses Analyze.
let analyzePgnInputTimer = null;
// True only while we programmatically rewrite #pgn-input from the tree, so the
// defensive guard below can tell our own writes from user edits. (Assigning
// `.value` does not fire `input`, so this is belt-and-suspenders.)
let analyzePgnWriting = false;

// Board / move-list → PGN box. Serialize the current Analyze tree (analyzed or
// typed mainline + explored variations) and write it back, preserving the header
// block. No-op while the textarea is focused (board moves happen with the board
// focused, so this only fires when it's safe).
async function syncPgnFromTree() {
  const input = document.getElementById("pgn-input");
  if (!input || document.activeElement === input) return;
  const analysis = appState.analysis;
  const seq = analysisRecallSeq;
  const original = input.value;
  const moves = analysis ? analysis.moves : [];
  const hasVars = appState.analysisVarNodes && appState.analysisVarNodes.size;
  if ((!moves || !moves.length) && !hasVars) return;
  const view = await ensureAnalyzeView();
  if (seq !== analysisRecallSeq || input.value !== original || document.activeElement === input) return;
  const next = view.serializeAnalysisPgn(input.value);
  if (!next) return;
  if (next !== input.value && document.activeElement !== input) {
    analyzePgnWriting = true;
    input.value = next;
    analyzePgnWriting = false;
  }
}

function bindEvalChart() {
  // Chart interaction (click / hover tooltip / keyboard) lives with the chart
  // renderer in views/analyze.js (bound on first render); app.js only keeps the
  // viewport resize hook that rescales the key-moment markers.
  // Only a mounted Analyze chart has markers to rescale — a resize on any other
  // page must not pull the Analyze chunk (and its CSS) in.
  window.addEventListener("resize", () => {
    if (analyzeView) analyzeView.rescaleEvalMarkers();
  });
}

// The repertoire editor lives in controllers/build-session.js, loaded with the Build view.
// Once loaded the wrappers below call straight through; before that they wait for it.
let buildSession = null;
let buildSessionLoading = null;
function loadBuildSession() {
  buildSessionLoading ||= import("./controllers/build-session.js").then((mod) => {
    buildSession = mod.createBuildSession({
      activeViewName, api, appState, boardAfterMove, boardInfo, boards,
      BROWSER_ENGINE_UNAVAILABLE, buildDockFolded, buildOpMatchesRepertoire,
      buildProvisionalNode, captureBuildContext, closeRepertoireContextMenu, currentOwnerId,
      deleteBuildNodeLocal, downloadText, effectiveMaiaRating, effectiveStockfishDepth,
      engineLifecycleMark, engineWidget, ensureBuildView, ensureExplorerClient, EXPLORER_EVAL_MAX_LINES, explorerDrawerOpen, explorerEvalEngine,
      handleRepertoireContextAction, hardFlushBuild, hasPendingBuildOpsFor, invalidateBook,
      isBuildReadOnly, jobToast, normalizeUci, openSettingsSection, optimisticBoardMove,
      postJson, preloadBuildGen, reapplyPendingBuildDeletes, reapplyPendingBuildNodes,
      refreshDashboardRepertoires, renderBuilderTree, renderBuildRepHeader, renderBuildSync,
      requireSignIn, resolveBuildId, sameFenPosition, scheduleBuildFlush, setBuildSync,
      setStatus, setStatusError, showInputModal, START_FEN, STOCKFISH_MAX_DEPTH,
      STOCKFISH_MIN_DEPTH, switchView, syncWorkspaceUrl,
    });
    return buildSession;
  }).catch((error) => {
    buildSessionLoading = null;
    throw error;
  });
  return buildSessionLoading;
}

let buildModule = null;
let buildView = null;

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
    buildView = mod.createBuildView({
      appState,
      boards,
      getMoveTreeRenderer: () => moveTreeRenderer,
      ensureMoveTreeRenderer,
      selectBuildNode,
      openNodeContextMenu,
      buildBranchContext,
      onTreeRendered: syncViewHeads,
    });
  }
  return buildView;
}

// The sidebar's repertoire identity line: which repertoire is open and for which
// colour. The ⋯ button next to it carries the repertoire-scoped actions.
function renderBuildRepHeader() {
  const nameEl = document.getElementById("build-rep-name");
  if (!nameEl) return;
  const empty = document.getElementById("build-empty");
  if (empty) empty.hidden = !!appState.build;
  if (!appState.build) {
    nameEl.textContent = "No repertoire open";
    return;
  }
  if (buildView) return buildView.renderBuildRepHeader();
  void ensureBuildView().then((view) => view.renderBuildRepHeader()).catch(() => {});
}

// Train sessions (smart queue, rehearsal, practice games, Feeling Lucky) live in
// controllers/train-session.js, loaded the first time Train is used. The wrappers
// below wait for it, so a click that lands before the chunk does is not lost.
let trainSessionLoading = null;
function loadTrainSession() {
  trainSessionLoading ||= import("./controllers/train-session.js").then((mod) => mod.createTrainSession({
    accountService, api, appState, BLITZ_SECONDS, blitzEnabled, boardAfterMove, boardInfo,
    boards, currentOwnerId, effectiveMaiaRating, ensureExplorerClient, ensureTrainView,
    flushTrainSync, hardFlushBuild, lichessAccounts, loadPgnIntoAnalyze,
    loadPhaseCoach, loadTrainResume, localDateString, maiaPhaseCoach, markTrainPositionDirty,
    openAuthModal, optimisticBoardMove, PLAY_COLOR_KEY, playSound, postJson, preloadTrainView,
    queueTrainAttempt, refreshAuthStatus, renderTrainStats, requireSignIn, setStatus,
    setStatusError, setTrainBanner, setTrainSyncState, sleep, START_FEN,
    switchView, syncViewHeads, syncWorkspaceUrl, updateTrainTurnBadge,
  })).catch((error) => {
    trainSessionLoading = null;
    throw error;
  });
  return trainSessionLoading;
}
const viaTrainSession = (name) => (...args) => loadTrainSession().then((train) => train[name](...args));
const clearBlitzTimer = viaTrainSession("clearBlitzTimer");
const loadTrainRepertoireOptions = viaTrainSession("loadTrainRepertoireOptions");
const onFeelingLucky = viaTrainSession("onFeelingLucky");
const openPlayInAnalyze = viaTrainSession("openPlayInAnalyze");
const persistPlayRepertoireIds = viaTrainSession("persistPlayRepertoireIds");
const renderPlayRepertoirePicker = viaTrainSession("renderPlayRepertoirePicker");
const resetTrainBoardIdle = viaTrainSession("resetTrainBoardIdle");
const resignPlaySession = viaTrainSession("resignPlaySession");
const selectedTrainRepertoireIds = viaTrainSession("selectedTrainRepertoireIds");
const setBlitzBarVisible = viaTrainSession("setBlitzBarVisible");
const setPlayPickerColor = viaTrainSession("setPlayPickerColor");
const skipTrainingLine = viaTrainSession("skipTrainingLine");
const startPlaySessionTracked = viaTrainSession("startPlaySessionTracked");
const startTraining = viaTrainSession("startTraining");
const submitTrainingMove = viaTrainSession("submitTrainingMove");
const syncTrainPickerVisibility = viaTrainSession("syncTrainPickerVisibility");
const takebackPlaySession = viaTrainSession("takebackPlaySession");
const trainHint = viaTrainSession("trainHint");

// ----- Opening explorer (Build sidebar) ---------------------------------------
// Real-game stats for the current Build position, fetched straight from Lichess's
// public CORS-open explorer — the PrepForge server never proxies a byte. The
// module is dynamically imported on first open so its code stays out of the boot
// bundle; the client inside it handles caching, request dedup, and 429 cooldown
// (see explorer.js). Here we only debounce navigation and skip work while closed.

let explorerModule = null;
let explorerClient = null;
let explorerLoading = null;
// One explorer client for Build and practice games, imported on first use.
function ensureExplorerClient() {
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
let explorerDb = "masters";

function explorerDrawerOpen() {
  const panel = document.getElementById("explorer-drawer");
  return !!(panel && !panel.hidden && !buildDockFolded() && activeViewName() === "build");
}

const BUILD_DOCK_TABS = ["explorer", "coverage"];
let buildDockTab = "explorer";

function buildDockFolded() {
  const dock = document.getElementById("build-inspector");
  return !!(dock && dock.classList.contains("is-folded"));
}

// ---- Live engine placement -------------------------------------------------
// The engine never floats over the board: it lives inside the panel that
// already answers "which move?" - Build's Explorer (pinned best line + an Eval
// column per candidate) and Analyze's Evaluation card (game graph + live lines).
const ENGINE_VIEW_SLOTS = { build: "explorer-engine-slot", analyze: "analysis-engine-slot" };
const ENGINE_VIEW_PREFS = { build: "engineBuild", analyze: "engineAnalyze" };
// Most Explorer rows the eval worker scores (the most-played ones). More lines
// means a shallower search per second, so the rest show a dash.
const EXPLORER_EVAL_MAX_LINES = 8;

function dockEngine(slotId) {
  const el = document.getElementById("engine-window");
  const slot = document.getElementById(slotId);
  if (!el || !slot || el.parentNode === slot) return;
  for (const prop of ["left", "top", "right", "width", "height"]) el.style.removeProperty(prop);
  el.classList.add("is-docked");
  slot.appendChild(el);
}

function engineWantedIn(view) {
  const key = ENGINE_VIEW_PREFS[view];
  return !!key && !!pref(key);
}

function syncEngineForView(view = activeViewName()) {
  const slot = ENGINE_VIEW_SLOTS[view];
  if (slot && engineWantedIn(view)) {
    dockEngine(slot);
    if (engineWidget.isOpen()) void engineWidget.onBoardChanged();
    else void engineWidget.openForCurrent();
  } else {
    void engineWidget.close();
  }
  syncEngineChrome();
  void explorerEvalEngine.sync();
}

function setEngineOn(view, on) {
  const key = ENGINE_VIEW_PREFS[view];
  if (!key) return;
  setPref(key, !!on);
  syncEngineForView(view);
}

function syncEngineChrome() {
  const buildOn = engineWantedIn("build");
  const analyzeOn = engineWantedIn("analyze");
  const toggle = document.getElementById("explorer-engine-toggle");
  if (toggle) {
    toggle.classList.toggle("is-on", buildOn);
    toggle.setAttribute("aria-checked", String(buildOn));
  }
  const analyzeBtn = document.getElementById("open-engine-widget");
  if (analyzeBtn) {
    analyzeBtn.classList.toggle("is-active", analyzeOn);
    analyzeBtn.setAttribute("aria-pressed", String(analyzeOn));
  }
  const rows = document.getElementById("explorer-rows");
  if (rows) rows.classList.toggle("has-eval", buildOn);
  explorerEvalEngine.repaint();
  syncAnalysisEvalCard();
}

// The Evaluation card shows when there is a game graph or the engine is on;
// the graph itself only once an analysis has plotted points (a loaded but not
// yet analyzed game has nothing to draw, so no empty grey box).
function syncAnalysisEvalCard() {
  const card = document.getElementById("analysis-eval-card");
  const graph = document.getElementById("analysis-eval-graph");
  const results = document.getElementById("analysis-results");
  const points = Array.isArray(appState.evalChartPoints) ? appState.evalChartPoints : [];
  const hasGraph = !!results && !results.hidden && points.length > 0;
  if (graph) graph.hidden = !hasGraph;
  card?.classList.toggle("is-engine", engineWantedIn("analyze"));
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
    if (buildSession) paintExplorerEvals(this.snapshot, engineWidget.isOpen() ? engineWidget.lastSnapshot : null);
  }
}
const explorerEvalEngine = new ExplorerEvalEngine();

// Explorer reports castling king-to-rook (e1h1); Stockfish king-two-squares.
const CASTLE_UCI = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" };
function normalizeUci(uci) {
  const key = String(uci || "").toLowerCase();
  return CASTLE_UCI[key] || key;
}

function sameFenPosition(a, b) {
  if (!a || !b) return false;
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

function setBuildInspector(tool) {
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
  const opening = document.getElementById("explorer-opening");
  const engineSwitch = document.getElementById("explorer-engine-switch");
  if (dbs) dbs.hidden = tab !== "explorer";
  if (opening) opening.hidden = tab !== "explorer";
  if (engineSwitch) engineSwitch.hidden = tab !== "explorer";
  for (const id of ["coverage-scope", "coverage-depth", "coverage-run"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = tab !== "coverage";
  }
  paintInspectorScope();
  if (tab === "explorer") refreshExplorerPanel();
  if (tab === "coverage") void ensureCoverageView().then((view) => { view.sync(); view.paint(); }).catch((error) => setStatusError(error.message));
  void explorerEvalEngine.sync();
}

function renderBuilderTreeEmptyState() {
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
  syncViewHeads();
}

function renderBuilderTree() {
  coverageView?.sync();
  if (!appState.build) {
    renderBuilderTreeEmptyState();
    return;
  }
  if (buildView) return buildView.renderBuilderTree();
  void ensureBuildView().then((view) => view.renderBuilderTree()).catch(() => {});
}

// ===== Local-first Build sync ================================================
// docs/local-first-sync-plan.md Phase 1. A played move mutates the local tree
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
function mintBuildTmpId() {
  return `tmp-${OUTBOX_TAB_ID}-${++appState.buildTmpCounter}`;
}

// True when the parent already has at least one enabled child — used to decide a
// provisional move's display-only `is_mainline` (first move wins). The server
// recomputes the authoritative value on reconcile.
function someEnabledChildOf(parentId) {
  if (!appState.build) return false;
  return appState.build.nodes.some((n) => n.parent_id === parentId && n.is_enabled);
}

// Resolve a possibly-stale `tmp-` id to its real id once a flush has reconciled
// the tree. Queued deletes are `{ id, repertoire_id }` entries (see
// queueBuildDelete) so they carry their target too; plain ids still work.
function resolveBuildId(ref) {
  const id = ref && typeof ref === "object" ? ref.id : ref;
  return (id && appState.buildIdMap[id]) || id;
}

// R-02: every queued op records WHICH repertoire it belongs to. A flush may
// only send ops for the repertoire it is flushing; anything else stays queued
// for its own tree, so restored work can never land in the wrong opening.
function buildOpMatchesRepertoire(entry, repertoireId) {
  return String(entry.repertoire_id) === String(repertoireId);
}

function queueBuildDelete(nodeId) {
  appState.buildPendingDeletes.push({
    id: nodeId,
    base_revision: appState.build?.revision,
    repertoire_id: appState.build ? appState.build.repertoire_id : null,
  });
}

function hasPendingBuildOpsFor(repertoireId) {
  return (
    appState.buildPending.some((m) => buildOpMatchesRepertoire(m, repertoireId)) ||
    appState.buildPendingDeletes.some((entry) => buildOpMatchesRepertoire(entry, repertoireId))
  );
}

// Build a provisional Build node matching the serializer shape (workspace_view.py
// opening_item_to_json) so it renders and is selectable exactly like a real one.
// Flags here are display-only; the server overwrites them on reconcile.
function buildProvisionalNode(parent, uci, after) {
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

// ----- Sync indicator (Google-Docs style chip by the Build board label) -------
function setBuildSync(state) {
  appState.buildSyncState = state;
  renderBuildSync();
}

function renderSyncChip(el, state, scope = "repertoire") {
  const v = syncChipVariant(state, scope);
  el.hidden = false;
  el.className = `build-sync ${v.cls}`;
  el.textContent = v.text;
  el.title = v.text;
}

function renderBuildSync() {
  const el = document.getElementById("build-sync");
  if (!el) return;
  // Nothing to show without an editable repertoire (read-only shared view = no
  // local edits ever happen).
  if (!appState.build || isBuildReadOnly()) {
    el.hidden = true;
    return;
  }
  renderSyncChip(el, appState.buildSyncState);
}

let trainModule = null;
let trainView = null;

function preloadTrainView() {
  if (!trainModule) {
    trainModule = import("./views/train.js").catch((err) => {
      trainModule = null;
      throw err;
    });
  }
  return trainModule;
}

async function ensureTrainView() {
  const mod = await preloadTrainView();
  if (!trainView) {
    trainView = mod.createTrainView({
      appState,
      boards,
      renderSyncChip,
      setTrainBanner,
      updateTrainTurnBadge,
      onStreakRendered: (streak) => {
        const s = appState.trainStats;
        if (s) s.lastStreak = streak;
      },
    });
  }
  return trainView;
}

// Train's counterpart chip (same look/classes): visible during a smart session
// or while abandoned-session attempts still wait to land.
function setTrainSyncState(state) {
  appState.trainSyncState = state;
  void renderTrainSync().catch(() => {});
}

async function renderTrainSync() {
  const el = document.getElementById("train-sync");
  if (!el) return;
  const sync = appState.trainSync;
  if (!appState.smart && !sync.pending.length && !sync.dirty) {
    el.hidden = true;
    return;
  }
  return (await ensureTrainView()).renderTrainSync();
}

async function renderTrainStats() {
  return (await ensureTrainView()).renderTrainStats();
}

// Re-insert still-pending provisional nodes onto the freshly hydrated tree (which
// dropped them when it rebuilt buildNodeById from the server payload). Insertion
// order preserves parent-before-child, so a tmp parent re-inserted earlier in the
// loop is already present for its child.
function reapplyPendingBuildNodes(pending, idMap) {
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
function pruneLocalBuildSubtree(rootId) {
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
function reapplyPendingBuildDeletes() {
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
      selectBuildNode(parentId);
    }
  }
  if (pruned) renderBuilderTree();
}

// Local-first delete (no confirmation by design — pruning lines is a routine
// Build edit, and the flush model makes it cheap): drop the subtree from the
// client tree immediately, cancel any pending adds inside it, and queue the
// subtree root for the debounced delete flush. A node that never reached the
// server (its add is still pending) is cancelled outright — no server op at all.
async function deleteBuildNodeLocal(nodeId) {
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
    await selectBuildNode(parentId);
  } else {
    renderBuilderTree();
  }
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
        setBuildSync("dirty");
        scheduleBuildFlush();
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
        await selectBuildNode(prevSelection);
      } else {
        renderBuilderTree();
      }
      if (parkedAdds.length) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      }
      setStatus(`Restored ${node.san || "move"}`);
    },
  });
  appState.buildUndoCommitByMove.set(undoMoveKey, undoCommit);
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
  appState.analysisFileSeq = sourceSeq;
  const isCurrent = () => appState.analysisFileSeq === sourceSeq && ownerId === currentOwnerId();
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
  const repertoireId = appState.build?.repertoire_id;
  const seq = buildLoadSeq;
  const owner = currentOwnerId();
  return () => repertoireId === appState.build?.repertoire_id && seq === buildLoadSeq && owner === currentOwnerId();
}

// The player's calendar day in their own timezone (not UTC) — the server keys
// the daily training streak off this so a late-evening session counts for the
// day the player actually lived it.
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A server timestamp (UTC ISO) as the player's local calendar day. Timestamps
// without an offset are UTC too.
function localDayOf(iso) {
  const raw = String(iso || "");
  if (!raw.includes("T")) return raw.slice(0, 10); // already a calendar day
  const stamp = /[zZ]$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? raw.slice(0, 10) : localDateString(d);
}

function setTrainBanner(state, title, sub) {
  const banner = document.getElementById("train-banner");
  if (!banner) return;
  banner.dataset.state = state;
  const titleEl = document.getElementById("train-banner-title");
  const subEl = document.getElementById("train-banner-sub");
  titleEl.textContent = title;
  titleEl.title = title || "";
  subEl.textContent = sub || "";
  subEl.title = sub || "";
  if (state === "correct" || state === "wrong") {
    banner.classList.remove("flash");
    void banner.offsetWidth;
    banner.classList.add("flash");
  }
}

const PLAY_COLOR_KEY = "prepforge.play_color";

function updateTrainTurnBadge(side) {
  const badge = document.getElementById("train-turn-badge");
  if (!badge) return;
  if (!side) {
    badge.hidden = true;
    badge.innerHTML = "";
    badge.title = "";
    delete badge.dataset.side;
    return;
  }
  badge.hidden = false;
  badge.dataset.side = side;
  badge.title = side === "white" ? "White to move" : "Black to move";
  // Show the side-to-move as a real piece (king of that colour), not a bare
  // letter. Pieces are inline SVG (see pieceSvg) — there is no PNG asset.
  badge.innerHTML = pieceSvg(side === "white" ? "K" : "k");
}

// ===== Smart queue trainer (Train v2) ========================================
//
// Card-based scheduler client over /api/train/smart/*. The flow per card:
// run-in animation (the approach plays itself, the opponent's last move is the
// recall cue) → prompt. New cards are taught first (arrow + idea, play it
// once); everything else is tested cold. Failure is two-stage: first miss
// auto-hints and lets the player retry (attempt 2, ungraded server-side),
// second miss reveals the answer and the card returns a few positions later.
// Only attempt 1 is graded, so the accuracy chips match the server's
// spaced-repetition writes.

// ----- Blitz mode: an answer clock per card (smart queue only) ---------------
//
// Entirely client-side. A timeout submits the null move "0000" as attempt 1, so
// the server grades an honest first-attempt miss — in blitz, not producing the
// move in time means it isn't known cold. Teach prompts (kind=new) and retries
// are untimed; the toggle is read once at session start.

const BLITZ_KEY = "prepforge-blitz";
const BLITZ_SECONDS = 10;

function blitzEnabled() {
  try {
    return localStorage.getItem(BLITZ_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function setBlitzEnabled(on) {
  try {
    if (on) localStorage.setItem(BLITZ_KEY, "1");
    else localStorage.removeItem(BLITZ_KEY);
  } catch (_) { /* private mode: the toggle just won't persist */ }
}

// ----- Settings tab — lazy view chunk -----------------------------------------
let settingsModulePromise = null;
let settingsView = null;

function preloadSettingsView() {
  if (!settingsModulePromise) {
    settingsModulePromise = import("./views/settings.js").catch((err) => {
      settingsModulePromise = null;
      throw err;
    });
  }
  return settingsModulePromise;
}

async function ensureSettingsView() {
  const mod = await preloadSettingsView();
  if (!settingsView) {
    settingsView = mod.createSettingsView({
      appState,
      setStatus,
      saveSettings,
      loadSettings,
      pref,
      setPref,
      effectiveMaiaRating,
      getSharedMaia3Provider,
      disposeSharedMaia3Provider,
      showConfirmModal,
      startFen: START_FEN,
      api,
      postJson,
      startLichessOAuth,
      onAccountsChanged: () => {
        void refreshLichessStatus();
      },
      signOut: () => accountController.signOut(),
      openAuthModal: (mode, options) => accountController.openAuthModal(mode, options),
      refreshAuthStatus: () => accountController.refreshAuthStatus(),
    });
    settingsView.bind();
  }
  return settingsView;
}

// Every in-flight loadSettings() (a tab click can start two). whenSettingsReady()
// waits until none remain, i.e. the Settings view is bound and fully rendered.
const settingsLoads = new Set();

function loadSettings() {
  const load = loadSettingsOnce().finally(() => settingsLoads.delete(load));
  settingsLoads.add(load);
  return load;
}

async function whenSettingsReady() {
  const view = await ensureSettingsView();
  while (settingsLoads.size) await Promise.allSettled([...settingsLoads]);
  return view;
}

// Open Settings through its tab (same path as a rail click) and jump to a
// section once the view is ready — no fixed delay.
async function openSettingsSection(sectionId) {
  const tab = document.querySelector('.tab[data-view="settings"]');
  if (tab) tab.click();
  else switchView("settings");
  await whenSettingsReady();
  const link = document.querySelector(`.settings-nav-link[href="#${sectionId}"]`);
  if (link) {
    link.click();
    return;
  }
  // A block inside a card (Chess accounts lives in Account): mark the card's
  // nav link, then bring the block itself into view.
  const target = document.getElementById(sectionId);
  const card = target?.closest(".card[id]");
  if (card) document.querySelector(`.settings-nav-link[href="#${card.id}"]`)?.click();
  target?.scrollIntoView({ block: "start" });
}

let settingsActionsPromise = null;
function loadSettingsActions() {
  settingsActionsPromise ||= import("./settings-actions.js").then(({ createSettingsActions }) => createSettingsActions({
    appState, currentOwnerId, ensureSettingsView, api, applySettingsPayload,
    applyServerEngineGating, setStatusError, getPositionCoach: () => analyzeSession?.positionCoach, engineWidget,
    activeViewName, explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel,
  })).catch((error) => { settingsActionsPromise = null; throw error; });
  return settingsActionsPromise;
}

async function loadSettingsOnce() {
  return (await loadSettingsActions()).loadSettingsOnce();
}

// Fold a /api/settings payload into state: the blob itself, the server-engine flag,
// and the pinned Maia rating (null = AUTO). Shared by init, loadSettings and saves.
function applySettingsPayload(payload) {
  appState.settings = payload;
  appState.maiaRatingPinned = Number.isFinite(payload.maia_rating) ? payload.maia_rating : null;
  settingsView?.renderStrengthControls();
}

// Persist a partial settings patch ({stockfish_depth} / {maia_rating}) and re-render.
async function saveSettings(patch) {
  return (await loadSettingsActions()).saveSettings(patch);
}

// Apply one button's gated state: disable + greyed style + explanatory title,
// or restore its original title when enabled.
function setButtonGated(button, gated, message) {
  if (!button) return;
  button.disabled = gated;
  button.classList.toggle("is-coming-soon", gated);
  if (gated) {
    if (!button.dataset.enabledTitle) {
      button.dataset.enabledTitle = button.getAttribute("title") || "";
    }
    button.setAttribute("title", message);
    button.setAttribute("aria-disabled", "true");
  } else {
    button.removeAttribute("aria-disabled");
    if (button.dataset.enabledTitle) {
      button.setAttribute("title", button.dataset.enabledTitle);
    } else {
      button.removeAttribute("title");
    }
  }
}

// Gate compute actions by where the compute can actually run. BOTH whole-game
// Analyze (Phase 2) and Build → Generate (Phase 3c) now run in the BROWSER, so
// each is gated only on the browser engine being available (cross-origin
// isolated) — independent of the server engine, with no server fallback.
function applyServerEngineGating() {
  const gated = !isBrowserEngineAvailable();
  setButtonGated(
    document.getElementById("run-analysis"),
    gated,
    BROWSER_ENGINE_UNAVAILABLE,
  );
  setButtonGated(
    document.getElementById("build-generate-node"),
    gated,
    BROWSER_ENGINE_UNAVAILABLE,
  );
  paintEngineBanners();
}

// NOTE: server-side engine install (Stockfish/Maia3) and the first-run install
// prompt were removed — the public flow runs Stockfish in the browser and never
// installs or runs an engine on the server. Server install endpoints remain in
// server.py for a future admin mode (gated by PREPFORGE_SERVER_ENGINE_ENABLED).

async function runLichessCompare() {
  // Games are checked against your repertoires (owner-scoped /api/lichess/compare).
  if (!requireSignIn("Sign in to check your games against your repertoire", "games-check")) return;
  const selection = gamesSourceSelection();
  const token = appState.replayCheckToken = (appState.replayCheckToken || 0) + 1;
  const owner = appState.accountUserId;
  const sourceKey = JSON.stringify(selection);
  const isCurrent = () => appState.replayCheckToken === token && appState.signedIn
    && appState.accountUserId === owner && JSON.stringify(gamesSourceSelection()) === sourceKey;
  const usernames = resolveFetchUsernames({
    selection,
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
  if (!usernames.length) {
    setStatus("No Games sources selected — open Add and pick one.");
    return;
  }
  const linkedIds = gamesSourceAccountIds();
  const hasExternal = normalizeSelection(selection).external.length > 0;
  const countInput = document.getElementById("replay-count");
  const count = Math.max(1, Math.min(MAX_FETCH, Number(countInput.value) || 10));
  const button = document.getElementById("lichess-compare-btn");
  button.disabled = true;
  setStatus("Fetching games from Lichess");
  try {
    const payload = await postJson("/api/lichess/compare", {
      count,
      // linkedIds is null only for the full-Self default (omit → all linked
      // accounts). Any explicit pick — including [] for external-only — is
      // sent as-is so the server never widens the selection back to Self.
      ...(linkedIds !== null ? { account_ids: linkedIds } : {}),
      ...(hasExternal ? { usernames } : {}),
    });
    if (!isCurrent()) return;
    payload.requested_sources = usernames.length;
    appState.replayResults = payload;
    appState.replayFilter = null;
    appState.replayOpen = new Set();
    await renderReplayResults(payload, isCurrent);
    if (!isCurrent()) return;
    const queued = Number(payload.misses_recorded) || 0;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const sourceLabel =
      sources.length > 1
        ? `self (${sources.length} accounts)`
        : payload.username === "self"
          ? "self"
          : payload.username;
    setStatus(
      queued > 0
        ? `Fetched ${payload.count} games · ${queued} forgotten move${queued === 1 ? "" : "s"} added to training`
        : `Fetched ${countOf(payload.count, "game")} for ${sourceLabel}`
    );
  } catch (error) {
    if (isCurrent()) setStatusError(error.message);
  } finally {
    if (appState.replayCheckToken === token) button.disabled = false;
  }
}

// Games source selection — shared explicit model with Scout:
// { linkedMode: "all" | "subset" | "none", accountIds, external }.
// "all" = Self (every linked identity, the default); "subset" = exactly the
// listed linked ids; "none" = no linked accounts. External Lichess usernames
// ride alongside on both pages (Games fetches them too). Persisted per
// browser as one explicit selection object.
function readSourceStore(key) {
  try {
    return normalizeSelection(JSON.parse(localStorage.getItem(key)));
  } catch (_) {
    return normalizeSelection(null);
  }
}

function writeSourceStore(key, selection) {
  try {
    localStorage.setItem(key, JSON.stringify(normalizeSelection(selection)));
  } catch (_) { /* storage unavailable */ }
}

const GAMES_SOURCE_KEY = "prepforge.games_source";


function gamesSourceSelection() {
  return readSourceStore(GAMES_SOURCE_KEY);
}

function writeGamesSelection(selection) {
  writeSourceStore(GAMES_SOURCE_KEY, selection);
}


function gamesSourceAccountIds() {
  const sel = gamesSourceSelection();
  if (sel.linkedMode === "none") return [];
  if (sel.linkedMode === "all") return null;
  const valid = sel.accountIds.filter((id) =>
    lichessAccounts().some((a) => a.id === id)
  );
  return valid.length ? valid : [];
}

function openGamesComposer(anchor) {
  const composer = openSourceComposer({
    anchor,
    selection: gamesSourceSelection(),
    linkedAccounts: lichessAccounts(),
    allowExternal: true,
    title: "Games sources",
    externalPlaceholder: "Add Lichess username…",
    onChange: (sel) => {
      writeGamesSelection(sel);
      paintGamesSource();
    },
    onClose: () => paintGamesSource(),
  });
  return composer;
}

function paintGamesSource() {
  const tray = document.getElementById("games-source-chips");
  if (!tray) return;
  // Signed out there is no "Self" (no linked accounts) and Check needs an
  // account anyway: a selected-looking "Self · all linked" chip contradicted
  // the "No Games sources selected" error. Offer the sign-in instead.
  if (!appState.signedIn) {
    tray.hidden = false;
    tray.innerHTML =
      html`<button type="button" class="src-chip src-chip-signin" data-games-signin>Sign in to use your games</button>`;
    return;
  }
  const selection = gamesSourceSelection();
  const { chips, selfState } = selectionChips(selection, lichessAccounts());
  const n = lichessAccounts().length;
  const label = n > 0 ? `Self · ${n}` : "Self · all linked";
  const visible = chips.length ? chips : [{ kind: "self", label }];
  tray.hidden = false;
  // Signed in with nothing linked and no usernames added: "Self · all linked"
  // named an empty set and Check stayed disabled without saying why.
  if (n === 0 && !selection.external.length && selection.linkedMode === "all") {
    tray.innerHTML =
      html`<button type="button" class="src-chip src-chip-signin" data-games-link>Link Lichess to use your games</button>`;
    return;
  }
  tray.innerHTML = html`${visible
    .map((c) =>
      c.kind === "self"
        ? html`<span class="src-chip is-self" data-games-chip-self>${label}</span>`
        : c.kind === "external"
          ? html`<span class="src-chip" data-games-chip="${c.id}">${c.label}<button type="button" class="src-chip-x" data-games-unpick-external="${c.id}" aria-label="Remove ${c.label} from Games sources">×</button></span>`
          : html`<span class="src-chip" data-games-chip="${c.id}">${c.label}${c.primary ? html` <span class="conn-primary">Primary</span>` : ""}<button type="button" class="src-chip-x" data-games-unpick="${c.id}" aria-label="Remove ${c.label} from Games sources">×</button></span>`
    )}`;
  if ((selfState === "none" || (!chips.length && selection.linkedMode !== "all")) && !selection.external.length) {
    tray.innerHTML =
      html`<span class="src-empty">No sources — open Add and pick one</span>`;
    return;
  }
}

function bindGamesSource() {
  document.getElementById("games-source-add")?.addEventListener("click", (event) => {
    // Sources only matter for a Check, which needs an account — don't let a
    // guest collect usernames that would silently ride into their account.
    if (!requireSignIn("Sign in to check your games against your repertoire", "games-check")) return;
    openGamesComposer(event?.currentTarget || document.getElementById("games-source-add"));
  });
  document.getElementById("games-source-chips")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-games-signin]")) {
      requireSignIn("Sign in to check your games against your repertoire", "games-check");
      return;
    }
    if (event.target.closest("[data-games-link]")) {
      openSettingsSection("set-connections").catch(() => {});
      return;
    }
    const removeExt = event.target.closest("[data-games-unpick-external]");
    if (removeExt) {
      const sel = gamesSourceSelection();
      writeGamesSelection({
        linkedMode: sel.linkedMode,
        accountIds: sel.accountIds,
        external: sel.external.filter((n) => n !== removeExt.dataset.gamesUnpickExternal),
      });
      paintGamesSource();
      return;
    }
    const remove = event.target.closest("[data-games-unpick]");
    if (!remove) return;
    const sel = gamesSourceSelection();
    const current =
      sel.linkedMode === "all" ? lichessAccounts().map((a) => a.id) : sel.accountIds;
    const rest = current.filter((id) => id !== remove.dataset.gamesUnpick);
    if (!rest.length && sel.linkedMode === "all") {
      writeGamesSelection({ linkedMode: "none", accountIds: [], external: sel.external });
    } else {
      writeGamesSelection({ linkedMode: "subset", accountIds: rest, external: sel.external });
    }
    paintGamesSource();
  });
  paintGamesSource();
}

// Scout source: the SAME shared Source Composer model as Games —
// { linkedMode, accountIds, external } with the shared persistence bridge.
// "all" = Self (every linked identity); "subset" = exactly the listed linked
// ids; "none" = no linked accounts. External Lichess usernames ride alongside
// on both pages. Page difference lives only in the analysis workflow after
// picking, never in the picker.
const SCOUT_SOURCE_KEY = "prepforge.scout_source";

function scoutSelection() {
  return readSourceStore(SCOUT_SOURCE_KEY);
}

function writeScoutSelection(selection) {
  const before = scoutPickedUsernames();
  writeSourceStore(SCOUT_SOURCE_KEY, selection);
  // A report scouted from other accounts would sit under chips that no longer
  // describe it; drop it so the next Start reflects the picked sources.
  if (scoutView && !sameFetchSources(before, scoutPickedUsernames())) scoutView.discardReport();
}

function openScoutComposer(anchor) {
  return openSourceComposer({
    anchor,
    selection: scoutSelection(),
    linkedAccounts: lichessAccounts(),
    allowExternal: true,
    title: "Scout sources",
    externalPlaceholder: "Add Lichess username…",
    onChange: (sel) => {
      writeScoutSelection(sel);
      paintScoutSource();
    },
    onClose: () => paintScoutSource(),
  });
}

function scoutPickedUsernames() {
  return resolveFetchUsernames({
    selection: scoutSelection(),
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
}

function paintScoutSource() {
  const tray = document.getElementById("scout-source-chips");
  if (!tray) return;
  const selection = scoutSelection();
  const { chips, selfState } = selectionChips(selection, lichessAccounts());
  const linked = lichessAccounts();
  const visible = chips.length
    ? chips
    : linked.length && selfState === "all"
      ? [{ kind: "self", label: `Self · ${linked.length}`, count: linked.length }]
      : [];
  tray.hidden = false;
  tray.innerHTML = visible.length
    ? html`${visible
        .map((c) =>
          c.kind === "external"
            ? html`<span class="src-chip" data-scout-chip="${c.id}">${c.label}<button type="button" class="src-chip-x" data-scout-unpick-external="${c.id}" aria-label="Remove ${c.label} from Scout sources">×</button></span>`
            : c.kind === "self"
              ? html`<span class="src-chip is-self" data-scout-chip-self>Self · ${c.count}</span>`
              : html`<span class="src-chip" data-scout-chip="${c.id}">${c.label}${c.primary ? html` <span class="conn-primary">Primary</span>` : ""}<button type="button" class="src-chip-x" data-scout-unpick="${c.id}" aria-label="Remove ${c.label} from Scout sources">×</button></span>`
        )}`
    : html`<span class="src-empty">No sources — open Add and pick one</span>`;
  // The empty state names the next step for where the user actually is.
  const hint = document.getElementById("scout-empty-hint");
  if (hint) {
    hint.textContent = !appState.signedIn
      ? "Sign in, add a Lichess username, then Start."
      : visible.length
        ? "Press Start."
        : linked.length
          ? "Add a Lichess username or pick Self, then Start."
          : "Add a Lichess username as a source, then Start.";
  }
}

function bindScoutSource() {
  document.getElementById("scout-source-add")?.addEventListener("click", (event) => {
    if (!requireSignIn("Sign in to scout an opponent", "scout-start")) return;
    openScoutComposer(event?.currentTarget || document.getElementById("scout-source-add"));
  });
  document.getElementById("scout-source-chips")?.addEventListener("click", (event) => {
    const unpickExt = event.target.closest("[data-scout-unpick-external]");
    if (unpickExt) {
      const sel = scoutSelection();
      writeScoutSelection({
        linkedMode: sel.linkedMode,
        accountIds: sel.accountIds,
        external: sel.external.filter((n) => n !== unpickExt.dataset.scoutUnpickExternal),
      });
      paintScoutSource();
      return;
    }
    const unpick = event.target.closest("[data-scout-unpick]");
    if (!unpick) return;
    const sel = scoutSelection();
    const current =
      sel.linkedMode === "all" ? lichessAccounts().map((a) => a.id) : sel.accountIds;
    const rest = current.filter((id) => id !== unpick.dataset.scoutUnpick);
    if (!rest.length && sel.linkedMode === "all") {
      writeScoutSelection({ linkedMode: "none", accountIds: [], external: sel.external });
    } else {
      writeScoutSelection({ linkedMode: "subset", accountIds: rest, external: sel.external });
    }
    paintScoutSource();
  });
  paintScoutSource();
}

let replayModule = null;
let replayView = null;

function preloadReplayView() {
  if (!replayModule) {
    replayModule = import("./views/replay.js").catch((err) => {
      replayModule = null;
      throw err;
    });
  }
  return replayModule;
}

async function ensureReplayView() {
  const mod = await preloadReplayView();
  if (!replayView) {
    replayView = mod.createReplayView({
      onError: setStatusError,
      // Focus-board renderers: the production FEN decoder + active piece-SVG
      // set, shared with the Library preview (piece style follows Settings).
      boardRenderers: { parseFenBoard, pieceSvg },
      getReplayFilter: () => appState.replayFilter,
      isGameOpen: (index) => appState.replayOpen.has(index),
      onToggleFilter: (kind) => {
        appState.replayFilter = appState.replayFilter === kind ? null : kind;
        appState.replayOpen.clear();
        saveReturnState("replay", { filter: appState.replayFilter, openIndex: null });
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onToggleGame: (index) => {
        appState.replayOpen = new Set([index]);
        saveReturnState("replay", { filter: appState.replayFilter, openIndex: index });
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onTrainMiss: async (game, focus) => {
        const task = rememberHandoff(gameHandoff(game, focus, "practice-missed-move"));
        if (task.persisted === false) setStatus("Task kept in this tab only; browser storage is unavailable", { severity: "warning" });
        if (!game.expected_node_id || !game.repertoire_id) throw new Error("Prepared move unavailable; reopen the repertoire");
        await trainRepertoire(game.repertoire_id, { targetNodeIds: [game.expected_node_id], fresh: true });
      },
      onBuildReply: async (game, focus) => {
        rememberHandoff(gameHandoff(game, focus, "build-reply"));
        const owner = currentOwnerId(), generation = appState.ownerGeneration;
        const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
        const mod = await import("./controllers/replay-actions.js");
        if (!isCurrent()) return;
        await mod.buildReply(game, { editRepertoire,
          getNode: () => appState.buildNodeById.get(appState.buildCurrentNodeId),
          isBuildReadOnly, localBoardInfo, onBuildBoardMove, isCurrent });
      },
      onAnalyze: (game, focus) => {
        rememberHandoff(gameHandoff(game, focus, "review-in-analyze"));
        return replayToAnalyze(game);
      },
    });
  }
  return replayView;
}

async function renderReplayResults(payload, isCurrent = () => true) {
  const view = await ensureReplayView();
  if (isCurrent()) return view.renderReplayResults(payload);
}

// F-06: the Games→Train/Analyze handoff record — source game, the decision
// ply + anchor FEN (the position where the user left prep), the user's side and
// the matched repertoire. Identity covers the whole tuple, so white/black,
// transpositions and different root FENs never interleave.
function gameHandoff(game, focus, reason) {
  return {
    source: "games",
    sourceView: "replay",
    reason,
    gameId: game.lichess_id || null,
    lineUcis: [game.expected_move_uci].filter(Boolean),
    ply: Number(game.departure_ply) || null,
    anchorFen: (focus && focus.fen) || null,
    side: game.user_color === "black" ? "black" : "white",
    repertoireId: game.repertoire_id ?? null,
    targetNodeIds: [game.expected_node_id].filter(Boolean),
  };
}

// "Review in Analyze": rebuild the game's PGN from the fetched move list and
// hand it to the Analyze tab — same flow as "My last game" (press Analyze for
// the full engine review; the book banner tracks your prep as you step through).
async function replayToAnalyze(game) {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
  const mod = await import("./controllers/replay-actions.js");
  if (!isCurrent()) return;
  return mod.replayToAnalyze(game, { switchView, orientAnalysisForSelf,
    loadPgnIntoAnalyze, showAnalysisPly, takeHandoff, setStatus, isCurrent });
}

// ----- Shared repertoire viewer (read-only Build) -------------------------------
// A share URL (/?shared=<token>) opens the Build view as a guest-readable,
// mutation-free viewer of someone else's repertoire. "Copy to my account" forks
// it server-side; signing in reloads the page with the token still in the URL,
// so the viewer (and the Copy button) come right back.

async function maybeOpenSharedView() {
  let token = null;
  try {
    token = new URLSearchParams(window.location.search).get("shared");
  } catch (_) {
    return false;
  }
  if (!token) return false;
  try {
    setStatus("Loading shared repertoire");
    const payload = await api(`/api/shared/${encodeURIComponent(token)}`);
    appState.sharedToken = token;
    await hydrateBuild(payload, payload.selected_node_id);
    renderSharedBanner(payload);
    switchView("build");
    syncCoverageReadOnlyState();
    setStatus(`Viewing shared repertoire "${payload.name}" (read-only)`);
    return true;
  } catch (error) {
    setStatus(`Share link problem: ${error.message}`, { severity: "error" });
    return false;
  }
}

// A join URL (/?join=<code>) redeems a team invite. Mirrors the shared viewer:
// signed-out visitors are nudged to sign in (the ?join= survives the reload), then
// we preview the team and let them confirm before joining. Idempotent server-side.
async function maybeHandleJoinLink() {
  let code = null;
  try {
    code = new URLSearchParams(window.location.search).get("join");
  } catch (_) {
    return false;
  }
  if (!code) return false;
  if (!appState.signedIn) {
    openAuthModal("login", { notice: "Sign in (or create an account) to join the team" });
    return false; // ?join= stays in the URL; we resume after the sign-in reload
  }
  let preview;
  try {
    preview = await api(`/api/teams/join/${encodeURIComponent(code)}`);
  } catch (error) {
    setStatus(`Invite link problem: ${error.message}`, { severity: "error" });
    clearJoinParam();
    return false;
  }
  const members = `${preview.member_count} member${preview.member_count === 1 ? "" : "s"}`;
  const confirmed = await showConfirmModal({
    title: preview.already_member ? `Open ${preview.name}?` : `Join ${preview.name}?`,
    body: preview.already_member
      ? "You're already a member of this team."
      : `Join "${preview.name}" (${members})? You'll get read-only access to repertoires shared with the team.`,
    okLabel: preview.already_member ? "Open" : "Join",
    cancelLabel: "Cancel",
  });
  clearJoinParam();
  if (!confirmed) return false;
  let result;
  try {
    result = await postJson(`/api/teams/join/${encodeURIComponent(code)}`, {});
  } catch (error) {
    setStatus(`Couldn't join: ${error.message}`, { severity: "error" });
    return false;
  }
  const team = result.team;
  setStatus(result.joined ? `Joined ${team.name}` : `You're already in ${team.name}`);
  appState.selectedTeamId = team.id;
  switchView("teams");
  await loadTeams();
  return true;
}

function clearJoinParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url.pathname + url.search);
  } catch (_) {
    /* cosmetic */
  }
}

// The shared/read-only banner is a static host in the Opus panel (index.html).
// Both states only change its text and visibility — no element is created,
// prepended, or re-rendered here, so the shared state renders in exactly the
// same panel composition as the writable one.
function renderReadOnlyBanner(payload) {
  const banner = document.getElementById("shared-banner");
  if (!banner) return;
  const title = document.getElementById("shared-banner-title");
  if (title) title.textContent = `Read-only · ${payload.name} · shared with you`;
  banner.hidden = false;
  syncViewHeads();
}

function renderSharedBanner(payload) {
  renderReadOnlyBanner(payload);
}

async function forkReadableRepertoire() {
  const viaToken = !!appState.sharedToken;
  const viaTeam = appState.build && appState.build.writable === false;
  if (!viaToken && !viaTeam) return;
  if (!requireSignIn("Sign in (or create an account) to copy this repertoire")) return;
  try {
    const result = viaToken
      ? await postJson(
          `/api/shared/${encodeURIComponent(appState.sharedToken)}/fork`,
          {},
        )
      : await postJson("/api/repertoires/fork", {
          repertoire_id: appState.build.repertoire_id,
        });
    appState.sharedToken = null;
    removeReadOnlyBanner();
    if (viaToken) {
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch (_) {
        /* cosmetic */
      }
    }
    await editRepertoire(result.repertoire_id);
    await refreshDashboardRepertoires();
    setStatus(`Copied "${result.name}" to your account — it's yours now`);
  } catch (error) {
    setStatusError(error.message);
  }
}

// ----- Coverage workbench (Build inspector) ------------------------------------
let coverageView = null;
let coverageViewReady = null;

function ensureCoverageView() {
  if (!coverageViewReady) {
    coverageViewReady = import("./controllers/coverage.js").then(({ createCoverageController }) => {
      coverageView = createCoverageController({
        getContext: () => ({ build: appState.build, ownerId: currentOwnerId(),
          ownerGeneration: appState.ownerGeneration, rating: effectiveMaiaRating(),
          selectedNodeId: appState.buildCurrentNodeId, readOnly: isBuildReadOnly() }),
        getProvider: () => getSharedMaia3Provider(), selectNode: selectBuildNode, getBoard: () => boards.build,
        previewReplies: previewCoverageReplies, getJob: () => jobToast,
        onError: (error) => setStatusError(error.message),
      });
      return coverageView;
    }).catch((error) => { coverageViewReady = null; throw error; });
  }
  return coverageViewReady;
}

async function runCoverageScanUI() {
  try { await (await ensureCoverageView()).scan(); }
  catch (error) { setStatusError(error.message); }
}

async function previewCoverageReplies(gaps, options) {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const mod = await import("./controllers/coverage-replies.js");
  if (owner !== currentOwnerId() || generation !== appState.ownerGeneration || !options.isValid()) return;
  return mod.previewCoverageReplies(gaps, options, {
    isBuildReadOnly, isBrowserEngineAvailable, unavailableMessage: BROWSER_ENGINE_UNAVAILABLE,
    jobToast, hardFlushBuild, captureBuildContext, getBuild: () => appState.build,
    effectiveMaiaRating, effectiveStockfishDepth, getGenerator: () => _buildGenReady || preloadBuildGen(),
    getProvider: getSharedMaia3Provider, showConfirmModal, postJson, classifySyncError,
    hydrateBuild, trainRepertoire,
  });
}

// ----- Opponent scouting (Replay tab) — lazy view chunk -----------------------
let scoutModulePromise = null;
let scoutView = null;

function preloadScoutView() {
  if (!scoutModulePromise) {
    scoutModulePromise = import("./views/scout.js").catch((err) => {
      scoutModulePromise = null;
      throw err;
    });
  }
  return scoutModulePromise;
}

async function ensureScoutView() {
  const mod = await preloadScoutView();
  if (!scoutView) {
    scoutView = mod.createScoutView({
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
      getBuildState: () => appState.build,
      getBuildNodeById: (id) => appState.buildNodeById.get(id),
      setBuildPending: (entry) => {
        appState.buildPending.push(entry);
      },
      pushBuildNode: (node) => {
        appState.build.nodes.push(node);
        appState.buildNodeById.set(node.id, node);
      },
      connectLichess: startLichessOAuth,
      loadPgnIntoAnalyze,
      rememberHandoff,
      effectiveMaiaRating,
      maiaAnalysisEnabled: () => maiaAnalysisEnabled(),
      scoutPickedUsernames: () => scoutPickedUsernames(),
      requireSignIn,
      getLichessUsername: () => appState.lichessUsername,
      getLichessAccounts: () => lichessAccounts(),
      effectiveStockfishDepth,
    });
  }
  return scoutView;
}

const SCOUT_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_SCOUT_E2E === "1";
const POLISH_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_POLISH_E2E === "1";

function installScoutE2eHook() {
  if (window.__prepforgeScoutE2e) return;
  const oauthOpens = [];
  const nativeOpen = window.open.bind(window);
  window.open = function scoutE2eOpen(url, target, features) {
    oauthOpens.push({
      url: String(url ?? ""),
      target: String(target ?? ""),
      features: String(features ?? ""),
      ts: Date.now(),
    });
    try {
      return nativeOpen(url, target, features);
    } catch {
      return null;
    }
  };
  window.__prepforgeScoutE2e = {
    async mountRefutationScenario(scenarioId) {
      switchView("replay");
      const view = await ensureScoutView();
      view.bindControls();
      return view.mountE2eRefutationScenario(scenarioId);
    },
    getOauthOpens() {
      return oauthOpens.map((entry) => ({ ...entry }));
    },
    resetOauthOpens() {
      oauthOpens.length = 0;
    },
  };
}

// Polish acceptance hook: deterministic tests seed linked identities and drive
// the real per-action chooser without OAuth popups. Same gating shape as the
// Scout hook — build flag + query param — so production pages never expose it.
function installPolishE2eHook() {
  if (window.__prepforgePolishE2e) return;
  window.__prepforgePolishE2e = {
    whenSettingsReady,
    async setLichessAccounts(accounts) {
      appState.lichessAccounts = accounts;
      const primary = accounts.find((a) => a.is_primary) || accounts[0] || null;
      appState.lichessUsername = primary ? primary.username : null;
      try {
        const view = await whenSettingsReady().catch(() => null);
        // Seed the connections list directly: the acceptance static server has
        // no /api/lichess backend, so refreshConnections() would keep the last
        // state instead of showing the seeded identities.
        await view?.renderConnections?.();
        view?.renderMaia3Status?.();
      } catch (_) {
        /* settings view may not be loaded yet */
      }
      try {
        syncReplayControls();
      } catch (_) {
        /* controller may not be initialised in a bare acceptance page */
      }
    },
    getLichessAccounts() {
      return lichessAccounts();
    },
    async fetchMyLastGame() {
      await fetchMyLichessGame();
      return document.getElementById("app-status")?.textContent || "";
    },
    async setBoardFen(boardName, fen) {
      const board = boards[boardName] || null;
      if (!board) throw new Error(`unknown board: ${boardName}`);
      const info = await boardInfo(fen);
      board.setPosition({ fen, legalMoves: info.legal_moves, lastMove: null });
      return info.legal_moves;
    },
  };
}

// Analyze E2E hook: deterministic tests seed a finished analysis payload
// (moves + eval graph) without running a browser engine. Same gating shape as
// the Scout/Polish hooks — E2E build flag + query-param opt-in — so production
// pages never expose it. Shares the existing E2E build flags so the CI e2e job's
// build (VITE_ENABLE_SCOUT_E2E=1) carries it.
const ANALYZE_E2E_BUILD_ENABLED = SCOUT_E2E_BUILD_ENABLED || POLISH_E2E_BUILD_ENABLED;

function installAnalyzeE2eHook() {
  if (window.__prepforgeAnalyzeE2e) return;
  window.__prepforgeAnalyzeE2e = {
    async seedAnalysis(payload) {
      // Boot races the seed: init()'s restoreWorkspaceLocation() switches to the
      // default view after this hook is installed. Await boot so the seeded
      // Analyze view (and its reveal) isn't switched away underneath us.
      if (appReadyPromise) await appReadyPromise;
      switchView("analyze");
      appState.analysis = payload;
      appState.analysisVarNodes = new Map();
      appState.analysisVarCounter = 0;
      appState.analysisCurrentNodeId = "root";
      appState.analysisTree = null;
      appState.analysisPly = 0;
      const view = await ensureAnalyzeView();
      view.renderAnalysis(payload);
      revealAnalysisResults();
      await showAnalysisPly(0);
      return true;
    },
    // The user's Lichess name, so a loaded PGN has a known side ("you") and the coach
    // reads the other side's moves as the opponent's.
    setSelfName(name) {
      appState.lichessUsername = name || null;
      return true;
    },
    getCoachProse: () => (document.getElementById("coach-prose") || {}).textContent || "",
    getPly: () => appState.analysisPly,
    getBoardLabel: () =>
      (document.getElementById("analysis-board-label") || {}).textContent || "",
  };
}

if (
  SCOUT_E2E_BUILD_ENABLED &&
  new URLSearchParams(location.search).get("scout_e2e") === "1"
) {
  installScoutE2eHook();
}

if (
  POLISH_E2E_BUILD_ENABLED &&
  new URLSearchParams(location.search).get("polish_e2e") === "1"
) {
  installPolishE2eHook();
}

if (
  ANALYZE_E2E_BUILD_ENABLED &&
  new URLSearchParams(location.search).get("analyze_e2e") === "1"
) {
  installAnalyzeE2eHook();
}

// Bind the view and let it paint the section's current state. The chunk is
// already in flight by the time Scout is shown, so this only resolves it.
async function ensureScoutUi() {
  const view = await ensureScoutView();
  view.bindControls();
  view.onShow?.();
  return view;
}

let scoutUiPromise = null;
function preloadScoutUi() {
  if (!scoutUiPromise) {
    scoutUiPromise = ensureScoutUi().catch((err) => {
      scoutUiPromise = null;
      throw err;
    });
  }
  return scoutUiPromise;
}

// Maia idle teardown. The browser Maia engine (onnxruntime-web session + WASM heap) is by
// far the heaviest thing the page holds — tens-to-hundreds of MB of weights + activation
// arena that ORT never voluntarily releases. Backgrounding a tab only throttles its CPU; it
// does NOT free that worker/session, so a tab left in the background keeps the whole footprint
// resident. After the tab has been hidden a while with no Maia work in flight, dispose the
// shared provider to hand that memory back. It transparently re-inits on the next use, and the
// IndexedDB weight cache means a re-init skips the ~46 MB download — only the session is rebuilt.
//
// The window is deliberately generous (10 min). A re-init still has to rebuild the ORT session
// (graph-optimizing a 23M-param transformer — seconds, the genuinely slow part), so tearing down
// after a SHORT hidden spell punished the common dev/study loop of tabbing to an editor and back:
// every return rebuilt the session and the "loading model" toast read like a fresh download. Only
// a tab parked in the background for a long stretch — where reclaiming ~1 GB clearly wins — should
// pay that rebuild cost. (Returning to the foreground cancels the timer, so an active tab never
// tears down.)
const MAIA_IDLE_TEARDOWN_MS = 10 * 60 * 1000;
let maiaIdleTimer = null;

function clearMaiaIdleTeardown() {
  if (maiaIdleTimer !== null) {
    clearTimeout(maiaIdleTimer);
    maiaIdleTimer = null;
  }
}

function scheduleMaiaIdleTeardown() {
  clearMaiaIdleTeardown();
  maiaIdleTimer = setTimeout(() => {
    maiaIdleTimer = null;
    const provider = peekSharedMaia3Provider();
    if (!provider) return; // nothing live to release
    // Still working (e.g. a Generate run left in a hidden tab)? Don't abort it — check back later.
    if (provider.busy) {
      scheduleMaiaIdleTeardown();
      return;
    }
    disposeSharedMaia3Provider();
  }, MAIA_IDLE_TEARDOWN_MS);
}

// Mobile bottom bar: the More button opens a bottom sheet carrying the
// secondary destinations (Analyze, Scout, Teams, Settings, command palette).
// Sheet entries mirror the canonical nav buttons so every view keeps its real
// activation path (URL sync, loaders, transient-overlay cleanup).
function wireMobileNav() {
  const sheet = document.getElementById("more-sheet");
  const moreBtn = document.getElementById("more-nav-btn");
  if (!sheet || !moreBtn) return;
  let sheetCleanup = null;
  const closeSheet = ({ restoreFocus = true } = {}) => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    sheetCleanup?.({ restoreFocus: false });
    sheetCleanup = null;
    moreBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus) moreBtn.focus();
  };
  const openSheet = () => {
    sheet.hidden = false;
    moreBtn.setAttribute("aria-expanded", "true");
    const menu = document.getElementById("account-menu");
    sheetCleanup = activateModal(sheet, { additionalRoots: menu ? [menu] : [] });
  };
  moreBtn.addEventListener("click", () => {
    if (sheet.hidden) openSheet();
    else closeSheet();
  });
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) closeSheet();
  });
  sheet.querySelectorAll("[data-nav-mirror]").forEach((item) => {
    item.addEventListener("click", () => {
      const [view, section] = item.dataset.navMirror.split(":");
      closeSheet({ restoreFocus: false });
      const target = document.querySelector(section
        ? `.tab[data-view="${view}"][data-replay-section="${section}"]`
        : `.tab[data-view="${view}"]`);
      target?.click();
    });
  });
  sheet.querySelectorAll("[data-lib-mirror]").forEach((item) => {
    item.addEventListener("click", () => {
      closeSheet({ restoreFocus: false });
      document.getElementById(item.dataset.libMirror)?.click();
    });
  });
  // Mobile account entry (the rail — and its account row — is hidden ≤ 760px).
  // Signed in, the account menu opens over the still-open sheet with this item
  // as its trigger, so Escape returns focus here; a guest gets the auth modal.
  const accountItem = document.getElementById("sheet-account");
  if (accountItem) {
    accountItem.addEventListener("click", () => {
      if (!appState.signedIn) closeSheet({ restoreFocus: false });
      onAccountChipClick(null, { trigger: accountItem });
    });
  }
  // Picking an account-menu action finishes the sheet's job too.
  document.getElementById("account-menu")?.addEventListener("click", (event) => {
    if (event.target.closest?.('[role="menuitem"]')) closeSheet({ restoreFocus: false });
  });
  // Phones have no rail: the sheet carries the light/dark toggle (it stays
  // open so the switch is visible behind it).
  document.getElementById("sheet-theme")?.addEventListener("click", toggleTheme);
  const paletteItem = document.getElementById("sheet-palette");
  if (paletteItem) {
    paletteItem.addEventListener("click", () => {
      closeSheet({ restoreFocus: false });
      document.getElementById("open-palette")?.click();
    });
  }
  document.addEventListener("keydown", (event) => {
    // Escape closes the topmost layer only: an account menu opened from the
    // sheet closes first (the global handler), the sheet on the next Escape.
    if (event.key === "Escape" && !sheet.hidden && !isAccountMenuOpen()) closeSheet();
  });
  wirePhoneStudyNav();
  wirePhoneSheets();
  wireHoldRepeat();
  mirrorAnalysisLabel();
}

// Phones hide the board bar's label (the thumb bar has no room), so Analyze's
// eval row repeats it: which move, and whether it is a variation or engine line.
function mirrorAnalysisLabel() {
  const label = document.getElementById("analysis-board-label");
  const copy = document.getElementById("analysis-ev-move");
  if (!label || !copy) return;
  const mirror = () => { copy.textContent = label.textContent; };
  new MutationObserver(mirror).observe(label, { childList: true, characterData: true, subtree: true });
  mirror();
}

// Holding a move arrow steps on repeat, like a held arrow key. The click that
// ends a hold is dropped so letting go doesn't step once more.
function wireHoldRepeat() {
  for (const id of ["analysis-prev", "analysis-next", "build-parent", "build-next"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    let delay = 0;
    let timer = 0;
    let repeated = false;
    const stop = () => {
      clearTimeout(delay);
      clearInterval(timer);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      stop();
      repeated = false;
      delay = setTimeout(() => {
        timer = setInterval(() => {
          repeated = true;
          button.click();
        }, 110);
      }, 380);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(type, stop);
    button.addEventListener("click", (event) => {
      if (!event.isTrusted || !repeated) return;
      repeated = false;
      event.stopImmediatePropagation();
    }, true);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }
}

// Phone study views (Analyze, Repertoire, Train) hide the tab bar so the board
// and panel get the height; the views button in the board bar slides it up over
// the bar. Picking a destination, tapping elsewhere or Escape puts it away.
function wirePhoneStudyNav() {
  const tabbar = document.getElementById("app-tabbar");
  const toggles = [...document.querySelectorAll("[data-phone-nav]")];
  if (!tabbar || !toggles.length) return;
  const isOpen = () => document.body.classList.contains("phone-nav-open");
  const setOpen = (open) => {
    document.body.classList.toggle("phone-nav-open", open);
    toggles.forEach((button) => button.setAttribute("aria-expanded", String(open)));
  };
  toggles.forEach((button) => button.addEventListener("click", () => setOpen(!isOpen())));
  tabbar.addEventListener("click", (event) => {
    if (event.target.closest(".tabbar-item")) setOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (isOpen() && !event.target.closest?.("#app-tabbar, [data-phone-nav]")) setOpen(false);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) setOpen(false);
  });
}

// Phone sheets (Analyze's report): a [data-sheet-open] button raises the sheet
// it names over the screen; Done, a tap outside or Escape lowers it. A
// [data-mirror] button clicks the control its selector names (phones hide some
// controls and offer them where the thumb is) and lowers any open sheet.
function wirePhoneSheets() {
  const close = () => {
    const open = document.querySelector(".phone-sheet.is-open");
    if (!open) return;
    open.classList.remove("is-open");
    document.querySelector(`[data-sheet-open="${open.id}"]`)?.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("click", (event) => {
    const opener = event.target.closest?.("[data-sheet-open]");
    if (opener) {
      const sheet = document.getElementById(opener.dataset.sheetOpen);
      const wasOpen = sheet?.classList.contains("is-open");
      close();
      if (sheet && !wasOpen) {
        sheet.classList.add("is-open");
        opener.setAttribute("aria-expanded", "true");
      }
      return;
    }
    const mirror = event.target.closest?.("[data-mirror]");
    if (mirror) {
      close();
      document.querySelector(mirror.dataset.mirror)?.click();
      return;
    }
    // The dim backdrop is the sheet's ::before, so a tap on it lands above the sheet's top.
    const sheet = event.target.closest?.(".phone-sheet");
    if (event.target.closest?.("[data-sheet-close]") || !sheet || event.clientY < sheet.getBoundingClientRect().top) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

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
      activateWorkspaceTab(button.dataset, { setReplaySection, switchView });
      if (button.dataset.view === "settings") loadSettings();
      if (button.dataset.view === "teams") loadTeams().catch(() => {});
    });
  });
  wireMobileNav();

  // Teams view actions.
  const teamsNewBtn = document.getElementById("teams-new");
  if (teamsNewBtn) teamsNewBtn.addEventListener("click", createTeam);
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

  // Account chip (folds in the old standalone Sign out button as a menu action)
  document.getElementById("account-chip").addEventListener("click", () => onAccountChipClick());
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  // Replay tab
  document.getElementById("lichess-compare-btn").addEventListener("click", runLichessCompare);
  bindGamesSource();
  bindScoutSource();
  // Static host in the Build panel, so one binding at init covers both states.
  document.getElementById("shared-fork-btn")?.addEventListener("click", forkReadableRepertoire);
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
  document.getElementById("analysis-retry-save-btn")?.addEventListener("click", () => {
    void retryAnalyzeSave();
  });
  document.getElementById("analysis-retry-save-discard")?.addEventListener("click", discardAnalyzeCheckpoint);
  const createRepFromGame = document.getElementById("create-repertoire-from-game");
  if (createRepFromGame) {
    createRepFromGame.addEventListener("click", () => {
      onCreateRepertoireFromGameClick().catch(() => {});
    });
  }
  document.getElementById("fetch-my-game").addEventListener("click", () => fetchMyLichessGame());
  // Lazy-load the analysis history list the first time its drawer is opened.
  const historyDrawer = document.getElementById("history-drawer");
  if (historyDrawer) {
    historyDrawer.addEventListener("toggle", () => {
      if (historyDrawer.open) loadAnalysisHistory();
    });
  }
  // Coverage scan: explicit button — never runs implicitly (it's a Maia batch).
  // Scope and horizon live in these header controls, so a change made before
  // the lazy controller loads is still the one it scans with.
  const coverageRun = document.getElementById("coverage-run");
  if (coverageRun) coverageRun.addEventListener("click", runCoverageScanUI);
  const invalidateCoverage = () => { coverageView?.invalidate(); };
  document.querySelectorAll("#coverage-scope [data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-active")) return;
      document.querySelectorAll("#coverage-scope [data-scope]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      invalidateCoverage();
    });
  });
  document.getElementById("coverage-depth")?.addEventListener("change", invalidateCoverage);

  // Explorer and Coverage share one compact header row: title + segmented
  // control + info popover + scan action. Selecting another tool replaces the
  // panel in place; selecting the active tool collapses the inspector.
  const inspectorDbs = document.getElementById("inspector-dbs");
  if (inspectorDbs) {
    inspectorDbs.querySelectorAll(".explorer-db").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        // Mouse clicks drop focus so stepping moves with ← / → never draws a
        // focus ring on the toggle.
        if (event.detail !== 0) btn.blur();
        explorerDb = btn.dataset.db === "lichess" ? "lichess" : "masters";
        inspectorDbs.querySelectorAll(".explorer-db").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-pressed", String(b === btn));
        });
        refreshExplorerPanel();
      });
    });
  }
  document.getElementById("inspector-info")?.addEventListener("click", onInspectorInfo);
  // Phones show one of the line tree, Explorer or Coverage under the board.
  const panes = document.getElementById("build-panes");
  panes?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pane]");
    if (!button) return;
    const pane = button.dataset.pane;
    document.getElementById("view-build").dataset.pane = pane;
    panes.querySelectorAll("[data-pane]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
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
  // Live PGN → move-list sync: every edit (debounced) re-parses the box and
  // rebuilds the move list + board. Invalid/half-typed movetext is ignored
  // (quiet) so the list never flickers mid-keystroke.
  const pgnInput = document.getElementById("pgn-input");
  if (pgnInput) {
    pgnInput.addEventListener("input", () => {
      if (analyzePgnWriting) return;
      invalidateAnalysisSource();
      syncViewHeads();
      analyzePgnInputTimer = setTimeout(() => {
        orientAnalysisFromPgn(pgnInput.value);
        void loadPgnIntoAnalyze(pgnInput.value, { goToEnd: true, quiet: true }).catch(
          () => {}
        );
      }, 300);
    });
  }
  document
    .getElementById("open-engine-widget")
    .addEventListener("click", () => setEngineOn("analyze", !engineWantedIn("analyze")));
  document
    .getElementById("explorer-engine-toggle")
    ?.addEventListener("click", () => setEngineOn("build", !engineWantedIn("build")));
  bindEvalChart();
  // While an engine line is on the board, the board-bar arrows step through it.
  const navOrPreview = (action, nav) => () => {
    if (engineWidget && engineWidget.stepPreview(action)) return;
    nav();
  };
  document.getElementById("analysis-start").addEventListener("click", navOrPreview("start", () => {
    void analysisTreeNav("start").catch(() => {});
  }));
  document.getElementById("analysis-prev").addEventListener("click", navOrPreview("prev", () => {
    void analysisTreeNav("prev").catch(() => {});
  }));
  document.getElementById("analysis-next").addEventListener("click", navOrPreview("next", () => {
    void analysisTreeNav("next").catch(() => {});
  }));
  document.getElementById("analysis-end").addEventListener("click", navOrPreview("end", () => {
    void analysisTreeNav("end").catch(() => {});
  }));
  for (const id of ["analysis-pv-exit", "build-pv-exit"]) {
    document.getElementById(id)?.addEventListener("click", () => {
      engineWidget?.exitPreview();
      if (id === "build-pv-exit") boards.build?.endPreview();
    });
  }

  document.getElementById("build-root").addEventListener("click", navOrPreview("start", buildGoRoot));
  document.getElementById("build-parent").addEventListener("click", navOrPreview("prev", buildGoBack));
  document.getElementById("build-next").addEventListener("click", navOrPreview("next", buildGoForward));
  document.getElementById("build-end").addEventListener("click", navOrPreview("end", buildGoToEnd));
  document.getElementById("build-generate-node").addEventListener("click", generateFromCurrentNode);
  document.getElementById("build-menu").addEventListener("click", openBuildMenu);
  document.getElementById("build-empty-create").addEventListener("click", () => createRepertoirePrompt({ title: "New repertoire", defaultName: "New repertoire" }));
  document.getElementById("build-empty-import").addEventListener("click", () => document.getElementById("dashboard-import-input").click());
  document.getElementById("build-empty-open").addEventListener("click", () => switchView("dashboard"));

  document.getElementById("start-train").addEventListener("click", () => startTraining());
  document.getElementById("train-summary-new").addEventListener("click", () => startTraining(undefined, { fresh: true }));
  const startPlay = document.getElementById("start-play");
  if (startPlay) {
    startPlay.addEventListener("click", async () => {
      // Mid-game the same button starts over: ask before throwing the game away.
      const live = appState.play && appState.play.active && (appState.play.history || []).length > 0;
      if (live) {
        const ok = await showConfirmModal({
          title: "Start a new game?",
          body: "The current game will be abandoned.",
          okLabel: "New game",
          cancelLabel: "Keep playing",
        });
        if (!ok) return;
      }
      startPlaySessionTracked();
    });
  }
  const luckyBtn = document.getElementById("feeling-lucky");
  if (luckyBtn) luckyBtn.addEventListener("click", () => onFeelingLucky());
  const takebackBtn = document.getElementById("play-takeback");
  if (takebackBtn) takebackBtn.addEventListener("click", () => takebackPlaySession());
  const resignBtn = document.getElementById("play-resign");
  if (resignBtn) resignBtn.addEventListener("click", () => resignPlaySession());
  const playAnalyze = document.getElementById("play-analyze");
  if (playAnalyze) playAnalyze.addEventListener("click", () => openPlayInAnalyze());
  document.querySelectorAll("#train-play-color .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setPlayPickerColor(btn.dataset.color);
    });
  });
  const playBookEl = document.getElementById("train-play-book");
  if (playBookEl) {
    playBookEl.addEventListener("change", () => {
      syncTrainPickerVisibility();
    });
  }
  const playRepertoireOptions = document.getElementById("train-repertoire-options");
  if (playRepertoireOptions) {
    playRepertoireOptions.addEventListener("change", async (event) => {
      const input = event.target.closest('input[type="checkbox"][data-repertoire-id]');
      if (!input) return;
      const id = String(input.dataset.repertoireId || "");
      if (!id) return;
      const selected = new Set(await selectedTrainRepertoireIds());
      if (input.checked) selected.add(id);
      else selected.delete(id);
      appState.playRepertoireIds = [...selected];
      persistPlayRepertoireIds();
      renderPlayRepertoirePicker();
      syncTrainPickerVisibility();
    });
  }
  const playRepertoireSelectAll = document.getElementById("train-repertoire-select-all");
  if (playRepertoireSelectAll) {
    playRepertoireSelectAll.addEventListener("change", () => {
      const active = (appState.repertoireList || []).filter(
        (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id)),
      );
      appState.playRepertoireIds = playRepertoireSelectAll.checked
        ? active.map((r) => String(r.id))
        : [];
      persistPlayRepertoireIds();
      renderPlayRepertoirePicker(active);
      syncTrainPickerVisibility();
    });
  }
  const trainFresh = document.getElementById("train-fresh");
  if (trainFresh) {
    trainFresh.addEventListener("click", () => startTraining(appState.trainMode, { fresh: true }));
  }
  bindCommandPalette();
  window.addEventListener("popstate", () => {
    const loc = parseWorkspaceLocation(window.location.href);
    if (loc.view === "replay" && loc.replaySection) {
      appState.replaySection = loc.replaySection;
    }
    switchView(loc.view, { fromUrl: true });
  });
  document.getElementById("train-hint").addEventListener("click", trainHint);
  const statusClose = document.getElementById("app-status-close");
  if (statusClose) {
    statusClose.addEventListener("click", () => clearStatus());
  }
  const blitzToggle = document.getElementById("train-blitz-toggle");
  if (blitzToggle) {
    const paintBlitz = (on) => {
      blitzToggle.classList.toggle("is-on", on);
      blitzToggle.setAttribute("aria-checked", String(on));
    };
    paintBlitz(blitzEnabled());
    blitzToggle.addEventListener("click", () => {
      if (blitzToggle.disabled) return;
      const next = !blitzToggle.classList.contains("is-on");
      setBlitzEnabled(next);
      paintBlitz(next);
    });
  }
  document.querySelectorAll("#train-modes .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (appState.trainMode === mode && btn.classList.contains("is-active")) return;
      document
        .querySelectorAll("#train-modes .train-mode")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      appState.trainMode = mode;
      appState.playStartToken = (appState.playStartToken || 0) + 1;
      appState.playStarting = null;
      appState.play = null;
      appState.trainBusy = false;
      if (mode !== "smart") appState.smart = null;
      if (mode !== "all_lines") appState.training = null;
      clearBlitzTimer();
      setBlitzBarVisible(false);
      if (mode === "play") {
        appState.smart = null;
        appState.training = null;
        setTrainBanner("idle", "Practice game", "");
        void resetTrainBoardIdle("Practice game");
      } else {
        // "Press Start" is said once, by the Start button itself (UX P2-10).
        setTrainBanner("idle", "Ready to train", "");
        void resetTrainBoardIdle("");
        const progress = document.getElementById("train-progress-panel");
        if (progress) progress.hidden = true;
        const summary = document.getElementById("train-summary");
        if (summary) summary.hidden = true;
      }
      // The answer clock only exists in the smart queue; rehearsal is untimed.
      document.getElementById("train-blitz-row").hidden = mode !== "smart";
      syncTrainPickerVisibility();
    });
  });
  const trainSelect = document.getElementById("train-repertoire-select");
  if (trainSelect) {
    trainSelect.addEventListener("change", () => {
      const value = trainSelect.value;
      appState.trainingRepertoireId = value && value !== "__demo__" ? value : null;
    });
  }

  // Analyze takes a PGN file as well as a paste (Library imports from a file too).
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
  document.getElementById("train-skip").addEventListener("click", skipTrainingLine);

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
    if (event.key === "Escape" && paletteIsOpen()) {
      event.preventDefault();
      closePalette();
      return;
    }
    const active = document.activeElement;
    const inEditable =
      !!active &&
      (["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName) ||
        active.isContentEditable === true);
    if (inEditable) return;
    // An engine line on the board: ← → step through it, Esc goes back to the game.
    if (engineWidget && engineWidget.isPreviewing()) {
      const action = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end" }[event.key];
      if (action) {
        event.preventDefault();
        engineWidget.stepPreview(action);
        return;
      }
      if (event.key === "Escape" && !paletteIsOpen()) {
        event.preventDefault();
        engineWidget.exitPreview();
        return;
      }
    }
    // Arrow keys navigate the active tab's board. We blur clicked move buttons
    // on click, so focus returns to the document for these to fire.
    const inBuild = activeViewName() === "build";
    // A control the mouse focused (Engine, the review switch) would otherwise take
    // the keyboard focus ring on the first arrow press, though the arrows drive the board.
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && focusFromPointer && active && active !== document.body) {
      active.blur();
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (inBuild) buildGoBack();
      else void analysisTreeNav("prev").catch(() => {});
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (inBuild) buildGoForward();
      else void analysisTreeNav("next").catch(() => {});
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
    if (event.key === "Escape") {
      buildSession?.closeNodeContextMenu();
      closeRepertoireContextMenu();
      closeAccountMenu({ restoreFocus: true });
      closePalette();
    }
  });
  document.addEventListener("click", (event) => {
    // The node menu exists only once the Build editor has loaded.
    if (!event.target.closest("#node-context-menu")) buildSession?.closeNodeContextMenu();
    if (!event.target.closest("#repertoire-context-menu")) closeRepertoireContextMenu(false);
    // The chip's own click toggles the menu; ignore it here so we don't immediately
    // re-close what the toggle just opened.
    if (
      !event.target.closest("#account-menu") &&
      !event.target.closest("#account-chip") &&
      !event.target.closest("#sheet-account")
    ) {
      closeAccountMenu();
    }
  });
}

async function init() {
  appState.prefs = loadPrefs();
  initAccountController();
  applyPref("theme");
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
  });
  jobToast.bind();
  bindStatusPillAvoidance();
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
  await refreshAuthProviders();
  await refreshAuthStatus();
  setHandoffOwner(currentOwnerId());
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
  // A share URL opens the read-only viewer last, so it lands on top of whatever
  // workspace state loaded — and works for signed-out visitors too.
  await maybeOpenSharedView();
  // A join URL (/?join=<code>) redeems a team invite (requires sign-in).
  await maybeHandleJoinLink();
  // A password-reset link (/?reset_password=<token>) opens the reset form, and a
  // Stripe return (/?billing=success|cancelled) reports the outcome once.
  accountService().openResetFromUrl();
  handleBillingReturn();
  syncWorkspaceUrl();
  await resumeAfterSignIn(signInReturn);
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
    setStatus("Signed in — choose Import PGN to pick your file.");
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
      if (wantPly && appState.analysis && !(appState.analysisPly > 0)) await showAnalysisPly(wantPly);
      return result;
    });
  },
  // #/train was restored and restoreWorkspaceLocation already started it.
  train: () => {
    if (appState.currentView !== "train") goToSmartTraining("Starting training…");
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
  // A card, not the status pill: the resumed action may own the pill.
  const toast = jobToast.notify({
    id: "kept-guest-sources",
    title: "Kept your Games/Scout sources",
    message:
      `${list} — added before you signed in — stay as Games/Scout sources. ` +
      "Remove them from the source chips if you don't need them.",
    actions: [{ label: "OK", primary: true, onClick: () => {} }],
  });
  if (toast && typeof toast._arm === "function") toast._arm(20000, () => {});
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
  const settingsReady = loadSettingsActions().then((actions) => {
    if (isCurrent()) return actions.loadSettingsOnce({ render: false });
  }).catch((error) => { if (isCurrent()) setStatusError(error.message); });
  const dashboardReady = loadDashboard();
  try {
    const stored = getStoredLichessUsername();
    if (stored) setLichessUsername(stored);
  } catch (_) {
    /* ignore storage errors */
  }
  // The Play opponent book depends on a linked Lichess account.
  refreshLichessStatus()
    .then(() => trainSessionLoading?.then((train) => train.syncTrainPickerVisibility()))
    .catch(() => {});
  syncReplayControls();
  // Boards are already seeded with the start position in init() (browser-computed),
  // so signing in doesn't need to re-fetch them.
  renderBuilderTree();
  // R-03/R-04: this OWNER's durable outbox comes back after a reload or an
  // earlier sign-out, and any flush paused waiting for sign-in re-arms.
  appState.syncPausedForAuth = false;
  const restored = await restoreOutbox();
  if (!isCurrent()) return;
  if (appState.buildPending.length || appState.buildPendingDeletes.length) {
    setBuildSync("dirty");
    scheduleBuildFlush();
  }
  if (restored && (restored.build || restored.train)) {
    const parts = [];
    if (restored.build) parts.push(`${restored.build} Build edit${restored.build === 1 ? "" : "s"}`);
    if (restored.train) parts.push(`${restored.train} training attempt${restored.train === 1 ? "" : "s"}`);
    setStatus(`Unsynced work kept on this device: ${parts.join(" and ")} — saving…`, "info");
  }
  if (restored && restored.rejected) {
    setBuildSync("rejected");
    setStatus(
      `${restored.rejected} edit${restored.rejected === 1 ? "" : "s"} couldn't be saved earlier and ${restored.rejected === 1 ? "is" : "are"} kept for review.`,
      { severity: "warning" },
    );
  }
  await refreshAnalyzeRecovery();
  if (!isCurrent()) return;
  await Promise.allSettled([settingsReady, dashboardReady]);
}

appReadyPromise = init().then(() => {
  document.documentElement.dataset.appReady = "true";
}).catch((error) => setStatusError(error.message));

// Lets that app.js reassigns, read live by the lazily loaded controllers/*-session.js.
export {
  _buildGenReady, _coachReady, analysisRecallSeq, analyzeView, buildDockTab, buildView, coverageView,
  explorerClient, explorerDb, explorerModule,
};
