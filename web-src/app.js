import "./styles.css";
import {
  createEngineProvider,
  isBrowserEngineAvailable,
} from "./engine/stockfish-provider.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";
import { runBrowserBuildGenerate } from "./engine/build-generate-runner.js";
import {
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
  resolveModelBase,
} from "./engine/maia3-provider.js";
import { getCachedWeights, clearWeightCache } from "./engine/maia3-weight-cache.js";
import { createCsrfTokenSource, isSafeMethod, CSRF_HEADER } from "./csrf.js";
import { localBoardInfo, localBoardAfterMove } from "./chess-local.js";
import { describeMove } from "./explain.js";
import { buildMoveFeatures, isBrilliantByMaia, markBrilliant } from "./coach/features.js";
import { attachIntuition } from "./coach/intuition.js";
import { buildCommentary } from "./coach/commentary.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const DEMO_PGN = `[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
// Piece artwork sets. Each value is the inner SVG markup for a 0 0 45 45
// viewBox; fill/stroke come from CSS (.piece). "berlin" is a cleaner,
// traditional Staunton silhouette (the default); "classic" is the original
// minimalist set, kept as an alternative.
const PIECE_SETS = {
  berlin: {
    p: `<circle cx="22.5" cy="13.5" r="4.5"></circle><path d="M19 20.2h7l1.4 8.2h-9.8z"></path><path d="M15.5 31.5h14c1.8 1.4 3 3.4 3.4 6H12.1c.4-2.6 1.6-4.6 3.4-6z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    n: `<path d="M13 38h23v3H11z"></path><path d="M15.5 34c1.1-6.8 4.9-9.4 8.2-13.1-3 .4-6.5-.5-8.9-2.4 1-6.4 6.6-10.4 13-9 5.7 1.3 9 6.1 8.4 12.4L34 34z"></path><path d="M18.1 15.6l3.9-5.3 1.2 5.5z" class="piece-cut"></path><circle cx="28.2" cy="15.1" r="1.25" class="piece-cut"></circle><path d="M22.4 20.5c2.4 1.1 5.1 1 7.5-.2" class="piece-line"></path>`,
    b: `<circle cx="22.5" cy="8.7" r="2.5"></circle><path d="M22.5 12c-4 3.7-7.1 8.8-7.1 14.1 0 3.8 3 6.2 7.1 6.2s7.1-2.4 7.1-6.2c0-5.3-3.1-10.4-7.1-14.1z"></path><path d="M26.7 16.2l-8.4 9.4" class="piece-line"></path><path d="M14 34h17c1.1 1 1.8 2.1 2 3.6H12c.2-1.5.9-2.6 2-3.6z"></path><path d="M10.8 38.2h23.4v2.8H10.8z"></path>`,
    r: `<path d="M12.5 9.5h5v3.6h3.4V9.5h3.2v3.6h3.4V9.5h5v8.6H29v11.3l3.2 3.3v3H12.8v-3l3.2-3.3V18.1h-3.5z"></path><path d="M16.5 21h12M16.3 31h12.4" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    q: `<circle cx="9.5" cy="13.2" r="2.2"></circle><circle cx="16.8" cy="9.5" r="2.2"></circle><circle cx="22.5" cy="8" r="2.4"></circle><circle cx="28.2" cy="9.5" r="2.2"></circle><circle cx="35.5" cy="13.2" r="2.2"></circle><path d="M10.2 16.2l4.3 15.5h16l4.3-15.5-6.6 8-2.8-11.2-2.9 12.2-2.9-12.2-2.8 11.2z"></path><path d="M13.5 32.2h18c.9.8 1.4 1.8 1.5 3H12c.1-1.2.6-2.2 1.5-3z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    k: `<path d="M22.5 5.5v7M19.2 8.8h6.6" class="piece-line"></path><path d="M17.8 14.5h9.4l1.4 6.7c2.2 1.7 3.6 4.2 3.6 7.1 0 2.3-1 4.1-2.8 5.2H15.6c-1.8-1.1-2.8-2.9-2.8-5.2 0-2.9 1.4-5.4 3.6-7.1z"></path><path d="M17.3 20.8h10.4M16.2 33.8h12.6" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
  },
  classic: {
    p: `<circle cx="22.5" cy="13" r="6"></circle><path d="M16 22h13l3 11H13z"></path><path d="M12 36h21v4H12z"></path>`,
    n: `<path d="M14 36h22v4H11z"></path><path d="M16 34c1-10 8-11 7-19-3 1-6 1-9-1 3-6 9-8 15-5 5 3 7 8 6 14l-2 11z"></path><circle cx="29" cy="14" r="1.4" class="piece-cut"></circle>`,
    b: `<circle cx="22.5" cy="10" r="4.5"></circle><path d="M15 31c0-7 5-12 7.5-18C25 19 30 24 30 31z"></path><path d="M13 35h19v5H13z"></path><path d="M19 20l7-7" class="piece-line"></path>`,
    r: `<path d="M12 9h6v4h4V9h6v4h5v8H12z"></path><path d="M15 21h15v14H15z"></path><path d="M11 35h23v5H11z"></path>`,
    q: `<circle cx="12" cy="12" r="3.5"></circle><circle cx="22.5" cy="9" r="3.5"></circle><circle cx="33" cy="12" r="3.5"></circle><path d="M12 17l5 16h11l5-16-8 7-2.5-9-2.5 9z"></path><path d="M13 35h19v5H13z"></path>`,
    k: `<path d="M21 7h3v7h6v3h-6v6h-3v-6h-6v-3h6z"></path><path d="M15 31c1-8 5-12 7.5-14C25 19 29 23 30 31z"></path><path d="M13 35h19v5H13z"></path>`,
  },
};

const PIECE_STYLE_KEY = "prepforge.piece_style";
const PIECE_STYLE_LABELS = { berlin: "Staunton Pro", classic: "Classic" };

function activePieceSet() {
  return PIECE_SETS[appState.pieceStyle] || PIECE_SETS.berlin;
}

const PREFS_KEY = "prepforge.prefs";
const DEFAULT_PREFS = {
  coordinates: true,
  lastMovePulse: true,
  flipAnim: true,
  moveAnim: true,
  sounds: true,
  bestArrow: true,
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
  if (name === "coordinates") {
    Object.values(boards).forEach((b) => b && b.applyCoordinates && b.applyCoordinates());
  }
  if (name === "bestArrow" && !pref("bestArrow")) {
    Object.values(boards).forEach((b) => b && b.setEngineArrow && b.setEngineArrow(null));
  }
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

// One wooden knock = noise burst through a bandpass (the contact click) +
// a fast pitch-dropping sine (the low body). Returns nothing; best-effort.
function _woodKnock(ctx, when, opts) {
  const { dur, noiseFreq, noiseQ, noiseGain, bodyFreq, bodyGain } = opts;

  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    // Sharp attack, quick exponential-ish decay so it sounds like a tap.
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
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
  analysis: null,
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
  buildNodeById: new Map(),
  buildCurrentNodeId: null,
  trainingRepertoireId: null,
  training: null,
  // Which trainer the Start button launches: "smart" (card queue, default) or
  // "all_lines" (legacy whole-line rehearsal, kept for pre-game prep).
  trainMode: "smart",
  // Live smart-queue session state (see the Smart queue trainer section).
  smart: null,
  // The LIVE Lichess token's username (drives latest-game fetch / replay). Null when
  // the token is absent/expired even if still signed in.
  lichessUsername: null,
  // The account's stable Lichess username from auth status — persists across a token
  // drop and is what the user-name button shows. Null only for a true guest.
  accountUsername: null,
  // Whether this browser's session is bound to a real account (vs a fresh guest). The
  // app is pure Lichess-OAuth, so signed-in ⇒ a username exists. Guests see a single
  // "Connect Lichess" action; signed-in users get the user-name button → Sign out.
  signedIn: false,
  replayResults: null,
  pieceStyle: "berlin",
  // Maia3 strength: a Settings-pinned rating (null = AUTO), and the auto-resolved
  // rating from the linked Lichess account's public profile (null until fetched).
  maiaRatingPinned: null,
  maiaAutoRating: null,
  // Whether the server exposes engine/Maia compute (admin builds only). The
  // public/default flow runs compute in the browser, so full-game Analyze and
  // Build → Generate (not yet ported to the browser) are gated off here rather
  // than letting the user click through to a raw 403. See applyServerEngineGating.
  serverEngineEnabled: false,
};

const LICHESS_KEY = "prepforge.lichess_username";

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
      renderStrengthControls();
      return;
    }
  } catch (_) { /* corrupt cache — refetch */ }
  try {
    const resp = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
    if (!resp.ok) return;
    const perfs = (await resp.json()).perfs || {};
    let best = null;
    for (const key of ["bullet", "blitz", "rapid", "classical"]) {
      const p = perfs[key];
      if (p && Number.isFinite(p.rating) && !p.prov) {
        if (!best || (p.games || 0) > best.games) best = { rating: p.rating, games: p.games || 0 };
      }
    }
    if (!best) return;
    appState.maiaAutoRating = Math.max(600, Math.min(2600, Math.round(best.rating)));
    try {
      localStorage.setItem(
        MAIA_AUTO_CACHE_KEY,
        JSON.stringify({ username, rating: appState.maiaAutoRating, at: Date.now() }),
      );
    } catch (_) { /* storage full — fine, refetch next time */ }
    renderStrengthControls();
  } catch (_) { /* offline or blocked — AUTO falls back silently */ }
}

// Shown when a browser-only compute action (whole-game Analyze, Build → Generate)
// can't run because the browser engine is unavailable (page not cross-origin
// isolated). Both run browser-only — there is no server fallback.
const BROWSER_ENGINE_UNAVAILABLE =
  "Browser engine unavailable — open in a cross-origin-isolated browser to run engines locally";

// Browser Build → Generate (Phase 3c) ceilings. Deliberately conservative: the
// recursion runs on the USER's machine (deep × branches is slow) and a large tree
// risks exceeding the server apply-plan caps (≤2000 changes / depth ≤64). The
// modal enforces these; GEN_PLAN_CHANGES_SOFT_CAP mirrors the server MAX_PLAN_CHANGES
// so we fail with an actionable message instead of a raw 400 after the work is done.
const GEN_MAX_PLY_DEPTH = 12;
const GEN_MAX_BRANCHES = 3;
const GEN_PLAN_CHANGES_SOFT_CAP = 2000;

const boards = {};

// Delays (ms) for auto-collapsing/auto-dismissing a card. The countdown only
// runs while the user is *not* actively pointing at the card (see _holdDismiss).
const TOAST_MINIMIZE_DELAY = 7500;
const TOAST_DONE_DELAY = 12000;
const TOAST_FAILED_DELAY = 6000;
const TOAST_CANCELLED_DELAY = 4500;
// How long the pointer must rest motionless over a card before its countdown
// is allowed to resume.
const TOAST_IDLE_RESUME_MS = 1100;

// A single notification card. Each job owns its own Toast (DOM + timers) so
// consecutive jobs never cross-talk; an old card's auto-dismiss can never
// reach into a newer card the way a shared, reused element used to.
//
// Two flavours share this one card system so they stack in a single column
// instead of overlapping:
//   - "job"  : a progress card with a Stop button (Analyze / Build gen).
//   - "info" : a notification with custom action buttons (e.g. "new game").
class Toast {
  constructor(stack, opts = {}) {
    const { id, title, tab, total, variant, onCancel, message, actions } = opts;
    this.stack = stack;
    this.id = id;
    this.tab = tab || null;
    this.variant = variant === "info" ? "info" : "job";
    this.state = this.variant === "info" ? "info" : "running";
    this.minimized = false;
    this.activeTotal = Math.max(1, Number(total) || 1);
    this.lastDisplayedPercent = 0;
    this.onClick = null;
    this.onCancel = typeof onCancel === "function" ? onCancel : null;
    this.cancelRequested = false;
    this.removed = false;
    // Single auto-action timer, gated by pointer activity.
    this.dismissTimer = null;
    this.dismissDelay = 0;
    this.dismissAction = null;
    this.idleTimer = null;
    this.hovering = false;
    this.pointerActive = false;
    this.el = this._build(title || "Working...", message, actions);
    stack.container.appendChild(this.el);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
    if (this.variant === "job") {
      this._arm(TOAST_MINIMIZE_DELAY, () => {
        if (this.state === "running") this.toggleMinimize(true);
      });
    }
  }

  _build(title, message, actions) {
    const el = document.createElement("div");
    el.className = `job-toast state-${this.state} variant-${this.variant}`;
    el.dataset.state = this.state;
    const stopBtn = this.onCancel
      ? '<button class="job-toast-stop" type="button" title="Stop job">Stop</button>'
      : "";
    let bodyInner;
    if (this.variant === "info") {
      bodyInner =
        `<div class="job-toast-message">${escapeHtml(message || "")}</div>` +
        '<div class="job-toast-actions"></div>';
    } else {
      // Track and Stop share one row so they never crowd each other, and the
      // track stays visible when the card is minimized.
      bodyInner =
        '<div class="job-toast-message">Queued</div>' +
        '<div class="job-toast-progress">' +
        '<div class="job-toast-track"><div class="job-toast-fill"></div></div>' +
        stopBtn +
        "</div>";
    }
    el.innerHTML =
      '<div class="job-toast-head">' +
      '<span class="job-toast-icon" aria-hidden="true"></span>' +
      `<span class="job-toast-title">${escapeHtml(title)}</span>` +
      '<button class="job-toast-collapse" type="button" title="Minimize" aria-label="Minimize">_</button>' +
      "</div>" +
      `<div class="job-toast-body">${bodyInner}</div>`;
    this.titleEl = el.querySelector(".job-toast-title");
    this.messageEl = el.querySelector(".job-toast-message");
    this.fillEl = el.querySelector(".job-toast-fill");
    this.collapseBtn = el.querySelector(".job-toast-collapse");
    this.stopBtn = el.querySelector(".job-toast-stop");
    this.collapseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMinimize(true);
    });
    if (this.stopBtn) {
      this.stopBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.requestCancel();
      });
    }
    if (this.variant === "info" && Array.isArray(actions)) {
      const host = el.querySelector(".job-toast-actions");
      actions.forEach((action) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `btn ${action.primary ? "primary" : "ghost"} toast-action`;
        btn.textContent = action.label || "OK";
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          if (typeof action.onClick === "function") action.onClick();
          if (action.closeOnClick !== false) this.dismiss();
        });
        host.appendChild(btn);
      });
    }
    el.addEventListener("click", () => {
      if (this.state === "done" && this.onClick) {
        this.onClick();
        this.dismiss();
      } else if (this.minimized) {
        this.toggleMinimize(false);
      }
    });
    this._bindHoverGating(el);
    return el;
  }

  update({ current, total, message }) {
    if (this.state !== "running") return;
    if (total && total > this.activeTotal) this.activeTotal = total;
    const ratio = Math.max(0, Math.min(1, (Number(current) || 0) / this.activeTotal));
    // Slightly pessimistic curve so the final segment feels fast.
    const pessimistic = Math.pow(ratio, 1.5);
    const display = Math.min(0.95, pessimistic);
    if (display > this.lastDisplayedPercent) this.lastDisplayedPercent = display;
    this._renderFill(this.lastDisplayedPercent);
    if (message && !this.cancelRequested) this.messageEl.textContent = message;
  }

  requestCancel() {
    if (this.cancelRequested || !this.onCancel) return;
    this.cancelRequested = true;
    this.el.classList.add("is-cancelling");
    if (this.stopBtn) {
      this.stopBtn.disabled = true;
      this.stopBtn.textContent = "Stopping...";
    }
    if (this.messageEl) this.messageEl.textContent = "Stopping job...";
    try {
      this.onCancel();
    } catch (_) {
      /* best-effort */
    }
  }

  // Make the job non-cancellable from here on and remove the Stop affordance.
  // Used once a result is committed to a server save: aborting the fetch can't
  // un-persist an atomic apply, so the UI must stop implying a cancel that
  // wouldn't hold. No-op if the user already requested cancel.
  lockCancel(message) {
    this._dropStop();
    if (message && this.messageEl && !this.cancelRequested) {
      this.messageEl.textContent = message;
    }
  }

  // Remove the Stop affordance and detach the cancel handler. Used both by the
  // saving-phase lock and by every terminal state below: once a job is done/failed/
  // stopped, cancellation has no meaning, so the finished card must not keep a Stop
  // button that visually implies it can still be cancelled.
  _dropStop() {
    this.onCancel = null;
    if (this.stopBtn) {
      this.stopBtn.remove();
      this.stopBtn = null;
    }
  }

  complete({ title, message, onClick } = {}) {
    this.state = "done";
    this.minimized = false;
    this._dropStop();
    this.onClick = typeof onClick === "function" ? onClick : null;
    this._applyState();
    if (title) this.titleEl.textContent = title;
    if (message) this.messageEl.textContent = message;
    this.lastDisplayedPercent = 1;
    this._renderFill(1);
    this._arm(TOAST_DONE_DELAY, () => this.dismiss());
  }

  fail(message) {
    this.state = "failed";
    this._dropStop();
    this._applyState();
    this.titleEl.textContent = "Job failed";
    this.messageEl.textContent = message || "Unknown error";
    this._arm(TOAST_FAILED_DELAY, () => this.dismiss());
  }

  // A job the user stopped: acknowledge briefly, then fade out.
  cancelled(message) {
    this.state = "cancelled";
    this.minimized = false;
    this._dropStop();
    this._applyState();
    this.titleEl.textContent = "Stopped";
    if (message) this.messageEl.textContent = message;
    this._renderFill(this.lastDisplayedPercent);
    this._arm(TOAST_CANCELLED_DELAY, () => this.dismiss());
  }

  toggleMinimize(force) {
    const next = typeof force === "boolean" ? force : !this.minimized;
    this.minimized = next;
    this.el.classList.toggle("is-minimized", next);
    // Re-arm the running-job minimize timer when the user expands it again.
    if (!next && this.state === "running") {
      this._arm(TOAST_MINIMIZE_DELAY, () => {
        if (this.state === "running") this.toggleMinimize(true);
      });
    }
  }

  dismiss() {
    if (this.removed) return;
    this.removed = true;
    this._clearDismiss();
    this._clearIdle();
    // Collapse out: slide away + shrink height so the cards below rise smoothly.
    this.el.classList.remove("is-visible");
    this.el.classList.add("is-leaving");
    setTimeout(() => {
      this.el.remove();
      this.stack._forget(this);
    }, 300);
  }

  _applyState() {
    this.el.dataset.state = this.state;
    this.el.classList.remove(
      "state-running",
      "state-done",
      "state-failed",
      "state-cancelled",
      "state-info"
    );
    this.el.classList.add(`state-${this.state}`);
    this.el.classList.toggle("is-minimized", this.minimized);
  }

  _renderFill(ratio) {
    if (!this.fillEl) return;
    this.fillEl.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  // ---- Pointer-gated auto-dismiss --------------------------------------
  // Arms a single deferred action (minimize or dismiss). The countdown is
  // suspended while the pointer is actively moving over the card and only
  // (re)starts once the pointer leaves or goes still — so a card never
  // collapses out from under a user who is reading or reaching for it.
  _arm(delay, action) {
    this.dismissDelay = delay;
    this.dismissAction = action;
    this._evaluateDismiss();
  }

  _evaluateDismiss() {
    if (!this.dismissAction) return;
    const hold = this.hovering && this.pointerActive;
    if (hold) {
      this._clearDismiss();
      return;
    }
    if (this.dismissTimer) return; // already counting
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      const action = this.dismissAction;
      this.dismissAction = null;
      if (action) action();
    }, this.dismissDelay);
  }

  _clearDismiss() {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  _clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _bindHoverGating(el) {
    el.addEventListener("pointerenter", () => {
      this.hovering = true;
      this.pointerActive = true;
      this._evaluateDismiss();
    });
    el.addEventListener("pointermove", () => {
      if (!this.hovering) this.hovering = true;
      this.pointerActive = true;
      this._clearIdle();
      this._evaluateDismiss();
      // Resume the countdown once the pointer rests motionless for a moment.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.pointerActive = false;
        this._evaluateDismiss();
      }, TOAST_IDLE_RESUME_MS);
    });
    el.addEventListener("pointerleave", () => {
      this.hovering = false;
      this.pointerActive = false;
      this._clearIdle();
      this._evaluateDismiss();
    });
  }
}

// Manages a vertical stack of independent Toasts. Heavy jobs are sequential
// (the server runs one at a time), so the manager tracks the current job as
// `active` for update/complete/fail/cancel, but every card — including info
// notifications — lives and dies on its own.
class ToastStack {
  constructor() {
    this.container = null;
    this.active = null;
  }

  bind() {
    this.container = document.getElementById("toast-stack");
  }

  isBusy() {
    return !!this.active && this.active.state === "running";
  }

  startJob(opts) {
    if (!this.container) return null;
    this.active = new Toast(this, opts);
    return this.active;
  }

  // Standalone notification card (shares the stack so nothing overlaps).
  notify(opts) {
    if (!this.container) return null;
    return new Toast(this, { ...opts, variant: "info" });
  }

  updateJob(data) {
    if (this.active) this.active.update(data);
  }

  completeJob(data) {
    if (this.active) this.active.complete(data);
  }

  failJob(message) {
    if (this.active) this.active.fail(message);
  }

  cancelJob(message) {
    if (this.active) this.active.cancelled(message);
  }

  // Disable cancellation on the active job (remove its Stop button).
  lockJob(message) {
    if (this.active) this.active.lockCancel(message);
  }

  _forget(toast) {
    if (this.active === toast) this.active = null;
  }
}

const jobToast = new ToastStack();

class EngineWidget {
  constructor() {
    this.el = null;
    this.head = null;
    this.pvsEl = null;
    this.evalBarWhite = null;
    this.evalBarText = null;
    this.evalHead = null;
    this.linesReadout = null;
    this.linesUpBtn = null;
    this.linesDownBtn = null;
    this.depthReadout = null;
    this.closeBtn = null;
    this.resizeHandle = null;
    this.open = false;
    this.pollTimer = null;
    this.lastFen = null;
    this.lastSnapshot = null;
    this.multipv = 1;
    this.maxMultipv = 5;
    this.minMultipv = 1;
    // Engine compute seam: browser Stockfish (WASM Worker) only. No server
    // fallback — if the browser engine is unavailable the widget shows an error.
    this.engine = createEngineProvider();
  }

  bind() {
    this.el = document.getElementById("engine-window");
    if (!this.el) return;
    this.head = document.getElementById("engine-window-head");
    this.pvsEl = document.getElementById("engine-window-pvs");
    this.evalBarWhite = document.getElementById("engine-eval-bar-white");
    this.evalBarText = document.getElementById("engine-eval-bar-text");
    this.evalHead = document.getElementById("engine-head-eval");
    this.linesReadout = document.getElementById("engine-lines-readout");
    this.linesUpBtn = document.getElementById("engine-lines-up");
    this.linesDownBtn = document.getElementById("engine-lines-down");
    this.depthReadout = document.getElementById("engine-window-depth-readout");
    this.closeBtn = document.getElementById("engine-window-close");
    this.resizeHandle = document.getElementById("engine-window-resize");
    this._renderLinesReadout();
    this._bindControls();
    this._bindDrag();
    this._bindResize();
  }

  isOpen() {
    return this.open;
  }

  /** FEN of whichever board the active tab is showing. */
  currentFen() {
    if (activeViewName() === "build") {
      const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
      if (node && node.fen) return node.fen;
    }
    return appState.analysisBoardFen || START_FEN;
  }

  async openForCurrent() {
    // The engine widget runs its own lightweight Stockfish session and is
    // intentionally *not* gated on heavy Analyze/Build jobs — the user can keep
    // probing positions while a long job runs in the background.
    this.open = true;
    this.el.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
    await this._restartForCurrentBoard();
    this._startPolling();
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    this._stopPolling();
    setEngineBestArrow(null);
    this.el.classList.remove("is-visible");
    setTimeout(() => {
      if (!this.el.classList.contains("is-visible")) this.el.hidden = true;
    }, 240);
    try {
      await this.engine.close();
    } catch (_) {
      // best-effort
    }
  }

  /** Re-analyze whenever the active board changes. No-op if widget closed. */
  async onBoardChanged() {
    if (!this.open) return;
    const fen = this.currentFen();
    if (fen === this.lastFen) return;
    this.lastFen = fen;
    this._clearAnalysisView();
    try {
      const snapshot = await this.engine.update({ fen, multipv: this.multipv });
      this._renderSnapshot(snapshot);
      this._startPolling();
    } catch (error) {
      this._showError(error.message);
    }
  }

  async _restartForCurrentBoard() {
    this.lastFen = this.currentFen();
    this._clearAnalysisView();
    try {
      const snapshot = await this.engine.open({
        fen: this.lastFen,
        multipv: this.multipv,
      });
      // Render the response immediately so depth/PVs appear without waiting
      // for the first poll.
      this._renderSnapshot(snapshot);
    } catch (error) {
      this._showError(error.message);
    }
  }

  async _setMultipv(next) {
    const clamped = Math.max(this.minMultipv, Math.min(this.maxMultipv, next));
    if (clamped === this.multipv) return;
    this.multipv = clamped;
    this._renderLinesReadout();
    if (!this.open) return;
    this._clearAnalysisView();
    try {
      const snapshot = await this.engine.update({
        fen: this.lastFen || this.currentFen(),
        multipv: this.multipv,
      });
      this._renderSnapshot(snapshot);
      this._startPolling();
    } catch (error) {
      this._showError(error.message);
    }
  }

  _showError(message) {
    setEngineBestArrow(null);
    setStatus(message);
    if (this.pvsEl) {
      this.pvsEl.innerHTML = `<div class="empty-state">${escapeHtml(
        message || "Engine error"
      )}</div>`;
    }
  }

  _clearAnalysisView() {
    setEngineBestArrow(null);
    if (this.pvsEl) {
      this.pvsEl.innerHTML = '<div class="empty-state">Calculating...</div>';
    }
    if (this.depthReadout) this.depthReadout.textContent = "0 / ?";
    if (this.evalBarText) this.evalBarText.textContent = "...";
    if (this.evalHead) this.evalHead.textContent = "...";
  }

  _renderLinesReadout() {
    if (!this.linesReadout) return;
    this.linesReadout.textContent = `${this.multipv}`;
    if (this.linesDownBtn) this.linesDownBtn.disabled = this.multipv <= this.minMultipv;
    if (this.linesUpBtn) this.linesUpBtn.disabled = this.multipv >= this.maxMultipv;
  }

  _bindControls() {
    this.closeBtn.addEventListener("click", () => this.close());
    this.linesUpBtn.addEventListener("click", () => this._setMultipv(this.multipv + 1));
    this.linesDownBtn.addEventListener("click", () => this._setMultipv(this.multipv - 1));
  }

  _startPolling() {
    this._stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const snapshot = await this.engine.snapshot();
        this._renderSnapshot(snapshot);
      } catch (_) {
        // Ignore transient polling errors.
      }
    }, 450);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _renderSnapshot(snapshot) {
    if (!snapshot || !snapshot.session_id) {
      setEngineBestArrow(null);
      if (this.depthReadout) this.depthReadout.textContent = "0 / 0";
      return;
    }
    this.lastSnapshot = snapshot;
    if (snapshot.error) {
      this._showError(snapshot.error);
      return;
    }
    const depthText = `${snapshot.current_depth || 0} / ${snapshot.max_depth || "?"}`;
    if (this.depthReadout) this.depthReadout.textContent = depthText;
    const pvs = Array.isArray(snapshot.pvs) ? snapshot.pvs : [];
    // Render only as many PV slots as the user asked for; engines occasionally
    // emit transient extra ranks while changing multipv.
    const sideToMove = snapshot.side_to_move || "white";
    const fullmoveNumber = this._fullmoveFromFen(snapshot.fen) || 1;
    if (pvs.length) {
      this.pvsEl.innerHTML = pvs
        .slice(0, this.multipv)
        .map((pv, index) =>
          this._renderPv(pv, index === 0, sideToMove, fullmoveNumber)
        )
        .join("");
      this._renderEvalBar(pvs[0]);
      const best = (pvs[0].pv_uci || [])[0] || null;
      setEngineBestArrow(best);
    } else {
      setEngineBestArrow(null);
      this.pvsEl.innerHTML = '<div class="empty-state">Calculating...</div>';
    }
    // Keep the coach's one-line rationale in sync with this (deeper) search.
    if (typeof positionCoach !== "undefined") positionCoach.onWidgetSnapshot(snapshot);
    // Once the engine reaches max depth it stops; no point polling further
    // until the position changes (open/update restart polling).
    if (snapshot.running === false) this._stopPolling();
  }

  _renderPv(pv, isTop, sideToMove, fullmoveNumber) {
    const evalText = this._formatEval(pv.score_cp, pv.mate_in);
    const moves = this._formatPvLine(
      pv.pv_san || [],
      sideToMove,
      fullmoveNumber
    );
    const cls = isTop ? "engine-pv is-top" : "engine-pv";
    return (
      `<div class="${cls}">` +
      `<span class="engine-pv-eval">${escapeHtml(evalText)}</span>` +
      `<span class="engine-pv-line">${moves || "..."}</span>` +
      `</div>`
    );
  }

  _formatPvLine(moves, sideToMove, fullmoveNumber) {
    if (!moves || !moves.length) return "";
    const out = [];
    let move = fullmoveNumber;
    let whiteToMove = sideToMove === "white";
    for (let i = 0; i < moves.length; i += 1) {
      if (whiteToMove) {
        out.push(`<span class="pv-move-num">${move}.</span>${escapeHtml(moves[i])}`);
      } else {
        if (i === 0) {
          out.push(`<span class="pv-move-num">${move}...</span>${escapeHtml(moves[i])}`);
        } else {
          out.push(escapeHtml(moves[i]));
        }
        move += 1;
      }
      whiteToMove = !whiteToMove;
    }
    return out.join(" ");
  }

  _fullmoveFromFen(fen) {
    if (!fen) return 1;
    const parts = fen.split(" ");
    return Number(parts[5]) || 1;
  }

  _formatEval(cp, mate) {
    if (mate !== null && mate !== undefined) {
      if (mate > 0) return `#${mate}`;
      if (mate < 0) return `#-${Math.abs(mate)}`;
      return "#0";
    }
    if (cp === null || cp === undefined) return "...";
    const pawns = cp / 100;
    return (pawns >= 0 ? "+" : "") + pawns.toFixed(2);
  }

  _renderEvalBar(topPv) {
    // White-perspective win chance from cp / mate.
    let wc;
    if (topPv.mate_in !== null && topPv.mate_in !== undefined) {
      wc = topPv.mate_in > 0 ? 0.99 : 0.01;
    } else if (topPv.score_cp === null || topPv.score_cp === undefined) {
      wc = 0.5;
    } else {
      const cp = Math.max(-1000, Math.min(1000, Number(topPv.score_cp) || 0));
      wc = 1 / (1 + Math.exp(-0.00368208 * cp));
    }
    const evalStr = this._formatEval(topPv.score_cp, topPv.mate_in);
    if (this.evalBarWhite) {
      this.evalBarWhite.style.height = `${Math.round(wc * 100)}%`;
    }
    if (this.evalBarText) this.evalBarText.textContent = evalStr;
    if (this.evalHead) this.evalHead.textContent = evalStr;
  }

  _bindDrag() {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      this.el.style.left = `${Math.max(0, startLeft + dx)}px`;
      this.el.style.top = `${Math.max(0, startTop + dy)}px`;
      this.el.style.right = "auto";
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    this.head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      dragging = true;
      const rect = this.el.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  _bindResize() {
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let resizing = false;
    const onMove = (event) => {
      if (!resizing) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      this.el.style.width = `${Math.max(260, startW + dx)}px`;
      this.el.style.height = `${Math.max(220, startH + dy)}px`;
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    this.resizeHandle.addEventListener("pointerdown", (event) => {
      resizing = true;
      const rect = this.el.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startW = rect.width;
      startH = rect.height;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    });
  }
}

const engineWidget = new EngineWidget();

// ---------------------------------------------------------------------------
// Position coach — the "basic explanation" layer for Analyze. Every position
// change gets instant, engine-free heuristic text (describePosition): material
// read, what the last move did, whose move it is, loose pieces. On top of that
// the engine's suggested move is drawn as a green board arrow with a one-line
// rationale — that arrow IS "the idea shown on the board".
//
// The engine half is debounced + token-cancellable so a flurry of next-clicks
// never queues stale searches. When the full Engine window is open we mirror its
// (deeper) top line via onWidgetSnapshot instead of spinning a second worker and
// fighting over the arrow.
// ---------------------------------------------------------------------------
class PositionCoach {
  constructor() {
    this.engine = null;
    this.fen = null;
    this.ctx = {};
    this.enabled = true;
    this.timer = null;
    this.token = 0;
    // fen -> engine read { lines:[{uci,san,cp,mate,pvUci,pvSan}], depth } (White-POV).
    // Cached so stepping forward (this position was last turn's "after") costs one
    // new search, not two — the prior position is already in here.
    this.evalCache = new Map();
  }

  bind() {
    const toggle = document.getElementById("explain-engine-toggle");
    if (!toggle) return;
    this.enabled = toggle.checked;
    toggle.addEventListener("change", () => {
      this.enabled = toggle.checked;
      if (this.enabled) this.update(this.fen, this.ctx);
      else renderInstantCoach(); // engine off → fall back to the plain read
    });
  }

  // Kept as a no-op: the coach runs its own searches and draws no competing arrow,
  // so it no longer needs to mirror the Engine window's snapshots.
  onWidgetSnapshot() {}

  // Called on every Analyze position change. The instant plain-language read is
  // already on screen (renderInstantCoach); this replaces it with the engine's
  // verdict on the move that was JUST PLAYED — never a next-move instruction.
  update(fen, ctx) {
    this.fen = fen;
    this.ctx = ctx || {};
    setEngineBestArrow(null); // review mode: the board shows your move, not a hint
    if (!fen) return;
    if (!this.enabled) return; // engine off → leave the instant read
    if (activeViewName() !== "analyze") return;
    const hasMove = !!(this.ctx.prevFen && this.ctx.lastUci);
    if (!hasMove) return; // nothing played in → leave the instant read
    if (!isBrowserEngineAvailable()) return; // no engine → leave the instant read
    window.clearTimeout(this.timer);
    setCoachProse("Let me look at that…", "info");
    const target = fen;
    this.timer = window.setTimeout(() => this._run(target), 280);
  }

  async _run(fen) {
    if (fen !== this.fen) return;
    const ctx = this.ctx;
    const prevFen = ctx.prevFen;
    const token = ++this.token;
    try {
      if (!this.engine) this.engine = createEngineProvider();
      // The position BEFORE the move (best line + best alternative) and AFTER it.
      const before = await this._eval(prevFen, token);
      if (token !== this.token || fen !== this.fen) return;
      const after = await this._eval(fen, token);
      if (token !== this.token || fen !== this.fen) return;
      if (!before || !after || !before.lines.length) return;

      const mover = fen.split(" ")[1] === "b" ? "white" : "black";
      const top = after.lines[0] || {};
      const features = buildMoveFeatures({
        ply: ctx.ply ?? null,
        moveNumber: Number(prevFen.split(" ")[5]) || null,
        mover,
        uci: ctx.lastUci,
        san: ctx.lastSan,
        fenBefore: prevFen,
        fenAfter: fen,
        beforeEval: { lines: before.lines },
        afterEval: { cp: top.cp ?? null, mate: top.mate ?? null, pvUci: top.pvUci || [], pvSan: top.pvSan || [] },
      });
      renderCoachProse(buildCommentary(features));
      // Read the position's "texture" from Maia's human-move distribution (one obvious
      // move vs. a rich spread) and fold it into the commentary — best-effort and async,
      // reusing the same Maia worker the brilliant check uses.
      this._checkIntuition(features, prevFen, fen, token);
      // A move can only be "brilliant" if the engine loves it but humans wouldn't —
      // confirm that against Maia in the background and upgrade the read if so.
      if (features.brilliantCandidate) {
        this._checkBrilliant(features, prevFen, ctx.lastUci, fen, token);
      }
    } catch (err) {
      console.warn("Coach: failed to build move commentary", err);
      /* leave the instant read on screen */
    }
  }

  // Maia (a ~human-strength move model) confirms a brilliancy: it rates the move
  // poorly and assigns it a tiny human-probability, yet the engine had it as best.
  // Best-effort and async — Maia may be unavailable (e.g. weights not served), in
  // which case we simply keep the engine read with no brilliancy. Lazily inits Maia
  // on the first candidate; the shared provider caches the model after that.
  async _checkBrilliant(features, prevFen, uci, fen, token) {
    try {
      const provider = getSharedMaia3Provider();
      const a = await provider.moveAssessment({ fen: prevFen, moveUci: uci });
      if (token !== this.token || fen !== this.fen || !a) return;
      const brilliant = isBrilliantByMaia(features, {
        maiaHumanProb: a.humanProbability,
        maiaWinAfter: a.winChanceAfter,
      });
      if (brilliant) {
        markBrilliant(features, { humanProb: a.humanProbability, winChanceAfter: a.winChanceAfter });
        renderCoachProse(buildCommentary(features));
      }
    } catch (err) {
      console.warn("Coach: Maia brilliancy check unavailable", err);
      /* Maia unavailable → no brilliancy; the engine read stands. */
    }
  }

  // Fold Maia's view of the position's TEXTURE into the read: its human-move distribution
  // over the position before the move says whether one move was obvious (a recapture) or
  // many looked reasonable (a sharp middlegame). Crossed with the move's quality, that's
  // what lets the coach call an error in an obvious spot a slip, and an error in a rich
  // one a hard choice. Best-effort and async — if Maia is unavailable the engine read
  // simply stands with no texture note. One Maia forward per move, reusing the shared
  // worker (the model is loaded once and cached), so it rides the existing budget.
  async _checkIntuition(features, prevFen, fen, token) {
    try {
      const provider = getSharedMaia3Provider();
      // Personalized: the texture read runs at the player's own strength (Settings →
      // Playing strength), so "one obvious move" means obvious to THEM.
      const read = await provider.positionRead({ fen: prevFen, rating: effectiveMaiaRating() });
      if (token !== this.token || fen !== this.fen || !read) return;
      attachIntuition(features, read);
      renderCoachProse(buildCommentary(features));
    } catch (err) {
      console.warn("Coach: Maia intuition read unavailable", err);
      /* Maia unavailable → no texture/sharpness note; the engine read stands. */
    }
  }

  // Run (or reuse a cached) MultiPV-2 read of `fen`, White-POV, on a short budget.
  async _eval(fen, token) {
    if (!fen) return null;
    const cached = this.evalCache.get(fen);
    if (cached) return cached;
    await this.engine.open({ fen, multipv: 2 });
    const deadline = Date.now() + 1200;
    let snap = this.engine.snapshot();
    while (Date.now() < deadline) {
      await sleep(150);
      if (token !== this.token) return null;
      snap = this.engine.snapshot();
      const ready = snap && snap.pvs && snap.pvs.length && snap.pvs[0].pv_uci.length;
      if (ready && (snap.running === false || snap.current_depth >= 14)) break;
    }
    const lines = (snap.pvs || [])
      .filter((pv) => pv.pv_uci && pv.pv_uci.length)
      .map((pv) => ({
        uci: pv.pv_uci[0],
        san: (pv.pv_san && pv.pv_san[0]) || pv.pv_uci[0],
        cp: pv.score_cp ?? null,
        mate: pv.mate_in ?? null,
        pvUci: pv.pv_uci.slice(),
        pvSan: (pv.pv_san || []).slice(),
      }));
    if (!lines.length) return null;
    const result = { fen, depth: snap.current_depth || 0, lines };
    this.evalCache.set(fen, result);
    if (this.evalCache.size > 50) this.evalCache.delete(this.evalCache.keys().next().value);
    return result;
  }
}

const positionCoach = new PositionCoach();

const COACH_TONES = ["good", "warn", "danger", "info", "brilliant"];

// The Coach speaks in one short paragraph. Set its text + tone (subtle colour).
function setCoachProse(text, tone = "info") {
  const el = document.getElementById("coach-prose");
  if (!el) return;
  el.textContent = text || "";
  for (const t of COACH_TONES) el.classList.toggle(`is-${t}`, t === tone);
}

// Render the engine's read of the move just played, in the coach's own voice.
function renderCoachProse(c) {
  if (!c) return;
  setCoachProse(c.prose, c.tone);
}

// Drive the coach from one position-change call: show an instant plain-language read
// immediately, then let the engine replace it with a graded verdict.
function refreshAnalysisExplain(ctx) {
  appState.explainContext = ctx || {};
  renderInstantCoach();
  positionCoach.update(ctx ? ctx.fen : null, ctx || {});
}

// Instant, engine-free sentence: what the last move did, or whose move it is. This is
// the placeholder the engine commentary upgrades a beat later.
function renderInstantCoach() {
  const ctx = appState.explainContext || {};
  const fen = ctx.fen || appState.analysisBoardFen || START_FEN;
  const turn = fen.split(" ")[1] === "b" ? "black" : "white";
  if (ctx.prevFen && ctx.lastSan) {
    const mover = turn === "white" ? "Black" : "White"; // the side that just moved
    const did = describeMove(ctx.prevFen, ctx.lastUci, ctx.lastSan);
    setCoachProse(did ? `${mover} ${did}.` : `${mover} plays ${ctx.lastSan}.`, "info");
  } else {
    const side = turn === "white" ? "White" : "Black";
    setCoachProse(`${side} to move. Make a move and I'll tell you what I think.`, "info");
  }
}

class BoardController {
  constructor(config) {
    this.board = document.getElementById(config.boardId);
    this.overlay = document.getElementById(config.overlayId);
    this.onMove = config.onMove;
    this.onAnnotate = config.onAnnotate || null;
    this.fen = null;
    this.legalMoves = [];
    this.selected = null;
    this.lastMove = null;
    this.dragFrom = null;
    this.ghost = null;
    this.engineArrow = null;
    this.branchArrows = [];
    this.moveBadge = null;
    this._hadPosition = false;
    this.annotationStart = null;
    this.highlights = new Set();
    this.arrows = [];
    this.squares = new Map();
    this._badgeEl = null;       // tracks the one square holding a .square-badge
    this._lastMoveSqs = null;   // tracks the [from, to] squares of the current last-move
    this.orientation = "white";
    this._buildGrid();
    this._bindBoardEvents();
  }

  setOrientation(orientation) {
    const next = orientation === "black" ? "black" : "white";
    if (this.orientation === next) return;
    this.orientation = next;
    this._buildGrid();
    if (this.fen) this._renderPieces();
    this._updateClasses();
    this._renderArrows();
    if (pref("flipAnim")) {
      this.board.classList.remove("is-flipping");
      // reflow so the class re-add restarts the animation
      void this.board.offsetWidth;
      this.board.classList.add("is-flipping");
      window.setTimeout(() => this.board.classList.remove("is-flipping"), 420);
    }
  }

  _renderArrows() {
    renderAnnotations(this.overlay, this.arrows, this.orientation, this.engineArrow, this.branchArrows);
  }

  setEngineArrow(uci) {
    const next = uci || null;
    if (this.engineArrow === next) return;
    this.engineArrow = next;
    this._renderArrows();
  }

  // Faint arrows for the next-move branch options at the current position, so a branch
  // point is visible on the board itself (the keyboard branch switcher's on-board echo).
  setBranchArrows(list) {
    const next = Array.isArray(list) ? list.filter((u) => typeof u === "string" && u.length >= 4) : [];
    const same = next.length === this.branchArrows.length && next.every((u, i) => u === this.branchArrows[i]);
    if (same) return;
    this.branchArrows = next;
    this._renderArrows();
  }

  flip() {
    this.setOrientation(this.orientation === "white" ? "black" : "white");
  }

  _buildGrid() {
    this.board.innerHTML = "";
    this.squares.clear();
    const ranks = this.orientation === "white"
      ? [8, 7, 6, 5, 4, 3, 2, 1]
      : [1, 2, 3, 4, 5, 6, 7, 8];
    const fileIndices = this.orientation === "white"
      ? [0, 1, 2, 3, 4, 5, 6, 7]
      : [7, 6, 5, 4, 3, 2, 1, 0];
    const bottomRank = ranks[ranks.length - 1];
    const leftFile = fileIndices[0];
    for (const rank of ranks) {
      for (const fileIndex of fileIndices) {
        const squareName = `${files[fileIndex]}${rank}`;
        const square = document.createElement("button");
        square.type = "button";
        square.className = `square ${(rank + fileIndex) % 2 === 1 ? "dark" : "light"}`;
        square.dataset.square = squareName;
        square.setAttribute("aria-label", squareName);
        if (rank === bottomRank) {
          square.insertAdjacentHTML("beforeend", `<span class="coord coord-file">${files[fileIndex]}</span>`);
        }
        if (fileIndex === leftFile) {
          square.insertAdjacentHTML("beforeend", `<span class="coord coord-rank">${rank}</span>`);
        }
        this.board.appendChild(square);
        this.squares.set(squareName, square);
      }
    }
    this.applyCoordinates();
  }

  applyCoordinates() {
    this.board.classList.toggle("show-coords", pref("coordinates"));
  }

  _bindBoardEvents() {
    this.board.addEventListener("contextmenu", (event) => event.preventDefault());

    this.board.addEventListener("pointerdown", (event) => {
      const square = event.target.closest(".square");
      if (!square) return;
      const squareName = square.dataset.square;
      if (event.button === 2) {
        this.annotationStart = squareName;
        return;
      }
      if (event.button !== 0) return;
      if (event.shiftKey) {
        this._toggleHighlight(squareName);
        return;
      }
      // Clicking a legal target while a piece is selected plays the move.
      if (this.selected && this.selected !== squareName) {
        const move = legalMoveFor(this.selected, squareName, this.legalMoves);
        if (move) {
          this._setSelected(null);
          this.play(move);
          return;
        }
      }
      if (this.hasLegalFrom(squareName)) {
        this._setSelected(squareName);
        this._beginDrag(squareName, event);
      } else {
        this._setSelected(null);
      }
    });

    this.board.addEventListener("pointerup", (event) => {
      if (event.button === 2) this._finishAnnotation(event);
    });
  }

  _beginDrag(squareName, event) {
    this._cancelDrag();
    const squareEl = this.squares.get(squareName);
    if (!squareEl || !squareEl.dataset.piece) return;
    this.dragFrom = squareName;
    const size = this.board.getBoundingClientRect().width / 8;
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.style.width = `${size}px`;
    ghost.style.height = `${size}px`;
    ghost.innerHTML = pieceSvg(squareEl.dataset.piece);
    document.body.appendChild(ghost);
    this.ghost = ghost;
    squareEl.classList.add("dragging");
    this._moveGhost(event);
    this._dragMove = (e) => {
      this._moveGhost(e);
      this._hoverTarget(e);
    };
    this._dragUp = (e) => this._endDrag(e);
    this._dragCancel = () => this._cancelDrag();
    window.addEventListener("pointermove", this._dragMove);
    window.addEventListener("pointerup", this._dragUp);
    window.addEventListener("pointercancel", this._dragCancel);
    window.addEventListener("blur", this._dragCancel);
  }

  _moveGhost(event) {
    if (!this.ghost) return;
    this.ghost.style.left = `${event.clientX}px`;
    this.ghost.style.top = `${event.clientY}px`;
  }

  _squareAt(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    const square = el ? el.closest(".square") : null;
    return square && this.board.contains(square) ? square.dataset.square : null;
  }

  _hoverTarget(event) {
    const name = this._squareAt(event);
    this.squares.forEach((square, squareName) => {
      square.classList.toggle(
        "drag-over",
        Boolean(name) && squareName === name && squareName !== this.dragFrom
      );
    });
  }

  _endDrag(event) {
    const from = this.dragFrom;
    this._cancelDrag();
    if (!from) return;
    const target = this._squareAt(event);
    // Same-square release is treated as a click: the piece stays selected so a
    // follow-up click on a target square plays the move.
    if (!target || target === from) return;
    const move = legalMoveFor(from, target, this.legalMoves);
    if (move) {
      this._setSelected(null);
      this.play(move);
    }
  }

  _cancelDrag() {
    if (this._dragMove) window.removeEventListener("pointermove", this._dragMove);
    if (this._dragUp) window.removeEventListener("pointerup", this._dragUp);
    if (this._dragCancel) {
      window.removeEventListener("pointercancel", this._dragCancel);
      window.removeEventListener("blur", this._dragCancel);
    }
    this._dragMove = null;
    this._dragUp = null;
    this._dragCancel = null;
    this.dragFrom = null;
    if (this.ghost) {
      this.ghost.remove();
      this.ghost = null;
    }
    this.squares.forEach((square) => square.classList.remove("dragging", "drag-over"));
  }

  _finishAnnotation(event) {
    if (!this.annotationStart) return;
    const start = this.annotationStart;
    this.annotationStart = null;
    const endEl = document.elementFromPoint(event.clientX, event.clientY);
    const endSquareEl = endEl ? endEl.closest(".square") : null;
    if (!endSquareEl || !this.board.contains(endSquareEl)) return;
    const end = endSquareEl.dataset.square;
    if (start === end) {
      this._toggleHighlight(start);
      return;
    }
    const arrow = `${start}${end}`;
    if (this.arrows.includes(arrow)) {
      this.arrows = this.arrows.filter((item) => item !== arrow);
    } else {
      this.arrows.push(arrow);
    }
    this._renderArrows();
    this._notifyAnnotate();
  }

  setAnnotations(arrows, circles) {
    this.arrows = Array.isArray(arrows) ? arrows.slice() : [];
    this.highlights = new Set(Array.isArray(circles) ? circles : []);
    this._updateClasses();
    this._renderArrows();
  }

  _notifyAnnotate() {
    if (this.onAnnotate) this.onAnnotate(this.arrows.slice(), [...this.highlights]);
  }

  setPosition({ fen, legalMoves = [], lastMove = null }) {
    this._cancelDrag();
    const fenChanged = this.fen !== fen;
    const prevFen = this.fen;

    // Read slide offsets NOW, before any DOM writes, so _animateSlide never
    // triggers a mid-write forced reflow to measure layout.
    let preSlide = null;
    if (fenChanged && this._hadPosition && lastMove && pref("moveAnim")) {
      const from = lastMove.slice(0, 2);
      const to = lastMove.slice(2, 4);
      const fromSq = this.squares.get(from);
      const toSq = this.squares.get(to);
      if (fromSq && toSq) {
        preSlide = { dx: fromSq.offsetLeft - toSq.offsetLeft, dy: fromSq.offsetTop - toSq.offsetTop, to };
      }
    }

    this.fen = fen;
    this.legalMoves = legalMoves;
    this.selected = null;
    this.lastMove = lastMove;
    this.moveBadge = null;
    this.dragFrom = null;
    this.annotationStart = null;
    if (fenChanged) {
      this._renderPieces();
      if (this._hadPosition && lastMove) {
        this._feedbackForMove(prevFen, fen, lastMove, preSlide);
      }
    }
    this._hadPosition = true;
    this._updateClasses();
    this._renderArrows();
  }

  setMoveBadge(squareName, classification, label) {
    if (!squareName) {
      this.moveBadge = null;
    } else {
      this.moveBadge = {
        square: squareName,
        classification: String(classification || "unknown").toLowerCase(),
        label: label || classification || "",
      };
    }
    this._syncMoveBadge();
  }

  // Slide the moved piece in, pulse the destination, and chirp a sound, all
  // driven off the final rendered position so a quick "skip" never leaves anything stranded.
  // preSlide is pre-computed {dx, dy, to} read before DOM writes to avoid forced reflow.
  _feedbackForMove(prevFen, fen, lastMove, preSlide) {
    const to = lastMove.slice(2, 4);
    const wasCapture = (() => {
      try {
        const before = parseFenBoard(prevFen);
        const after = parseFenBoard(fen);
        return Object.keys(before).length > Object.keys(after).length;
      } catch (_) {
        return false;
      }
    })();
    playSound(wasCapture ? "capture" : "move");
    if (pref("moveAnim") && preSlide) this._animateSlide(preSlide);
    if (pref("lastMovePulse")) this._pulseSquare(to);
  }

  // preSlide = { dx, dy, to } — offsets already read before DOM writes.
  _animateSlide({ dx, dy, to }) {
    const toSq = this.squares.get(to);
    if (!toSq) return;
    const piece = toSq.querySelector(".piece");
    if (!piece) return;
    piece.style.transition = "none";
    piece.style.transform = `translate(${dx}px, ${dy}px)`;
    void piece.offsetWidth; // one reflow to commit the start state before transitioning
    piece.style.transition = "transform 170ms ease-out";
    piece.style.transform = "translate(0, 0)";
    window.setTimeout(() => {
      piece.style.transition = "";
      piece.style.transform = "";
    }, 200);
  }

  _pulseSquare(square) {
    const el = this.squares.get(square);
    if (!el) return;
    el.classList.remove("move-pulse");
    // rAF lets the removal commit to a frame before re-adding, avoiding forced reflow.
    requestAnimationFrame(() => {
      el.classList.add("move-pulse");
      window.setTimeout(() => el.classList.remove("move-pulse"), 500);
    });
  }

  clearMarkers() {
    this.highlights.clear();
    this.arrows = [];
    this._updateClasses();
    this._renderArrows();
  }

  _renderPieces() {
    const pieces = parseFenBoard(this.fen);
    this.squares.forEach((square, squareName) => {
      const piece = pieces[squareName];
      const desired = piece ? piece : "";
      if (square.dataset.piece === desired) return;
      square.dataset.piece = desired;
      // Swap only the piece element so coordinate labels survive.
      const existing = square.querySelector(".piece");
      if (existing) existing.remove();
      if (piece) square.insertAdjacentHTML("beforeend", pieceSvg(piece));
    });
  }

  // Force every piece to re-render with the current style (dataset cache busts
  // the no-op check in _renderPieces).
  redrawPieces() {
    this.squares.forEach((square) => {
      square.dataset.piece = "";
      const existing = square.querySelector(".piece");
      if (existing) existing.remove();
    });
    if (this.fen) this._renderPieces();
  }

  _updateClasses() {
    const legalTargets = new Set(
      this.selected ? legalTargetsFrom(this.selected, this.legalMoves) : []
    );
    this.squares.forEach((square, squareName) => {
      square.classList.toggle("selected", this.selected === squareName);
      square.classList.toggle("legal", legalTargets.has(squareName));
      square.classList.toggle("highlighted", this.highlights.has(squareName));
    });
    // Update last-move only on the squares that actually changed (prev vs next).
    const next = this.lastMove
      ? [this.lastMove.slice(0, 2), this.lastMove.slice(2, 4)]
      : [];
    const prev = this._lastMoveSqs || [];
    const toUpdate = new Set([...prev, ...next]);
    const nextSet = new Set(next);
    toUpdate.forEach((sq) => {
      const el = this.squares.get(sq);
      if (el) el.classList.toggle("last-move", nextSet.has(sq));
    });
    this._lastMoveSqs = next;
    this._syncMoveBadge();
  }

  _syncMoveBadge() {
    // Clear previous badge from exactly the one tracked square (not a 64-square scan).
    if (this._badgeEl) {
      const existing = this._badgeEl.querySelector(".square-badge");
      if (existing) existing.remove();
      this._badgeEl = null;
    }
    if (!this.moveBadge) return;
    const square = this.squares.get(this.moveBadge.square);
    if (!square) return;
    this._badgeEl = square;
    const cls = this.moveBadge.classification.replace(/[^a-z0-9_-]/g, "");
    const label = escapeHtml(this.moveBadge.label);
    square.insertAdjacentHTML(
      "beforeend",
      `<span class="square-badge class-${cls}">${label}</span>`
    );
  }

  _setSelected(squareName) {
    if (this.selected === squareName) return;
    this.selected = squareName;
    this._updateClasses();
  }

  _toggleHighlight(squareName) {
    if (this.highlights.has(squareName)) this.highlights.delete(squareName);
    else this.highlights.add(squareName);
    this._updateClasses();
    this._notifyAnnotate();
  }

  hasLegalFrom(squareName) {
    return this.legalMoves.some((move) => move.startsWith(squareName));
  }

  play(moveUci) {
    if (this.onMove) this.onMove(moveUci, this.fen);
  }
}

function setStatus(message) {
  document.getElementById("app-status").textContent = message;
}

const getCsrfToken = createCsrfTokenSource();

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // Merge caller headers over the JSON default, then attach the CSRF token on
  // unsafe methods (bootstrapping /api/csrf if the cookie isn't set yet). The
  // FastAPI backend 403s any unsafe request that doesn't echo the cookie.
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!isSafeMethod(method)) {
    const token = await getCsrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
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
        throw new Error(`Server error ${response.status} ${response.statusText}`.trim());
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  }
  // Legacy server returned {error}; FastAPI returns {detail}. Accept both so the
  // SPA surfaces real messages during and after the cutover.
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || `Request failed (${response.status})`);
  }
  return payload;
}

function postJson(path, body, options = {}) {
  // `options` (e.g. an AbortSignal) is forwarded to fetch via api(); it spreads
  // last so a caller can pass `signal` for a cancellable request.
  return api(path, {
    method: "POST",
    body: JSON.stringify(body || {}),
    ...options,
  });
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

function readSelectedFile(input) {
  return new Promise((resolve, reject) => {
    const file = input.files && input.files[0];
    if (!file) {
      reject(new Error("Choose a repertoire package first"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsText(file);
  });
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

function switchView(name) {
  appState.currentView = name;
  // Navigating is user activity; if the Lichess watch is running, switching to
  // Analyze (where a fresh game matters most) tightens the poll cadence briefly.
  noteLichessActivity();
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  if (name === "train") {
    loadTrainRepertoireOptions();
  }
  // Coming back to the dashboard refreshes its counters — after a training
  // session the streak / due numbers on the today card would otherwise be stale.
  if (name === "dashboard" && appState.signedIn) {
    loadDashboard().catch(() => { /* counters refresh is best-effort */ });
  }
  // The engine widget is shared across tabs: it stays open while navigating and
  // re-syncs to whichever board the new tab shows (Analyze or Build).
  if (engineWidget && engineWidget.isOpen && engineWidget.isOpen()) {
    if (name === "analyze" || name === "build") engineWidget.onBoardChanged();
  }
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

function pieceSvg(piece) {
  const colorClass = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  return `<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${activePieceSet()[piece.toLowerCase()]}</g></svg>`;
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
  const sample = ["K", "Q", "N", "p"];
  host.innerHTML = Object.keys(PIECE_SETS)
    .map((style) => {
      const active = style === appState.pieceStyle ? " is-active" : "";
      const set = PIECE_SETS[style];
      const previews = sample
        .map((pc) => {
          const colorClass = pc === pc.toUpperCase() ? "piece-white" : "piece-black";
          return `<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${set[pc.toLowerCase()]}</g></svg>`;
        })
        .join("");
      return (
        `<button type="button" class="piece-style-option${active}" data-style="${escapeHtml(style)}">` +
        `<span class="piece-style-preview">${previews}</span>` +
        `<span class="piece-style-name">${escapeHtml(PIECE_STYLE_LABELS[style] || style)}</span>` +
        `</button>`
      );
    })
    .join("");
  host.querySelectorAll(".piece-style-option").forEach((btn) => {
    btn.addEventListener("click", () => setPieceStyle(btn.dataset.style));
  });
}

function renderPrefsToggles() {
  const host = document.getElementById("board-prefs");
  if (!host) return;
  host.innerHTML = Object.keys(DEFAULT_PREFS)
    .map((key) => {
      const on = pref(key) ? " is-on" : "";
      return (
        `<button type="button" class="pref-toggle${on}" data-pref="${escapeHtml(key)}" role="switch" aria-checked="${pref(key)}">` +
        `<span class="pref-label">${escapeHtml(PREF_LABELS[key] || key)}</span>` +
        `<span class="pref-switch"><span class="pref-knob"></span></span>` +
        `</button>`
      );
    })
    .join("");
  host.querySelectorAll(".pref-toggle").forEach((btn) => {
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

// Build a single closed polygon for an arrow from `from` to `to`.
// Doing shaft + head as one path (instead of a <line> + <marker>) means the
// arrowhead and shaft are guaranteed to be in perfect alignment regardless of
// stroke width, marker scale, or board orientation. The tip lands exactly on
// the to-square center and the tail starts near the edge of the from-square.
function buildArrowPath(from, to) {
  const tailOffset = 4.0;
  const headLength = 5.0;
  const halfBase = 1.05;
  const halfNeck = 0.85;
  const halfHead = 2.25;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;

  const sx = from.x + ux * tailOffset;
  const sy = from.y + uy * tailOffset;
  const nx = to.x - ux * headLength;
  const ny = to.y - uy * headLength;

  const p1x = sx + px * halfBase, p1y = sy + py * halfBase;
  const p2x = nx + px * halfNeck, p2y = ny + py * halfNeck;
  const p3x = nx + px * halfHead, p3y = ny + py * halfHead;
  const p5x = nx - px * halfHead, p5y = ny - py * halfHead;
  const p6x = nx - px * halfNeck, p6y = ny - py * halfNeck;
  const p7x = sx - px * halfBase, p7y = sy - py * halfBase;

  return [
    `M${p1x.toFixed(3)},${p1y.toFixed(3)}`,
    `L${p2x.toFixed(3)},${p2y.toFixed(3)}`,
    `L${p3x.toFixed(3)},${p3y.toFixed(3)}`,
    `L${to.x.toFixed(3)},${to.y.toFixed(3)}`,
    `L${p5x.toFixed(3)},${p5y.toFixed(3)}`,
    `L${p6x.toFixed(3)},${p6y.toFixed(3)}`,
    `L${p7x.toFixed(3)},${p7y.toFixed(3)}`,
    "Z",
  ].join(" ");
}

function renderAnnotations(overlay, arrows, orientation = "white", engineArrow = null, branchArrows = []) {
  overlay.setAttribute("viewBox", "0 0 100 100");
  overlay.innerHTML = "";
  // Colours and stroke come from CSS tokens (.annot-arrow rules) so board
  // arrows stay in step with the rest of the theme.
  const drawArrow = (arrow, kind) => {
    const from = squareCenter(arrow.slice(0, 2), orientation);
    const to = squareCenter(arrow.slice(2, 4), orientation);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", buildArrowPath(from, to));
    path.setAttribute("class", `annot-arrow annot-${kind}`);
    overlay.appendChild(path);
  };
  // Branch hints sit under the user/engine arrows so an explicit annotation always wins.
  (branchArrows || []).forEach((arrow) => arrow && arrow.length >= 4 && drawArrow(arrow, "branch"));
  arrows.forEach((arrow) => drawArrow(arrow, "user"));
  if (engineArrow && engineArrow.length >= 4) drawArrow(engineArrow, "engine");
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

// Deep-link into the smart queue (it already front-loads due reviews).
function goToSmartTraining(statusMessage) {
  switchView("train");
  appState.trainMode = "smart";
  const btn = document.querySelector('#train-modes .train-mode[data-mode="smart"]');
  if (btn) btn.click();
  setStatus(statusMessage);
}

// The "Today" hero card: the daily streak plus what the queue holds right now
// and within 24h — one glance, one button into the smart queue.
function renderDashboardToday(payload) {
  const card = document.getElementById("dashboard-today");
  if (!card) return;
  const streak = payload.streak || { current: 0, best: 0, trained_today: false };
  const due = payload.due_reviews || 0;
  const soon = payload.due_soon || 0;
  // Nothing to say to a brand-new user without repertoires; the empty-state
  // repertoire card below already points them at Build.
  if (!payload.repertoires) {
    card.hidden = true;
    return;
  }
  const note = streak.trained_today
    ? `Trained today - day ${streak.current} ✓`
    : streak.current > 0
      ? `Train today to keep your ${streak.current}-day streak`
      : "Train today to start a streak";
  const best = streak.best > 1 ? ` &middot; best ${streak.best}` : "";
  const queueBits = [];
  if (due > 0) queueBits.push(`<b>${due}</b> due now`);
  if (soon > 0) queueBits.push(`<b>${soon}</b> coming up in 24h`);
  const queueText = queueBits.length ? queueBits.join(" &middot; ") : "Queue is clear";
  // One narrative line about the week: reviews done, mastery movement. Deltas are
  // against a snapshot taken at the start of the player's week (server-side).
  const recap = payload.recap || null;
  let recapHtml = "";
  if (recap && (recap.reviews_7d > 0 || recap.mastered_now > 0 || recap.weak_now > 0)) {
    // Tone follows meaning, not sign: more mastered is good, more weak spots is bad.
    const delta = (n, goodWhenUp) => {
      if (!n) return "";
      const cls = (n > 0) === goodWhenUp ? "up" : "down";
      return ` <span class="${cls}">(${n > 0 ? "+" : ""}${n})</span>`;
    };
    const bits = [
      `<b>${recap.reviews_7d}</b> review${recap.reviews_7d === 1 ? "" : "s"} this week`,
      `<b>${recap.mastered_now}</b> mastered${delta(recap.mastered_delta, true)}`,
    ];
    if (recap.weak_now > 0 || recap.weak_delta !== 0) {
      bits.push(`<b>${recap.weak_now}</b> weak spot${recap.weak_now === 1 ? "" : "s"}${delta(recap.weak_delta, false)}`);
    }
    recapHtml = `<div class="today-recap">${bits.join(" &middot; ")}</div>`;
  }
  card.innerHTML = `
    <div class="today-streak" data-lit="${streak.current > 0 ? "1" : "0"}">
      <span class="today-flame" aria-hidden="true">\u{1F525}</span>
      <span class="today-count">${streak.current}</span>
      <span class="today-unit">day streak${best}</span>
    </div>
    <div class="today-text">
      <div class="today-note">${note}</div>
      <div class="today-queue">${queueText}</div>
      ${recapHtml}
    </div>
    <button class="btn primary" id="dashboard-train-now" data-testid="dashboard-train-now">Train now</button>
  `;
  card.hidden = false;
  document.getElementById("dashboard-train-now").addEventListener("click", () =>
    goToSmartTraining(
      due > 0 ? "Due review - pick a repertoire and start" : "Pick a repertoire and start"
    )
  );
}

async function loadDashboard() {
  // local_date phrases the streak in the player's calendar, not UTC's.
  const payload = await api(`/api/dashboard?local_date=${localDateString()}`);
  if (payload.streak) appState.dayStreak = payload.streak;
  renderDashboardToday(payload);
  const due = payload.due_reviews || 0;
  const metrics = [
    ["Games", payload.games, ""],
    ["Repertoires", payload.repertoires, ""],
    ["Sessions", payload.training_sessions, ""],
    // Spaced-repetition queue, clickable when there's something due so the
    // player can jump straight into a review session.
    ["Due review", due, due > 0 ? "is-due is-clickable" : ""],
  ];
  document.getElementById("dashboard-metrics").innerHTML = metrics
    .map(
      ([label, value, cls]) => `
        <div class="metric ${cls}" ${cls.includes("is-due") ? 'data-action="due-review"' : ""}>
          <div class="metric-value">${value}</div>
          <div class="metric-label">${label}</div>
        </div>
      `
    )
    .join("");
  const dueMetric = document.querySelector('#dashboard-metrics [data-action="due-review"]');
  if (dueMetric) {
    dueMetric.addEventListener("click", () =>
      goToSmartTraining("Due review - pick a repertoire and start")
    );
  }
  await loadDashboardRepertoires();
  setStatus("Ready");
}

function setLichessUsername(username) {
  const cleaned = (username || "").trim();
  appState.lichessUsername = cleaned || null;
  if (cleaned) {
    try {
      localStorage.setItem(LICHESS_KEY, cleaned);
    } catch (_) { /* ignore */ }
  } else {
    try {
      localStorage.removeItem(LICHESS_KEY);
    } catch (_) { /* ignore */ }
  }
  renderAccountChip();
  syncReplayControls();
  // The player's own strength feeds Maia's AUTO rating; resolve it (cached) whenever
  // the linked account changes. Fire-and-forget — AUTO falls back until it lands.
  refreshAutoMaiaRating();
}

// The single user-name button in the topbar. The app is pure Lichess-OAuth, so there's
// no meaningful difference between "sign out of PrepForge" and "disconnect Lichess" — both
// live behind this one button as a single Sign out action. A guest instead sees a plain
// "Connect Lichess" action that goes straight to OAuth.
function renderAccountChip() {
  const chip = document.getElementById("account-chip");
  const label = document.getElementById("account-label");
  if (!chip || !label) return;
  const name = appState.accountUsername || appState.lichessUsername;
  if (appState.signedIn) {
    chip.classList.add("is-connected");
    label.textContent = name || "Account";
    chip.setAttribute("aria-haspopup", "menu");
    chip.title = `Signed in as ${name || "your account"}`;
  } else {
    chip.classList.remove("is-connected");
    label.textContent = "Sign in";
    // A guest chip is a single action, not a menu — drop the popup affordance.
    chip.removeAttribute("aria-haspopup");
    chip.setAttribute("aria-expanded", "false");
    chip.title = "Sign in to PrepForge";
  }
}

// Which sign-in methods the server offers (Google when configured; email/password
// always). Fetched once; drives which buttons the auth modal shows.
async function refreshAuthProviders() {
  try {
    appState.authProviders = await api("/api/auth/providers");
  } catch (_) {
    appState.authProviders = { google: false, password: true };
  }
}

// The sign-in / create-account modal. Google (when configured) is the primary path;
// email/password is the always-available fallback.
function openAuthModal(mode = "login") {
  const existing = document.querySelector(".modal-overlay.auth-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay auth-overlay";
  const providers = appState.authProviders || { google: false, password: true };
  const render = (currentMode) => {
    const isRegister = currentMode === "register";
    const title = isRegister ? "Create account" : "Sign in";
    const googleBlock = providers.google
      ? `<button class="btn primary auth-google" data-action="google" type="button">Continue with Google</button>
         <div class="auth-divider"><span>or use email</span></div>`
      : "";
    overlay.innerHTML = `
      <div class="modal auth-modal" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-title">${title}</div>
        <div class="modal-body">
          ${googleBlock}
          <label class="modal-field"><span>Email</span>
            <input type="email" data-auth="email" autocomplete="email" /></label>
          <label class="modal-field"><span>Password</span>
            <input type="password" data-auth="password"
              autocomplete="${isRegister ? "new-password" : "current-password"}" /></label>
          <p class="auth-error" data-auth="error" role="alert" hidden></p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="toggle" type="button">${
            isRegister ? "Have an account? Sign in" : "New here? Create account"
          }</button>
          <button class="btn primary" data-action="submit" type="button">${
            isRegister ? "Create account" : "Sign in"
          }</button>
        </div>
      </div>`;
    overlay.dataset.mode = currentMode;
    const emailInput = overlay.querySelector('[data-auth="email"]');
    if (emailInput) emailInput.focus();
  };
  render(mode);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const showError = (msg) => {
    const el = overlay.querySelector('[data-auth="error"]');
    if (el) {
      el.textContent = msg;
      el.hidden = !msg;
    }
  };
  const submit = async () => {
    const currentMode = overlay.dataset.mode;
    const email = overlay.querySelector('[data-auth="email"]').value.trim();
    const password = overlay.querySelector('[data-auth="password"]').value;
    if (!email || !password) {
      showError("Enter your email and password.");
      return;
    }
    if (currentMode === "register" && password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }
    showError("");
    const submitBtn = overlay.querySelector('[data-action="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const endpoint = currentMode === "register" ? "/api/auth/register" : "/api/auth/login";
      await postJson(endpoint, { email, password });
      close();
      // A fresh session changes every owner-scoped view — reload for a clean slate.
      window.location.reload();
    } catch (error) {
      showError(error.message || "Sign-in failed.");
      if (submitBtn) submitBtn.disabled = false;
    }
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (event.target === overlay) {
      close();
    } else if (action === "google") {
      window.location.assign("/api/auth/google/login");
    } else if (action === "toggle") {
      render(overlay.dataset.mode === "register" ? "login" : "register");
    } else if (action === "submit") {
      submit();
    }
  });
}

// Guest → the chip is a single Connect action (straight to OAuth). Signed in → the
// chip toggles the account menu.
function onAccountChipClick() {
  if (!appState.signedIn) {
    openAuthModal("login");
    return;
  }
  toggleAccountMenu();
}

function openAccountMenu() {
  const chip = document.getElementById("account-chip");
  const menu = document.getElementById("account-menu");
  if (!chip || !menu) return;
  const name = appState.accountUsername || appState.lichessUsername || "your account";
  // Signed in: offer the Lichess link as a secondary connection. Show the linked
  // username when present, otherwise a "Connect Lichess" action.
  const lichessItem = appState.lichessUsername
    ? `<div class="context-section">Lichess: ${escapeHtml(appState.lichessUsername)}</div>`
    : `<button type="button" role="menuitem" data-action="connect-lichess">Connect Lichess</button>`;
  const items = [
    `<div class="context-section">Signed in as ${escapeHtml(name)}</div>`,
    lichessItem,
    `<button type="button" role="menuitem" data-action="signout">Sign out</button>`,
  ];
  menu.innerHTML = items.join("");
  menu.hidden = false;
  chip.setAttribute("aria-expanded", "true");
  // Drop the menu under the chip, right-aligned to it and clamped to the viewport.
  const cr = chip.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(cr.right - rect.width, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(cr.bottom + 6, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => handleAccountMenuAction(button.dataset.action));
  });
}

function closeAccountMenu() {
  const menu = document.getElementById("account-menu");
  if (menu) menu.hidden = true;
  const chip = document.getElementById("account-chip");
  if (chip) chip.setAttribute("aria-expanded", "false");
}

function toggleAccountMenu() {
  const menu = document.getElementById("account-menu");
  if (menu && !menu.hidden) closeAccountMenu();
  else openAccountMenu();
}

async function handleAccountMenuAction(action) {
  closeAccountMenu();
  if (action === "signout") {
    await signOut();
  } else if (action === "connect-lichess") {
    startLichessOAuth();
  }
}

// Ask the server whether this browser's session is a real account or a guest, and
// capture the account's stable username for the user-name button.
async function refreshAuthStatus() {
  try {
    const status = await api("/api/auth/status");
    appState.signedIn = !!status.signed_in;
    appState.accountUsername = status.username || null;
  } catch (_) {
    appState.signedIn = false;
    appState.accountUsername = null;
  }
  renderAccountChip();
}

// Sign out of PrepForge on this browser: rotate the session to a fresh guest so the
// account's repertoires/games are no longer visible here. The new guest session also
// has no Lichess token, so this is the single "log out" action for the app.
async function signOut() {
  const confirmed = await showConfirmModal({
    title: "Sign out?",
    body:
      "Signs you out on this browser. Your saved repertoires and games stay on your " +
      "account and return when you sign back in with Lichess.",
    okLabel: "Sign out",
    cancelLabel: "Stay signed in",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await postJson("/api/auth/signout", {});
  } catch (_) {
    // The session was NOT rotated server-side; reloading would drop the user right
    // back into the same account while flashing "Signed out". Stay put and report.
    setStatus("Sign out failed — you are still signed in. Try again.");
    return;
  }
  try {
    localStorage.removeItem(LICHESS_KEY);
  } catch (_) {
    /* ignore */
  }
  setStatus("Signed out");
  // Reload so every view reflects the fresh guest session cleanly.
  window.location.reload();
}

function syncReplayControls() {
  const input = document.getElementById("replay-username");
  if (input) {
    input.value = appState.lichessUsername || "";
    input.disabled = !appState.lichessUsername;
    input.placeholder = appState.lichessUsername ? "" : "not connected";
  }
  const btn = document.getElementById("lichess-compare-btn");
  if (btn) btn.disabled = !appState.lichessUsername;
}

// Drop the Lichess OAuth token. This is NOT a sign-out: the browser stays bound to
// Pull the server's stored connection state (the source of truth with OAuth).
async function refreshLichessStatus() {
  try {
    const status = await api("/api/lichess/status");
    setLichessUsername(status.connected ? status.username : "");
    if (status.connected) startLichessGameWatch();
  } catch (_) {
    renderAccountChip();
  }
}

// Open Lichess sign-in in a popup; the callback page postMessages back, and we
// also poll status as a fallback if the message is blocked.
function startLichessOAuth() {
  const w = 520;
  const h = 660;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(
    "/oauth/login",
    "lichess-oauth",
    `width=${w},height=${h},left=${left},top=${top}`
  );
  setStatus("Opening Lichess sign-in...");
  const onMessage = (event) => {
    if (!event.data || event.data.type !== "lichess-oauth") return;
    window.removeEventListener("message", onMessage);
    if (event.data.ok) {
      refreshLichessStatus();
      // Login rebinds the session to the account profile → now signed in.
      refreshAuthStatus();
      setStatus(`Lichess: ${event.data.detail}`);
    } else {
      setStatus(`Lichess sign-in failed: ${event.data.detail}`);
    }
  };
  window.addEventListener("message", onMessage);
  let tries = 0;
  const poll = window.setInterval(async () => {
    tries += 1;
    try {
      const status = await api("/api/lichess/status");
      if (status.connected) {
        window.clearInterval(poll);
        window.removeEventListener("message", onMessage);
        setLichessUsername(status.username);
        refreshAuthStatus();
        startLichessGameWatch();
        setStatus(`Lichess: ${status.username}`);
        return;
      }
    } catch (_) {
      /* ignore */
    }
    if (tries > 120 || (popup && popup.closed)) window.clearInterval(poll);
  }, 1500);
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

// "My game" button: pull the latest Lichess game straight into the PGN box.
async function fetchMyLichessGame() {
  if (!appState.lichessUsername) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  setStatus("Fetching your latest game...");
  let latest;
  try {
    latest = await api("/api/lichess/latest");
  } catch (error) {
    setStatus(error.message);
    return;
  }
  if (!latest.has_game) {
    setStatus("No recent games found");
    return;
  }
  document.getElementById("pgn-input").value = latest.pgn || "";
  const drawer = document.querySelector("#view-analyze .drawer");
  if (drawer) drawer.open = true;
  if (latest.lichess_id) markLichessSeen(latest.lichess_id);
  setStatus(`Loaded ${latest.white || "?"} vs ${latest.black || "?"} - press Analyze`);
}

// Analyze "History": list previously analyzed games; click to recall a saved
// report without re-running the engine.
async function loadAnalysisHistory() {
  const host = document.getElementById("analysis-history");
  if (!host) return;
  host.innerHTML = '<div class="muted hint">Loading...</div>';
  let payload;
  try {
    payload = await api("/api/analyses");
  } catch (error) {
    host.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!payload.analyses || !payload.analyses.length) {
    host.innerHTML = '<div class="muted hint">No saved analyses yet.</div>';
    return;
  }
  host.innerHTML = payload.analyses
    .map((a) => {
      const when = (a.analyzed_at || "").slice(0, 10);
      return (
        `<button class="history-item" data-game-id="${escapeHtml(a.game_id)}">` +
        `<span class="hi-players">${escapeHtml(a.white || "?")} vs ${escapeHtml(a.black || "?")}</span>` +
        `<span class="hi-meta">${escapeHtml(a.result || "")} · ${escapeHtml(when)}</span>` +
        `</button>`
      );
    })
    .join("");
  host.querySelectorAll(".history-item").forEach((btn) => {
    btn.addEventListener("click", () => recallAnalysis(btn.dataset.gameId));
  });
}

async function recallAnalysis(gameId) {
  setStatus("Loading saved analysis...");
  try {
    const payload = await api(`/api/analyses/${encodeURIComponent(gameId)}`);
    appState.analysis = payload;
    resetAnalysisVariations();
    showAnalysisPly(0);
    renderAnalysis(payload);
    revealAnalysisResults();
    setStatus(`Recalled analysis: ${payload.moves.length} plies`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadDashboardRepertoires() {
  const container = document.getElementById("dashboard-repertoires");
  try {
    const payload = await api("/api/repertoires");
    if (!payload.repertoires || !payload.repertoires.length) {
      container.innerHTML =
        '<div class="empty-state">No repertoires yet. Use Build to create one.</div>';
      return;
    }
    container.innerHTML = payload.repertoires
      .map((item) => {
        const id = escapeHtml(item.id);
        const name = escapeHtml(item.name);
        const color = escapeHtml(item.color);
        const active = item.is_active !== false;
        const cls = active ? "list-item" : "list-item is-disabled";
        const status = active ? "" : ' <span class="sub">· disabled</span>';
        return `
          <button class="${cls}" data-repertoire-id="${id}" data-active="${active ? "1" : "0"}">
            <span>
              <span class="color-dot ${color}"></span>
              <span class="name">${name}</span>
              <span class="sub"> · ${color}</span>${status}
            </span>
            ${healthBadgeHtml(item.health)}
          </button>
        `;
      })
      .join("");
    container.querySelectorAll(".list-item").forEach((button) => {
      button.addEventListener("click", () => editRepertoire(button.dataset.repertoireId));
      button.addEventListener("contextmenu", (event) =>
        openRepertoireContextMenu(event, button.dataset.repertoireId, button.dataset.active === "1")
      );
    });
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

// Compact library-health badge for a repertoire row: a mastery% chip plus the
// counts that actually need attention (weak / due / untrained). Empty when the
// repertoire has no trainable moves yet.
function healthBadgeHtml(health) {
  if (!health || !health.trainable) {
    return '<span class="rep-health rep-health-empty">no moves yet</span>';
  }
  const parts = [];
  if (health.weak) parts.push(`<span class="rh-weak">${health.weak} weak</span>`);
  if (health.due) parts.push(`<span class="rh-due">${health.due} due</span>`);
  if (health.untrained) parts.push(`<span class="rh-untrained">${health.untrained} new</span>`);
  const pct = health.mastery_pct || 0;
  const tier = pct >= 80 ? "high" : pct >= 40 ? "mid" : "low";
  return (
    `<span class="rep-health">` +
    `<span class="rh-pct tier-${tier}">${pct}% mastered</span>` +
    (parts.length ? `<span class="rh-detail">${parts.join(" · ")}</span>` : "") +
    `</span>`
  );
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function showInputModal({ title, fields, okLabel = "OK" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const inputsHtml = fields
      .map((field) => {
        const safeName = escapeHtml(field.name);
        const safeLabel = escapeHtml(field.label || field.name);
        const safeValue = escapeHtml(field.default == null ? "" : String(field.default));
        if (field.type === "textarea") {
          return `
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
              return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
            })
            .join("");
          return `
            <label class="modal-field">
              <span>${safeLabel}</span>
              <select name="${safeName}" data-field>${options}</select>
            </label>
          `;
        }
        const inputType = field.type === "number" ? "number" : "text";
        const numericAttrs =
          field.type === "number"
            ? ` min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}"`
            : "";
        return `
          <label class="modal-field">
            <span>${safeLabel}</span>
            <input name="${safeName}" type="${inputType}" value="${safeValue}"${numericAttrs} data-field />
          </label>
        `;
      })
      .join("");
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">${inputsHtml}</div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">Cancel</button>
          <button class="btn primary" data-action="ok" type="button">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
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
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => close(collect()));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
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
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <p class="modal-copy">${escapeHtml(body)}</p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${okClass}" data-action="ok" type="button">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
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

async function editRepertoire(repertoireId) {
  setStatus("Loading repertoire");
  try {
    const payload = await api(
      `/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`
    );
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    switchView("build");
    setStatus(`Editing ${payload.name}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function trainRepertoire(repertoireId) {
  appState.trainingRepertoireId = repertoireId;
  switchView("train");
  await startTraining();
}

function openRepertoireContextMenu(event, repertoireId, isActive) {
  event.preventDefault();
  const menu = document.getElementById("repertoire-context-menu");
  const safeId = escapeHtml(repertoireId);
  const items = [
    ["train", "Start training"],
    ["edit", "Edit in builder"],
    ["rename", "Rename..."],
    ["toggle-active", isActive ? "Disable" : "Enable"],
    ["delete", "Delete..."],
  ];
  menu.innerHTML = items
    .map(
      ([action, label]) =>
        `<button type="button" data-action="${escapeHtml(action)}" data-repertoire-id="${safeId}">${escapeHtml(label)}</button>`
    )
    .join("");
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () =>
      handleRepertoireContextAction(button.dataset.action, button.dataset.repertoireId, isActive)
    );
  });
}

function closeRepertoireContextMenu() {
  const menu = document.getElementById("repertoire-context-menu");
  if (menu) menu.hidden = true;
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
      await loadDashboardRepertoires();
      setStatus(`Renamed to ${name}`);
      return;
    }
    if (action === "toggle-active") {
      const verb = isActive ? "Disable" : "Enable";
      await postJson("/api/repertoires/set-active", {
        repertoire_id: repertoireId,
        active: !isActive,
      });
      await loadDashboardRepertoires();
      setStatus(`${verb}d repertoire`);
      return;
    }
    if (action === "delete") {
      const confirmed = await showInputModal({
        title: "Delete repertoire?",
        okLabel: "Delete",
        fields: [
          {
            name: "confirm",
            label: "This removes the repertoire and every move in it. Type \"delete\" to confirm.",
            default: "",
          },
        ],
      });
      if (!confirmed) return;
      if ((confirmed.confirm || "").trim().toLowerCase() !== "delete") {
        setStatus("Delete cancelled");
        return;
      }
      await postJson("/api/repertoires/delete", { repertoire_id: repertoireId });
      if (appState.build && appState.build.repertoire_id === repertoireId) {
        appState.build = null;
        appState.buildNodeById = new Map();
        appState.buildCurrentNodeId = null;
        renderBuilderTree();
        document.getElementById("build-board-label").textContent = "No repertoire";
      }
      if (appState.trainingRepertoireId === repertoireId) {
        appState.trainingRepertoireId = null;
      }
      await loadDashboardRepertoires();
      setStatus("Deleted repertoire");
      return;
    }
  } catch (error) {
    setStatus(error.message);
  }
}

function prefillDemoPgn() {
  document.getElementById("pgn-input").value = DEMO_PGN;
}

async function loadDemoAndAnalyze() {
  prefillDemoPgn();
  const drawer = document.querySelector("#view-analyze .drawer");
  if (drawer) drawer.open = true;
  await runAnalysis();
}

// Phase 3d: compute each played move's Maia3 assessment (humanProbability,
// winChanceAfter) IN THE BROWSER so the server's BrilliantAnalyzer (via ReplayMaia) can
// flag brilliancies with zero server compute. Best-effort: if Maia is unavailable (no
// weights) or any inference fails, we return what we have (possibly []), and the analysis
// still completes without brilliancies — exactly the server's no-Maia degradation.
//
// `rating` MUST be the rating the server advertised (prep.brilliant.rating) so the numbers
// match what its analyzer expects. We assess every played move; the server only consults
// the eligible (Best/Excellent) ones, so over-supplying is harmless (and avoids porting the
// win-chance/classification math to JS just to pre-filter).
async function computeBrilliantAssessments({ moves, rating, onProgress, shouldCancel }) {
  const provider = getSharedMaia3Provider();
  const assessments = [];
  const total = moves.length;
  const cancelledError = () => {
    const err = new Error("Analysis stopped");
    err.cancelled = true;
    return err;
  };
  for (let i = 0; i < total; i++) {
    // Before kicking off each assessment. The FIRST iteration's moveAssessment also drives
    // the model download + session init, so this is the pre-init checkpoint too.
    if (shouldCancel && shouldCancel()) throw cancelledError();
    const m = moves[i];
    if (m && m.fen_before && m.uci) {
      const a = await provider.moveAssessment({ fen: m.fen_before, moveUci: m.uci, rating });
      // The await above can span a long download/init/inference; honour a Stop that arrived
      // during it so we neither record this result nor proceed to the next move. (Aborting the
      // in-flight fetch itself is the future AbortSignal work; this stops at the next seam.)
      if (shouldCancel && shouldCancel()) throw cancelledError();
      if (a && Number.isFinite(a.humanProbability) && Number.isFinite(a.winChanceAfter)) {
        assessments.push({
          fen: m.fen_before,
          uci: m.uci,
          human_probability: a.humanProbability,
          win_chance_after: a.winChanceAfter,
        });
      }
    }
    if (onProgress) onProgress(i + 1, total);
  }
  return assessments;
}

async function runAnalysis() {
  // Phase 2: whole-game analysis runs in the browser. The server only parses
  // the PGN (/api/analyze/prepare) and classifies + saves the browser-computed
  // evals (/api/analyze/classify-save) — it never runs an engine.
  if (!isBrowserEngineAvailable()) {
    setStatus(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  const pgn = document.getElementById("pgn-input").value.trim();
  if (!pgn) {
    setStatus("Paste PGN before analyzing");
    return;
  }
  if (jobToast.isBusy()) {
    setStatus("Another job is already running");
    return;
  }
  setStatus("Analyzing PGN");
  hideAnalysisResults();
  const runButton = document.getElementById("run-analysis");
  runButton.disabled = true;

  let cancelled = false;
  const jobId = `browser-analysis-${Date.now()}`;
  try {
    const prep = await postJson("/api/analyze/prepare", { pgn });
    const positions = prep.positions || [];
    if (!positions.length) throw new Error("No positions to analyze");

    jobToast.startJob({
      id: jobId,
      title: "Analyzing game",
      tab: "analyze",
      total: positions.length,
      onCancel: () => {
        cancelled = true;
      },
    });

    const evals = await analyzeGamePositions({
      positions,
      depth: prep.depth,
      multipv: 1,
      onProgress: (done, total) => {
        jobToast.updateJob({
          current: done,
          total,
          message: `evaluating ${done}/${total} positions`,
        });
      },
      shouldCancel: () => cancelled,
    });

    // Phase 3d: browser Brilliant detection. Compute Maia assessments for the played
    // moves (best-effort) so the server can flag brilliancies with no server compute.
    // Maia's ~46 MB model downloads once (then cached); progress shows in the toast.
    // Any failure (no weights / inference error) is swallowed → analysis without
    // brilliancies, mirroring the server's no-Maia path.
    let maiaAssessments = [];
    if (prep.brilliant && prep.brilliant.enabled && Array.isArray(prep.moves) && prep.moves.length) {
      try {
        const provider = getSharedMaia3Provider();
        provider.setInitProgressHandler(({ phase, loaded, total }) => {
          if (phase === "download") {
            const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
            jobToast.updateJob({ message: `loading Maia model · ${pct}%` });
          } else if (phase === "cache") {
            jobToast.updateJob({ message: "loading cached Maia model" });
          }
        });
        try {
          maiaAssessments = await computeBrilliantAssessments({
            moves: prep.moves,
            rating: prep.brilliant.rating,
            shouldCancel: () => cancelled,
            onProgress: (done, total) =>
              jobToast.updateJob({ current: done, total, message: `checking brilliancies ${done}/${total}` }),
          });
        } finally {
          provider.setInitProgressHandler(null);
        }
      } catch (brilliantErr) {
        if (brilliantErr && brilliantErr.cancelled) throw brilliantErr;
        // Non-fatal: proceed with no brilliancies (e.g. Maia weights unavailable).
        maiaAssessments = [];
      }
    }

    // Final cancellation checkpoint: even if eval/Maia work completed, a Stop that arrived
    // during it must prevent persistence. classify-save is the write — don't post past a Stop.
    if (cancelled) {
      const err = new Error("Analysis stopped");
      err.cancelled = true;
      throw err;
    }

    // Past this point we're persisting (classify-save). Like Build Generate's apply phase,
    // the save is not cancellable, so remove the Stop affordance rather than imply a cancel
    // that wouldn't hold.
    jobToast.lockJob();
    jobToast.updateJob({
      current: positions.length,
      total: positions.length,
      message: "classifying",
    });

    const payload = await postJson("/api/analyze/classify-save", {
      game_id: prep.game_id,
      engine: prep.engine || "stockfish (browser)",
      depth: prep.depth,
      positions: positions.map((fen) => {
        const ev = evals.get(fen) || {};
        return {
          fen,
          score_cp: ev.score_cp ?? null,
          mate_in: ev.mate_in ?? null,
          best_move_uci: ev.best_move_uci ?? null,
          pv: ev.pv || [],
        };
      }),
      maia_assessments: maiaAssessments,
    });

    appState.analysis = payload;
    resetAnalysisVariations();
    showAnalysisPly(0);
    renderAnalysis(payload);
    setStatus(`Analysis ready: ${payload.moves.length} plies`);
    jobToast.completeJob({
      title: "Analysis ready",
      message: `${payload.moves.length} plies classified`,
      onClick: () => switchView("analyze"),
    });
    revealAnalysisResults();
  } catch (error) {
    if (error && error.cancelled) {
      setStatus("Analysis stopped");
      jobToast.cancelJob(error.message || "Analysis stopped");
    } else {
      setStatus(error.message);
      jobToast.failJob(error.message);
    }
  } finally {
    runButton.disabled = false;
  }
}

function hideAnalysisResults() {
  const panel = document.getElementById("analysis-results");
  if (!panel) return;
  panel.classList.remove("is-visible");
  panel.hidden = true;
}

function revealAnalysisResults() {
  const panel = document.getElementById("analysis-results");
  if (!panel) return;
  panel.hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      panel.classList.add("is-visible");
      // Now that the chart has real dimensions, round out the key-moment dots.
      rescaleEvalMarkers();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderAnalysis(payload) {
  renderMovePairs(payload.moves);
  renderEvalChart(payload.eval_graph);
  renderClassificationBars(payload.moves);
}

// Group raw move classifications into the handful of buckets a human actually
// reads at a glance. Order here is the left-to-right order on the bar.
const CLASS_GROUPS = [
  { key: "brilliant", label: "Brilliant", members: ["brilliant"] },
  { key: "good", label: "Good", members: ["best", "excellent", "good", "book"] },
  { key: "inaccuracy", label: "Inaccuracy", members: ["inaccuracy"] },
  { key: "mistake", label: "Mistake", members: ["mistake"] },
  { key: "blunder", label: "Blunder", members: ["blunder"] },
  { key: "missed", label: "Missed", members: ["missed_win", "missed_tactic"] },
];
const CLASS_GROUP_OF = (() => {
  const map = {};
  CLASS_GROUPS.forEach((g) => g.members.forEach((m) => (map[m] = g.key)));
  return map;
})();
function classBadgeSymbol(classification) {
  const group = CLASS_GROUP_OF[String(classification || "").toLowerCase()];
  return {
    brilliant: "!!",
    good: "+",
    inaccuracy: "?!",
    mistake: "?",
    blunder: "!",
    missed: "x",
  }[group] || ".";
}

// Per-side segmented bars: White on top, Black below. Each segment's width is
// proportional to how many of that side's moves fell in the bucket; clicking a
// segment jumps the board to that side's first move of that kind. Replaces the
// old alphabetical pill soup that new players couldn't parse.
function renderClassificationBars(moves) {
  const host = document.getElementById("analysis-summary");
  if (!host) return;
  if (!moves || !moves.length) {
    host.innerHTML = "";
    return;
  }
  const tally = { white: {}, black: {} };
  moves.forEach((move) => {
    const side = move.side === "black" ? "black" : "white";
    const group = CLASS_GROUP_OF[move.classification];
    if (!group) return;
    tally[side][group] = (tally[side][group] || 0) + 1;
  });

  const rowHtml = (side, label) => {
    const counts = tally[side];
    const total = CLASS_GROUPS.reduce((sum, g) => sum + (counts[g.key] || 0), 0);
    const segs = CLASS_GROUPS.filter((g) => counts[g.key] > 0)
      .map((g) => {
        const n = counts[g.key];
        const pct = Math.round((n / total) * 100);
        return (
          `<button class="cbar-seg seg-${g.key}" style="flex:${n}" ` +
          `data-side="${side}" data-group="${g.key}" ` +
          `title="${g.label}: ${n}" aria-label="${label} ${g.label}: ${n}">` +
          `<span class="cbar-seg-n">${pct >= 10 ? n : ""}</span></button>`
        );
      })
      .join("");
    const track = total
      ? segs
      : '<span class="cbar-empty">no scored moves</span>';
    return (
      `<div class="cbar-row">` +
      `<span class="cbar-side">${label}</span>` +
      `<span class="cbar-track">${track}</span>` +
      `</div>`
    );
  };

  const legend = CLASS_GROUPS.map(
    (g) => `<span class="cbar-key"><i class="seg-${g.key}"></i>${g.label}</span>`
  ).join("");

  host.innerHTML =
    `<div class="class-bars">` +
    rowHtml("white", "White") +
    rowHtml("black", "Black") +
    `<div class="cbar-legend">${legend}</div>` +
    `</div>`;

  host.querySelectorAll(".cbar-seg").forEach((seg) => {
    seg.addEventListener("click", () => {
      jumpToClassGroup(seg.dataset.side, seg.dataset.group);
      seg.blur();
    });
  });
}

// Jump to the next matching move after the current ply; wrap only when the
// rest of the game has no more moves in that bucket.
function jumpToClassGroup(side, groupKey) {
  const moves = appState.analysis ? appState.analysis.moves : [];
  const current = Number(appState.analysisPly) || 0;
  const matches = (move) =>
    (move.side === "black" ? "black" : "white") === side &&
    CLASS_GROUP_OF[move.classification] === groupKey;
  const match =
    moves.find((m) => Number(m.ply) > current && matches(m)) ||
    moves.find((m) => Number(m.ply) <= current && matches(m));
  if (match) showAnalysisPly(Number(match.ply));
}

async function showAnalysisPly(ply) {
  const moves = appState.analysis ? appState.analysis.moves : [];
  const boundedPly = Math.max(0, Math.min(ply, moves.length));
  appState.analysisPly = boundedPly;
  appState.analysisCurrentNodeId = boundedPly === 0 ? "root" : `m${boundedPly}`;
  const move = boundedPly > 0 ? moves[boundedPly - 1] : null;
  const fen = move ? move.fen_after : moves[0]?.fen_before || START_FEN;
  const info = await boardInfo(fen);
  appState.analysisBoardFen = fen;
  boards.analysis.setPosition({
    fen,
    legalMoves: info.legal_moves,
    lastMove: move ? move.uci : null,
  });
  boards.analysis.setMoveBadge(
    move ? move.uci.slice(2, 4) : null,
    move ? move.classification : null,
    move ? classBadgeSymbol(move.classification) : ""
  );
  document.getElementById("analysis-board-label").textContent = move
    ? `${move.move_number}${move.side === "black" ? "..." : "."} ${move.san}`
    : "Initial position";
  highlightCurrentMove();
  refreshAnalysisExplain({
    fen,
    lastUci: move ? move.uci : null,
    lastSan: move ? move.san : null,
    prevFen: move ? move.fen_before : null,
  });
  if (engineWidget) engineWidget.onBoardChanged();
}

// Tree-aware Analyze navigation (start/prev/next/end). Works for both the analysed
// mainline and free-exploration variations, because it walks the live node tree by
// id rather than a flat ply index. `next` follows the mainline child (children[0]).
function analysisTreeNav(kind) {
  const tree =
    appState.analysisTree ||
    buildAnalysisTree(appState.analysis ? appState.analysis.moves : []);
  appState.analysisTree = tree;
  let node = tree.byId.get(appState.analysisCurrentNodeId || "root") || tree.root;
  if (kind === "start") node = tree.root;
  else if (kind === "prev") node = node.parent || node;
  else if (kind === "next") node = (node.children && node.children[0]) || node;
  else if (kind === "end") {
    while (node.children && node.children[0]) node = node.children[0];
  }
  selectAnalysisNode(node.id);
}

function resetAnalysisVariations() {
  appState.analysisVarNodes = new Map();
  appState.analysisVarCounter = 0;
  appState.analysisCurrentNodeId = "root";
  appState.analysisTree = null;
}

// `renderMovePairs` keeps its name (callers in renderAnalysis) but now renders
// the mainline together with any study variations the player explored.
function renderMovePairs(moves) {
  renderAnalysisTree(moves);
}

// ---------------------------------------------------------------------------
// Shared move-tree renderer — used by both Analyze (study lines) and Build
// (repertoire). Variations render as DOM-nested blocks: a variation lives
// *inside* its parent's block, so each level indents one step further by pure
// nesting (no depth arithmetic) and a sub-variation can never jump to the
// front. The only highlight is the single current move plus a faint trail along
// the line that leads to it — both computed from real node ids, so no phantom
// lines ever light up.
//
//   root: { children: [node, ...] }   children[0] is the mainline continuation
//   node: { id, san, moveNumber, side: "white"|"black", children: [...] }
//   opts: {
//     currentId,                         id of the selected node
//     pathIds: Set<id>,                  nodes on the trail to currentId
//     decorate(node) -> { classes?, suffix?, title? },
//     collapsible, isCollapsed(node)->bool,
//   }
// ---------------------------------------------------------------------------
function renderMoveTree(root, opts) {
  const kids = root.children || [];
  if (!kids.length) {
    return (
      '<div class="mtree"><div class="empty-state">' +
      escapeHtml(opts.emptyText || "No moves yet.") +
      "</div></div>"
    );
  }
  const main = kids[0];
  const alts = kids.slice(1);
  let body = renderMoveLine(main, opts);
  for (const alt of alts) body += renderMoveVariation(alt, opts);
  return `<div class="mtree"><div class="mtree-line is-main">${body}</div></div>`;
}

// Follow the mainline chain from `startNode`, inserting a variation block for
// every alternative move encountered along the way.
function renderMoveLine(startNode, opts) {
  let html = "";
  let cur = startNode;
  let forceNumber = true; // first move of any line is always numbered
  while (cur) {
    html += renderMoveToken(cur, opts, forceNumber);
    forceNumber = false;
    const kids = cur.children || [];
    const main = kids[0] || null;
    for (let i = 1; i < kids.length; i += 1) {
      html += renderMoveVariation(kids[i], opts);
      forceNumber = true; // a block interrupted the flow → re-number on resume
    }
    cur = main;
  }
  return html;
}

function renderMoveVariation(firstNode, opts) {
  const collapsed =
    opts.collapsible && opts.isCollapsed && opts.isCollapsed(firstNode);
  const toggle = opts.collapsible
    ? `<button class="mtree-collapse" type="button" data-collapse-id="${escapeHtml(
        String(firstNode.id)
      )}" title="${collapsed ? "Expand" : "Collapse"} variation">${
        collapsed ? "▸" : "▾"
      }</button>`
    : "";
  const inner = collapsed
    ? '<span class="mtree-collapsed">…</span>'
    : renderMoveLine(firstNode, opts);
  return `<div class="mtree-var">${toggle}${inner}</div>`;
}

function renderMoveToken(node, opts, forceNumber) {
  const isWhite = node.side === "white";
  const numHtml =
    isWhite || forceNumber
      ? `<span class="mtree-num">${node.moveNumber}${isWhite ? "." : "…"}</span>`
      : "";
  const deco = (opts.decorate && opts.decorate(node)) || {};
  const classes = ["mtree-move"];
  if (deco.classes) classes.push(...deco.classes);
  if (node.id === opts.currentId) classes.push("is-current");
  else if (opts.pathIds && opts.pathIds.has(node.id)) classes.push("on-path");
  const title = deco.title ? ` title="${escapeHtml(String(deco.title))}"` : "";
  return (
    `${numHtml}<button class="${classes.join(" ")}" data-node-id="${escapeHtml(
      String(node.id)
    )}"${title}><span class="mtree-san">${escapeHtml(node.san)}</span>${
      deco.suffix || ""
    }</button>`
  );
}

// Wire click (and optional right-click) handlers onto every move in a tree.
function bindMoveTreeClicks(container, onSelect, onContext) {
  container.querySelectorAll(".mtree-move[data-node-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      onSelect(button.dataset.nodeId);
      event.currentTarget.blur();
    });
    if (onContext) {
      button.addEventListener("contextmenu", (event) =>
        onContext(event, button.dataset.nodeId)
      );
    }
  });
}

// Assemble the analyzed mainline plus user-explored variations into a single
// navigable tree. Mainline nodes get stable ids (`m{ply}`); the start position
// is `root`. Variation nodes (`v{n}`) are stored in appState and re-attached on
// every build so they survive re-renders.
function buildAnalysisTree(moves) {
  const startFen = (moves && moves[0] && moves[0].fen_before) || START_FEN;
  const root = {
    id: "root",
    san: null,
    fenAfter: startFen,
    ply: 0,
    isMainline: true,
    isVariation: false,
    parent: null,
    children: [],
  };
  const byId = new Map([["root", root]]);
  let prev = root;
  (moves || []).forEach((move) => {
    const node = {
      id: `m${move.ply}`,
      ply: Number(move.ply),
      san: move.san,
      uci: move.uci,
      fenBefore: move.fen_before,
      fenAfter: move.fen_after,
      moveNumber: move.move_number,
      side: move.side,
      classification: move.classification,
      isMainline: true,
      isVariation: false,
      parent: prev,
      children: [],
    };
    byId.set(node.id, node);
    prev.children.push(node);
    prev = node;
  });
  // Attach variations in creation order so a parent always exists first.
  const pending = Array.from(appState.analysisVarNodes.values()).sort(
    (a, b) => a.seq - b.seq
  );
  for (const v of pending) {
    const parent = byId.get(v.parentId);
    if (!parent) continue; // parent vanished (mainline reloaded) — drop quietly
    const node = {
      id: v.id,
      ply: -1,
      san: v.san,
      uci: v.uci,
      fenBefore: v.fenBefore,
      fenAfter: v.fenAfter,
      moveNumber: v.moveNumber,
      side: v.side,
      classification: null,
      isMainline: false,
      isVariation: true,
      parent,
      children: [],
    };
    byId.set(node.id, node);
    parent.children.push(node);
  }
  return { root, byId };
}

function analysisPathIds(nodeId, tree) {
  const set = new Set();
  let node = tree.byId.get(nodeId || "root");
  while (node) {
    set.add(node.id);
    node = node.parent;
  }
  return set;
}

function renderAnalysisTree(movesArg) {
  const container = document.getElementById("analysis-moves");
  if (!container) return;
  const moves = movesArg || (appState.analysis ? appState.analysis.moves : []);
  // Always build the tree so navigation + free-exploration branching have a live
  // structure even before any game is loaded. A move played on the board attaches
  // a variation node off `root`, so the tree has content the moment the user explores.
  const tree = buildAnalysisTree(moves);
  appState.analysisTree = tree;
  const hasContent = (tree.root.children || []).length > 0;
  if (!hasContent) {
    container.innerHTML =
      '<div class="empty-state">Play moves on the board to branch into study lines, ' +
      "or load a PGN and click Analyze for a full review.</div>";
    return;
  }
  // Reveal the results panel as soon as there's a line to show (loaded game or a
  // user-explored variation); it stays tucked away on a blank start.
  const panel = document.getElementById("analysis-results");
  if (panel && panel.hidden) revealAnalysisResults();
  const pathIds = analysisPathIds(appState.analysisCurrentNodeId, tree);
  container.innerHTML = renderMoveTree(tree.root, {
    currentId: appState.analysisCurrentNodeId,
    pathIds,
    decorate: (node) => {
      if (node.isVariation) {
        return { classes: ["is-variation"], title: "variation" };
      }
      const cls = String(node.classification || "unknown");
      return {
        classes: [`cls-${cls}`],
        suffix: '<span class="mtree-dot"></span>',
        title: cls,
      };
    },
  });
  bindMoveTreeClicks(container, (id) => selectAnalysisNode(id));
  const focus = container.querySelector(".mtree-move.is-current");
  if (focus) focus.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Highlight the active move + sync the eval-chart cursor. The list itself is
// re-rendered from appState.analysisCurrentNodeId so highlighting and variation
// structure can never drift apart.
function highlightCurrentMove() {
  renderAnalysisTree();
  updateEvalChartCursor();
}

async function selectAnalysisNode(nodeId) {
  const tree = appState.analysisTree;
  const node = tree ? tree.byId.get(nodeId) : null;
  if (!node) return;
  if (node.isMainline) {
    await showAnalysisPly(node.ply);
    return;
  }
  // Variation node: drive the board straight to its resulting position.
  appState.analysisCurrentNodeId = node.id;
  appState.analysisPly = -1;
  const fen = node.fenAfter;
  const info = await boardInfo(fen);
  appState.analysisBoardFen = fen;
  boards.analysis.setPosition({
    fen,
    legalMoves: info.legal_moves,
    lastMove: node.uci,
  });
  boards.analysis.setMoveBadge(null, null, "");
  document.getElementById("analysis-board-label").textContent = `${node.moveNumber}${
    node.side === "black" ? "..." : "."
  } ${node.san} · variation`;
  highlightCurrentMove();
  refreshAnalysisExplain({ fen, lastUci: node.uci, lastSan: node.san, prevFen: node.fenBefore });
  if (engineWidget) engineWidget.onBoardChanged();
}

async function onAnalysisBoardMove(moveUci, fen) {
  try {
    const tree = appState.analysisTree;
    const currentId =
      appState.analysisCurrentNodeId ||
      (appState.analysisPly > 0 ? `m${appState.analysisPly}` : "root");
    const currentNode = tree ? tree.byId.get(currentId) : null;
    // Replaying the existing continuation (mainline or a known variation) just
    // steps forward instead of forking a duplicate line.
    if (currentNode) {
      const existing = currentNode.children.find((child) => child.uci === moveUci);
      if (existing) {
        await selectAnalysisNode(existing.id);
        return;
      }
    }
    // New move from here → record it as a study variation branching off the
    // current node.
    const payload = await boardAfterMove(fen, moveUci);
    const parts = fen.split(" ");
    const side = parts[1] === "b" ? "black" : "white";
    const moveNumber = Number(parts[5]) || 1;
    const seq = (appState.analysisVarCounter = (appState.analysisVarCounter || 0) + 1);
    const id = `v${seq}`;
    appState.analysisVarNodes.set(id, {
      id,
      seq,
      parentId: currentId,
      uci: moveUci,
      san: payload.move.san,
      fenBefore: fen,
      fenAfter: payload.board.fen,
      moveNumber,
      side,
    });
    appState.analysisCurrentNodeId = id;
    appState.analysisPly = -1;
    appState.analysisBoardFen = payload.board.fen;
    boards.analysis.setPosition({
      fen: payload.board.fen,
      legalMoves: payload.board.legal_moves,
      lastMove: moveUci,
    });
    boards.analysis.setMoveBadge(null, null, "");
    document.getElementById("analysis-board-label").textContent = `${moveNumber}${
      side === "black" ? "..." : "."
    } ${payload.move.san} · variation`;
    highlightCurrentMove();
    refreshAnalysisExplain({
      fen: payload.board.fen,
      lastUci: moveUci,
      lastSan: payload.move.san,
      prevFen: fen,
    });
    if (engineWidget) engineWidget.onBoardChanged();
  } catch (error) {
    setStatus(error.message);
  }
}

// Colors for key-moment dots on the eval chart. Keep in sync with the
// classification dot colors in styles.css (--brilliant / --warn / --danger).
const EVAL_MARKER_COLORS = {
  brilliant: "#2f7fe0",
  inaccuracy: "#cda04b",
  mistake: "#c98439",
  blunder: "#c4524d",
  missed: "#8a6db5",
};

function renderEvalChart(points) {
  const chart = document.getElementById("eval-chart");
  chart.innerHTML = "";
  appState.evalChartPoints = points || [];
  const width = 640;
  const height = 96;
  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  chart.setAttribute("preserveAspectRatio", "none");
  chart.setAttribute("aria-label", "Evaluation trend by move");
  chart.style.cursor = points && points.length ? "pointer" : "default";

  const axis = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axis.setAttribute("x1", "0");
  axis.setAttribute("x2", String(width));
  axis.setAttribute("y1", String(height / 2));
  axis.setAttribute("y2", String(height / 2));
  axis.setAttribute("stroke", "#d6d2cb");
  axis.setAttribute("stroke-dasharray", "4 4");
  chart.appendChild(axis);
  if (!points || !points.length) return;

  const coords = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height / 2 - (point.bounded_score_cp / 1000) * (height / 2 - 8);
    return { x, y, ply: point.ply, classification: point.classification };
  });

  const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const areaPoints = [
    `0,${height / 2}`,
    ...coords.map((c) => `${c.x},${c.y}`),
    `${width},${height / 2}`,
  ].join(" ");
  area.setAttribute("points", areaPoints);
  area.setAttribute("fill", "rgba(209, 139, 63, 0.18)");
  chart.appendChild(area);

  const svgNS = "http://www.w3.org/2000/svg";
  const polyline = document.createElementNS(svgNS, "polyline");
  polyline.setAttribute("points", coords.map((c) => `${c.x},${c.y}`).join(" "));
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", "#b9722a");
  polyline.setAttribute("stroke-width", "2");
  polyline.setAttribute("stroke-linecap", "round");
  polyline.setAttribute("stroke-linejoin", "round");
  chart.appendChild(polyline);

  // Key-moment markers so a player can jump straight to their brilliancies and
  // errors. preserveAspectRatio="none" stretches the viewBox horizontally, so
  // the radius is compensated per-axis in rescaleEvalMarkers() to keep the dots
  // round on screen; rerun there because this can render while still hidden.
  coords.forEach((c) => {
    const raw = String(c.classification || "").toLowerCase();
    const cls = CLASS_GROUP_OF[raw] || raw;
    const color = EVAL_MARKER_COLORS[cls];
    if (!color) return;
    const dot = document.createElementNS(svgNS, "ellipse");
    dot.classList.add("eval-marker");
    dot.setAttribute("cx", String(c.x));
    dot.setAttribute("cy", String(c.y));
    dot.setAttribute("fill", color);
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", "1.5");
    dot.setAttribute("vector-effect", "non-scaling-stroke");
    dot.setAttribute("data-ply", String(c.ply));
    dot.dataset.baseR = "4.5";
    dot.style.cursor = "pointer";
    const title = document.createElementNS(svgNS, "title");
    title.textContent = cls.charAt(0).toUpperCase() + cls.slice(1);
    dot.appendChild(title);
    dot.addEventListener("click", (event) => {
      event.stopPropagation();
      showAnalysisPly(c.ply);
    });
    chart.appendChild(dot);
  });
  rescaleEvalMarkers();

  const marker = document.createElementNS("http://www.w3.org/2000/svg", "line");
  marker.setAttribute("id", "eval-chart-cursor");
  marker.setAttribute("y1", "0");
  marker.setAttribute("y2", String(height));
  marker.setAttribute("stroke", "#b9722a");
  marker.setAttribute("stroke-width", "1.5");
  marker.setAttribute("stroke-dasharray", "3 3");
  marker.setAttribute("x1", "-10");
  marker.setAttribute("x2", "-10");
  chart.appendChild(marker);

  updateEvalChartCursor();
}

// Keep the round look of key-moment dots despite the chart's non-uniform
// stretch. Safe to call any time (after render, on reveal, on resize).
function rescaleEvalMarkers() {
  const chart = document.getElementById("eval-chart");
  if (!chart) return;
  const markers = chart.querySelectorAll(".eval-marker");
  if (!markers.length) return;
  const viewWidth = 640;
  const viewHeight = 96;
  const rect = chart.getBoundingClientRect();
  const xScale = rect.width > 0 ? viewWidth / rect.width : 1;
  const yScale = rect.height > 0 ? viewHeight / rect.height : 1;
  markers.forEach((dot) => {
    const baseR = Number(dot.dataset.baseR) || 4;
    dot.setAttribute("rx", String(baseR * xScale));
    dot.setAttribute("ry", String(baseR * yScale));
  });
}

function updateEvalChartCursor() {
  const marker = document.getElementById("eval-chart-cursor");
  if (!marker) return;
  const points = appState.evalChartPoints || [];
  if (!points.length) {
    marker.setAttribute("x1", "-10");
    marker.setAttribute("x2", "-10");
    return;
  }
  const ply = appState.analysisPly;
  const idx = points.findIndex((p) => p.ply === ply);
  if (idx < 0) {
    marker.setAttribute("x1", "-10");
    marker.setAttribute("x2", "-10");
    return;
  }
  const width = 640;
  const x = points.length === 1 ? width / 2 : (idx / (points.length - 1)) * width;
  marker.setAttribute("x1", String(x));
  marker.setAttribute("x2", String(x));
}

function bindEvalChart() {
  const chart = document.getElementById("eval-chart");
  chart.addEventListener("click", (event) => {
    const points = appState.evalChartPoints || [];
    if (!points.length) return;
    const rect = chart.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (points.length - 1));
    showAnalysisPly(points[idx].ply);
  });
  window.addEventListener("resize", rescaleEvalMarkers);
}

async function hydrateBuild(payload, selectedNodeId = null) {
  appState.build = payload;
  appState.buildNodeById = new Map(payload.nodes.map((node) => [node.id, node]));
  if (boards.build) boards.build.setOrientation(payload.color === "black" ? "black" : "white");
  const nextNodeId = selectedNodeId || payload.selected_node_id || payload.nodes[0]?.id;
  await selectBuildNode(nextNodeId);
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
    setStatus(error.message);
  }
}

async function skipTrainingLine() {
  if (appState.smart) {
    await skipSmartCard();
    return;
  }
  const prompt = currentTrainingPrompt();
  if (!prompt) {
    setStatus("No active training line");
    return;
  }
  try {
    const result = await postJson("/api/train/skip", { session_id: prompt.session_id });
    if (result.prompt) {
      appState.training.prompt = result.prompt;
      renderTraining(result.prompt);
      setStatus("Skipped to next line");
    } else {
      appState.training.prompt = null;
      if (appState.trainReview && appState.trainReview.queue.length) {
        enterReviewRound();
      } else {
        finishTrainingSession();
      }
      setStatus("Session complete");
    }
  } catch (error) {
    setStatus(error.message);
  }
}

async function selectBuildNode(nodeId) {
  if (!appState.buildNodeById.has(nodeId)) return;
  appState.buildCurrentNodeId = nodeId;
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
      ? `${appState.build.name} - ${appState.build.color}`
      : `${node.move_number}${node.move_side === "black" ? "..." : "."} ${node.san}`;
  document.getElementById("build-board-label").textContent = label;
  renderBuilderTree();
  if (engineWidget) engineWidget.onBoardChanged();
  scheduleExplorerRefresh();
}

// ----- Opening explorer (Build sidebar) ---------------------------------------
// Real-game stats for the current Build position, fetched straight from Lichess's
// public CORS-open explorer — the PrepForge server never proxies a byte. The
// module is dynamically imported on first open so its code stays out of the boot
// bundle; the client inside it handles caching, request dedup, and 429 cooldown
// (see explorer.js). Here we only debounce navigation and skip work while closed.

let explorerModule = null;
let explorerClient = null;
let explorerDb = "masters";
let explorerTimer = null;
let explorerSeq = 0;

function explorerDrawerOpen() {
  const drawer = document.getElementById("explorer-drawer");
  return !!(drawer && drawer.open);
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
    rows.innerHTML = '<div class="muted hint">Open a repertoire to see real-game stats.</div>';
    return;
  }
  const seq = ++explorerSeq;
  try {
    if (!explorerModule) {
      rows.innerHTML = '<div class="muted hint">Loading explorer…</div>';
      explorerModule = await import("./explorer.js");
      explorerClient = explorerModule.createExplorerClient({});
    }
    const stats = await explorerClient.fetchStats(explorerDb, fen, {
      rating: effectiveMaiaRating(),
    });
    if (seq !== explorerSeq || !explorerDrawerOpen()) return; // superseded
    renderExplorerRows(stats);
  } catch (error) {
    if (seq !== explorerSeq) return;
    if (explorerModule && error instanceof explorerModule.ExplorerRateLimited) {
      const secs = Math.max(1, Math.ceil(error.retryInMs / 1000));
      rows.innerHTML = `<div class="muted hint">Lichess asks for a short pause - try again in ~${secs}s.</div>`;
    } else {
      rows.innerHTML = `<div class="muted hint">Explorer unavailable: ${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderExplorerRows(stats) {
  const rows = document.getElementById("explorer-rows");
  if (!rows) return;
  const openingEl = document.getElementById("explorer-opening");
  if (openingEl) openingEl.textContent = stats.opening || "";
  if (!stats.moves.length) {
    rows.innerHTML = '<div class="muted hint">No games reached this position - true novelty territory.</div>';
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
  rows.innerHTML = stats.moves
    .map(
      (m) => `
    <button type="button" class="explorer-row" data-uci="${escapeHtml(m.uci)}" title="Add ${escapeHtml(m.san)} to the repertoire">
      <span class="explorer-san">${escapeHtml(m.san)}${inRep.has(m.uci) ? '<span class="explorer-inrep" title="In your repertoire">&#9679;</span>' : ""}</span>
      <span class="explorer-games">${explorerModule.formatGames(m.total)}</span>
      <span class="explorer-bar" aria-label="White ${m.whitePct}% / draw ${m.drawPct}% / Black ${m.blackPct}%">
        <span class="explorer-bar-w" style="width:${m.whitePct}%"></span><span class="explorer-bar-d" style="width:${m.drawPct}%"></span><span class="explorer-bar-b" style="width:${m.blackPct}%"></span>
      </span>
    </button>`,
    )
    .join("");
  rows.querySelectorAll(".explorer-row").forEach((btn) => {
    btn.addEventListener("click", () => onBuildBoardMove(btn.dataset.uci));
  });
}

// Normalize the flat repertoire node list into the shared tree shape, with the
// mainline child first at every branch point.
function buildNormalizedTree() {
  if (!appState.build) return null;
  const childrenByParent = new Map();
  let rootNode = null;
  for (const node of appState.build.nodes) {
    if (node.depth === 0) {
      rootNode = node;
      continue;
    }
    if (!childrenByParent.has(node.parent_id)) childrenByParent.set(node.parent_id, []);
    childrenByParent.get(node.parent_id).push(node);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
  }
  if (!rootNode) return null;
  const make = (bnode) => ({
    id: bnode.id,
    san: bnode.san,
    moveNumber: bnode.move_number,
    side: bnode.move_side,
    raw: bnode,
    children: (childrenByParent.get(bnode.id) || []).map(make),
  });
  return make(rootNode);
}

function renderBuilderTree() {
  const container = document.getElementById("builder-tree");
  const branchBar = document.getElementById("build-branchbar");
  if (!appState.build) {
    container.innerHTML =
      '<div class="empty-state">No repertoire loaded. Press <b>New</b> or import one from the Dashboard.</div>';
    if (branchBar) branchBar.hidden = true;
    if (boards.build) boards.build.setBranchArrows([]);
    return;
  }
  const root = buildNormalizedTree();
  if (!root || !root.children.length) {
    container.innerHTML =
      renderBuildBreadcrumb() +
      '<div class="empty-state">Play a move on the board to add it to the repertoire.</div>';
    if (branchBar) branchBar.hidden = true;
    if (boards.build) boards.build.setBranchArrows([]);
    return;
  }
  const collapsed = appState.buildCollapsed || (appState.buildCollapsed = new Set());
  const pathIds = new Set(buildPath(appState.buildCurrentNodeId).map((n) => n.id));
  const treeHtml = renderMoveTree(root, {
    currentId: appState.buildCurrentNodeId,
    pathIds,
    collapsible: true,
    isCollapsed: (node) => collapsed.has(node.id),
    decorate: (node) => {
      const b = node.raw;
      const classes = [];
      if (b.mastery) classes.push(`m-${b.mastery}`);
      if (!b.is_enabled) classes.push("is-disabled");
      if (b.is_mainline) classes.push("is-main");
      if (b.is_prepared) classes.push("is-prep");
      return { classes };
    },
  });
  container.innerHTML = renderBuildBreadcrumb() + treeHtml;
  container.querySelectorAll(".mtree-collapse[data-collapse-id]").forEach((toggle) => {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = toggle.dataset.collapseId;
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      renderBuilderTree();
    });
  });
  bindMoveTreeClicks(
    container,
    (id) => selectBuildNode(id),
    (event, id) => openNodeContextMenu(event, id)
  );
  container.querySelectorAll(".mtree-crumb[data-node-id]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      selectBuildNode(btn.dataset.nodeId);
      event.currentTarget.blur();
    });
  });
  const focusBtn = container.querySelector(".mtree .mtree-move.is-current");
  if (focusBtn) focusBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderBuildBranchBar();
}

// A sticky one-line trail from the opening move to the selected node, so the
// active line is always easy to read regardless of how branchy the tree is.
function renderBuildBreadcrumb() {
  const path = buildPath(appState.buildCurrentNodeId).filter((n) => n.depth > 0);
  if (!path.length) {
    return (
      '<div class="build-breadcrumb">' +
      '<span class="crumb-empty">Start position - play a move or pick a line below</span>' +
      "</div>"
    );
  }
  const inner = path
    .map((node, i) => {
      const prev = i > 0 ? path[i - 1] : null;
      const isWhite = node.move_side === "white";
      const needNumber = i === 0 || isWhite || !prev || prev.move_side !== "white";
      const numberHtml = needNumber
        ? `<span class="mtree-num">${node.move_number}${isWhite ? "." : "…"}</span>`
        : "";
      const cur = node.id === appState.buildCurrentNodeId ? " is-current" : "";
      return (
        numberHtml +
        `<button class="mtree-crumb${cur}" data-node-id="${escapeHtml(node.id)}">` +
        `${escapeHtml(node.san)}</button>`
      );
    })
    .join("");
  return `<div class="build-breadcrumb">${inner}</div>`;
}

function buildPath(nodeId) {
  const path = [];
  let current = appState.buildNodeById.get(nodeId);
  while (current) {
    path.push(current);
    current = current.parent_id ? appState.buildNodeById.get(current.parent_id) : null;
  }
  return path.reverse();
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

// Branch alternatives at the SAME move (siblings sharing a parent), mainline first.
function buildSiblingsOf(node) {
  if (!appState.build || !node) return [];
  return appState.build.nodes
    .filter((n) => n.parent_id === node.parent_id && n.depth > 0)
    .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
}

// The next-move branches from a node (its children), mainline first.
function buildChildrenOf(nodeId) {
  if (!appState.build || !nodeId) return [];
  return appState.build.nodes
    .filter((n) => n.parent_id === nodeId)
    .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
}

// The branch picture at the current node: either the alternatives to the current move
// ("current" — switch between them with up/down), or, when the current move is forced,
// the next-move branches ahead ("next" — step into one with →). Drives both the on-screen
// branch bar and the up/down key behaviour so the two always agree.
function buildBranchContext() {
  if (!appState.build || !appState.buildCurrentNodeId) return null;
  const current = appState.buildNodeById.get(appState.buildCurrentNodeId);
  if (!current) return null;
  const siblings = buildSiblingsOf(current);
  if (siblings.length >= 2) {
    return { mode: "current", node: current, options: siblings, activeId: current.id };
  }
  const children = buildChildrenOf(current.id);
  if (children.length >= 2) {
    return { mode: "next", node: current, options: children, activeId: null };
  }
  return { mode: "none", node: current, options: [], activeId: null };
}

// Up/Down on the Build board switch between the branch ALTERNATIVES at the current move
// (no mouse needed) and do nothing else. They deliberately do NOT fall back to forward/
// back: stepping along the line is ← →'s job, and having ↑ ↓ also move the cursor through
// the move list made the two feel tangled and jumpy. With no alternatives here, ↑ ↓ are
// inert — ← → still navigates, and → enters a forced branch point.
function buildBranchKey(direction) {
  const ctx = buildBranchContext();
  if (!ctx || ctx.mode !== "current") return;
  const opts = ctx.options;
  const idx = opts.findIndex((n) => n.id === ctx.node.id);
  const next = opts[(idx + direction + opts.length) % opts.length];
  if (next) selectBuildNode(next.id);
}

// The on-screen branch switcher: a compact strip of the branch options at the current
// point, the active one lit, with a key hint. Mirrors what up/down will do. Also paints
// faint arrows on the board for the next-move branches so a fork is visible there too.
function renderBuildBranchBar() {
  const bar = document.getElementById("build-branchbar");
  if (!bar) return;
  const ctx = buildBranchContext();
  if (!ctx || ctx.mode === "none") {
    bar.hidden = true;
    bar.innerHTML = "";
    if (boards.build) boards.build.setBranchArrows([]);
    return;
  }
  const label = ctx.mode === "current" ? "Branches at this move" : "Next-move branches";
  const hint = ctx.mode === "current" ? "↑ ↓ to switch" : "→ to enter · ↑ ↓ once inside";
  const activeIdx =
    ctx.mode === "current" ? Math.max(0, ctx.options.findIndex((n) => n.id === ctx.activeId)) : -1;
  const chips = ctx.options
    .map((n, i) => {
      const isWhite = n.move_side === "white";
      const num = `${n.move_number}${isWhite ? "." : "…"}`;
      const cls = [
        "branch-chip",
        n.id === ctx.activeId ? "is-active" : "",
        n.is_mainline ? "is-main" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return (
        `<button class="${cls}" type="button" data-node-id="${escapeHtml(String(n.id))}" ` +
        `title="Go to ${escapeHtml(n.san)}"><span class="branch-num">${num}</span>` +
        `<span class="branch-san">${escapeHtml(n.san)}</span></button>`
      );
    })
    .join("");
  const counter =
    ctx.mode === "current" && ctx.options.length > 1
      ? `<span class="branchbar-count">${activeIdx + 1}/${ctx.options.length}</span>`
      : `<span class="branchbar-count">${ctx.options.length}</span>`;
  bar.hidden = false;
  bar.innerHTML =
    `<div class="branchbar-head"><span class="branchbar-label">${label}</span>${counter}` +
    `<span class="branchbar-hint">${hint}</span></div>` +
    `<div class="branchbar-chips">${chips}</div>`;
  bar.querySelectorAll(".branch-chip[data-node-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectBuildNode(btn.dataset.nodeId);
      btn.blur();
    });
  });
  // Board echo: only the next-move branches map cleanly onto the current position.
  if (boards.build) {
    boards.build.setBranchArrows(
      ctx.mode === "next" ? ctx.options.map((n) => n.uci).filter(Boolean) : []
    );
  }
}

async function saveBuildAnnotations(arrows, circles) {
  if (activeViewName() !== "build") return;
  if (!appState.build || !appState.buildCurrentNodeId) return;
  const nodeId = appState.buildCurrentNodeId;
  const node = appState.buildNodeById.get(nodeId);
  if (node) {
    node.arrows = arrows.slice();
    node.circles = circles.slice();
  }
  try {
    await postJson("/api/build/annotations", {
      repertoire_id: appState.build.repertoire_id,
      node_id: nodeId,
      arrows,
      circles,
    });
  } catch (error) {
    setStatus(error.message);
  }
}

async function onBuildBoardMove(moveUci) {
  try {
    if (!appState.build || !appState.buildCurrentNodeId) {
      const created = await createRepertoirePrompt({
        title: "Start a new repertoire",
        defaultName: "New repertoire",
      });
      if (!created) {
        setStatus("Cancelled - playing the move would create a new repertoire");
        return;
      }
    }
    const payload = await postJson("/api/build/add-move", {
      repertoire_id: appState.build.repertoire_id,
      parent_node_id: appState.buildCurrentNodeId,
      move_uci: moveUci,
    });
    await hydrateBuild(payload, payload.selected_node_id);
    setStatus(`Added ${moveUci}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function createRepertoirePrompt({ title, defaultName, openAfter = true } = {}) {
  const result = await showInputModal({
    title: title || "New repertoire",
    okLabel: "Create",
    fields: [
      { name: "name", label: "Name", default: defaultName || "New repertoire" },
      { name: "color", label: "Your color (white / black)", default: "white" },
    ],
  });
  if (!result) return null;
  const name = (result.name || "").trim() || "New repertoire";
  const color = ((result.color || "white").trim().toLowerCase() === "black") ? "black" : "white";
  try {
    const payload = await postJson("/api/repertoires/create", { name, color });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    if (openAfter) switchView("build");
    setStatus(`Created ${name}`);
    await loadDashboardRepertoires();
    return payload;
  } catch (error) {
    setStatus(error.message);
    return null;
  }
}

async function dashboardImportPgn() {
  const input = document.getElementById("dashboard-import-input");
  input.value = "";
  input.click();
}

async function handleImportPgnFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (error) {
    setStatus("Could not read file");
    return;
  }
  const isJson = file.name.toLowerCase().endsWith(".json") || text.trim().startsWith("{");
  if (isJson) {
    try {
      const payload = await postJson("/api/repertoires/import", { package_json: text });
      await hydrateBuild(payload, payload.selected_node_id);
      appState.trainingRepertoireId = payload.repertoire_id;
      await loadDashboardRepertoires();
      setStatus(`Imported ${payload.name}`);
    } catch (error) {
      setStatus(error.message);
    }
    return;
  }
  const meta = await showInputModal({
    title: "Import PGN as repertoire",
    okLabel: "Import",
    fields: [
      { name: "name", label: "Name", default: file.name.replace(/\.[^.]+$/, "") },
      { name: "color", label: "Your color (white / black)", default: "white" },
    ],
  });
  if (!meta) return;
  const name = (meta.name || "").trim() || "Imported";
  const color = ((meta.color || "white").trim().toLowerCase() === "black") ? "black" : "white";
  try {
    const payload = await postJson("/api/repertoires/import-pgn", { pgn: text, name, color });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    await loadDashboardRepertoires();
    setStatus(`Imported ${name}`);
  } catch (error) {
    setStatus(error.message);
  }
}

// Make an element accept dropped files. `onFile` receives the first file; the
// element gets a .drag-over class while a drag hovers for visual feedback.
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
  try {
    const text = await file.text();
    document.getElementById("pgn-input").value = text;
    const drawer = document.querySelector("#view-analyze .drawer");
    if (drawer) drawer.open = true;
    setStatus(`Loaded ${file.name} - press Analyze`);
  } catch (_) {
    setStatus("Could not read file");
  }
}

async function generateFromCurrentNode() {
  // Phase 3c: generation runs in the BROWSER. Stockfish (our turn) + Maia3
  // (opponent) drive the recursion locally into a tree-mutation plan; the server
  // only re-validates + persists via /api/build/generate/apply-plan. No server
  // compute, no fallback.
  if (!isBrowserEngineAvailable()) {
    setStatus(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  const nodeId = appState.buildCurrentNodeId;
  if (!appState.build || !nodeId) {
    setStatus("Open or create a repertoire first");
    return;
  }
  if (jobToast.isBusy()) {
    setStatus("Another job is already running");
    return;
  }
  const repColor = appState.build.color === "black" ? "black" : "white";
  const values = await showInputModal({
    title: "Generate moves from this position",
    okLabel: "Generate",
    fields: [
      {
        name: "own_color",
        label: "Your side (whose best moves to build)",
        type: "select",
        default: repColor,
        options: [
          { value: "white", label: "White" + (repColor === "white" ? " - your repertoire" : " - explore opponent") },
          { value: "black", label: "Black" + (repColor === "black" ? " - your repertoire" : " - explore opponent") },
        ],
      },
      // Kept conservative on purpose: the recursion runs locally (deep × branches
      // is slow on the user's machine) and a huge tree risks exceeding the server
      // apply-plan caps. See GEN_MAX_* / GEN_PLAN_CHANGES_SOFT_CAP.
      { name: "ply_depth", label: `Ply depth (1-${GEN_MAX_PLY_DEPTH})`, type: "number", default: 6, min: 1, max: GEN_MAX_PLY_DEPTH },
      {
        name: "own_side_candidate_count",
        label: `Your-move branches per node (1-${GEN_MAX_BRANCHES})`,
        type: "number",
        default: 1,
        min: 1,
        max: GEN_MAX_BRANCHES,
      },
      {
        name: "detail_mode",
        label: "Detail mode",
        type: "select",
        default: "balanced",
        options: [
          { value: "simple", label: "simple - mainline + first-level branches" },
          { value: "balanced", label: "balanced - recurse, 10% / 30% thresholds" },
          { value: "deep", label: "deep - same as balanced, intended for shallower depth" },
        ],
      },
      // Defaults to the player's own strength (Settings → Playing strength), so the
      // generated tree leans toward replies THEIR opponents actually play.
      { name: "maia_rating", label: "Maia rating (600-2600)", type: "number", default: effectiveMaiaRating(), min: 600, max: 2600 },
    ],
  });
  if (!values) return;
  const ownColor = values.own_color === "black" ? "black" : "white";
  const plyDepth = Math.max(1, Math.min(GEN_MAX_PLY_DEPTH, Number(values.ply_depth) || 6));
  const ownSideCandidateCount = Math.max(
    1,
    Math.min(GEN_MAX_BRANCHES, Number(values.own_side_candidate_count) || 1),
  );
  const detailMode = ["simple", "balanced", "deep"].includes(values.detail_mode)
    ? values.detail_mode
    : "balanced";
  const maiaRating = Math.max(600, Math.min(2600, Number(values.maia_rating) || effectiveMaiaRating()));

  const jobId = `browser-generate-${Date.now()}`;
  // Cancel model has two phases. GENERATION (local, before the POST) is
  // cancellable: jobToast's Stop aborts the controller, the recursion checks the
  // signal, and an explicit re-check below bails before the POST — so Stop here
  // persists NOTHING. SAVING (the apply-plan POST) is NOT cancellable: an atomic
  // server apply can't be un-persisted by aborting the fetch, so we remove the
  // Stop button before the POST rather than imply a cancel that wouldn't hold.
  const controller = new AbortController();
  try {
    setStatus("Loading engines and generating moves");
    jobToast.startJob({
      id: jobId,
      title: "Generating moves",
      tab: "build",
      total: 0,
      onCancel: () => controller.abort(),
    });

    const plan = await runBrowserBuildGenerate({
      build: appState.build,
      rootNodeId: nodeId,
      ownColor,
      plyDepth,
      detailMode,
      maiaRating,
      ownSideCandidateCount,
      signal: controller.signal,
      // Reuse ONE warm Maia worker/session across Generate runs (Stage 4b) — the first run
      // downloads + caches the ~46 MB model, later runs skip both the fetch and the session
      // create. The orchestrator borrows it and never terminates it.
      maiaProvider: getSharedMaia3Provider(),
      onProgress: (added) => {
        jobToast.updateJob({ current: added, total: 0, message: `building tree · +${added} nodes` });
      },
      // Cold-init weight download/verify/session progress (only on the first run / a cache
      // miss). A warm run emits nothing, so the node-building message above just takes over.
      onMaiaInitProgress: ({ phase, loaded, total }) => {
        if (phase === "download") {
          const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          jobToast.updateJob({ current: loaded, total: total || 0, message: `downloading Maia model · ${pct}%` });
        } else if (phase === "cache") {
          jobToast.updateJob({ message: "loading cached Maia model" });
        } else if (phase === "verify") {
          jobToast.updateJob({ message: "verifying Maia model" });
        } else if (phase === "session") {
          jobToast.updateJob({ message: "starting Maia engine" });
        }
      },
    });

    // Stop pressed during generation (or in the final stretch before we got
    // here) must mean NOTHING is persisted: bail before the POST. The recursion
    // also checks the signal, but it can resolve a tick after the last check.
    if (controller.signal.aborted) {
      const err = new Error("Generation stopped");
      err.name = "AbortError";
      throw err;
    }

    const changeCount = (plan.changes && plan.changes.length) || 0;
    if (changeCount > GEN_PLAN_CHANGES_SOFT_CAP) {
      // The server would reject this with a 400; fail with an actionable message
      // before wasting the round trip.
      throw new Error(
        `That produced ${changeCount} changes, more than the server accepts ` +
          `(${GEN_PLAN_CHANGES_SOFT_CAP}). Lower the ply depth or branch count and try again.`,
      );
    }

    // Committing to the save now. Aborting the apply-plan fetch can't un-persist
    // an atomic server apply, so the saving phase is NOT cancellable: remove the
    // Stop button (synchronously, before the awaited POST, so no late click can
    // land in the gap) rather than let the UI imply a cancel that wouldn't hold.
    jobToast.updateJob({
      current: plan.addedCount || 0,
      total: plan.addedCount || 0,
      message: "saving",
    });
    jobToast.lockJob("saving — finishing up");
    const payload = await postJson(
      "/api/build/generate/apply-plan",
      {
        repertoire_id: appState.build.repertoire_id,
        root_node_id: nodeId,
        plan,
      },
      { signal: controller.signal },
    );
    await hydrateBuild(payload, nodeId);
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
      setStatus(error.message);
      jobToast.failJob(error.message);
    }
  }
}

function openNodeContextMenu(event, nodeId) {
  event.preventDefault();
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
  const safeId = escapeHtml(nodeId);
  menu.innerHTML = sections
    .map(
      (section) =>
        `<div class="context-section">${escapeHtml(section.title)}</div>` +
        section.items
          .map(
            ([action, label]) =>
              `<button type="button" data-action="${escapeHtml(
                action
              )}" data-node-id="${safeId}">${escapeHtml(label)}</button>`
          )
          .join("")
    )
    .join("");
  menu.hidden = false;
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
  const node = appState.buildNodeById.get(nodeId);
  if (!node) return;
  try {
    if (action === "generate") {
      appState.buildCurrentNodeId = nodeId;
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
    if (action === "delete") {
      const confirmed = await showInputModal({
        title: "Delete this move and its branch?",
        okLabel: "Delete",
        fields: [
          {
            name: "confirm",
            label: `Type "delete" to confirm removing ${node.san}`,
            default: "",
          },
        ],
      });
      if (!confirmed) return;
      if ((confirmed.confirm || "").trim().toLowerCase() !== "delete") {
        setStatus("Delete cancelled (confirmation text didn't match)");
        return;
      }
      const payload = await postJson("/api/build/action", {
        repertoire_id: appState.build.repertoire_id,
        node_id: nodeId,
        action: "delete",
      });
      await hydrateBuild(payload, payload.selected_node_id);
      setStatus(`Deleted ${node.san}`);
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
    setStatus(error.message);
  }
}

function closeNodeContextMenu() {
  document.getElementById("node-context-menu").hidden = true;
}

async function exportBuild(format, nodeId = null) {
  if (!appState.build) {
    setStatus("Open a repertoire first");
    return;
  }
  // Full tree-with-variations PGN for top-level "Export PGN" calls
  if (format === "pgn" && !nodeId) {
    const payload = await api(
      `/api/repertoires/export-pgn?repertoire_id=${encodeURIComponent(appState.build.repertoire_id)}`
    );
    downloadText(payload.filename, payload.mime, payload.content);
    setStatus(`Downloaded ${payload.filename}`);
    return;
  }
  const payload = await postJson("/api/build/export", {
    repertoire_id: appState.build.repertoire_id,
    format,
    node_id: nodeId,
  });
  downloadText(payload.filename, payload.mime, payload.content);
  setStatus(`Downloaded ${payload.filename}`);
}

async function importRepertoireFromInput(inputId) {
  try {
    const packageJson = await readSelectedFile(document.getElementById(inputId));
    const payload = await postJson("/api/repertoires/import", { package_json: packageJson });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    setStatus(`Imported ${payload.name}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadTrainRepertoireOptions() {
  const select = document.getElementById("train-repertoire-select");
  if (!select) return;
  let active = [];
  try {
    const payload = await api("/api/repertoires");
    active = (payload.repertoires || []).filter((r) => r.is_active !== false);
  } catch (error) {
    setStatus(error.message);
  }
  const previous =
    appState.trainingRepertoireId ||
    (active.length ? active[0].id : "__demo__");
  const options = [
    '<option value="__demo__">Demo repertoire</option>',
    ...active.map(
      (r) =>
        `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} (${escapeHtml(r.color)})</option>`
    ),
  ];
  select.innerHTML = options.join("");
  // Restore previous selection when still valid.
  const valid = new Set(["__demo__", ...active.map((r) => r.id)]);
  select.value = valid.has(previous) ? previous : (active.length ? active[0].id : "__demo__");
  if (select.value !== "__demo__") {
    appState.trainingRepertoireId = select.value;
  } else {
    appState.trainingRepertoireId = null;
  }
}

function selectedTrainRepertoireId() {
  const select = document.getElementById("train-repertoire-select");
  if (!select) return appState.trainingRepertoireId;
  const value = select.value;
  if (!value || value === "__demo__") return null;
  return value;
}

function trainStatsReset() {
  appState.trainStats = { correct: 0, mistakes: 0, streak: 0, best: 0, history: [], lastStreak: 0 };
  appState.trainReview = { queue: [], index: 0, active: false, savedStreak: 0, recovered: 0 };
}

function sideToMoveFromFen(fen) {
  return (fen || "").split(" ")[1] === "b" ? "black" : "white";
}

// The player's calendar day in their own timezone (not UTC) — the server keys
// the daily training streak off this so a late-evening session counts for the
// day the player actually lived it.
function localDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function setTrainBanner(state, title, sub) {
  const banner = document.getElementById("train-banner");
  if (!banner) return;
  banner.dataset.state = state;
  document.getElementById("train-banner-title").textContent = title;
  document.getElementById("train-banner-sub").textContent = sub || "";
  if (state === "correct" || state === "wrong") {
    banner.classList.remove("flash");
    void banner.offsetWidth;
    banner.classList.add("flash");
  }
}

function renderTrainStats() {
  const s = appState.trainStats || { correct: 0, mistakes: 0, streak: 0, history: [], lastStreak: 0 };
  const streakEl = document.getElementById("train-stat-streak");
  const flame = "";
  streakEl.innerHTML = `${s.streak}${flame}`;
  // Pop the streak chip whenever it grows; mark at-risk if recovery is pending.
  const chip = streakEl.closest(".train-stat");
  if (chip) {
    chip.classList.toggle("at-risk", !!(appState.trainReview && appState.trainReview.savedStreak > 0 && s.streak === 0));
    if (s.streak > (s.lastStreak || 0)) {
      chip.classList.remove("pop");
      void chip.offsetWidth;
      chip.classList.add("pop");
      if (s.streak > 0 && s.streak % 5 === 0) chip.classList.add("milestone");
      else chip.classList.remove("milestone");
    }
  }
  s.lastStreak = s.streak;
  document.getElementById("train-stat-correct").textContent = s.correct;
  document.getElementById("train-stat-mistakes").textContent = s.mistakes;
  const total = s.correct + s.mistakes;
  document.getElementById("train-accuracy").textContent = total
    ? `${Math.round((s.correct / total) * 100)}%`
    : "100%";
  const trail = document.getElementById("train-line-trail");
  if (!s.history.length) {
    trail.innerHTML = '<span class="trail-empty">No moves yet</span>';
  } else {
    trail.innerHTML = s.history
      .slice(-26)
      .map((ok) => `<span class="trail-pip ${ok ? "ok" : "no"}"></span>`)
      .join("");
  }
}

async function startTraining(mode) {
  mode = mode || appState.trainMode || "smart";
  appState.trainMode = mode;
  if (mode === "smart") {
    await startSmartTraining();
    return;
  }
  // ----- legacy line rehearsal (all_lines) below -----
  appState.smart = null;
  clearBlitzTimer();
  setBlitzBarVisible(false);
  setSmartPanelsHidden();
  setStatus("Starting trainer");
  const repertoireId = selectedTrainRepertoireId();
  appState.trainingRepertoireId = repertoireId;
  // No unauthenticated demo in the SaaS model: training is always against one of the
  // user's own repertoires. Without one, prompt them to build first instead of
  // hitting a (now-removed) demo endpoint.
  if (!repertoireId) {
    setStatus("Create a repertoire in Build first, then train it.");
    setTrainBanner("done", "No repertoire to train", "Build a repertoire, then start the trainer.");
    return;
  }
  const body = { seed: 13, mode, repertoire_id: repertoireId };
  try {
    const payload = await postJson("/api/train/start", body);
    appState.training = payload;
    trainStatsReset();
    if (boards.train && payload.color) {
      boards.train.setOrientation(payload.color === "black" ? "black" : "white");
    }
    document.getElementById("train-progress-panel").hidden = false;
    renderTrainStats();
    if (payload.prompt) {
      renderTraining(payload);
    } else {
      boards.train.setEngineArrow(null);
      setTrainBanner("done", "No trainable lines here", "Add prepared moves in Build, then train.");
      document.getElementById("train-board-label").textContent = "Nothing to train yet";
    }
    setStatus(`Trainer ready: ${payload.lines.length} lines`);
  } catch (error) {
    setStatus(error.message);
  }
}

function renderTraining(payloadOrPrompt) {
  const prompt = payloadOrPrompt.prompt || payloadOrPrompt;
  if (!prompt) return;
  if (appState.training) appState.training.prompt = prompt;
  appState.trainHintLevel = 0;
  appState.trainHintInfo = null;
  boards.train.setEngineArrow(null); // clear any lingering hint arrow
  boards.train.setPosition({
    fen: prompt.fen_before,
    legalMoves: prompt.legal_moves || [],
    lastMove: null,
  });
  const side = sideToMoveFromFen(prompt.fen_before);
  setTrainBanner("move", `${side === "white" ? "White" : "Black"} to move`, "Play your prepared move on the board");
  updateTrainTurnBadge(side);
  const total = prompt.total_lines || 1;
  document.getElementById("train-line-label").textContent = `Line ${(prompt.current_index || 0) + 1} / ${total}`;
  document.getElementById("train-progress-fill").style.width =
    `${Math.round(((prompt.current_index || 0) / Math.max(1, total)) * 100)}%`;
  const name = (appState.training && appState.training.repertoire_name) || "Repertoire";
  const color = (appState.training && appState.training.color) || "white";
  document.getElementById("train-board-label").textContent = `${name} - you play ${color}`;
}

async function submitTrainingMove(playedUci) {
  if (appState.smart) {
    return submitSmartMove(playedUci);
  }
  if (appState.trainReview && appState.trainReview.active) {
    return submitReviewMove(playedUci);
  }
  const prompt = currentTrainingPrompt();
  if (!prompt || !playedUci || appState.trainBusy) return;
  let result;
  try {
    result = await api("/api/train/move", {
      method: "POST",
      body: JSON.stringify({
        session_id: prompt.session_id,
        played_uci: playedUci,
        local_date: localDateString(),
      }),
    });
  } catch (error) {
    setStatus(error.message);
    return;
  }
  if (result.day_streak) appState.dayStreak = result.day_streak;
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);
  const review = appState.trainReview;
  appState.trainHintLevel = 0;

  if (!result.correct) {
    stats.mistakes += 1;
    // Remember the best streak so the recovery round can hand it back, then
    // break the running streak (it's "at risk", not gone for good).
    if (stats.streak > review.savedStreak) review.savedStreak = stats.streak;
    stats.streak = 0;
    stats.history.push(false);
    // Queue this missed position for the end-of-session recovery round.
    if (!review.queue.some((it) => it.fen === prompt.fen_before)) {
      review.queue.push({
        fen: prompt.fen_before,
        expected_uci: result.expected_uci,
        expected_san: result.expected_san,
      });
    }
    renderTrainStats();
    appState.trainBusy = true;
    let playedSan = result.played_san || "";
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      playedSan = after.move?.san || playedSan;
      boards.train.setPosition({
        fen: after.board.fen,
        legalMoves: [],
        lastMove: playedUci,
      });
    } catch (_) {
      // Keep SAN-only feedback even if the preview move cannot be rendered.
    }
    const expectedSan = result.expected_san || "the prepared move";
    const sub = review.savedStreak > 0
      ? `Prepared move: ${expectedSan}. Fix it in recovery to save your streak.`
      : `Prepared move: ${expectedSan}. Resetting the position.`;
    setTrainBanner(
      "wrong",
      playedSan ? `Not ${playedSan}` : "Not the prepared move",
      sub
    );
    playSound("capture");
    if (appState.training) appState.training.prompt = result.prompt;
    await sleep(1450);
    appState.trainBusy = false;
    if (result.prompt) renderTraining(result.prompt);
    return;
  }

  stats.correct += 1;
  stats.streak += 1;
  stats.best = Math.max(stats.best, stats.streak);
  stats.history.push(true);
  renderTrainStats();
  if (appState.training) appState.training.prompt = result.prompt;
  appState.trainBusy = true;
  boards.train.setEngineArrow(null);

  // 1) Land the player's own move on the board (board animates + sounds).
  boards.train.setPosition({
    fen: result.fen_after_player || prompt.fen_before,
    legalMoves: [],
    lastMove: result.played_uci,
  });
  setTrainBanner("correct", "Correct!", result.played_san ? `You played ${result.played_san}` : "Nice - that's the prep");

  // 2) After a beat, let the opponent reply as its own animated step.
  if (result.reply_uci && result.fen_after_reply) {
    await sleep(520);
    boards.train.setPosition({
      fen: result.fen_after_reply,
      legalMoves: [],
      lastMove: result.reply_uci,
    });
    setTrainBanner("move", "Opponent replies", result.reply_san || "");
    await sleep(440);
  } else {
    await sleep(480);
  }

  appState.trainBusy = false;
  if (result.prompt) {
    renderTraining(result.prompt);
  } else if (review.queue.length) {
    enterReviewRound();
  } else {
    finishTrainingSession();
  }
}

// ----- Recovery round: replay the moves you missed until they're clean ------

async function enterReviewRound() {
  const review = appState.trainReview;
  review.active = true;
  review.index = 0;
  boards.train.setEngineArrow(null);
  setTrainBanner("review", "Recovery round", `Fix ${review.queue.length} missed move${review.queue.length === 1 ? "" : "s"} to win your streak back`);
  await sleep(700);
  showReviewItem();
}

async function showReviewItem() {
  const review = appState.trainReview;
  if (review.index >= review.queue.length) {
    finishReviewRound();
    return;
  }
  const item = review.queue[review.index];
  let info;
  try {
    info = await boardInfo(item.fen);
  } catch (_) {
    info = { legal_moves: [] };
  }
  boards.train.setEngineArrow(null);
  boards.train.setPosition({ fen: item.fen, legalMoves: info.legal_moves || [], lastMove: null });
  const side = sideToMoveFromFen(item.fen);
  updateTrainTurnBadge(side);
  setTrainBanner("review", `Recovery - ${review.index + 1} / ${review.queue.length}`, `${side === "white" ? "White" : "Black"} to move - the one you missed`);
  document.getElementById("train-board-label").textContent = "Recovery round - get it right to recover your streak";
}

async function submitReviewMove(playedUci) {
  const review = appState.trainReview;
  const item = review.queue[review.index];
  if (!item || !playedUci || appState.trainBusy) return;
  const stats = appState.trainStats;
  if (playedUci === item.expected_uci) {
    appState.trainBusy = true;
    let after;
    try {
      after = await boardAfterMove(item.fen, playedUci);
    } catch (_) {
      after = null;
    }
    if (after) {
      boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci });
    }
    review.recovered += 1;
    stats.history.push(true);
    renderTrainStats();
    setTrainBanner("correct", "Recovered!", "Mistake fixed - nice save");
    playSound("move");
    await sleep(640);
    appState.trainBusy = false;
    review.index += 1;
    showReviewItem();
  } else {
    stats.history.push(false);
    renderTrainStats();
    setTrainBanner("wrong", "Still not it", "Try again - you've got this");
    playSound("capture");
  }
}

function finishReviewRound() {
  const review = appState.trainReview;
  const stats = appState.trainStats;
  review.active = false;
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  if (review.savedStreak > 0) {
    stats.streak = review.savedStreak;
    stats.best = Math.max(stats.best, review.savedStreak);
    renderTrainStats();
    setTrainBanner("done", "Streak recovered!", `Fixed ${review.recovered} - streak back to ${review.savedStreak} - best ${stats.best}`);
  } else {
    setTrainBanner("done", "All cleaned up!", `Fixed ${review.recovered} missed move${review.recovered === 1 ? "" : "s"}`);
  }
  document.getElementById("train-board-label").textContent = "Press Start to train again";
  celebrate();
}

function finishTrainingSession() {
  const stats = appState.trainStats;
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  setTrainBanner("done", "Session complete!", `${stats.correct} correct - ${stats.mistakes} mistakes - best streak ${stats.best}`);
  document.getElementById("train-board-label").textContent = "Press Start to train again";
  celebrate();
}

// Lightweight confetti burst, no library, just falling coloured chips.
function celebrate() {
  const host = document.getElementById("view-train");
  if (!host) return;
  const colors = ["#d18b3f", "#4a8964", "#b9722a", "#c4524d", "#e6c34a"];
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  for (let i = 0; i < 36; i += 1) {
    const bit = document.createElement("span");
    bit.className = "confetti-bit";
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = `${Math.random() * 250}ms`;
    bit.style.animationDuration = `${900 + Math.random() * 700}ms`;
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(bit);
  }
  host.appendChild(layer);
  window.setTimeout(() => layer.remove(), 1900);
}

// Progressive hint: idea, piece, full answer (with arrow). Each click reveals
// one more level, so it teaches rather than just spoiling the move.
async function trainHint() {
  if (appState.smart) {
    smartHint();
    return;
  }
  const prompt = currentTrainingPrompt();
  if (!prompt) {
    setStatus("Start a session first");
    return;
  }
  try {
    if (!appState.trainHintInfo || appState.trainHintInfo.forFen !== prompt.fen_before) {
      const res = await postJson("/api/train/hint", { session_id: prompt.session_id });
      appState.trainHintInfo = { ...res, forFen: prompt.fen_before };
      appState.trainHintLevel = 0;
    }
    const info = appState.trainHintInfo;
    appState.trainHintLevel = Math.min(3, (appState.trainHintLevel || 0) + 1);
    const level = appState.trainHintLevel;
    if (level === 1) {
      boards.train.setEngineArrow(null);
      setTrainBanner("move", "Hint 1 · Idea", info.strategy || "Follow your preparation");
    } else if (level === 2) {
      boards.train.setEngineArrow(null);
      setTrainBanner("move", "Hint 2 · Piece", info.piece || "Find the move");
    } else {
      setTrainBanner("move", "Hint 3 · Answer", info.expected_san ? `Play ${info.expected_san}` : "Here it is");
      if (info.expected_uci) boards.train.setEngineArrow(info.expected_uci);
    }
  } catch (error) {
    setStatus(error.message);
  }
}

function currentTrainingPrompt() {
  return appState.training ? appState.training.prompt : null;
}

function updateTrainTurnBadge(side) {
  const badge = document.getElementById("train-turn-badge");
  if (!badge) return;
  badge.hidden = false;
  badge.dataset.side = side;
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

const SMART_KIND_LABELS = {
  weak: "Weak spot",
  due: "Due review",
  new: "New move",
  polish: "Polish",
};

// "Why this move", engine-free, for the moments the answer is on screen (teach
// cards and the second-miss reveal). The repertoire author's own annotation wins;
// otherwise describe what the move actually does on the board (chess.js only, so
// Train keeps needing no engine); the server's generic heuristic is the last resort.
function teachWhy(prompt, fallback) {
  const hint = (prompt && prompt.hint) || {};
  if (hint.annotated && hint.strategy) return hint.strategy;
  const did = describeMove(prompt.fen_before, prompt.expected_uci, prompt.expected_san);
  if (did) return `${did.charAt(0).toUpperCase()}${did.slice(1)}.`;
  return hint.strategy || fallback;
}

function setSmartPanelsHidden() {
  const queue = document.getElementById("train-queue");
  if (queue) queue.hidden = true;
  const summary = document.getElementById("train-summary");
  if (summary) summary.hidden = true;
  const dots = document.getElementById("train-card-dots");
  if (dots) dots.innerHTML = "";
}

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

// Mount/unmount the clock for a whole session. During a blitz session the bar
// stays in the layout (merely emptied between cards) so the board never jumps.
function setBlitzBarVisible(on) {
  const bar = document.getElementById("train-blitz");
  if (bar) bar.hidden = !on;
}

function clearBlitzTimer() {
  if (appState.blitzTimer) {
    window.clearTimeout(appState.blitzTimer);
    appState.blitzTimer = null;
  }
  const fill = document.getElementById("train-blitz-fill");
  if (fill) {
    fill.style.transition = "none";
    fill.style.width = "0%";
  }
}

function startBlitzTimer(smart, prompt) {
  clearBlitzTimer();
  const fill = document.getElementById("train-blitz-fill");
  if (fill) {
    // Restart the shrink from full: kill the transition, snap to 100%, reflow,
    // then let one linear transition spend the whole budget.
    fill.style.transition = "none";
    fill.style.width = "100%";
    void fill.offsetWidth;
    fill.style.transition = `width ${BLITZ_SECONDS}s linear`;
    fill.style.width = "0%";
  }
  appState.blitzTimer = window.setTimeout(() => {
    appState.blitzTimer = null;
    const current = appState.smart;
    // Fire only when this exact first attempt is still waiting on screen;
    // a backgrounded tab or a navigated-away view forfeits the clock, not
    // the card.
    const live =
      current === smart &&
      current.prompt === prompt &&
      current.attempt === 1 &&
      !appState.trainBusy &&
      appState.currentView === "train" &&
      !document.hidden;
    clearBlitzTimer();
    if (!live) return;
    smart.timeouts = (smart.timeouts || 0) + 1;
    submitSmartMove("0000", { timedOut: true });
  }, BLITZ_SECONDS * 1000);
}

async function startSmartTraining() {
  setStatus("Building your queue");
  const repertoireId = selectedTrainRepertoireId();
  appState.trainingRepertoireId = repertoireId;
  if (!repertoireId) {
    setStatus("Create a repertoire in Build first, then train it.");
    setTrainBanner("done", "No repertoire to train", "Build a repertoire, then start the trainer.");
    return;
  }
  let payload;
  try {
    payload = await postJson("/api/train/smart/start", { repertoire_id: repertoireId });
  } catch (error) {
    setStatus(error.message);
    setTrainBanner("done", "Nothing to train yet", "Add prepared moves in Build, then train.");
    return;
  }
  trainStatsReset();
  appState.training = null; // leave legacy mode if it was active
  // A restart can interrupt an in-flight run-in; its early-return leaves the
  // busy flag set, so clear it before the new session takes the board.
  appState.trainBusy = false;
  clearBlitzTimer();
  appState.smart = {
    sessionId: payload.session_id,
    repertoireId: payload.repertoire_id,
    repertoireName: payload.repertoire_name,
    color: payload.color,
    totalCards: payload.total_cards,
    counts: { ...payload.counts },
    healthBefore: payload.health || null,
    prompt: null,
    attempt: 1,
    cardsDone: 0,
    retriesFixed: 0,
    // Snapshot the toggle so flipping it mid-session can't change the rules.
    blitz: blitzEnabled(),
    timeouts: 0,
  };
  setBlitzBarVisible(appState.smart.blitz);
  if (boards.train && payload.color) {
    boards.train.setOrientation(payload.color === "black" ? "black" : "white");
  }
  document.getElementById("train-progress-panel").hidden = false;
  setSmartPanelsHidden();
  renderSmartQueueStrip();
  renderTrainStats();
  document.getElementById("train-board-label").textContent =
    `${payload.repertoire_name} - you play ${payload.color}`;
  const resumed = payload.card_index > 0 ? " (resumed)" : "";
  setStatus(`Queue ready: ${payload.total_cards} cards${resumed}`);
  await presentSmartPrompt(payload.prompt);
}

// The queue composition strip: one proportional segment + legend chip per kind.
function renderSmartQueueStrip() {
  const smart = appState.smart;
  const wrap = document.getElementById("train-queue");
  if (!wrap) return;
  const counts = smart && smart.counts;
  const kinds = ["weak", "due", "new", "polish"].filter((k) => counts && counts[k] > 0);
  if (!kinds.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  document.getElementById("train-queue-bar").innerHTML = kinds
    .map((k) => `<span class="tq-seg tq-${k}" style="flex:${counts[k]}"></span>`)
    .join("");
  document.getElementById("train-queue-legend").innerHTML = kinds
    .map((k) => `<span class="tq-chip tq-${k}">${counts[k]} ${k}</span>`)
    .join("");
}

function renderSmartProgress(prompt) {
  const total = Math.max(1, prompt.total_cards);
  document.getElementById("train-line-label").textContent =
    `Card ${Math.min(prompt.card_index + 1, total)} / ${total} · ${SMART_KIND_LABELS[prompt.kind] || prompt.kind}`;
  document.getElementById("train-progress-fill").style.width =
    `${Math.round((prompt.card_index / total) * 100)}%`;
  // Multi-target cards get one dot per own move so "where am I in this card"
  // is visible at a glance; single-target cards need no dots.
  const dots = document.getElementById("train-card-dots");
  if (dots) {
    dots.innerHTML =
      prompt.targets_total > 1
        ? Array.from({ length: prompt.targets_total }, (_, i) => {
            const cls = i < prompt.target_index ? "done" : i === prompt.target_index ? "now" : "";
            return `<span class="card-dot ${cls}"></span>`;
          }).join("")
        : "";
  }
}

// Show one card prompt: animate the run-in (unless the board is already on the
// position, i.e. mid-card right after the opponent's reply), then open the
// board for the answer — teach-first when the card is new.
async function presentSmartPrompt(prompt) {
  const smart = appState.smart;
  if (!smart || !prompt) return;
  smart.prompt = prompt;
  smart.attempt = 1;
  appState.trainHintLevel = 0;
  renderSmartProgress(prompt);
  const board = boards.train;
  board.setEngineArrow(null);
  let cueUci = board.lastMove || null;
  if (board.fen !== prompt.fen_before) {
    appState.trainBusy = true;
    const runIn = prompt.run_in || [];
    if (runIn.length) {
      let fen = prompt.start_fen;
      board.setPosition({ fen, legalMoves: [], lastMove: null });
      setTrainBanner("runin", "Finding the position…", runIn.map((m) => m.san).join(" "));
      await sleep(480);
      for (const mv of runIn) {
        if (appState.smart !== smart || smart.prompt !== prompt) return; // superseded
        try {
          const after = await boardAfterMove(fen, mv.uci);
          fen = after.board.fen;
          board.setPosition({ fen, legalMoves: [], lastMove: mv.uci });
          cueUci = mv.uci;
        } catch (_) {
          break; // jump-cut to fen_before below
        }
        await sleep(430);
      }
      await sleep(160);
    }
    if (appState.smart !== smart || smart.prompt !== prompt) return;
    appState.trainBusy = false;
  }
  board.setPosition({
    fen: prompt.fen_before,
    legalMoves: prompt.legal_moves || [],
    lastMove: cueUci,
  });
  const side = sideToMoveFromFen(prompt.fen_before);
  updateTrainTurnBadge(side);
  if (prompt.kind === "new") {
    // Teach-then-test: show the move and its idea; playing it (graded) is the
    // first, easy rep — the real test comes when spaced repetition brings it back.
    setTrainBanner(
      "teach",
      `New move: ${prompt.expected_san}`,
      teachWhy(prompt, "Watch the arrow, then play the move.")
    );
    board.setEngineArrow(prompt.expected_uci);
    clearBlitzTimer(); // learning is never against the clock
  } else {
    setTrainBanner(
      "move",
      `${side === "white" ? "White" : "Black"} to move`,
      `${SMART_KIND_LABELS[prompt.kind] || "Review"} - play your prepared move`
    );
    if (smart.blitz) startBlitzTimer(smart, prompt);
    else clearBlitzTimer();
  }
}

async function submitSmartMove(playedUci, { timedOut = false } = {}) {
  const smart = appState.smart;
  if (!smart || !smart.prompt || !playedUci || appState.trainBusy) return;
  clearBlitzTimer(); // answered (or timed out) — stop the countdown right away
  const prompt = smart.prompt;
  const attempt = smart.attempt;
  let result;
  try {
    result = await postJson("/api/train/smart/move", {
      session_id: smart.sessionId,
      played_uci: playedUci,
      attempt,
      local_date: localDateString(),
    });
  } catch (error) {
    setStatus(error.message);
    return;
  }
  if (result.day_streak) appState.dayStreak = result.day_streak;
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);
  smart.totalCards = result.total_cards;

  if (!result.correct) {
    // Only the first answer is graded (matches the server's SR write); the
    // accuracy chips therefore never count retries.
    if (attempt === 1) {
      stats.mistakes += 1;
      stats.history.push(false);
      renderTrainStats();
    }
    appState.trainBusy = true;
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      boards.train.setPosition({
        fen: after.board.fen,
        legalMoves: [],
        lastMove: playedUci,
      });
    } catch (_) {
      // Wrong-move preview is cosmetic (a blitz timeout has no move to show);
      // grading already happened server-side.
    }
    playSound("capture");
    if (attempt === 1) {
      // First miss: auto-hint and a free retry, streak intact, no reveal.
      // The blitz retry is deliberately untimed — the clock tests recall,
      // the retry rebuilds it.
      setTrainBanner(
        "wrong",
        timedOut ? "Time's up - try again" : "Not that one - try again",
        prompt.hint.strategy || prompt.hint.piece || "Think about the idea behind the line."
      );
    } else {
      // Second miss: reveal, let the answer be played, and the card returns
      // a few positions later (replaces the old end-of-session recovery round).
      stats.streak = 0;
      renderTrainStats();
      if (result.requeued) {
        smart.counts[prompt.kind] = (smart.counts[prompt.kind] || 0) + 1;
        renderSmartQueueStrip();
      }
      // The answer is on screen anyway, so say WHY it's the move — a reveal that
      // teaches sticks better than a bare "it's Nf3".
      const why = teachWhy(prompt, "");
      setTrainBanner(
        "reveal",
        `It's ${result.expected_san}`,
        `${why ? `${why} ` : ""}${result.requeued ? "Play it to continue - this card comes back in a few cards." : "Play it to continue."}`
      );
    }
    await sleep(950);
    if (appState.smart !== smart || smart.prompt !== prompt) return;
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: null,
    });
    if (attempt >= 2) boards.train.setEngineArrow(result.expected_uci);
    appState.trainBusy = false;
    smart.attempt = attempt + 1;
    return;
  }

  if (attempt === 1) {
    stats.correct += 1;
    stats.streak += 1;
    stats.best = Math.max(stats.best, stats.streak);
    stats.history.push(true);
  } else {
    smart.retriesFixed += 1;
  }
  renderTrainStats();
  appState.trainBusy = true;
  boards.train.setEngineArrow(null);

  // 1) Land the player's move, 2) after a beat the opponent replies, 3) flow
  // straight into the next prompt (same-card prompts skip the run-in because
  // the board is already on the position).
  boards.train.setPosition({
    fen: result.fen_after_player || prompt.fen_before,
    legalMoves: [],
    lastMove: result.played_uci,
  });
  const praise =
    attempt > 1 ? "Got it this time" : prompt.kind === "new" ? "Learned!" : "Correct!";
  setTrainBanner("correct", praise, result.played_san ? `You played ${result.played_san}` : "");
  if (result.reply_uci && result.fen_after_reply) {
    await sleep(520);
    boards.train.setPosition({
      fen: result.fen_after_reply,
      legalMoves: [],
      lastMove: result.reply_uci,
    });
    setTrainBanner("move", "Opponent replies", result.reply_san || "");
    await sleep(440);
  } else {
    await sleep(480);
  }
  if (appState.smart !== smart) return;
  if (result.card_completed) smart.cardsDone += 1;
  appState.trainBusy = false;
  if (result.prompt) {
    await presentSmartPrompt(result.prompt);
  } else {
    await finishSmartSession();
  }
}

async function skipSmartCard() {
  const smart = appState.smart;
  if (!smart || !smart.prompt) {
    setStatus("No active card");
    return;
  }
  if (appState.trainBusy) return;
  clearBlitzTimer();
  try {
    const result = await postJson("/api/train/smart/skip", { session_id: smart.sessionId });
    if (result.prompt) {
      setStatus("Skipped to the next card");
      await presentSmartPrompt(result.prompt);
    } else {
      setStatus("Session complete");
      await finishSmartSession();
    }
  } catch (error) {
    setStatus(error.message);
  }
}

// Progressive hint, fully local — the prompt already carries the idea, the
// piece, and the answer (it's the player's own repertoire, not a quiz).
function smartHint() {
  const smart = appState.smart;
  const prompt = smart && smart.prompt;
  if (!prompt) {
    setStatus("Start a session first");
    return;
  }
  appState.trainHintLevel = Math.min(3, (appState.trainHintLevel || 0) + 1);
  const level = appState.trainHintLevel;
  if (level === 1) {
    boards.train.setEngineArrow(null);
    setTrainBanner("move", "Hint 1 · Idea", prompt.hint.strategy || "Follow your preparation");
  } else if (level === 2) {
    boards.train.setEngineArrow(null);
    setTrainBanner("move", "Hint 2 · Piece", prompt.hint.piece || "Find the move");
  } else {
    setTrainBanner("move", "Hint 3 · Answer", `Play ${prompt.expected_san}`);
    boards.train.setEngineArrow(prompt.expected_uci);
  }
}

async function finishSmartSession() {
  const smart = appState.smart;
  if (!smart) return;
  const stats = appState.trainStats || {};
  smart.prompt = null;
  clearBlitzTimer();
  setBlitzBarVisible(false);
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  const dots = document.getElementById("train-card-dots");
  if (dots) dots.innerHTML = "";
  const fixed = smart.retriesFixed ? ` - ${smart.retriesFixed} fixed on retry` : "";
  const blitzed = smart.blitz && smart.timeouts ? ` (${smart.timeouts} timed out)` : "";
  setTrainBanner(
    "done",
    smart.blitz ? "Blitz session complete!" : "Session complete!",
    `${stats.correct || 0} first-try correct - ${stats.mistakes || 0} missed${blitzed}${fixed}`
  );
  document.getElementById("train-board-label").textContent = "Press Start for a fresh queue";
  celebrate();
  // End-of-session report: what this session changed, and what lands tomorrow.
  let after = null;
  try {
    after = await api(
      `/api/train/smart/summary?repertoire_id=${encodeURIComponent(smart.repertoireId)}`
    );
  } catch (_) {
    // The summary is a bonus — never block the finish on it.
  }
  renderSmartSummary(smart, stats, after);
}

function renderSmartSummary(smart, stats, after) {
  const panel = document.getElementById("train-summary");
  if (!panel) return;
  const queue = document.getElementById("train-queue");
  if (queue) queue.hidden = true; // the summary replaces the composition strip
  const firstTries = (stats.correct || 0) + (stats.mistakes || 0);
  const acc = firstTries ? Math.round(((stats.correct || 0) / firstTries) * 100) : 100;
  const statCells = [
    [smart.cardsDone, "cards"],
    [`${acc}%`, "first try"],
    [stats.best || 0, "best streak"],
  ];
  // The daily streak (server-tracked, all repertoires) earns its slot once the
  // first graded move of the session reported it.
  const day = appState.dayStreak;
  if (day && day.current > 0) statCells.push([`\u{1F525}${day.current}`, "day streak"]);
  document.getElementById("train-summary-stats").innerHTML = statCells
    .map(
      ([value, label]) =>
        `<div class="tsum-stat"><span class="tsum-value">${value}</span><span class="tsum-label">${label}</span></div>`
    )
    .join("");
  const deltaEl = document.getElementById("train-summary-delta");
  const footEl = document.getElementById("train-summary-foot");
  const before = smart.healthBefore;
  if (before && after && after.health) {
    // goodDir: which direction is good news for this row (+1 = growing is
    // good, -1 = shrinking is good, 0 = neutral churn).
    deltaEl.innerHTML = [
      ["mastered", "Mastered", "good", 1],
      ["learning", "Learning", "", 0],
      ["due", "Due", "warn", -1],
      ["weak", "Weak", "bad", -1],
      ["untrained", "New", "", -1],
    ]
      .map(([key, label, cls, goodDir]) => {
        const now = after.health[key] || 0;
        const diff = now - (before[key] || 0);
        const tone = diff * goodDir > 0 ? "up" : diff * goodDir < 0 ? "down" : "";
        const delta =
          diff === 0
            ? ""
            : `<span class="tsum-delta ${tone}">${diff > 0 ? "+" : ""}${diff}</span>`;
        return `<div class="tsum-row ${cls}"><span>${label}</span><span class="tsum-num">${now}${delta}</span></div>`;
      })
      .join("");
    footEl.textContent =
      after.due_tomorrow > 0
        ? `${after.due_tomorrow} review${after.due_tomorrow === 1 ? "" : "s"} due tomorrow - come back!`
        : "Nothing due tomorrow - the queue is clear.";
  } else {
    deltaEl.innerHTML = "";
    footEl.textContent = "";
  }
  panel.hidden = false;
}

async function loadSettings() {
  try {
    const payload = await api("/api/settings");
    applySettingsPayload(payload);
    applyServerEngineGating();
    renderSettings(payload);
  } catch (error) {
    setStatus(error.message);
  }
}

// Fold a /api/settings payload into state: the blob itself, the server-engine flag,
// and the pinned Maia rating (null = AUTO). Shared by init, loadSettings and saves.
function applySettingsPayload(payload) {
  appState.settings = payload;
  appState.serverEngineEnabled = !!payload.server_engine_enabled;
  appState.maiaRatingPinned = Number.isFinite(payload.maia_rating) ? payload.maia_rating : null;
  renderStrengthControls();
}

// Persist a partial settings patch ({stockfish_depth} / {maia_rating}) and re-render.
async function saveSettings(patch) {
  try {
    const payload = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
    applySettingsPayload(payload);
  } catch (error) {
    setStatus(error.message);
  }
}

// Paint the Playing-strength card from state. Cheap and idempotent — called whenever
// settings or the auto-resolved rating change.
function renderStrengthControls() {
  const depthEl = document.getElementById("settings-depth");
  const depthOut = document.getElementById("settings-depth-readout");
  const autoEl = document.getElementById("settings-maia-auto");
  const autoLabel = document.getElementById("settings-maia-auto-label");
  const ratingEl = document.getElementById("settings-maia-rating");
  const ratingOut = document.getElementById("settings-maia-rating-readout");
  if (!depthEl || !autoEl || !ratingEl) return;
  const settings = appState.settings || {};
  if (Number.isFinite(settings.stockfish_depth)) {
    depthEl.value = String(settings.stockfish_depth);
  }
  if (depthOut) depthOut.textContent = depthEl.value;
  const auto = !Number.isFinite(appState.maiaRatingPinned);
  autoEl.checked = auto;
  ratingEl.disabled = auto;
  ratingEl.value = String(effectiveMaiaRating());
  if (ratingOut) ratingOut.textContent = ratingEl.value;
  if (autoLabel) {
    autoLabel.textContent = appState.lichessUsername
      ? Number.isFinite(appState.maiaAutoRating)
        ? `Auto — match my Lichess rating (~${appState.maiaAutoRating})`
        : "Auto — match my Lichess rating"
      : `Auto — Lichess not linked, using ${MAIA_FALLBACK_RATING}`;
  }
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
}

// Browser-only engine state depends ONLY on the browser (cross-origin isolation),
// not on any server call. Kept separate from renderSettings so init() can paint it
// immediately even for a signed-out visitor — otherwise a failed /api/settings (401)
// left the widget stuck on its initial "checking…" placeholder forever.
function renderBrowserEngineStatus() {
  const browserStatusEl = document.getElementById("settings-browser-engine-status");
  const note = document.getElementById("settings-stockfish-status");
  if (browserStatusEl) {
    if (self.crossOriginIsolated) {
      browserStatusEl.textContent = "available";
      if (note) note.textContent = "";
    } else {
      browserStatusEl.textContent = "unavailable";
      if (note) {
        note.textContent =
          "This browser is not cross-origin isolated (COOP/COEP). Use a supported browser to run analysis locally.";
      }
    }
  }
  // Maia3 runs IN THE BROWSER; probe the real client-side state (manifest + IndexedDB).
  renderMaia3Status();
}

function renderSettings(payload) {
  // payload accepted for forward-compat but unused — engine status is browser-derived.
  void payload;
  renderBrowserEngineStatus();
}

// Report the real browser Maia3 state in Settings: a warm provider's live state when it has
// one, otherwise probe the manifest + IndexedDB weight cache to distinguish "ready (cached)"
// from "available on demand" from "unavailable". Best-effort: never throws.
async function renderMaia3Status() {
  const modelEl = document.getElementById("settings-maia-model");
  const noteEl = document.getElementById("settings-maia-status");
  const errEl = document.getElementById("settings-maia-error");
  if (!modelEl) return;
  const set = (model, note = "", error = "") => {
    modelEl.textContent = model;
    if (noteEl) noteEl.textContent = note;
    if (errEl) {
      errEl.textContent = error ? `Last error: ${error}` : "";
      errEl.hidden = !error;
    }
  };
  try {
    const provider = getSharedMaia3Provider();
    // A provider that has been exercised this session has authoritative live state.
    if (provider.state === "ready") {
      const info = provider.info || {};
      const base = info.url || provider.assetBase || "";
      set("available", base ? `Loaded this session · ${base}` : "Loaded this session.");
      return;
    }
    if (provider.state === "initializing") {
      set("initializing…", "Downloading / preparing the model.");
      return;
    }
    if (provider.state === "unavailable") {
      // Surface the REAL failure (init timeout / worker crash / ORT / weight fetch) so
      // the user can tell a transient hiccup from a stale-cache or environment problem.
      const err = provider.lastError;
      set(
        "unavailable",
        "Last load failed. Use Retry now, or Reset cache if it keeps failing.",
        err ? `${err.message}${err.phase ? ` (${err.phase})` : ""}` : "",
      );
      return;
    }
    // Idle (never used yet this session): probe whether the model can load and is cached.
    let manifest;
    try {
      const resp = await fetch("/static/maia3/maia3.manifest.json");
      if (!resp.ok) throw new Error(`manifest ${resp.status}`);
      manifest = await resp.json();
    } catch {
      set("unavailable", "Model manifest is not reachable from this server.");
      return;
    }
    const base = resolveModelBase(manifest);
    const key =
      (manifest.backend_artifact && manifest.backend_artifact.wasm) ||
      (manifest.artifacts && manifest.artifacts.fp16 && manifest.artifacts.fp16.file) ||
      null;
    const bytes =
      (manifest.artifacts && manifest.artifacts.fp16 && manifest.artifacts.fp16.bytes) || 0;
    const sizeMb = bytes ? `${Math.round(bytes / (1024 * 1024))} MB` : "~46 MB";
    const cached = key ? await getCachedWeights(key) : null;
    if (cached) {
      set("ready (cached)", `${sizeMb} cached in this browser · ${base}`);
    } else {
      set("available on demand", `Downloads ${sizeMb} on first use, then cached · ${base}`);
    }
  } catch {
    set("unavailable", "Could not determine the browser Maia3 state.");
  }
}

// Settings "Retry now": force the shared provider to re-init right away instead of
// waiting for the next analysis. predictions() drives _ensureReady, which on a prior
// failure spins up a fresh worker and re-downloads (or reuses the cached weights).
async function retryMaia3() {
  const btn = document.getElementById("settings-maia-retry");
  if (btn) btn.disabled = true;
  setStatus("Retrying Maia3…");
  try {
    const provider = getSharedMaia3Provider();
    renderMaia3Status(); // reflect "initializing…" while it loads
    await provider.predictions({ fen: START_FEN });
    setStatus("Maia3 ready");
  } catch (err) {
    setStatus(`Maia3 retry failed: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
    renderMaia3Status();
  }
}

// Settings "Reset cache": recovery path for a stale/corrupt IndexedDB weight store.
// Tears down the warm provider, drops the cached model, and reloads so the worker/ORT
// state starts clean — the model re-downloads on next use.
async function resetMaia3Cache() {
  const confirmed = await showConfirmModal({
    title: "Reset Maia cache?",
    body:
      "Deletes the cached Maia model from this browser, then reloads. The model " +
      "(~46 MB) re-downloads on next use. Use this if Maia keeps failing to load.",
    okLabel: "Reset & reload",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return;
  setStatus("Clearing Maia cache…");
  try {
    disposeSharedMaia3Provider();
  } catch (_) {
    /* ignore */
  }
  await clearWeightCache();
  window.location.reload();
}

// NOTE: server-side engine install (Stockfish/Maia3) and the first-run install
// prompt were removed — the public flow runs Stockfish in the browser and never
// installs or runs an engine on the server. Server install endpoints remain in
// server.py for a future admin mode (gated by PREPFORGE_SERVER_ENGINE_ENABLED).

async function runLichessCompare() {
  if (!appState.lichessUsername) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  const countInput = document.getElementById("replay-count");
  const count = Math.max(1, Math.min(50, Number(countInput.value) || 10));
  const button = document.getElementById("lichess-compare-btn");
  button.disabled = true;
  setStatus("Fetching games from Lichess");
  try {
    const payload = await postJson("/api/lichess/compare", {
      username: appState.lichessUsername,
      count,
    });
    appState.replayResults = payload;
    renderReplayResults(payload);
    const queued = Number(payload.misses_recorded) || 0;
    setStatus(
      queued > 0
        ? `Fetched ${payload.count} games · ${queued} forgotten move${queued === 1 ? "" : "s"} added to training`
        : `Fetched ${payload.count} games for ${payload.username}`
    );
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderReplayResults(payload) {
  const container = document.getElementById("replay-results");
  if (!payload || !payload.games || !payload.games.length) {
    container.innerHTML =
      '<div class="empty-state">No games found, or none played as a color you have a repertoire for.</div>';
    return;
  }
  container.innerHTML = payload.games.map(renderReplayCard).join("");
  container.querySelectorAll("[data-train-rep]").forEach((btn) => {
    btn.addEventListener("click", () => trainRepertoire(btn.dataset.trainRep));
  });
  container.querySelectorAll("[data-edit-rep]").forEach((btn) => {
    btn.addEventListener("click", () => editRepertoire(btn.dataset.editRep));
  });
}

function renderReplayCard(game) {
  const players = `${escapeHtml(game.white || "?")} vs ${escapeHtml(game.black || "?")} · ${escapeHtml(game.result || "*")}`;
  const lichessLink = game.lichess_id
    ? ` <a class="link" target="_blank" rel="noopener noreferrer" href="https://lichess.org/${escapeHtml(game.lichess_id)}">open</a>`
    : "";
  let cls = "no-prep";
  let badge = "No matching repertoire";
  let badgeClass = "muted";
  if (game.in_repertoire && game.departure_reason === "game_stayed_in_preparation") {
    cls = "in-prep";
    badge = "Stayed in prep";
  } else if (game.departure_reason === "user_left_preparation") {
    cls = "user-error";
    badge = "You left prep";
  } else if (game.departure_reason === "opponent_unprepared_branch") {
    cls = "left-prep";
    badge = "Opponent novelty";
  } else if (game.departure_reason === "no_repertoire_for_color") {
    cls = "no-prep";
    badge = "No repertoire";
  }

  const moveLine = renderReplayMoveLine(game);
  const detail = renderReplayDetail(game);
  const actions = game.repertoire_id
    ? `<div class="tools" style="margin-top:6px">
        <button class="btn ghost" data-edit-rep="${escapeHtml(game.repertoire_id)}">Open in builder</button>
        <button class="btn ghost" data-train-rep="${escapeHtml(game.repertoire_id)}">Train this</button>
      </div>`
    : "";
  return `
    <div class="replay-card ${cls}">
      <div class="replay-head">
        <div><span class="players">${players}</span>${lichessLink}</div>
        <span class="pill" data-badge-class="${badgeClass}">${escapeHtml(badge)}</span>
      </div>
      <div class="replay-line">${moveLine}</div>
      <div class="replay-detail">${detail}</div>
      ${actions}
    </div>
  `;
}

function renderReplayMoveLine(game) {
  const history = game.move_san_history || [];
  if (!history.length) return '<span class="muted">No moves recorded.</span>';
  const departPly = game.departure_ply; // 1-indexed ply of the departing move
  const matched = Number(game.matched_plies) || 0;
  const parts = [];
  history.forEach((san, index) => {
    const ply = index + 1;
    const moveNumber = Math.ceil(ply / 2);
    const isWhite = ply % 2 === 1;
    if (isWhite) parts.push(`<span class="move-num">${moveNumber}.</span>`);
    else if (ply === 1 || ply === matched + 1) parts.push(`<span class="move-num">${moveNumber}...</span>`);
    const inPrep = ply <= matched;
    const isDepart = ply === departPly;
    const classes = [];
    if (inPrep) classes.push("prep");
    if (isDepart) classes.push("ply-mark");
    parts.push(`<span class="${classes.join(" ")}">${escapeHtml(san)}</span>`);
  });
  return parts.join(" ");
}

function replayDepartureSan(game) {
  const history = game.move_san_history || [];
  const index = Number(game.departure_ply || 0) - 1;
  return index >= 0 && index < history.length ? history[index] : "";
}

function renderReplayDetail(game) {
  const lines = [];
  if (game.repertoire_name) {
    lines.push(
      `Repertoire: <strong>${escapeHtml(game.repertoire_name)}</strong> · matched ${game.matched_plies} plies`
    );
  } else {
    lines.push(`Played as ${escapeHtml(game.user_color)}, but no active repertoire matched.`);
  }
  if (game.departure_reason === "user_left_preparation") {
    const expected = game.expected_move_san ? ` (expected <strong>${escapeHtml(game.expected_move_san)}</strong>)` : "";
    const playedSan = replayDepartureSan(game);
    const played = playedSan ? ` <strong>${escapeHtml(playedSan)}</strong>` : "";
    const queued = game.training_recorded
      ? " Added to your training queue - the move you forgot is due now."
      : " Already in your training queue.";
    lines.push(`You diverged on ply ${game.departure_ply}${played}${expected}.${queued}`);
  } else if (game.departure_reason === "opponent_unprepared_branch") {
    const playedSan = replayDepartureSan(game);
    const played = playedSan ? ` <strong>${escapeHtml(playedSan)}</strong>` : "";
    lines.push(`Opponent took an unprepared branch on ply ${game.departure_ply}${played}. Backlog this in Builder.`);
  } else if (game.departure_reason === "game_stayed_in_preparation") {
    lines.push("Game stayed entirely within preparation. Nice.");
  } else if (game.departure_reason === "no_repertoire_for_color") {
    lines.push("No active repertoire defined for the colour you played.");
  }
  return lines.join("<br />");
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.view);
      if (button.dataset.view === "settings") loadSettings();
    });
  });

  // Settings
  document.getElementById("settings-refresh").addEventListener("click", loadSettings);
  const maiaRetryBtn = document.getElementById("settings-maia-retry");
  if (maiaRetryBtn) maiaRetryBtn.addEventListener("click", retryMaia3);
  const maiaResetBtn = document.getElementById("settings-maia-reset");
  if (maiaResetBtn) maiaResetBtn.addEventListener("click", resetMaia3Cache);

  // Playing strength: readouts track the drag (input), the save fires on release
  // (change) so a slider sweep is ONE settings POST, not thirty.
  const depthSlider = document.getElementById("settings-depth");
  if (depthSlider) {
    depthSlider.addEventListener("input", () => {
      const out = document.getElementById("settings-depth-readout");
      if (out) out.textContent = depthSlider.value;
    });
    depthSlider.addEventListener("change", () =>
      saveSettings({ stockfish_depth: Number(depthSlider.value) })
    );
  }
  const maiaAuto = document.getElementById("settings-maia-auto");
  const maiaSlider = document.getElementById("settings-maia-rating");
  if (maiaAuto && maiaSlider) {
    maiaAuto.addEventListener("change", () =>
      saveSettings({ maia_rating: maiaAuto.checked ? "auto" : Number(maiaSlider.value) })
    );
    maiaSlider.addEventListener("input", () => {
      const out = document.getElementById("settings-maia-rating-readout");
      if (out) out.textContent = maiaSlider.value;
    });
    maiaSlider.addEventListener("change", () => {
      if (!maiaAuto.checked) saveSettings({ maia_rating: Number(maiaSlider.value) });
    });
  }

  // Account chip (folds in the old standalone Sign out button as a menu action)
  document.getElementById("account-chip").addEventListener("click", onAccountChipClick);

  // Dashboard repertoire actions
  document.getElementById("dashboard-new-rep").addEventListener("click", () =>
    createRepertoirePrompt({ title: "New repertoire" })
  );
  document.getElementById("dashboard-import-pgn").addEventListener("click", dashboardImportPgn);
  document.getElementById("dashboard-import-input").addEventListener("change", (event) => {
    handleImportPgnFile(event.target.files && event.target.files[0]);
  });

  // Replay tab
  document.getElementById("lichess-compare-btn").addEventListener("click", runLichessCompare);

  document.getElementById("run-analysis").addEventListener("click", runAnalysis);
  document.getElementById("fetch-my-game").addEventListener("click", fetchMyLichessGame);
  // Lazy-load the analysis history list the first time its drawer is opened.
  const historyDrawer = document.getElementById("history-drawer");
  if (historyDrawer) {
    historyDrawer.addEventListener("toggle", () => {
      if (historyDrawer.open) loadAnalysisHistory();
    });
  }
  // Opening explorer: fetch on open, switch databases in place. Closing cancels
  // any pending debounce via the drawer-open guard.
  const explorerDrawer = document.getElementById("explorer-drawer");
  if (explorerDrawer) {
    explorerDrawer.addEventListener("toggle", () => {
      if (explorerDrawer.open) refreshExplorerPanel();
    });
    explorerDrawer.querySelectorAll(".explorer-db").forEach((btn) => {
      btn.addEventListener("click", () => {
        explorerDb = btn.dataset.db === "lichess" ? "lichess" : "masters";
        explorerDrawer.querySelectorAll(".explorer-db").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        refreshExplorerPanel();
      });
    });
  }

  // Drag-and-drop: a PGN onto the Analyze box loads it; a PGN/JSON onto the
  // dashboard repertoires card imports it.
  bindDropZone(document.getElementById("pgn-input"), fillPgnInputFromFile);
  const dashCard = document.getElementById("dashboard-repertoires");
  bindDropZone(dashCard && dashCard.closest(".card"), handleImportPgnFile);
  document
    .getElementById("open-engine-widget")
    .addEventListener("click", () => engineWidget.openForCurrent());
  document
    .getElementById("open-engine-widget-build")
    .addEventListener("click", () => engineWidget.openForCurrent());
  bindEvalChart();
  document.getElementById("analysis-start").addEventListener("click", () => analysisTreeNav("start"));
  document.getElementById("analysis-prev").addEventListener("click", () => analysisTreeNav("prev"));
  document.getElementById("analysis-next").addEventListener("click", () => analysisTreeNav("next"));
  document.getElementById("analysis-end").addEventListener("click", () => analysisTreeNav("end"));

  document
    .getElementById("build-new")
    .addEventListener("click", () =>
      createRepertoirePrompt({ title: "New repertoire", defaultName: "New repertoire" })
    );
  document.getElementById("build-root").addEventListener("click", buildGoRoot);
  document.getElementById("build-parent").addEventListener("click", buildGoBack);
  document.getElementById("build-next").addEventListener("click", buildGoForward);
  document.getElementById("build-end").addEventListener("click", buildGoToEnd);
  document.getElementById("build-generate-node").addEventListener("click", generateFromCurrentNode);
  document.getElementById("export-build-json").addEventListener("click", () => exportBuild("json"));
  document.getElementById("export-build-pgn").addEventListener("click", () => exportBuild("pgn"));
  document
    .getElementById("import-build-file")
    .addEventListener("click", () => document.getElementById("build-import-input").click());
  document
    .getElementById("import-build-json")
    .addEventListener("click", () => importRepertoireFromInput("build-import-input"));
  document
    .getElementById("import-train-json")
    .addEventListener("click", () => importRepertoireFromInput("train-import-input"));

  document.getElementById("start-train").addEventListener("click", () => startTraining());
  document.getElementById("train-hint").addEventListener("click", trainHint);
  const blitzRow = document.getElementById("train-blitz-row");
  const blitzToggle = document.getElementById("train-blitz-toggle");
  if (blitzToggle) {
    blitzToggle.checked = blitzEnabled();
    blitzToggle.addEventListener("change", () => setBlitzEnabled(blitzToggle.checked));
  }
  document.querySelectorAll("#train-modes .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#train-modes .train-mode")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      appState.trainMode = btn.dataset.mode;
      // The answer clock only exists in the smart queue; rehearsal is untimed.
      if (blitzRow) blitzRow.hidden = btn.dataset.mode !== "smart";
    });
  });
  const trainSelect = document.getElementById("train-repertoire-select");
  if (trainSelect) {
    trainSelect.addEventListener("change", () => {
      const value = trainSelect.value;
      appState.trainingRepertoireId = value && value !== "__demo__" ? value : null;
    });
  }

  // Board flip + rename + skip
  document.getElementById("analysis-flip").addEventListener("click", () => boards.analysis.flip());
  document.getElementById("build-flip").addEventListener("click", () => boards.build.flip());
  document.getElementById("train-flip").addEventListener("click", () => boards.train.flip());
  document.getElementById("build-rename").addEventListener("click", renameRepertoire);
  document.getElementById("train-skip").addEventListener("click", skipTrainingLine);

  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (active && ["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName)) return;
    // Arrow keys navigate the active tab's board. We blur clicked move buttons
    // on click, so focus returns to the document for these to fire.
    const inBuild = activeViewName() === "build";
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (inBuild) buildGoBack();
      else analysisTreeNav("prev");
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (inBuild) buildGoForward();
      else analysisTreeNav("next");
    }
    // Up/Down (and j/k) switch between branch alternatives at the current move in Build,
    // so a fork can be navigated entirely from the keyboard. The on-screen branch bar
    // mirrors the choice. With no alternatives they do nothing (← → handle stepping).
    if (inBuild && (event.key === "ArrowDown" || event.key === "j")) {
      event.preventDefault();
      buildBranchKey(1);
    }
    if (inBuild && (event.key === "ArrowUp" || event.key === "k")) {
      event.preventDefault();
      buildBranchKey(-1);
    }
    if (event.key === "Escape") {
      closeNodeContextMenu();
      closeRepertoireContextMenu();
      closeAccountMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#node-context-menu")) closeNodeContextMenu();
    if (!event.target.closest("#repertoire-context-menu")) closeRepertoireContextMenu();
    // The chip's own click toggles the menu; ignore it here so we don't immediately
    // re-close what the toggle just opened.
    if (!event.target.closest("#account-menu") && !event.target.closest("#account-chip")) {
      closeAccountMenu();
    }
  });
}

async function init() {
  appState.prefs = loadPrefs();
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
  engineWidget.bind();
  positionCoach.bind();
  bindEvents();
  renderPieceStylePicker();
  renderPrefsToggles();
  prefillDemoPgn();
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
  // Engine status is browser-derived (cross-origin isolation) — paint it now, even
  // for a signed-out visitor, so it never sticks on the initial "checking…".
  renderBrowserEngineStatus();
  applyServerEngineGating();

  // Learn the auth state BEFORE any owner-scoped calls. A signed-out visitor must
  // not fire /api/settings, /api/dashboard, /api/board, /api/lichess — they 401 and
  // spam the console. Gate that whole workspace load behind a real session.
  await refreshAuthProviders();
  await refreshAuthStatus();
  if (appState.signedIn) {
    await loadSignedInWorkspace();
  } else {
    setStatus("Sign in to build and train your repertoires.");
    renderBuilderTree();
  }
}

// Everything that needs an authenticated session. Called from init only when
// signed in, and after a successful sign-in.
async function loadSignedInWorkspace() {
  try {
    applySettingsPayload(await api("/api/settings"));
  } catch (_) {
    appState.serverEngineEnabled = false;
  }
  applyServerEngineGating();
  try {
    const stored = localStorage.getItem(LICHESS_KEY);
    if (stored) setLichessUsername(stored);
  } catch (_) {
    /* ignore storage errors */
  }
  refreshLichessStatus();
  syncReplayControls();
  // Boards are already seeded with the start position in init() (browser-computed),
  // so signing in doesn't need to re-fetch them.
  renderBuilderTree();
  await loadDashboard();
}

init().catch((error) => setStatus(error.message));
