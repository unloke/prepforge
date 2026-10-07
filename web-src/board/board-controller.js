import { typedSquare } from "../board-navigation.js";

let pref, renderAnnotations, files, isPromotionMove, resolveBoardMove, legalMoveFor,
  pieceSvg, parseFenBoard, playSound, pieceLabel, legalTargetsFrom, escapeHtml;

export function createBoardController(deps) {
  ({
    pref, renderAnnotations, files, isPromotionMove, resolveBoardMove, legalMoveFor,
    pieceSvg, parseFenBoard, playSound, pieceLabel, legalTargetsFrom, escapeHtml,
  } = deps);
  return BoardController;
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
    this.betterArrow = null;
    this.branchArrows = [];
    this.branchPick = null;
    this.moveBadge = null;
    this._hadPosition = false;
    this.annotationStart = null;
    this.highlights = new Set();
    this.arrows = [];
    this.squares = new Map();
    this._badgeEl = null;       // tracks the one square holding a .square-badge
    this._badgeKey = "";        // what that badge shows, so an unchanged one is left alone
    this._lastMoveSqs = null;   // tracks the [from, to] squares of the current last-move
    this.orientation = "white";
    this._rovingSquare = null; // tabbable-square cursor for the roving tabindex
    this._typedFile = null; // file letter typed toward a keyboard square jump ("e" of "e4")
    this._typedAt = 0;
    this._buildGrid();
    this._bindBoardEvents();
  }

  setOrientation(orientation) {
    const next = orientation === "black" ? "black" : "white";
    if (this.orientation === next) return;
    this.orientation = next;
    // Rebuilding the grid drops DOM focus (innerHTML wipe); restore it to the
    // same square so a keyboard user isn't dumped out of the board on a flip.
    const focusedSquare = document.activeElement?.dataset?.square;
    this._buildGrid();
    if (focusedSquare && this.squares.has(focusedSquare)) {
      this.squares.get(focusedSquare).focus();
    }
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
    renderAnnotations(
      this.overlay,
      this.arrows,
      this.orientation,
      this.engineArrow,
      this.branchArrows,
      this.branchPick,
      this.betterArrow
    );
  }

  // --- Engine-line preview ---------------------------------------------------
  // Shows positions that are not the game's (an engine PV) without touching the game,
  // the analysis tree or a repertoire. The real position is saved on entry and put back
  // by endPreview(); a real setPosition() while previewing ends the preview instead (the
  // game moved on), so a stale preview can never hide the real board. Moves are off while
  // previewing (no legal moves), and engine/fork arrows meant for the real position wait.
  beginPreview({ onEnd = null } = {}) {
    if (!this._preview) {
      this._preview = {
        fen: this.fen,
        legalMoves: this.legalMoves,
        lastMove: this.lastMove,
        moveBadge: this.moveBadge,
        engineArrow: this.engineArrow,
        betterArrow: this.betterArrow,
        branchArrows: this.branchArrows,
        branchPick: this.branchPick,
      };
    }
    this._preview.onEnd = onEnd;
    this.board.classList.add("is-previewing");
  }

  showPreview({ fen, lastMove = null }) {
    if (!this._preview || !fen) return;
    this._renderingPreview = true;
    try {
      this.setPosition({ fen, legalMoves: [], lastMove });
    } finally {
      this._renderingPreview = false;
    }
    this.moveBadge = null;
    this._syncMoveBadge();
    this.engineArrow = null;
    this.betterArrow = null;
    this.branchArrows = [];
    this.branchPick = null;
    this._renderArrows();
  }

  // Put the saved real position back (restore = true), or just drop the preview because
  // the caller is about to show a new real position (restore = false).
  endPreview({ restore = true } = {}) {
    const saved = this._preview;
    if (!saved) return;
    this._preview = null;
    this.board.classList.remove("is-previewing");
    if (restore) {
      this.setPosition({ fen: saved.fen, legalMoves: saved.legalMoves, lastMove: saved.lastMove });
      this.moveBadge = saved.moveBadge;
      this._syncMoveBadge();
      this.engineArrow = saved.engineArrow;
      this.betterArrow = saved.betterArrow;
      this.branchArrows = saved.branchArrows;
      this.branchPick = saved.branchPick;
      this._renderArrows();
    }
    if (saved.onEnd) saved.onEnd({ restored: restore });
  }

  setEngineArrow(uci) {
    const next = uci || null;
    if (this._preview) {
      this._preview.engineArrow = next;
      return;
    }
    if (this.engineArrow === next) return;
    this.engineArrow = next;
    this._renderArrows();
  }

  // The move the side that just moved should have played instead (Analyze, on a graded
  // error), drawn in its own colour so it never reads as the engine's next move.
  setBetterArrow(uci) {
    const next = typeof uci === "string" && uci.length >= 4 ? uci : null;
    if (this._preview) {
      this._preview.betterArrow = next;
      return;
    }
    if (this.betterArrow === next) return;
    this.betterArrow = next;
    this._renderArrows();
  }

  // Faint arrows for the fork's next-move options at the current position, so a
  // branch point is visible on the board itself (the fork picker's on-board echo).
  // ``pickUci`` is the currently picked option, drawn stronger than its siblings.
  setBranchArrows(list, pickUci = null) {
    const next = Array.isArray(list) ? list.filter((u) => typeof u === "string" && u.length >= 4) : [];
    const pick = typeof pickUci === "string" && pickUci.length >= 4 ? pickUci : null;
    if (this._preview) {
      this._preview.branchArrows = next;
      this._preview.branchPick = pick;
      return;
    }
    const same =
      pick === this.branchPick &&
      next.length === this.branchArrows.length &&
      next.every((u, i) => u === this.branchArrows[i]);
    if (same) return;
    this.branchArrows = next;
    this.branchPick = pick;
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
        square.setAttribute("aria-pressed", "false");
        square.tabIndex = -1; // roving: exactly one square is tabbable; see _applyRovingTabindex
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
    this._applyRovingTabindex();
  }

  applyCoordinates() {
    this.board.classList.toggle("show-coords", pref("coordinates"));
  }

  _bindBoardEvents() {
    this.board.addEventListener("contextmenu", (event) => event.preventDefault());

    // A mouse or touch press never focuses a square: a focused square shows the
    // keyboard focus ring, and the ring would then follow later key presses.
    // The press still blurs whatever had focus (as a normal click would), so ←/→
    // step the game right after clicking the board.
    this.board.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".square")) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === "function") active.blur();
    });

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
        const from = this.selected;
        if (isPromotionMove(from, squareName, this.legalMoves)) {
          this._setSelected(null);
          const board = this;
          resolveBoardMove({
            from,
            to: squareName,
            moves: this.legalMoves,
            board,
            play: (uci) => board.play(uci),
          });
          return;
        }
        const move = legalMoveFor(from, squareName, this.legalMoves);
        if (move) {
          this._setSelected(null);
          this.play(move);
          return;
        }
      }
      if (this.hasLegalFrom(squareName)) {
        // Pressing the already-selected piece again arms a deselect: a plain
        // click (release on the same square) clears the legal-move dots, while
        // dragging it away still plays the move.
        const wasSelected = this.selected === squareName;
        this._setSelected(squareName);
        this._beginDrag(squareName, event);
        this._deselectOnRelease = wasSelected;
      } else {
        this._setSelected(null);
      }
    });

    this.board.addEventListener("pointerup", (event) => {
      if (event.button === 2) this._finishAnnotation(event);
    });

    // Keyboard parity for the click-to-move model. The board is one Tab stop
    // (see _applyRovingTabindex):
    //   • Arrow keys are not board-local — they bubble to the app's move
    //     navigation (← → step the game) like anywhere else on the page;
    //   • typing a square name ("e4") moves focus to that square;
    //   • Enter/Space on a square selects a movable piece, then selects a legal
    //     target to play — the pointer path minus the drag.
    this.board.addEventListener("keydown", (event) => {
      const square = event.target.closest(".square");
      if (!square) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        // Swallow the default button activation so Space doesn't also scroll and
        // Enter doesn't fire a redundant synthetic click.
        event.preventDefault();
        this._typedFile = null;
        this._keyActivatedAt = Date.now();
        this._handleSquareActivation(square.dataset.square);
        return;
      }
      const pending = this._typedFile && Date.now() - this._typedAt < 1500 ? this._typedFile : null;
      const typed = typedSquare(pending, event.key);
      this._typedFile = typed.pending;
      this._typedAt = Date.now();
      if (!typed.handled) return;
      // A file letter here is part of a square name, not a page shortcut (F flips).
      event.preventDefault();
      event.stopPropagation();
      if (typed.square && this.squares.has(typed.square)) {
        this.squares.get(typed.square).focus();
        this._applyRovingTabindex(typed.square);
      }
    });

    // Assistive tech activates a square with a click and no pointer press
    // (event.detail === 0): route it through the same select/play flow.
    this.board.addEventListener("click", (event) => {
      if (event.detail !== 0 || Date.now() - (this._keyActivatedAt || 0) < 400) return;
      const square = event.target.closest(".square");
      if (square) this._handleSquareActivation(square.dataset.square);
    });
  }

  // Shared by the keyboard handler above: activate a square — play into a legal
  // target when a piece is selected, else select/deselect the square. Split out
  // so the Enter/Space flow has one home (the pointer path intentionally keeps
  // its own drag-aware flow).
  _handleSquareActivation(squareName) {
    if (this.selected && this.selected !== squareName) {
      const from = this.selected;
      if (isPromotionMove(from, squareName, this.legalMoves)) {
        this._setSelected(null);
        const board = this;
        resolveBoardMove({
          from,
          to: squareName,
          moves: this.legalMoves,
          board,
          play: (uci) => board.play(uci),
        });
        return;
      }
      const move = legalMoveFor(from, squareName, this.legalMoves);
      if (move) {
        this._setSelected(null);
        this.play(move);
        return;
      }
    }
    if (this.hasLegalFrom(squareName) && this.selected !== squareName) {
      this._setSelected(squareName);
    } else {
      this._setSelected(null);
    }
  }

  // Roving tabindex over the 64 square buttons: exactly ONE square stays in the
  // Tab order, so keyboard users don't Tab through 64 stops — typing a square
  // name moves focus inside the board instead. The tabbable square is the
  // remembered cursor (last typed square) when it still exists,
  // else the anchor on the player's home rank (e2 for White, e7 for Black —
  // the closest thing to a natural starting point on either orientation).
  // Called from _buildGrid (constructor + every orientation flip) and after
  // typed focus moves, keeping DOM focus and the tabbable square in sync.
  _applyRovingTabindex(anchor = null) {
    let tabbable = anchor || this._rovingSquare;
    if (!tabbable || !this.squares.has(tabbable)) {
      tabbable = this.orientation === "black" ? "e7" : "e2";
    }
    for (const [name, square] of this.squares) {
      square.tabIndex = name === tabbable ? 0 : -1;
    }
    this._rovingSquare = tabbable;
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
    const deselect = this._deselectOnRelease;
    this._deselectOnRelease = false;
    this._cancelDrag();
    if (!from) return;
    const target = this._squareAt(event);
    // Same-square release is treated as a click: the piece stays selected so a
    // follow-up click on a target square plays the move — unless it was already
    // selected, in which case the second click toggles the selection off.
    if (target === from && deselect) {
      this._setSelected(null);
      return;
    }
    if (!target || target === from) return;
    if (isPromotionMove(from, target, this.legalMoves)) {
      this._setSelected(null);
      const board = this;
      const moves = this.legalMoves;
      resolveBoardMove({
        from,
        to: target,
        moves,
        board,
        play: (uci) => board.play(uci),
      });
      return;
    }
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
    // A real position arriving mid-preview ends the preview (see beginPreview).
    if (this._preview && !this._renderingPreview) this.endPreview({ restore: false });
    const fenChanged = this.fen !== fen;
    const prevFen = this.fen;
    // A same-position refresh (an autosave landing, a panel re-render) must not
    // yank a piece out of the user's hand: keep the drag and selection alive
    // while the dragged/selected piece still has legal moves.
    const keepInteraction =
      !fenChanged &&
      (this.dragFrom || this.selected) &&
      legalMoves.some((move) => move.startsWith(this.dragFrom || this.selected));
    if (!keepInteraction) this._cancelDrag();

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
    if (!keepInteraction) {
      this.selected = null;
      this.dragFrom = null;
    }
    // A same-position refresh keeps the badge, so it doesn't pop in again.
    if (fenChanged || this.lastMove !== lastMove) this.moveBadge = null;
    this.lastMove = lastMove;
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
    if (this._preview) return;
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

  _renderPieces() {
    const pieces = parseFenBoard(this.fen);
    this.squares.forEach((square, squareName) => {
      const piece = pieces[squareName];
      const desired = piece ? piece : "";
      if (square.dataset.piece === desired) return;
      square.dataset.piece = desired;
      // Keep the accessible name in lockstep with the rendered piece so
      // keyboard users hear what is on the square, not just its coordinates.
      square.setAttribute("aria-label", piece ? `${pieceLabel(piece)} ${squareName}` : squareName);
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
      // Keyboard selection state must be visible to assistive tech too: the
      // Enter/Space pick-and-move flow toggles .selected, so mirror it as
      // aria-pressed on the square button.
      square.setAttribute("aria-pressed", String(this.selected === squareName));
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
    // Selecting a piece re-syncs classes: an unchanged badge stays put rather than being
    // re-inserted, which would replay its entrance animation.
    const key = this.moveBadge ? `${this.moveBadge.square}|${this.moveBadge.classification}|${this.moveBadge.label}` : "";
    if (
      key && key === this._badgeKey &&
      this._badgeEl === this.squares.get(this.moveBadge.square) &&
      this._badgeEl.querySelector(".square-badge")
    ) return;
    this._badgeKey = key;
    // Clear previous badge from exactly the one tracked square (not a 64-square scan).
    if (this._badgeEl) {
      const existing = this._badgeEl.querySelector(".square-badge");
      if (existing) existing.remove();
      this._badgeEl = null;
    }
    // The last-move squares take the grade's colour (styles.css), so the tint and the
    // badge read as one mark.
    if (this.board) delete this.board.dataset.moveClass;
    if (!this.moveBadge) return;
    const square = this.squares.get(this.moveBadge.square);
    if (!square) return;
    this._badgeEl = square;
    const cls = this.moveBadge.classification.replace(/[^a-z0-9_-]/g, "");
    if (this.board) this.board.dataset.moveClass = cls;
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
