// Looking at a move without making it, in two sizes.
//
// boardLine: a line walked on a view's own board (engine PVs, a note's line, a
// coverage gap). The real position is saved on entry and put back on exit; ◀ ▶ /
// ← → step, Esc or "Exit line" leaves. The game, the analysis tree and the
// repertoire are never touched. One line at a time, whoever opened it.
//
// The peek: a small board beside a move token (move-text.js markup, or any control
// a view registers with registerPeekSource) showing the position after it. Mouse:
// hover. Keyboard: focus, Esc closes. Touch: a tap pins it with an explicit
// "Show on board" where the view has a board to show it on. Clicking (or Enter on)
// a `.move-ref` acts on the view's board through the view's own apply handler;
// views without one (Train, Scout, Games…) only show the peek.
import { html } from "./html.js";
import { clampPly, decodeLine, previewLabel, previewPosition, stepPreview } from "./move-text.js";
import { parseFenBoard, pieceSvg } from "./board/ui.js";
import { releasePreviewCaption, setPreviewCaption, takePreviewCaption } from "./controllers/preview-caption.js";

let session = null;

function endedSession(restored) {
  const s = session;
  if (!s) return;
  session = null;
  releasePreviewCaption(s.caption, restored);
  s.onChange?.(null);
}

function showSession() {
  const s = session;
  s.board.showPreview(previewPosition(s.line, s.ply));
  setPreviewCaption(s.caption, previewLabel(s.line, s.ply, s.name));
  s.onChange?.(s);
}

export const boardLine = {
  /** Walk `line` (move-text walkLine shape) on `board` at `ply`; `onChange(s|null)` follows it. */
  open({ board, view, line, ply = 1, name = "Line", owner = null, onChange = null }) {
    if (!board || !line) return;
    if (session && session.board !== board) this.exit();
    if (session && session.owner !== owner) {
      // Another source takes the same board over: the board stays in preview.
      const prev = session.onChange;
      session.onChange = null;
      prev?.(null);
    }
    if (!session) {
      board.beginPreview({ onEnd: ({ restored }) => endedSession(restored) });
      session = { caption: takePreviewCaption(view) };
    }
    Object.assign(session, { board, line, name, owner, onChange, ply: clampPly(line, ply) });
    showSession();
  },
  /** Step the open line; false when none is open. */
  step(action) {
    if (!session) return false;
    session.ply = stepPreview(session.line, session.ply, action);
    showSession();
    return true;
  },
  exit() {
    session?.board.endPreview({ restore: true });
  },
  get active() {
    return session;
  },
};

// --- Peek -------------------------------------------------------------------

const sources = [];
/** Hover peek for an existing control: `resolve(el)` → `{ fen, lastMove, label }` or null. */
export function registerPeekSource(selector, resolve) {
  sources.push({ selector, resolve });
}

// A token carries its line, or sits inside an element that does (a game's move list).
const TOKEN = "[data-mt][data-p], [data-mt] [data-p]";
const INTENT_MS = 120;
let host = null;
let peek = null; // { target, pinned, hover, title }
let timer = 0;
let lastPointer = "mouse";
let options = { apply: () => null, orientation: () => "white" };

function sourceSelector() {
  return [TOKEN, ...sources.map((s) => s.selector)].join(",");
}

/** What a token or registered control shows: `{ fen, lastMove, label, line, ply }`. */
export function peekPosition(el) {
  if (el.matches(TOKEN)) {
    const line = decodeLine(el.closest("[data-mt]").dataset.mt);
    const ply = Number(el.dataset.p) + 1;
    if (!line || line.plies.length < ply) return null;
    return { ...previewPosition(line, ply), label: line.plies[ply - 1].label, line, ply };
  }
  const source = sources.find((s) => el.matches(s.selector));
  return source ? source.resolve(el) : null;
}

const FILES = "abcdefgh";
function miniBoardHtml(fen, lastMove, orientation) {
  const pieces = parseFenBoard(fen);
  const last = lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : [];
  const ranks = orientation === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = orientation === "black" ? [...FILES].reverse() : [...FILES];
  const squares = [];
  for (const rank of ranks) {
    for (const file of files) {
      const sq = `${file}${rank}`;
      const dark = (rank + FILES.indexOf(file)) % 2 === 1 ? "dark" : "light";
      const p = pieces[sq];
      squares.push(html`<div class="scout-minisquare ${dark}${last.includes(sq) ? " last" : ""}">${p ? pieceSvg(p) : ""}</div>`);
    }
  }
  return html`<div class="scout-miniboard" aria-hidden="true">${squares}</div>`;
}

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "move-peek";
  host.hidden = true;
  host.setAttribute("role", "tooltip");
  host.id = "move-peek";
  host.addEventListener("click", (event) => {
    if (!event.target.closest(".move-peek-go") || !peek) return;
    const target = peek.target;
    hidePeek();
    applyToken(target);
  });
  document.body.append(host);
  return host;
}

// The block the token reads in (a coach sentence, a line title, a table cell).
// The peek goes beside THAT, not beside the word: a popover centred on a word
// covers the rest of its own sentence.
const BLOCK = "p, li, h1, h2, h3, h4, td, th, .line-title, .scout-line-moves, .mtree-line";
const GAP = 8;
const EDGE = 8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

function place(target) {
  const r = target.getBoundingClientRect();
  const bottom = Number.isFinite(r.bottom) ? r.bottom : r.top + (r.height || 0);
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const put = (x, y) => {
    host.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  // A surface the peek must never cover (the eval chart it is reading): it goes
  // outside that box, above or below, at the end away from the pointer.
  const avoid = peek?.avoid?.isConnected ? peek.avoid.getBoundingClientRect() : null;
  if (avoid) {
    const above = avoid.top - GAP - EDGE;
    const below = vh - avoid.bottom - GAP - EDGE;
    const y = above >= h || above > below ? avoid.top - GAP - h : avoid.bottom + GAP;
    const farRight = r.left + (r.width || 0) / 2 >= (avoid.left + avoid.right) / 2;
    const x = farRight ? avoid.right - w : avoid.left;
    put(clamp(x, EDGE, Math.max(EDGE, vw - w - EDGE)), clamp(y, EDGE, Math.max(EDGE, vh - h - EDGE)));
    return;
  }
  // Level with the word it explains, kept off the screen edges.
  const top = clamp(r.top + (r.height || 0) / 2 - h / 2, EDGE, vh - h - EDGE);
  const block = target.closest?.(BLOCK) || target;
  const b = block === target ? r : block.getBoundingClientRect();
  if (vw - b.right - GAP - EDGE >= w) return put(b.right + GAP, top);
  if (b.left - GAP - EDGE >= w) return put(b.left - GAP - w, top);
  // No gutter beside the text (full-width prose, a phone): above the word when
  // there is more room there, so the line being read and the one after it stay.
  const above = r.top - GAP - EDGE;
  const below = vh - bottom - GAP - EDGE;
  const y = above >= h || above > below ? r.top - GAP - h : bottom + GAP;
  put(clamp(r.left + (r.width || 0) / 2 - w / 2, EDGE, Math.max(EDGE, vw - w - EDGE)), clamp(y, EDGE, Math.max(EDGE, vh - h - EDGE)));
}

function restoreTitle() {
  if (peek?.titled) peek.titled.setAttribute("title", peek.title);
}

function showPeek(target, { pinned = false, hover = false, avoid = null } = {}) {
  const pos = peekPosition(target);
  if (!pos || !pos.fen) {
    hidePeek();
    return;
  }
  ensureHost();
  if (peek?.target !== target) {
    restoreTitle();
    // A native tooltip (the control's own, or its row's) would sit over the peek, so
    // it is lifted while the peek shows. The peek carries the control's own.
    const titled = target.closest("[title]");
    const title = titled?.getAttribute("title") || "";
    titled?.removeAttribute("title");
    peek = { target, titled, title };
  }
  peek.avoid = avoid;
  peek.pinned = pinned;
  peek.hover = hover && !pinned;
  const canApply = pinned && target.classList.contains("move-ref") && !!options.apply(target, true);
  const own = peek.titled === target ? peek.title : "";
  const note = own && own !== pos.label ? html`<span class="move-peek-note">${own}</span>` : "";
  // A view whose boards face one player (a Scout colour section, a Games review)
  // names that side on the token's container; elsewhere the active board decides.
  const side = target.closest("[data-board-side]")?.dataset.boardSide || options.orientation();
  host.innerHTML = html`${miniBoardHtml(pos.fen, pos.lastMove, side)}<div class="move-peek-foot"><b class="move-peek-label">${pos.label || ""}</b>${canApply ? html`<button type="button" class="btn sm move-peek-go">Show on board</button>` : ""}</div>${note}`;
  host.classList.toggle("is-pinned", pinned);
  host.setAttribute("role", pinned ? "dialog" : "tooltip");
  host.setAttribute("aria-label", pos.label ? `Position after ${pos.label}` : "Position");
  host.hidden = false;
  target.setAttribute("aria-describedby", "move-peek");
  place(target);
}

/**
 * Peek at `target` from code (a chart's hover readout, which takes no pointer
 * itself). `avoid` is a surface the peek must not cover (the chart being read).
 */
export function peekAt(target, { avoid = null } = {}) {
  if (target?.isConnected && !peek?.pinned) showPeek(target, { hover: true, avoid });
}

export function hidePeek() {
  window.clearTimeout(timer);
  if (!peek) return;
  restoreTitle();
  peek.target.removeAttribute("aria-describedby");
  peek = null;
  if (host) host.hidden = true;
}

function applyToken(target) {
  const run = options.apply(target, false);
  if (!run) return false;
  hidePeek();
  run();
  return true;
}

// A tap pins the peek; a second tap on the same token (or its button) applies.
// A click or Enter applies where the view can, and otherwise pins the peek.
function activate(target) {
  if (lastPointer === "touch") {
    if (peek?.target === target && peek.pinned) applyToken(target);
    else showPeek(target, { pinned: true });
    return;
  }
  if (applyToken(target)) return;
  if (peek?.target === target && peek.pinned) hidePeek();
  else showPeek(target, { pinned: true });
}

/**
 * Install the delegated listeners once. `apply(token, probe)` returns a function that
 * acts on the active view's board for that token, or null where the view has none
 * (probe = only asking). `orientation()` is the peek board's side.
 */
export function initMoveLinks(opts) {
  options = { ...options, ...opts };
  const doc = document;
  doc.addEventListener("pointerdown", (event) => {
    lastPointer = event.pointerType || "mouse";
    if (peek?.pinned && !event.target.closest(".move-peek") && event.target.closest(TOKEN) !== peek.target) hidePeek();
  }, true);
  doc.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const target = event.target.closest?.(sourceSelector());
    if (!target || peek?.target === target) return;
    if (peek?.pinned) return;
    window.clearTimeout(timer);
    // Moving from one token to the next swaps at once; a fresh hover waits for intent.
    if (peek) showPeek(target, { hover: true });
    else timer = window.setTimeout(() => target.isConnected && showPeek(target, { hover: true }), INTENT_MS);
  });
  doc.addEventListener("pointerout", (event) => {
    if (event.pointerType === "touch") return;
    const target = event.target.closest?.(sourceSelector());
    if (!target || target.contains(event.relatedTarget)) return;
    window.clearTimeout(timer);
    if (peek?.target === target && !peek.pinned) hidePeek();
  });
  doc.addEventListener("focusin", (event) => {
    const target = event.target.closest?.(TOKEN);
    if (target && target.matches(":focus-visible") && peek?.target !== target) showPeek(target);
  });
  doc.addEventListener("focusout", (event) => {
    if (peek && event.target === peek.target && !host.contains(event.relatedTarget)) hidePeek();
  });
  // Capture: a token inside a clickable row (a Scout line) is its own control.
  doc.addEventListener("click", (event) => {
    const target = event.target.closest?.(".move-ref[data-p]");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    activate(target);
  }, true);
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && peek) {
      // A peek under the pointer is not what Esc is for: it goes, and the key
      // goes on to the dialog, menu or line it was meant for.
      if (peek.hover) {
        hidePeek();
        return;
      }
      // Before the board's own Esc (leave the line): one press closes one thing.
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = peek.target;
      hidePeek();
      if (target.isConnected && doc.activeElement !== target && host.contains(doc.activeElement)) target.focus();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest?.(".move-ref[data-p]");
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lastPointer = "keyboard";
    activate(target);
  }, true);
  window.addEventListener("scroll", (event) => peek && !host.contains(event.target) && hidePeek(), true);
  window.addEventListener("resize", hidePeek);
}
