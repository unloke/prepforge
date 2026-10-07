import { localGameOver } from "../chess-local.js";
import { buildPvPreview, clampPly, previewPosition, previewLabel, stepPreview } from "../pv-preview.js";
import { formatEngineEval } from "../engine-eval.js";

let effectiveStockfishDepth, createSharedEvaluationProvider, activeViewName, appState,
  boards, START_FEN, setEngineBestArrow, setStatusError, escapeHtml, setEngineOn,
  activeBoardController, explorerEvalEngine, getAnalyzeSession;

export function createEngineWidget(deps) {
  ({
    effectiveStockfishDepth, createSharedEvaluationProvider, activeViewName, appState,
    boards, START_FEN, setEngineBestArrow, setStatusError, escapeHtml, setEngineOn,
    activeBoardController, explorerEvalEngine, getAnalyzeSession,
  } = deps);
  const widget = new EngineWidget();
  widget.bind();
  return widget;
}

class EngineWidget {
  constructor() {
    this.el = null;
    this.pvsEl = null;
    this.evalBarWhite = null;
    this.evalBarText = null;
    this.evalHead = null;
    this.linesReadout = null;
    this.linesUpBtn = null;
    this.linesDownBtn = null;
    this.depthReadout = null;
    this.closeBtn = null;
    this.open = false;
    this.pollTimer = null;
    this.lastFen = null;
    this.lastSnapshot = null;
    // The engine line shown on the board (see _previewLine), or null.
    this.preview = null;
    this.multipv = 1;
    // Lines actually searched. Always the shown lines: Explorer row evals come
    // from their own worker (explorerEvalEngine), so the main line keeps the
    // full-strength single-PV search instead of being widened to every row.
    this.searchedMultipv = 1;
    this.maxMultipv = 5;
    this.minMultipv = 1;
    // Engine compute seam: browser Stockfish (WASM Worker) only. No server
    // fallback — if the browser engine is unavailable the widget shows an error.
    // Built lazily (on first open) at the Settings depth, and rebuilt if that
    // depth changes — so the slider in Settings actually steers the widget.
    this.engine = null;
    this.engineDepth = null;
  }

  // Build the provider on demand at the current Settings depth. If the depth changed
  // since we last built (the user dragged the slider), close the stale provider and
  // make a fresh one — the depth readout then naturally shows `current / new max`.
  _ensureEngine() {
    const depth = effectiveStockfishDepth();
    if (this.engine && this.engineDepth === depth) return;
    if (this.engine) {
      try {
        this.engine.close();
      } catch (_) {
        /* best-effort */
      }
    }
    this.engine = createSharedEvaluationProvider({ maxDepth: depth });
    this.engineDepth = depth;
  }

  // Settings depth changed: if open, rebuild at the new depth and re-analyze the
  // current board; if closed, drop the stale provider so the next open rebuilds.
  async onDepthSettingChanged() {
    if (this.engineDepth === effectiveStockfishDepth()) return;
    if (!this.open) {
      if (this.engine) {
        try {
          await this.engine.close();
        } catch (_) {
          /* best-effort */
        }
      }
      this.engine = null;
      this.engineDepth = null;
      return;
    }
    await this._restartForCurrentBoard();
    this._startPolling();
  }

  bind() {
    this.el = document.getElementById("engine-window");
    if (!this.el) return;
    this.pvsEl = document.getElementById("engine-window-pvs");
    this.evalBarWhite = document.getElementById("engine-eval-bar-white");
    this.evalBarText = document.getElementById("engine-eval-bar-text");
    this.evalHead = document.getElementById("engine-head-eval");
    this.linesReadout = document.getElementById("engine-lines-readout");
    this.linesUpBtn = document.getElementById("engine-lines-up");
    this.linesDownBtn = document.getElementById("engine-lines-down");
    this.depthReadout = document.getElementById("engine-window-depth-readout");
    this.closeBtn = document.getElementById("engine-window-close");
    this._renderLinesReadout();
    this._bindControls();
  }

  isOpen() {
    return this.open;
  }

  /** FEN of whichever board the active tab is showing. */
  currentFen() {
    if (activeViewName() === "build") {
      const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
      if (node && node.fen) return node.fen;
      // No repertoire open: analyse what the Build board shows, never the
      // Analyze board's position.
      return (boards.build && boards.build.fen) || START_FEN;
    }
    return appState.analysisBoardFen || START_FEN;
  }

  async openForCurrent() {
    // The engine widget runs its own lightweight Stockfish session and is
    // intentionally *not* gated on heavy Analyze/Build jobs — the user can keep
    // probing positions while a long job runs in the background.
    this.open = true;
    this.el.hidden = false;
    this.el.classList.add("is-visible");
    await this._restartForCurrentBoard();
    this._startPolling();
  }

  async close() {
    if (!this.open) return;
    this.exitPreview();
    this.open = false;
    this._stopPolling();
    setEngineBestArrow(null);
    this.el.classList.remove("is-visible");
    setTimeout(() => {
      if (!this.el.classList.contains("is-visible")) this.el.hidden = true;
    }, 240);
    try {
      if (this.engine) await this.engine.close();
    } catch (_) {
      // best-effort
    }
  }

  _searchMultipv() {
    return activeViewName() === "analyze" ? Math.max(2, this.multipv) : this.multipv;
  }

  /** Re-analyze whenever the active board changes. No-op if widget closed. */
  async onBoardChanged() {
    if (!this.open) return;
    const fen = this.currentFen();
    if (fen === this.lastFen) return;
    this._ensureEngine();
    const engine = this.engine;
    this.lastFen = fen;
    this._clearAnalysisView();
    try {
      this.searchedMultipv = this._searchMultipv();
      const snapshot = await engine.update({ fen, multipv: this.searchedMultipv });
      // Bail if the world moved while update() was in flight: the panel closed, a NEWER board
      // change set a different lastFen, or a depth change swapped the provider out. Otherwise we'd
      // paint this (now stale) FEN's eval onto the current board, or poll the wrong provider.
      // provider.serialize() orders engine commands, not these UI continuations.
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._renderSnapshot(snapshot);
      this._startPolling();
    } catch (error) {
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._showError(error.message);
    }
  }

  async _restartForCurrentBoard() {
    this._ensureEngine();
    const engine = this.engine;
    const fen = this.currentFen();
    this.lastFen = fen;
    this._clearAnalysisView();
    try {
      this.searchedMultipv = this._searchMultipv();
      const snapshot = await engine.open({ fen, multipv: this.searchedMultipv });
      // Bail if the panel closed, the board moved on, or a depth change swapped the provider
      // while open() was in flight (see onBoardChanged).
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      // Render the response immediately so depth/PVs appear without waiting
      // for the first poll.
      this._renderSnapshot(snapshot);
    } catch (error) {
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
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
    const engine = this.engine;
    const fen = this.lastFen || this.currentFen();
    try {
      this.searchedMultipv = this._searchMultipv();
      const snapshot = await engine.update({ fen, multipv: this.searchedMultipv });
      // Bail if the world moved while update() was in flight: panel closed, provider swapped, the
      // board changed, or the line count was clicked again (this.multipv !== clamped). See
      // onBoardChanged.
      if (
        !this.open ||
        engine !== this.engine ||
        fen !== this.lastFen ||
        this.multipv !== clamped
      ) {
        return;
      }
      this._renderSnapshot(snapshot);
      this._startPolling();
    } catch (error) {
      if (!this.open || engine !== this.engine || this.multipv !== clamped) return;
      this._showError(error.message);
    }
  }

  _showError(message) {
    setEngineBestArrow(null);
    setStatusError(message);
    if (this.pvsEl) {
      this.pvsEl.innerHTML = `<div class="empty-state">${escapeHtml(
        message || "Engine error"
      )}</div>`;
    }
  }

  _clearAnalysisView() {
    setEngineBestArrow(null);
    this.exitPreview();
    if (this.lastFen && this._renderGameOver(this.lastFen)) return;
    if (this.pvsEl) this.pvsEl.innerHTML = this._pendingRows(0);
    if (this.depthReadout) this.depthReadout.textContent = "0 / ?";
    if (this.evalBarText) this.evalBarText.textContent = "...";
    if (this.evalHead) {
      // Analyze keeps the last live number while the next position warms up.
      if (activeViewName() !== "analyze") {
        this.evalHead.textContent = "...";
        delete this.evalHead.dataset.side;
      }
      this.evalHead.dataset.pending = "true";
    }
  }

  // Placeholder rows so the panel keeps the same height while a search warms up:
  // one row per requested line, identical in size to a real line.
  _pendingRows(from) {
    let html = "";
    for (let i = from; i < this.multipv; i += 1) {
      html +=
        '<div class="engine-pv is-pending" aria-hidden="true">' +
        '<span class="engine-pv-eval">…</span>' +
        `<span class="engine-pv-line">${i === 0 ? "Calculating…" : ""}</span>` +
        "</div>";
    }
    return html;
  }

  // Checkmate / stalemate / draw on the board: there is no line to search, so
  // say the result instead of "Calculating…" forever. Returns true if shown.
  _renderGameOver(fen) {
    const over = localGameOver(fen);
    if (!over) return false;
    setEngineBestArrow(null);
    const text =
      over.kind === "checkmate"
        ? `Checkmate — ${over.winner === "white" ? "White" : "Black"} wins`
        : over.kind === "stalemate"
          ? "Stalemate — draw"
          : "Draw";
    if (this.pvsEl) {
      this.pvsEl.innerHTML =
        '<div class="engine-pv is-top is-final">' +
        `<span class="engine-pv-eval">${escapeHtml(over.result)}</span>` +
        `<span class="engine-pv-line">${escapeHtml(text)}</span>` +
        "</div>";
    }
    if (this.depthReadout) this.depthReadout.textContent = "—";
    if (this.evalBarWhite) {
      this.evalBarWhite.style.height =
        over.winner === "white" ? "100%" : over.winner === "black" ? "0%" : "50%";
    }
    if (this.evalBarText) this.evalBarText.textContent = over.result;
    if (this.evalHead) {
      this.evalHead.textContent = over.result;
      this.evalHead.dataset.side = over.winner || "even";
      delete this.evalHead.dataset.pending;
    }
    return true;
  }

  _renderLinesReadout() {
    if (!this.linesReadout) return;
    this.linesReadout.textContent = `${this.multipv}`;
    if (this.linesDownBtn) this.linesDownBtn.disabled = this.multipv <= this.minMultipv;
    if (this.linesUpBtn) this.linesUpBtn.disabled = this.multipv >= this.maxMultipv;
  }

  _bindControls() {
    this.closeBtn.addEventListener("click", () => setEngineOn(activeViewName(), false));
    this.linesUpBtn.addEventListener("click", () => this._setMultipv(this.multipv + 1));
    this.linesDownBtn.addEventListener("click", () => this._setMultipv(this.multipv - 1));
    // A line is for the board: clicking it (or one of its moves) plays it out there,
    // ◀ ▶ / ← → step through it, and "Back to game" (or Esc) returns. The game, the
    // analysis tree and repertoires are never touched.
    this.pvsEl.addEventListener("click", (event) => {
      const row = event.target.closest(".engine-pv[data-line]");
      if (!row) return;
      const move = event.target.closest(".pv-move[data-ply]");
      this._previewLine(Number(row.dataset.line), move ? Number(move.dataset.ply) + 1 : null);
    });
    // The rows are real controls, so Enter/Space must work too.
    this.pvsEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest(".engine-pv[data-line]");
      if (!row) return;
      event.preventDefault(); // Space would otherwise scroll the dock
      this._previewLine(Number(row.dataset.line), null);
    });
  }

  isPreviewing() {
    return !!this.preview;
  }

  // Put line `index` of the current search on the board at `ply` (1 = after its first
  // move). Clicking the previewed row again (not one of its moves) goes back to the game.
  _previewLine(index, ply) {
    if (!Number.isFinite(index)) return;
    if (this.preview && this.preview.index === index && ply === null) {
      this.exitPreview();
      return;
    }
    // A move in the previewed row belongs to the line shown there, not to whatever
    // the search has since put in that slot.
    const board = activeBoardController();
    const same = this.preview && this.preview.index === index && this.preview.board === board ? this.preview : null;
    const pv = same ? same.pv : (this.lastSnapshot?.pvs || [])[index];
    const data = same ? same.data : pv && board ? buildPvPreview(this.lastFen, pv.pv_uci || []) : null;
    if (!data) return;
    if (this.preview && this.preview.board !== board) this.exitPreview();
    const view = activeViewName();
    const labelEl = document.getElementById(view === "build" ? "build-board-label" : "analysis-board-label");
    const exitBtn = document.getElementById(view === "build" ? "build-pv-exit" : "analysis-pv-exit");
    if (!this.preview) {
      board.beginPreview({ onEnd: ({ restored }) => this._onPreviewEnded(restored) });
      this.preview = { labelEl, exitBtn, savedLabel: labelEl ? labelEl.textContent : "" };
    }
    Object.assign(this.preview, { index, data, pv, board, ply: clampPly(data, ply ?? 1) });
    this._showPreviewPly();
  }

  // ◀ ▶ ⏮ ⏭ and ← → while a line is on the board. Returns false when not previewing.
  stepPreview(action) {
    if (!this.preview) return false;
    this.preview.ply = stepPreview(this.preview.data, this.preview.ply, action);
    this._showPreviewPly();
    return true;
  }

  _showPreviewPly() {
    const p = this.preview;
    if (!p) return;
    p.board.showPreview(previewPosition(p.data, p.ply));
    if (p.labelEl) p.labelEl.textContent = previewLabel(p.data, p.ply, p.index);
    if (p.exitBtn) p.exitBtn.hidden = false;
    this._repaintRows();
  }

  // Back to the game position (no-op when not previewing).
  exitPreview() {
    if (!this.preview) return;
    this.preview.board.endPreview({ restore: true });
  }

  // The board left the preview: restored to the game (restored) or replaced by a new real
  // position the caller is about to label (not restored).
  _onPreviewEnded(restored) {
    const p = this.preview;
    if (!p) return;
    this.preview = null;
    if (restored && p.labelEl) p.labelEl.textContent = p.savedLabel;
    if (p.exitBtn) p.exitBtn.hidden = true;
    this._repaintRows();
  }

  _repaintRows() {
    if (this.lastSnapshot && this.lastSnapshot.fen === this.lastFen) this._renderSnapshot(this.lastSnapshot);
  }

  _startPolling() {
    // Never poll a closed panel. openForCurrent()/onDepthSettingChanged() call this right after
    // awaiting _restartForCurrentBoard(), so the user may have closed the widget mid-await — guard
    // here to cover every call site at once (a stray 450ms interval on a hidden panel otherwise).
    if (!this.open) return;
    this._stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const engine = this.engine;
        const fen = this.lastFen;
        const snapshot = await engine.snapshot();
        if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
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
    if (snapshot?.fen && snapshot.fen !== this.lastFen) return;
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
    const pvs = Array.isArray(snapshot.pvs) ? snapshot.pvs : [];
    if (!pvs.length && this._renderGameOver(snapshot.fen || this.lastFen)) {
      this._stopPolling();
      return;
    }
    const depthText = `${snapshot.current_depth || 0} / ${snapshot.max_depth || "?"}`;
    if (this.depthReadout) this.depthReadout.textContent = depthText;
    // Render only as many PV slots as the user asked for; engines occasionally
    // emit transient extra ranks while changing multipv. Missing ranks keep a
    // placeholder row so the block never changes height mid-search.
    const sideToMove = snapshot.side_to_move || "white";
    const fullmoveNumber = this._fullmoveFromFen(snapshot.fen) || 1;
    const shown = pvs.slice(0, this.multipv);
    this.pvsEl.innerHTML =
      shown
        .map((pv, index) => this._renderPv(pv, index, sideToMove, fullmoveNumber))
        .join("") + this._pendingRows(shown.length);
    if (pvs.length) {
      this._renderEvalBar(pvs[0]);
      const best = (pvs[0].pv_uci || [])[0] || null;
      setEngineBestArrow(best);
    } else {
      setEngineBestArrow(null);
    }
    // The main line is the reference the Explorer's per-row colours compare against.
    explorerEvalEngine.repaint();
    // Keep the coach's one-line rationale in sync with this (deeper) search.
    getAnalyzeSession()?.positionCoach.onWidgetSnapshot(snapshot);
    // Once the engine reaches max depth it stops; no point polling further
    // until the position changes (open/update restart polling).
    if (snapshot.running === false) this._stopPolling();
  }

  // One line per row, cut off at the panel edge. Clicking a row plays it out on the
  // board; the previewed row keeps the line it was clicked on (the search goes on
  // underneath) and marks the move on the board; rows stay one line.
  _renderPv(pv, index, sideToMove, fullmoveNumber) {
    const previewing = this.preview && this.preview.index === index ? this.preview : null;
    const line = previewing ? previewing.pv : pv;
    const evalText = formatEngineEval(line.score_cp, line.mate_in);
    const moves = this._formatPvLine(
      line.pv_san || [],
      sideToMove,
      fullmoveNumber,
      previewing ? previewing.ply - 1 : -1
    );
    let cls = index === 0 ? "engine-pv is-top" : "engine-pv";
    if (previewing) cls += " is-previewing";
    const title = previewing ? "Back to game" : "Show on board";
    return (
      `<div class="${cls}" data-line="${index}" role="button" tabindex="0"` +
      ` aria-pressed="${!!previewing}" title="${title}">` +
      `<span class="engine-pv-eval">${escapeHtml(evalText)}</span>` +
      `<span class="engine-pv-line">${moves || "..."}</span>` +
      `</div>`
    );
  }

  _formatPvLine(moves, sideToMove, fullmoveNumber, currentPly = -1) {
    if (!moves || !moves.length) return "";
    const out = [];
    let move = fullmoveNumber;
    let whiteToMove = sideToMove === "white";
    for (let i = 0; i < moves.length; i += 1) {
      const san = `<span class="pv-move${i === currentPly ? " is-current" : ""}" data-ply="${i}">${escapeHtml(moves[i])}</span>`;
      if (whiteToMove) {
        out.push(`<span class="pv-move-num">${move}.</span>${san}`);
      } else {
        if (i === 0) {
          out.push(`<span class="pv-move-num">${move}...</span>${san}`);
        } else {
          out.push(san);
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

  _renderEvalBar(topPv) {
    // A scoreless MultiPV placeholder is still warming up.
    if (activeViewName() === "analyze" && topPv.score_cp == null && topPv.mate_in == null) return;
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
    const evalStr = formatEngineEval(topPv.score_cp, topPv.mate_in);
    if (this.evalBarWhite) {
      this.evalBarWhite.style.height = `${Math.round(wc * 100)}%`;
    }
    if (this.evalBarText) {
      this.evalBarText.textContent = evalStr;
      // The number sits at the winning side's end of the bar, in that side's
      // contrasting ink — top/light text on black, bottom/dark text on white —
      // so a big White advantage never renders white-on-white.
      this.evalBarText.classList.toggle("is-white-side", wc >= 0.5);
    }
    if (this.evalHead) {
      this.evalHead.textContent = evalStr;
      this.evalHead.dataset.side = wc > 0.52 ? "white" : wc < 0.48 ? "black" : "even";
      delete this.evalHead.dataset.pending;
    }
  }

}
