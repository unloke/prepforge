import { html, raw } from "../html.js";
import { appState, boards, files } from "../core/state.js";
import { pref, setPref, PREF_LABELS } from "../core/prefs.js";
import {
  CIRCLE_RADIUS,
  buildArrowHeadPath,
  buildArrowPath,
  endsUnder,
  parseArrowToken,
  parseCircleToken,
} from "../board-arrows.js";
import { localBoardAfterMove, localBoardInfo } from "../chess-local.js";
import { openPopover } from "../core/dialog.js";
import { playSound } from "../core/sound.js";

// Artwork uses a shared 0 0 45 45 viewBox, with fill and stroke in board.css.
// "berlin" is the default Staunton set; "classic" is the minimalist alternative.
export const PIECE_SETS = {
  berlin: {
    p: html`<path d="M22.5 10a5.6 5.6 0 0 1 2.9 10.4c.1 4.3 1.6 7.9 4.8 11.1h1c2 1.6 3.1 4.1 3.3 7.5h-24c.2-3.4 1.3-5.9 3.3-7.5h1c3.2-3.2 4.7-6.8 4.8-11.1A5.6 5.6 0 0 1 22.5 10Z"></path><path class="piece-line" d="M14.4 32.4h16.2"></path>`,
    n: html`<path d="M11 39c.2-3.4 1.5-5.7 4-7.5h1c.8-4.7 4.9-7.1 7.8-10.7l-3.6 1.1-4.7 4.1-6.1-3.2 4-7.5 4.3-3.5-.3-5.4 5.4 3.5 3.1-1.6c5.9 1.2 10.4 7.1 10.4 14.2 0 3.1-.7 5.8-1.9 9h.6c2 1.7 3.1 4.2 3.3 7.5Z"></path><path class="piece-line" d="M15.5 32.4h19M27 13.5c4.5 2 6.5 6.5 5.2 12.9"></path><circle class="piece-cut" cx="19.2" cy="15.9" r="1.1"></circle>`,
    b: html`<path d="M22.5 9.8c-4.7 4.1-8.4 9.2-8.4 14.6 0 3.2 2.4 5.1 5.4 5.6l-2 1.5h-2.4c-2.4 1.5-3.6 4-3.8 7.5h22.4c-.2-3.5-1.4-6-3.8-7.5h-2.4l-2-1.5c3-.5 5.4-2.4 5.4-5.6 0-5.4-3.7-10.5-8.4-14.6Z"></path><circle cx="22.5" cy="7.7" r="2.4"></circle><path class="piece-line" d="m26.7 15.9-6.4 7M15.3 32.4h14.4"></path>`,
    r: html`<path d="M10.5 9.5h5.8v4.3h3.4V9.5h5.6v4.3h3.4V9.5h5.8v8.3l-4.3 4v9.7h.7c2 1.6 3.1 4.1 3.3 7.5H10.8c.2-3.4 1.3-5.9 3.3-7.5h.7v-9.7l-4.3-4Z"></path><path class="piece-line" d="M15.1 21.9h14.8M14.6 32.4h15.8"></path>`,
    q: html`<path d="m8.8 13.3 7.1 8.8 1.6-10.8 5 8.6 5-8.6 1.6 10.8 7.1-8.8-6.1 14.3v3.9h1.1c2.2 1.6 3.5 4.1 3.7 7.5H10.1c.2-3.4 1.5-5.9 3.7-7.5h1.1v-3.9Z"></path><circle cx="8.2" cy="12.3" r="1.8"></circle><circle cx="17.4" cy="10.2" r="1.8"></circle><circle cx="27.6" cy="10.2" r="1.8"></circle><circle cx="36.8" cy="12.3" r="1.8"></circle><path class="piece-line" d="M15.5 27.5h14M14.8 32.4h15.4"></path>`,
    k: html`<path d="M21.1 4.8h2.8v3.4h3.4V11h-3.4v4.7h-2.8V11h-3.4V8.2h3.4Z"></path><path d="M22.5 17.6c3-4 8.7-4.7 11.4-1.1 2.7 3.5.6 8.1-2.5 11.2l-2 3.8h1.4c2.2 1.6 3.5 4.1 3.7 7.5h-24c.2-3.4 1.5-5.9 3.7-7.5h1.4l-2-3.8c-3.1-3.1-5.2-7.7-2.5-11.2 2.7-3.6 8.4-2.9 11.4 1.1Z"></path><path class="piece-line" d="M22.5 18.2v7.3M14.2 27.4h16.6m-15 5h13.4"></path>`,
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

export const PIECE_STYLE_KEY = "prepforge.piece_style";
const PIECE_STYLE_LABELS = { berlin: "Staunton Pro", classic: "Classic" };

export function activePieceSet() {
  return PIECE_SETS[appState.pieceStyle] || PIECE_SETS.berlin;
}

export function parseFenBoard(fen) {
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

export function pieceLabel(piece) {
  const name = PIECE_LABEL_NAMES[piece.toLowerCase()] || "piece";
  return `${piece === piece.toUpperCase() ? "white" : "black"} ${name}`;
}

export function pieceSvg(piece) {
  const colorClass = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  // eslint-disable-next-line local/trusted-raw -- SVG paths come from the authored piece sets above.
  return html`<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${raw(activePieceSet()[piece.toLowerCase()])}</g></svg>`;
}

export function setPieceStyle(style) {
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

export function renderPieceStylePicker() {
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

export function renderPrefsToggles() {
  const host = document.getElementById("board-prefs");
  if (!host) return;
  if (host.closest?.("[hidden]")) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = html`${Object.keys(PREF_LABELS)
    .map((key) => {
      const on = pref(key) ? " is-on" : "";
      const label = PREF_LABELS[key] || key;
      // The volume rides under the sound switch, as Lichess sets its sound.
      const volume = key === "sounds"
        ? html`<div class="pf-row pf-volume"${pref("sounds") ? "" : " hidden"}><span class="pf-row-text"><span class="pf-row-label" id="pf-volume-label">Volume</span></span><input type="range" id="pf-volume" min="0" max="100" step="5" value="${String(pref("soundVolume"))}" aria-labelledby="pf-volume-label" /></div>`
        : "";
      return (
        html`<div class="pf-row"><span class="pf-row-text"><span class="pf-row-label">${label}</span></span><button type="button" class="pf-switch${on}" data-pref="${key}" role="switch" aria-checked="${pref(key)}" aria-label="${label}"><span class="pf-knob"></span></button></div>${volume}`
      );
    })}`;
  host.querySelectorAll(".pf-switch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.pref;
      setPref(key, !pref(key));
      btn.classList.toggle("is-on", pref(key));
      btn.setAttribute("aria-checked", String(pref(key)));
      if (key === "sounds") host.querySelector(".pf-volume").hidden = !pref(key);
    });
  });
  // Dragging previews the level with a move click; the value is stored on release.
  const slider = host.querySelector("#pf-volume");
  slider?.addEventListener("input", () => {
    appState.prefs.soundVolume = Number(slider.value);
    playSound("move");
  });
  slider?.addEventListener("change", () => setPref("soundVolume", Number(slider.value)));
}

export function legalTargetsFrom(square, moves) {
  return moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4));
}

export function legalMoveFor(from, to, moves) {
  return moves.find((move) => move.startsWith(`${from}${to}`));
}

const PROMOTION_PIECES = ["q", "r", "b", "n"];
const PROMOTION_LABELS = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };

export function promotionOptions(from, to, moves) {
  return PROMOTION_PIECES.map((piece) => `${from}${to}${piece}`).filter((uci) =>
    moves.includes(uci)
  );
}

// True when `from→to` is a pawn promotion: more than one 5-char UCI shares the
// from/to prefix, or a single 5-char UCI does. Callers gate the picker on this
// so normal moves keep the instant click/drag path with zero UI.
export function isPromotionMove(from, to, moves) {
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
export function showPromotionPicker({ from, to, moves, anchorBoard, color, onOpen }) {
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
    // A [popover] laid over the board: Escape and a press off the board are the
    // browser's light dismiss, which cancels.
    const overlay = document.createElement("div");
    overlay.className = "promotion-picker-overlay";
    overlay.popover = "auto";
    const side = color === "black" ? "black" : "white";
    overlay.innerHTML = html`
      <div class="promotion-picker" role="group" aria-label="Choose promotion piece">
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
    let choice = null;
    boardEl?.parentElement?.append(overlay);
    const close = openPopover(overlay, {
      onClose: () => {
        overlay.remove();
        resolve(choice);
      },
    });
    onOpen?.(close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    const box = boardEl?.getBoundingClientRect();
    if (box?.width) {
      Object.assign(overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    }
    const buttons = [...overlay.querySelectorAll(".promotion-option")];
    buttons.forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        choice = btn.dataset.uci;
        close();
      });
    });
    buttons[0]?.focus({ preventScroll: true });
  });
}

// Promotion-aware resolution shared by click / drag / keyboard-square paths.
// Plain moves resolve synchronously; promotions open the picker and resolve
// async. `play` is invoked exactly once with the final UCI (or never, on
// cancel) so board handlers keep a single onMove entry point.
export function resolveBoardMove({ from, to, moves, board, play }) {
  if (!isPromotionMove(from, to, moves)) {
    const move = legalMoveFor(from, to, moves);
    if (move) play(move);
    return;
  }
  const fen = board?.fen;
  const piece = board?.squares?.get(from)?.dataset.piece;
  // During a premove the player is the opposite of the FEN's side to move.
  const sideIsBlack = piece ? piece === piece.toLowerCase() : fen?.split(" ")[1] === "b";
  const boardEl = board && board.board ? board.board : null;
  void showPromotionPicker({
    from,
    to,
    moves,
    anchorBoard: boardEl,
    color: sideIsBlack ? "black" : "white",
    onOpen: (close) => { board._cancelPromotion = close; },
  }).then((uci) => {
    board._cancelPromotion = null;
    if (uci && board.fen === fen) play(uci);
  });
}

export function renderAnnotations(
  overlay,
  arrows,
  orientation = "white",
  engineArrow = null,
  branchArrows = [],
  branchPick = null,
  betterArrow = null,
  options = null
) {
  overlay.setAttribute("viewBox", "0 0 100 100");
  overlay.innerHTML = "";
  const opts = options && typeof options === "object" && !("setAttribute" in options) ? options : null;
  if (options && "setAttribute" in options) {
    options.setAttribute("viewBox", "0 0 100 100");
    options.innerHTML = "";
  }
  const NS = "http://www.w3.org/2000/svg";
  const validUci = (uci) => typeof uci === "string" && uci.length >= 4 && uci.slice(0, 2) !== uci.slice(2, 4);
  const visualKey = (uci) => uci.slice(0, 4);
  const draft = opts?.draft || null;

  // 1. Circles (committed + live right-click circle preview / pending erase)
  const circleMap = new Map();
  for (const rawCircle of opts?.circles || []) {
    const parsed = parseCircleToken(rawCircle);
    if (parsed) circleMap.set(parsed.square, { square: parsed.square, brush: parsed.brush, erasing: false, preview: false });
  }
  let previewCircle = null;
  if (draft?.orig && draft.dest === draft.orig) {
    const existing = circleMap.get(draft.orig);
    if (existing && existing.brush === draft.brush) {
      existing.erasing = true;
    } else {
      if (existing) existing.erasing = true;
      previewCircle = { square: draft.orig, brush: draft.brush || "G", erasing: false, preview: true };
    }
  }
  const paintCircle = (c) => {
    const center = squareCenter(c.square, orientation);
    const el = document.createElementNS(NS, "circle");
    el.setAttribute("cx", center.x.toFixed(3));
    el.setAttribute("cy", center.y.toFixed(3));
    el.setAttribute("r", String(CIRCLE_RADIUS));
    const brushCls = ` brush-${String(c.brush || "G").toLowerCase()}`;
    const stateCls = `${c.erasing ? " is-erasing" : ""}${c.preview ? " is-preview" : ""}`;
    el.setAttribute("class", `annot-circle annot-user${brushCls}${stateCls}`);
    overlay.appendChild(el);
  };
  circleMap.forEach(paintCircle);
  if (previewCircle) paintCircle(previewCircle);

  // 2. Manual user arrows + live right-drag arrow preview / pending erase
  const manualMap = new Map();
  for (const rawArrow of arrows || []) {
    const parsed = parseArrowToken(rawArrow);
    if (parsed) manualMap.set(parsed.key, { ...parsed, erasing: false });
  }
  let previewArrow = null;
  if (draft?.orig && draft?.dest && draft.dest !== draft.orig) {
    const draftKey = `${draft.orig}${draft.dest}`;
    const existing = manualMap.get(draftKey);
    if (existing && existing.brush === draft.brush) {
      existing.erasing = true;
    } else {
      if (existing) existing.erasing = true;
      previewArrow = { from: draft.orig, to: draft.dest, key: draftKey, brush: draft.brush || "G" };
    }
  }

  // 3. Automatic arrows (Multi-PV engine, better move, repertoire branches)
  const rawEngineList = Array.isArray(opts?.engineArrows) && opts.engineArrows.length
    ? opts.engineArrows
    : (validUci(engineArrow) ? [{ uci: engineArrow, scale: 1, rank: 1 }] : []);
  const seenEngine = new Set();
  const engineList = [];
  for (const item of rawEngineList) {
    const uci = typeof item === "string" ? item : item?.uci;
    if (!validUci(uci)) continue;
    const key = visualKey(uci);
    if (seenEngine.has(key)) continue;
    seenEngine.add(key);
    engineList.push({
      uci,
      key,
      scale: typeof item === "object" && Number.isFinite(item?.scale) ? item.scale : 1,
      alt: engineList.length > 0,
    });
  }
  const topEngine = engineList[0] || null;
  const altEngines = engineList.slice(1);
  const topEngineKey = topEngine ? topEngine.key : null;
  const altEngineKeys = new Set(altEngines.map((e) => e.key));

  const better = validUci(betterArrow) && visualKey(betterArrow) !== topEngineKey ? betterArrow : null;
  const betterKey = better ? visualKey(better) : null;

  const seenBranches = new Set();
  const branches = (branchArrows || []).filter(validUci).filter((uci) => {
    const key = visualKey(uci);
    if (seenBranches.has(key)) return false;
    seenBranches.add(key);
    return true;
  });
  const pick = branches.some((uci) => visualKey(uci) === visualKey(branchPick || "")) ? branchPick : null;
  const pickKey = pick ? visualKey(pick) : null;

  const entries = [];
  const sharedHeads = new Map();
  const centerOf = (key) => [
    squareCenter(key.slice(0, 2), orientation),
    squareCenter(key.slice(2, 4), orientation),
  ];
  const makeEntry = (key, kind, extra = "", scale = 1) => {
    const [from, to] = centerOf(key);
    return { key, fromSq: key.slice(0, 2), toSq: key.slice(2, 4), kind, extra, scale, from, to };
  };
  const queue = (key, kind, extra = "", scale = 1) => {
    if (manualMap.has(key) && kind !== "user") {
      sharedHeads.set(key, { kind, extra, scale });
      return null;
    }
    const entry = makeEntry(key, kind, extra, scale);
    entries.push(entry);
    return entry;
  };

  // Layering on one upper plane (above pieces so target pieces never bury arrowheads):
  // unpicked branches (longest first) -> Multi-PV alternatives -> picked branch -> better -> user -> top engine.
  const span = (a) => (a.to.x - a.from.x) ** 2 + (a.to.y - a.from.y) ** 2;
  const branchEntries = branches
    .map(visualKey)
    .filter((key) => key !== topEngineKey && key !== betterKey && key !== pickKey && !altEngineKeys.has(key))
    .map((key) => makeEntry(key, "branch"));
  branchEntries.sort((a, b) => span(b) - span(a));
  for (const b of branchEntries) {
    if (manualMap.has(b.key)) sharedHeads.set(b.key, { kind: b.kind, extra: "", scale: 1 });
    else entries.push(b);
  }

  for (const alt of altEngines) {
    if (alt.key === betterKey || alt.key === pickKey) continue;
    queue(alt.key, "engine", " is-alt", alt.scale);
  }

  if (pickKey && pickKey !== topEngineKey && pickKey !== betterKey) {
    queue(pickKey, "branch is-pick");
  }
  if (betterKey) {
    queue(betterKey, "better");
  }
  manualMap.forEach((m) => {
    const brushExtra = ` brush-${m.brush.toLowerCase()}${m.erasing ? " is-erasing" : ""}`;
    queue(m.key, "user", brushExtra, 1);
  });
  if (topEngine) {
    queue(topEngine.key, "engine", topEngine.key === pickKey ? " is-pick" : "", topEngine.scale);
  }

  // Converging destination shortening: when >=2 arrows from different squares arrive
  // at the same square, pull their tips back slightly so heads fan cleanly around the square.
  const destOrigins = new Map();
  const countDest = (fromSq, toSq) => {
    let set = destOrigins.get(toSq);
    if (!set) {
      set = new Set();
      destOrigins.set(toSq, set);
    }
    set.add(fromSq);
  };
  entries.forEach((e) => countDest(e.fromSq, e.toSq));
  if (previewArrow) countDest(previewArrow.from, previewArrow.to);
  const shouldShorten = (toSq) => (destOrigins.get(toSq)?.size || 0) >= 2;

  const paintPath = (kind, d, extra = "") => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `annot-arrow annot-${kind}${extra}`);
    overlay.appendChild(path);
  };

  entries.forEach((entry) => {
    const shorten = shouldShorten(entry.toSq);
    paintPath(entry.kind, buildArrowPath(entry.from, entry.to, entry.kind, { shorten, scale: entry.scale }), entry.extra);
  });

  // Surface shared manual+automatic heads, and surface a stop head whenever a later
  // collinear arrow's shaft painted over a shorter arrow from the same square.
  entries.forEach((arrow, idx) => {
    const sharedHead = sharedHeads.get(arrow.key);
    const coveredByLater = entries.slice(idx + 1).some((other) => endsUnder(arrow, other));
    if (sharedHead || coveredByLater) {
      const kind = sharedHead?.kind ?? arrow.kind;
      const scale = sharedHead?.scale ?? arrow.scale;
      const shorten = shouldShorten(arrow.toSq);
      const extra = `${sharedHead?.extra ?? (kind === arrow.kind ? arrow.extra : "")}${coveredByLater ? " annot-stop" : ""}`;
      paintPath(kind, buildArrowHeadPath(arrow.from, arrow.to, kind, { shorten, scale }), extra);
    }
  });

  if (previewArrow) {
    const [from, to] = centerOf(previewArrow.key);
    const shorten = shouldShorten(previewArrow.to);
    paintPath(
      "user",
      buildArrowPath(from, to, "user", { shorten, scale: 0.88 }),
      ` brush-${previewArrow.brush.toLowerCase()} is-preview`
    );
  }
}

export function squareCenter(square, orientation = "white") {
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
export async function boardAfterMove(fen, moveUci) {
  return localBoardAfterMove(fen, moveUci);
}

export async function boardInfo(fen) {
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
// `cue` goes to the board's own feedback: a graded answer passes false because
// its right/wrong cue covers the move.
export async function optimisticBoardMove(board, fenBefore, moveUci, cue) {
  if (!board || !fenBefore || !moveUci) return false;
  try {
    const after = await boardAfterMove(fenBefore, moveUci);
    board.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: moveUci, cue });
    return true;
  } catch (_) {
    return false;
  }
}
