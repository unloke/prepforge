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
  evalChartPoints: [],
  build: null,
  buildNodeById: new Map(),
  buildCurrentNodeId: null,
  trainingRepertoireId: null,
  training: null,
  lichessUsername: null,
  replayResults: null,
  pieceStyle: "berlin",
};

const LICHESS_KEY = "prepforge.lichess_username";

const boards = {};

// A single notification card. Each job owns its own Toast (DOM + timers) so
// consecutive jobs never cross-talk; an old card's auto-dismiss can never
// reach into a newer card the way a shared, reused element used to.
class Toast {
  constructor(stack, { id, title, tab, total }) {
    this.stack = stack;
    this.id = id;
    this.tab = tab || null;
    this.state = "running";
    this.minimized = false;
    this.activeTotal = Math.max(1, Number(total) || 1);
    this.lastDisplayedPercent = 0;
    this.onClick = null;
    this.minimizeTimer = null;
    this.completionTimer = null;
    this.removed = false;
    this.el = this._build(title);
    stack.container.appendChild(this.el);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
    this._scheduleAutoMinimize();
  }

  _build(title) {
    const el = document.createElement("div");
    el.className = "job-toast state-running";
    el.dataset.state = "running";
    el.innerHTML =
      '<div class="job-toast-head">' +
      '<span class="job-toast-icon" aria-hidden="true"></span>' +
      `<span class="job-toast-title">${escapeHtml(title || "Working...")}</span>` +
      '<button class="job-toast-collapse" type="button" title="Minimize" aria-label="Minimize">_</button>' +
      "</div>" +
      '<div class="job-toast-body">' +
      '<div class="job-toast-message">Queued</div>' +
      '<div class="job-toast-track"><div class="job-toast-fill"></div></div>' +
      "</div>";
    this.titleEl = el.querySelector(".job-toast-title");
    this.messageEl = el.querySelector(".job-toast-message");
    this.fillEl = el.querySelector(".job-toast-fill");
    this.collapseBtn = el.querySelector(".job-toast-collapse");
    this.collapseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMinimize(true);
    });
    el.addEventListener("click", () => {
      if (this.state === "done" && this.onClick) {
        this.onClick();
        this.dismiss();
      } else if (this.minimized) {
        this.toggleMinimize(false);
      }
    });
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
    if (message) this.messageEl.textContent = message;
  }

  complete({ title, message, onClick } = {}) {
    this.state = "done";
    this.minimized = false;
    this.onClick = typeof onClick === "function" ? onClick : null;
    this._applyState();
    if (title) this.titleEl.textContent = title;
    if (message) this.messageEl.textContent = message;
    this.lastDisplayedPercent = 1;
    this._renderFill(1);
    this._clearAutoMinimize();
    this.completionTimer = setTimeout(() => this.dismiss(), 12000);
  }

  fail(message) {
    this.state = "failed";
    this._applyState();
    this.titleEl.textContent = "Job failed";
    this.messageEl.textContent = message || "Unknown error";
    this._clearAutoMinimize();
    this.completionTimer = setTimeout(() => this.dismiss(), 5000);
  }

  toggleMinimize(force) {
    const next = typeof force === "boolean" ? force : !this.minimized;
    this.minimized = next;
    this.el.classList.toggle("is-minimized", next);
    if (!next) this._scheduleAutoMinimize();
  }

  dismiss() {
    if (this.removed) return;
    this.removed = true;
    this._clearAutoMinimize();
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
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
    this.el.classList.remove("state-running", "state-done", "state-failed");
    this.el.classList.add(`state-${this.state}`);
    this.el.classList.toggle("is-minimized", this.minimized);
  }

  _renderFill(ratio) {
    if (!this.fillEl) return;
    this.fillEl.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  _scheduleAutoMinimize() {
    this._clearAutoMinimize();
    this.minimizeTimer = setTimeout(() => {
      if (this.state === "running") this.toggleMinimize(true);
    }, 7500);
  }

  _clearAutoMinimize() {
    if (this.minimizeTimer) {
      clearTimeout(this.minimizeTimer);
      this.minimizeTimer = null;
    }
  }
}

// Manages a vertical stack of independent Toasts. Jobs are sequential (the
// server runs one heavy job at a time), so the manager tracks the current job
// as `active` for update/complete/fail, but every card lives and dies on its
// own.
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

  updateJob(data) {
    if (this.active) this.active.update(data);
  }

  completeJob(data) {
    if (this.active) this.active.complete(data);
  }

  failJob(message) {
    if (this.active) this.active.fail(message);
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
    if (jobToast.isBusy()) {
      setStatus("Another job is already running");
      return;
    }
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
      await postJson("/api/engine/close", {});
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
      const snapshot = await postJson("/api/engine/update", { fen, multipv: this.multipv });
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
      const snapshot = await postJson("/api/engine/open", {
        fen: this.lastFen,
        multipv: this.multipv,
        engine: "stockfish",
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
      const snapshot = await postJson("/api/engine/update", {
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
        const snapshot = await api("/api/engine/snapshot");
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
    this.moveBadge = null;
    this._hadPosition = false;
    this.annotationStart = null;
    this.highlights = new Set();
    this.arrows = [];
    this.squares = new Map();
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
    renderAnnotations(this.overlay, this.arrows, this.orientation, this.engineArrow);
  }

  setEngineArrow(uci) {
    const next = uci || null;
    if (this.engineArrow === next) return;
    this.engineArrow = next;
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
        this._feedbackForMove(prevFen, fen, lastMove);
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
  _feedbackForMove(prevFen, fen, lastMove) {
    const from = lastMove.slice(0, 2);
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
    if (pref("moveAnim")) this._animateSlide(from, to);
    if (pref("lastMovePulse")) this._pulseSquare(to);
  }

  _animateSlide(from, to) {
    const fromSq = this.squares.get(from);
    const toSq = this.squares.get(to);
    if (!fromSq || !toSq) return;
    const piece = toSq.querySelector(".piece");
    if (!piece) return;
    const dx = fromSq.offsetLeft - toSq.offsetLeft;
    const dy = fromSq.offsetTop - toSq.offsetTop;
    piece.style.transition = "none";
    piece.style.transform = `translate(${dx}px, ${dy}px)`;
    void piece.offsetWidth;
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
    void el.offsetWidth;
    el.classList.add("move-pulse");
    window.setTimeout(() => el.classList.remove("move-pulse"), 500);
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
      square.classList.toggle(
        "last-move",
        Boolean(this.lastMove) && this.lastMove.includes(squareName)
      );
    });
    this._syncMoveBadge();
  }

  _syncMoveBadge() {
    this.squares.forEach((square) => {
      const existing = square.querySelector(".square-badge");
      if (existing) existing.remove();
    });
    if (!this.moveBadge) return;
    const square = this.squares.get(this.moveBadge.square);
    if (!square) return;
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function postJson(path, body) {
  return api(path, {
    method: "POST",
    body: JSON.stringify(body || {}),
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
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  if (name === "train") {
    loadTrainRepertoireOptions();
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

function renderAnnotations(overlay, arrows, orientation = "white", engineArrow = null) {
  overlay.setAttribute("viewBox", "0 0 100 100");
  const userColor = "rgba(214, 92, 50, 0.92)";
  const engineColor = "rgba(74, 137, 100, 0.92)";
  overlay.innerHTML = "";
  const drawArrow = (arrow, color) => {
    const from = squareCenter(arrow.slice(0, 2), orientation);
    const to = squareCenter(arrow.slice(2, 4), orientation);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", buildArrowPath(from, to));
    path.setAttribute("fill", color);
    path.setAttribute("stroke", "rgba(0, 0, 0, 0.18)");
    path.setAttribute("stroke-width", "0.35");
    path.setAttribute("stroke-linejoin", "round");
    overlay.appendChild(path);
  };
  arrows.forEach((arrow) => drawArrow(arrow, userColor));
  if (engineArrow && engineArrow.length >= 4) drawArrow(engineArrow, engineColor);
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

async function boardAfterMove(fen, moveUci) {
  return api("/api/board/move", {
    method: "POST",
    body: JSON.stringify({ fen, move_uci: moveUci }),
  });
}

async function boardInfo(fen) {
  return api(`/api/board?fen=${encodeURIComponent(fen)}`);
}

async function loadDashboard() {
  const payload = await api("/api/dashboard");
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
    dueMetric.addEventListener("click", () => {
      switchView("train");
      appState.trainMode = "mistakes_only";
      const btn = document.querySelector('#train-modes .train-mode[data-mode="mistakes_only"]');
      if (btn) btn.click();
      setStatus("Due review - pick a repertoire and start");
    });
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
  renderLichessChip();
  syncReplayControls();
}

function renderLichessChip() {
  const chip = document.getElementById("lichess-chip");
  const label = document.getElementById("lichess-label");
  if (!chip || !label) return;
  const u = appState.lichessUsername;
  if (u) {
    chip.classList.add("is-connected");
    label.textContent = u;
    chip.title = `Lichess: connected as ${u} (click to change)`;
  } else {
    chip.classList.remove("is-connected");
    label.textContent = "Connect Lichess";
    chip.title = "Connect a Lichess account";
  }
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

// Clicking the chip connects via OAuth when signed out, or disconnects when
// signed in.
async function promptLichessConnect() {
  if (appState.lichessUsername) {
    const confirmed = await showConfirmModal({
      title: "Disconnect Lichess?",
      body: `You are connected as ${appState.lichessUsername}. Disconnecting stops latest-game fetch and replay comparison until you connect again.`,
      okLabel: "Disconnect",
      cancelLabel: "Stay connected",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await postJson("/api/lichess/disconnect", {});
    } catch (_) {
      /* ignore */
    }
    setLichessUsername("");
    stopLichessGameWatch();
    setStatus("Lichess disconnected");
    return;
  }
  startLichessOAuth();
}

// Pull the server's stored connection state (the source of truth with OAuth).
async function refreshLichessStatus() {
  try {
    const status = await api("/api/lichess/status");
    setLichessUsername(status.connected ? status.username : "");
    if (status.connected) startLichessGameWatch();
  } catch (_) {
    renderLichessChip();
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

// Background watch: while connected, periodically check whether a newer game
// has appeared and, if so, surface the "you just finished a game" widget. The
// 90s cadence stays inside the prompt-cache window and is plenty for "just".
function startLichessGameWatch() {
  stopLichessGameWatch();
  appState.lichessWatch = window.setInterval(checkLatestLichessGame, 90000);
  window.setTimeout(checkLatestLichessGame, 4000);
}

function stopLichessGameWatch() {
  if (appState.lichessWatch) {
    window.clearInterval(appState.lichessWatch);
    appState.lichessWatch = null;
  }
}

async function checkLatestLichessGame() {
  if (!appState.lichessUsername) return;
  let latest;
  try {
    latest = await api("/api/lichess/latest");
  } catch (_) {
    return;
  }
  if (latest.has_game && latest.is_new) showNewGameWidget(latest);
}

// Bottom-right card nudging the player to analyze the game they just finished.
function showNewGameWidget(game) {
  if (appState.newGameWidgetId === game.lichess_id) return;
  appState.newGameWidgetId = game.lichess_id;
  const host = document.getElementById("newgame-host") || document.body;
  const card = document.createElement("div");
  card.className = "newgame-widget";
  card.innerHTML =
    `<div class="ngw-body">` +
    `<div class="ngw-title">You just finished a game!</div>` +
    `<div class="ngw-sub">${escapeHtml(game.white || "?")} vs ${escapeHtml(game.black || "?")}` +
    `${game.result ? " · " + escapeHtml(game.result) : ""}</div>` +
    `</div>` +
    `<div class="ngw-actions">` +
    `<button class="btn ghost ngw-dismiss" type="button">Dismiss</button>` +
    `<button class="btn primary ngw-analyze" type="button">Analyze</button>` +
    `</div>`;
  host.appendChild(card);
  const cleanup = () => {
    card.remove();
    markLichessSeen(game.lichess_id);
  };
  card.querySelector(".ngw-dismiss").addEventListener("click", cleanup);
  card.querySelector(".ngw-analyze").addEventListener("click", async () => {
    card.remove();
    markLichessSeen(game.lichess_id);
    switchView("analyze");
    document.getElementById("pgn-input").value = game.pgn || "";
    await runAnalysis();
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
  await startTraining("all_lines");
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

async function runAnalysis() {
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
  try {
    const started = await api("/api/analyze/pgn/start", {
      method: "POST",
      body: JSON.stringify({ pgn }),
    });
    appState.analysisJobId = started.job_id;
    jobToast.startJob({
      id: started.job_id,
      title: "Analyzing game",
      tab: "analyze",
      total: started.total_plies || started.total || 0,
    });
    const payload = await pollAnalysisJob(started.job_id);
    appState.analysis = payload;
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
    setStatus(error.message);
    jobToast.failJob(error.message);
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

async function pollAnalysisJob(jobId) {
  while (true) {
    const status = await api(`/api/analyze/status?job_id=${encodeURIComponent(jobId)}`);
    jobToast.updateJob({
      current: status.current_ply || status.current || 0,
      total: status.total_plies || status.total || 0,
      message: status.message || status.status,
    });
    if (status.status === "completed") {
      if (!status.result) throw new Error("Analysis completed without a result");
      return status.result;
    }
    if (status.status === "failed") {
      throw new Error(status.error || "Analysis failed");
    }
    await sleep(500);
  }
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
  if (engineWidget) engineWidget.onBoardChanged();
}

function renderMovePairs(moves) {
  const container = document.getElementById("analysis-moves");
  if (!moves || !moves.length) {
    container.innerHTML =
      '<div class="empty-state">Load a PGN and click Analyze to see the move list.</div>';
    return;
  }
  // Render mainline using the same Build-style branch layout. This keeps
  // the visual language consistent and leaves room for variations later.
  const inner = moves
    .map((move, i) => {
      const prev = i > 0 ? moves[i - 1] : null;
      const isWhite = move.side === "white";
      const needNumber =
        i === 0 ||
        isWhite ||
        !prev ||
        prev.side !== "white" ||
        prev.move_number !== move.move_number;
      const numberHtml = needNumber
        ? `<span class="move-num">${move.move_number}${isWhite ? "." : "..."}</span>`
        : "";
      return numberHtml + analysisInlineMove(move);
    })
    .join("");
  container.innerHTML = `<div class="branch main">${inner}</div>`;
  document.querySelectorAll("#analysis-moves .inline-move[data-ply]").forEach((button) => {
    button.addEventListener("click", (event) => {
      showAnalysisPly(Number(button.dataset.ply));
      event.currentTarget.blur();
    });
  });
}

function analysisInlineMove(move) {
  const cls = escapeHtml(move.classification || "unknown");
  return (
    `<button class="inline-move class-${cls}" data-ply="${Number(move.ply)}" ` +
    `title="${cls}"><span>${escapeHtml(move.san)}</span>` +
    `<span class="move-class-dot"></span></button>`
  );
}

function highlightCurrentMove() {
  let current = null;
  document.querySelectorAll("#analysis-moves .inline-move").forEach((button) => {
    const isCurrent = Number(button.dataset.ply) === appState.analysisPly;
    button.classList.toggle("is-current", isCurrent);
    if (isCurrent) current = button;
  });
  if (current) current.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateEvalChartCursor();
}

async function onAnalysisBoardMove(moveUci, fen) {
  try {
    const knownMove = (appState.analysis?.moves || []).find(
      (move) => move.fen_before === fen && move.uci === moveUci
    );
    if (knownMove) {
      await showAnalysisPly(Number(knownMove.ply));
      return;
    }
    const payload = await boardAfterMove(fen, moveUci);
    appState.analysisBoardFen = payload.board.fen;
    appState.analysisPly = -1;
    boards.analysis.setPosition({
      fen: payload.board.fen,
      legalMoves: payload.board.legal_moves,
      lastMove: moveUci,
    });
    document.getElementById("analysis-board-label").textContent = `Explore: ${payload.move.san}`;
    highlightCurrentMove();
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
}

function renderBuilderTree() {
  const container = document.getElementById("builder-tree");
  if (!appState.build) {
    container.innerHTML =
      '<div class="empty-state">No repertoire loaded. Press <b>New</b> or import one from the Dashboard.</div>';
    return;
  }
  const childrenByParent = new Map();
  let rootId = null;
  for (const node of appState.build.nodes) {
    if (node.depth === 0) {
      rootId = node.id;
      continue;
    }
    if (!childrenByParent.has(node.parent_id)) childrenByParent.set(node.parent_id, []);
    childrenByParent.get(node.parent_id).push(node);
  }
  // Mainline first, then preserve original (DFS) order for stable display.
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
  }
  const segments = [];
  visitChildren(rootId, 0, segments, childrenByParent, null, []);
  let usedSegments = segments.filter((s) => s.nodes.length);
  if (!usedSegments.length) {
    container.innerHTML =
      '<div class="empty-state">Play a move on the board to add it to the repertoire.</div>';
    return;
  }
  // Which variation keys actually have sub-variations under them; only those
  // get a collapse toggle.
  const keysWithDescendants = new Set();
  usedSegments.forEach((s) => (s.ancestors || []).forEach((k) => keysWithDescendants.add(k)));
  const collapsed = appState.buildCollapsed || (appState.buildCollapsed = new Set());
  // Hide any segment living under a collapsed variation.
  const visibleSegments = usedSegments.filter(
    (s) => !(s.ancestors || []).some((k) => collapsed.has(k))
  );

  const currentPath = new Set(buildPath(appState.buildCurrentNodeId).map((n) => n.id));
  const body = visibleSegments
    .map((s) => renderBuildSegment(s, currentPath, keysWithDescendants, collapsed, ""))
    .join("");
  container.innerHTML =
    renderBuildBreadcrumb() + `<div class="build-tree-body">${body}</div>`;
  container.querySelectorAll(".branch-collapse[data-key]").forEach((toggle) => {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = toggle.dataset.key;
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      renderBuilderTree();
    });
  });
  container.querySelectorAll(".inline-move[data-node-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      selectBuildNode(button.dataset.nodeId);
      event.currentTarget.blur();
    });
    button.addEventListener("contextmenu", (event) =>
      openNodeContextMenu(event, button.dataset.nodeId)
    );
  });
  const focusBtn = container.querySelector(".build-tree-body .inline-move.is-current");
  if (focusBtn) focusBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
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
        ? `<span class="move-num">${node.move_number}${isWhite ? "." : "..."}</span>`
        : "";
      const cur = node.id === appState.buildCurrentNodeId ? " is-current" : "";
      return (
        numberHtml +
        `<button class="inline-move crumb${cur}" data-node-id="${escapeHtml(node.id)}">` +
        `${escapeHtml(node.san)}</button>`
      );
    })
    .join(" ");
  return `<div class="build-breadcrumb">${inner}</div>`;
}

function visitChildren(parentId, depth, segments, childrenByParent, segment, ancestors) {
  if (!parentId) return;
  const ancestorKeys = ancestors || [];
  let cur = parentId;
  let seg = segment;
  while (true) {
    const children = childrenByParent.get(cur);
    if (!children || children.length === 0) return;
    const main = children[0];
    const alts = children.slice(1);
    if (!seg) {
      seg = { depth, nodes: [], ancestors: ancestorKeys, key: null };
      segments.push(seg);
    }
    seg.nodes.push(main);
    for (const alt of alts) {
      // Each variation gets a stable key (its first move's node id); its own
      // deeper sub-variations carry that key in `ancestors`, so collapsing the
      // variation hides exactly its descendants.
      const altSeg = { depth: depth + 1, nodes: [alt], ancestors: ancestorKeys, key: alt.id };
      segments.push(altSeg);
      visitChildren(alt.id, depth + 1, segments, childrenByParent, altSeg, ancestorKeys.concat(alt.id));
    }
    if (alts.length > 0) {
      seg = { depth, nodes: [], ancestors: ancestorKeys, key: null };
      segments.push(seg);
    }
    cur = main.id;
  }
}

function renderBuildSegment(segment, currentPath, keysWithDescendants, collapsed, query) {
  const onPathBranch = segment.nodes.some((node) => currentPath.has(node.id));
  const inner = segment.nodes
    .map((node, i) => {
      const prev = i > 0 ? segment.nodes[i - 1] : null;
      const isWhite = node.move_side === "white";
      const needNumber =
        i === 0 ||
        isWhite ||
        !prev ||
        prev.move_side !== "white" ||
        prev.move_number !== node.move_number;
      const numberHtml = needNumber
        ? `<span class="move-num">${node.move_number}${isWhite ? "." : "..."}</span>`
        : "";
      return numberHtml + renderInlineMove(node, currentPath, query);
    })
    .join("");
  const depthClass = `depth-${Math.min(4, Math.max(0, segment.depth))}`;
  const cls = [
    "branch",
    segment.depth === 0 ? "main" : "alt",
    depthClass,
    segment.key ? "starts-variation" : "continues-line",
    onPathBranch ? "is-path-branch" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const indent = segment.depth === 0 ? 0 : (segment.depth - 1) * 14;
  // A collapse toggle sits at the head of any variation that has descendants.
  let toggle = "";
  if (segment.key && keysWithDescendants && keysWithDescendants.has(segment.key)) {
    const isCollapsed = collapsed && collapsed.has(segment.key);
    toggle =
      `<button class="branch-collapse" data-key="${escapeHtml(segment.key)}" ` +
      `title="${isCollapsed ? "Expand variation" : "Collapse variation"}" ` +
      `aria-label="${isCollapsed ? "Expand" : "Collapse"} variation">` +
      `${isCollapsed ? "+" : "-"}</button>`;
  }
  return `<div class="${cls}" style="--branch-indent:${indent}px">${toggle}${inner}</div>`;
}

function renderInlineMove(node, currentPath, query) {
  const safeId = escapeHtml(node.id);
  const isCurrent = node.id === appState.buildCurrentNodeId;
  const onPath = currentPath.has(node.id);
  const isFound = !!query && String(node.san || "").toLowerCase().includes(query);
  const classes = [
    "inline-move",
    node.mastery ? `m-${node.mastery}` : "",
    isCurrent ? "is-current" : "",
    onPath && !isCurrent ? "on-path" : "",
    isFound ? "is-found" : "",
    node.is_enabled ? "" : "is-disabled",
    node.is_mainline ? "is-main" : "",
    node.is_prepared ? "is-prep" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<button class="${classes}" data-node-id="${safeId}">${escapeHtml(node.san)}</button>`;
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

// Move selection to the previous/next sibling variation at the current move,
// so j/k cycles through the alternatives at a branch point.
function buildStepSibling(direction) {
  if (!appState.build || !appState.buildCurrentNodeId) return;
  const current = appState.buildNodeById.get(appState.buildCurrentNodeId);
  if (!current) return;
  const siblings = appState.build.nodes
    .filter((n) => n.parent_id === current.parent_id && n.depth > 0)
    .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
  if (siblings.length < 2) return;
  const idx = siblings.findIndex((n) => n.id === current.id);
  const next = siblings[(idx + direction + siblings.length) % siblings.length];
  if (next) selectBuildNode(next.id);
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
      { name: "ply_depth", label: "Ply depth", type: "number", default: 8, min: 1, max: 20 },
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
      { name: "maia_rating", label: "Maia rating (600-2600)", type: "number", default: 2200, min: 600, max: 2600 },
    ],
  });
  if (!values) return;
  const own_color = values.own_color === "black" ? "black" : "white";
  const ply_depth = Math.max(1, Math.min(20, Number(values.ply_depth) || 8));
  const detail_mode = ["simple", "balanced", "deep"].includes(values.detail_mode)
    ? values.detail_mode
    : "balanced";
  const maia_rating = Math.max(600, Math.min(2600, Number(values.maia_rating) || 2200));
  try {
    setStatus("Generating moves");
    const started = await postJson("/api/build/generate/start", {
      repertoire_id: appState.build.repertoire_id,
      node_id: nodeId,
      ply_depth,
      detail_mode,
      maia_rating,
      own_color,
    });
    jobToast.startJob({
      id: started.job_id,
      title: "Generating moves",
      tab: "build",
      total: started.estimated_total || started.total || ply_depth * 8,
    });
    const payload = await pollBuildJob(started.job_id);
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
    setStatus(error.message);
    jobToast.failJob(error.message);
  }
}

async function pollBuildJob(jobId) {
  while (true) {
    const status = await api(`/api/build/generate/status?job_id=${encodeURIComponent(jobId)}`);
    jobToast.updateJob({
      current: status.added_nodes || status.current || 0,
      total: status.estimated_total || status.total || 0,
      message: status.message || status.status,
    });
    if (status.status === "completed") {
      if (!status.result) throw new Error("Generation completed without a result");
      return status.result;
    }
    if (status.status === "failed") {
      throw new Error(status.error || "Generation failed");
    }
    await sleep(450);
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
  mode = mode || appState.trainMode || "all_lines";
  appState.trainMode = mode;
  setStatus("Starting trainer");
  const repertoireId = selectedTrainRepertoireId();
  appState.trainingRepertoireId = repertoireId;
  const endpoint = repertoireId ? "/api/train/start" : "/api/train/demo/start";
  const body = repertoireId ? { seed: 13, mode, repertoire_id: repertoireId } : { seed: 13, mode };
  try {
    const payload = await postJson(endpoint, body);
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
  const badge = document.getElementById("train-turn-badge");
  if (badge) {
    badge.hidden = false;
    badge.dataset.side = side;
    badge.textContent = side === "white" ? "W" : "B";
  }
  const total = prompt.total_lines || 1;
  document.getElementById("train-line-label").textContent = `Line ${(prompt.current_index || 0) + 1} / ${total}`;
  document.getElementById("train-progress-fill").style.width =
    `${Math.round(((prompt.current_index || 0) / Math.max(1, total)) * 100)}%`;
  const name = (appState.training && appState.training.repertoire_name) || "Repertoire";
  const color = (appState.training && appState.training.color) || "white";
  document.getElementById("train-board-label").textContent = `${name} - you play ${color}`;
}

async function submitTrainingMove(playedUci) {
  if (appState.trainReview && appState.trainReview.active) {
    return submitReviewMove(playedUci);
  }
  const prompt = currentTrainingPrompt();
  if (!prompt || !playedUci || appState.trainBusy) return;
  let result;
  try {
    result = await api("/api/train/move", {
      method: "POST",
      body: JSON.stringify({ session_id: prompt.session_id, played_uci: playedUci }),
    });
  } catch (error) {
    setStatus(error.message);
    return;
  }
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
  const badge = document.getElementById("train-turn-badge");
  if (badge) {
    badge.hidden = false;
    badge.dataset.side = side;
    badge.textContent = side === "white" ? "W" : "B";
  }
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

async function loadSettings() {
  try {
    const payload = await api("/api/settings");
    appState.settings = payload;
    renderSettings(payload);
  } catch (error) {
    setStatus(error.message);
  }
}

function renderSettings(payload) {
  const stockfish = payload.stockfish || {};
  document.getElementById("settings-stockfish-path").textContent = stockfish.path || "(not installed)";
  document.getElementById("settings-stockfish-version").textContent =
    stockfish.version || (stockfish.installed ? "(unknown - could not handshake)" : "...");
  document.getElementById("settings-depth-input").value = payload.stockfish_depth ?? 16;
  const status = document.getElementById("settings-stockfish-status");
  if (stockfish.error) {
    status.textContent = stockfish.error;
  } else if (!stockfish.installed) {
    status.textContent = "Use Install / Update Stockfish to fetch the latest release.";
  } else {
    status.textContent = "";
  }
  const maia3 = payload.maia3 || {};
  const maiaModel = document.getElementById("settings-maia-model");
  const maiaRepo = document.getElementById("settings-maia-repo");
  const maiaStatus = document.getElementById("settings-maia-status");
  if (maiaModel) {
    maiaModel.textContent = maia3.model
      ? `${maia3.model}${maia3.package_installed ? "" : " (package missing)"}`
      : "(not configured)";
  }
  if (maiaRepo) maiaRepo.textContent = maia3.repo || "(not configured)";
  if (maiaStatus) {
    maiaStatus.textContent = maia3.brilliant_ready
      ? "Maia3 is ready - human move prediction and Brilliant detection enabled."
      : "Install CSSLab Maia3 to enable the real model and Brilliant detection.";
  }
}

async function saveStockfishDepth() {
  const value = Math.max(1, Math.min(30, Number(document.getElementById("settings-depth-input").value) || 16));
  try {
    const payload = await postJson("/api/settings", { stockfish_depth: value });
    renderSettings(payload);
    setStatus(`Stockfish depth saved: ${value}`);
  } catch (error) {
    setStatus(error.message);
  }
}

// App-Store-style action: spinner while working, then a check or error badge.
async function runEngineAction(btnId, request, { working = "Working...", okText } = {}) {
  const btn = document.getElementById(btnId);
  if (!btn || btn.classList.contains("is-working")) return;
  const label = btn.querySelector(".ea-label");
  const original = label ? label.textContent : "";
  btn.classList.remove("is-done", "is-error");
  btn.classList.add("is-working");
  btn.disabled = true;
  if (label) label.textContent = working;
  setStatus(working);
  try {
    const payload = await request();
    btn.classList.remove("is-working");
    btn.classList.add("is-done");
    const done = okText ? okText(payload) : "Done";
    if (label) label.textContent = done;
    setStatus(done);
    await loadSettings();
    window.setTimeout(() => {
      btn.classList.remove("is-done");
      if (label) label.textContent = original;
    }, 2400);
  } catch (error) {
    btn.classList.remove("is-working");
    btn.classList.add("is-error");
    if (label) label.textContent = "Failed";
    setStatus(error.message);
    window.setTimeout(() => {
      btn.classList.remove("is-error");
      if (label) label.textContent = original;
    }, 2800);
  } finally {
    btn.disabled = false;
  }
}

function installStockfish() {
  return runEngineAction("settings-stockfish-install", () => postJson("/api/stockfish/install", {}), {
    working: "Downloading Stockfish...",
    okText: (p) => (p.already_present ? "Already installed" : `Installed ${p.version || ""}`.trim()),
  });
}

function installMaia3() {
  return runEngineAction("settings-maia-install", () => postJson("/api/maia3/install", {}), {
    working: "Installing Maia3...",
    okText: (p) => (p.already_present ? "Up to date" : "Installed"),
  });
}

const ENGINE_PROMPTED_KEY = "prepforge.engine_prompted";

// First-run nudge: analysis needs Stockfish, so if it's missing on startup,
// offer a one-click install instead of letting the first Analyze just fail.
// Only the engine, no training/analysis tutorial (kept intentionally light).
async function maybePromptEngineSetup() {
  let prompted = false;
  try {
    prompted = localStorage.getItem(ENGINE_PROMPTED_KEY) === "1";
  } catch (_) {
    /* ignore storage errors */
  }
  if (prompted) return;
  let settings;
  try {
    settings = await api("/api/settings");
  } catch (_) {
    return;
  }
  if (settings && settings.stockfish && settings.stockfish.installed) return;
  showEngineSetupModal();
}

function markEnginePrompted() {
  try {
    localStorage.setItem(ENGINE_PROMPTED_KEY, "1");
  } catch (_) {
    /* ignore storage errors */
  }
}

function showEngineSetupModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" data-testid="engine-setup-modal">
      <div class="modal-title">Set up the analysis engine</div>
      <div class="modal-body">
        <p class="muted">
          PrepForge uses <b>Stockfish</b> to analyze your games and grade moves.
          It isn't installed yet - install it now (a one-time download) to enable Analyze.
        </p>
        <p class="muted engine-setup-status" id="engine-setup-status" hidden></p>
      </div>
      <div class="modal-footer">
        <button class="btn ghost" data-action="later" type="button">Maybe later</button>
        <button class="btn primary" data-action="install" type="button">Install Stockfish</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => {
    markEnginePrompted();
    overlay.remove();
  };
  overlay.querySelector('[data-action="later"]').addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  const installBtn = overlay.querySelector('[data-action="install"]');
  const statusEl = overlay.querySelector("#engine-setup-status");
  installBtn.addEventListener("click", async () => {
    installBtn.disabled = true;
    statusEl.hidden = false;
    statusEl.textContent = "Downloading Stockfish...";
    try {
      const payload = await postJson("/api/stockfish/install", {});
      statusEl.textContent = payload.already_present
        ? "Already installed."
        : `Installed ${payload.version || "Stockfish"}. Analyze is ready.`;
      setStatus("Stockfish ready");
      markEnginePrompted();
      // Refresh anything that reflects engine availability.
      if (activeViewName() === "settings") await loadSettings();
      window.setTimeout(() => overlay.remove(), 1100);
    } catch (error) {
      statusEl.textContent = `Install failed: ${error.message}`;
      installBtn.disabled = false;
    }
  });
}

async function runLichessCompare() {
  if (!appState.lichessUsername) {
    setStatus("Connect a Lichess account first");
    await promptLichessConnect();
    if (!appState.lichessUsername) return;
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
    setStatus(`Fetched ${payload.count} games for ${payload.username}`);
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
    lines.push(`You diverged on ply ${game.departure_ply}${played}${expected}. Adding to review queue is a planned follow-up.`);
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
  document.getElementById("settings-depth-save").addEventListener("click", saveStockfishDepth);
  document.getElementById("settings-stockfish-install").addEventListener("click", installStockfish);
  document.getElementById("settings-maia-install").addEventListener("click", installMaia3);

  // Lichess chip
  document.getElementById("lichess-chip").addEventListener("click", promptLichessConnect);

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
  document.getElementById("analysis-start").addEventListener("click", () => showAnalysisPly(0));
  document
    .getElementById("analysis-prev")
    .addEventListener("click", () => showAnalysisPly(appState.analysisPly - 1));
  document
    .getElementById("analysis-next")
    .addEventListener("click", () => showAnalysisPly(appState.analysisPly + 1));
  document
    .getElementById("analysis-end")
    .addEventListener("click", () => showAnalysisPly(appState.analysis?.moves.length || 0));

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
  document.querySelectorAll("#train-modes .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#train-modes .train-mode")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      appState.trainMode = btn.dataset.mode;
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
      else showAnalysisPly(appState.analysisPly - 1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (inBuild) buildGoForward();
      else showAnalysisPly(appState.analysisPly + 1);
    }
    // j/k step through sibling variations of the current move in Build.
    if (inBuild && (event.key === "j" || event.key === "k")) {
      event.preventDefault();
      buildStepSibling(event.key === "j" ? 1 : -1);
    }
    if (event.key === "Escape") {
      closeNodeContextMenu();
      closeRepertoireContextMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#node-context-menu")) closeNodeContextMenu();
    if (!event.target.closest("#repertoire-context-menu")) closeRepertoireContextMenu();
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
  bindEvents();
  renderPieceStylePicker();
  renderPrefsToggles();
  prefillDemoPgn();
  // Show any cached username instantly, then reconcile with the server (OAuth
  // connection state is stored server-side and is the source of truth).
  try {
    const stored = localStorage.getItem(LICHESS_KEY);
    if (stored) setLichessUsername(stored);
    else renderLichessChip();
  } catch (_) {
    renderLichessChip();
  }
  refreshLichessStatus();
  syncReplayControls();
  const info = await boardInfo(START_FEN);
  boards.analysis.setPosition({ fen: START_FEN, legalMoves: info.legal_moves });
  boards.build.setPosition({ fen: START_FEN, legalMoves: info.legal_moves });
  boards.train.setPosition({ fen: START_FEN, legalMoves: info.legal_moves });
  renderBuilderTree();
  await loadDashboard();
  // First-run: offer to install Stockfish if it's missing (after the UI is up).
  maybePromptEngineSetup();
}

init().catch((error) => setStatus(error.message));
