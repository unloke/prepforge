// Replay tab rendering (lazy-loaded from app.js).

import { Chess } from "chess.js";
import "./replay.css";

const REPLAY_KINDS = {
  "in-prep": { icon: "✓", badge: "Stayed in prep", label: "stayed in prep", tone: "good" },
  "user-error": { icon: "✗", badge: "You left prep", label: "you left prep", tone: "bad" },
  "left-prep": { icon: "⚡", badge: "Opponent novelty", label: "novelties", tone: "warn" },
  "no-prep": { icon: "—", badge: "No repertoire", label: "not covered", tone: "none", departure: "—" },
};

const MINI_FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

// An opponent who leaves the repertoire within the first couple of moves didn't play a
// "novelty" — they simply chose a different opening. Same bucket (filter, Add reply), but
// the badge and copy say what actually happened.
const EARLY_DEPARTURE_PLY = 4;

export function isDifferentOpening(game) {
  const ply = Number(game && game.departure_ply) || 0;
  return (
    !!game &&
    game.departure_reason === "opponent_unprepared_branch" &&
    ply > 0 &&
    ply <= EARLY_DEPARTURE_PLY
  );
}

function replayBadge(game, meta) {
  return isDifferentOpening(game) ? "Different opening" : meta.badge;
}

function replayGameKind(game) {
  if (game.in_repertoire && game.departure_reason === "game_stayed_in_preparation")
    return "in-prep";
  if (game.departure_reason === "user_left_preparation") return "user-error";
  if (game.departure_reason === "opponent_unprepared_branch") return "left-prep";
  return "no-prep";
}

// Result colour is real: win/loss is resolved against the user's own colour.
function replayResultClass(game) {
  const result = String(game.result || "");
  if (result === "1-0") return game.user_color === "white" ? "r-win" : "r-loss";
  if (result === "0-1") return game.user_color === "black" ? "r-win" : "r-loss";
  return "r-draw";
}

// The focus board is derived client-side from the real move list: replay the
// SAN history with the already-bundled chess.js up to the decision point (the
// ply before a departure, or the game end when it stayed in prep), then lift
// the production payload's expected/departure UCIs onto that exact position —
// both arrows share the position the user actually faced. No new API data —
// the same fields the detail text already uses.
function replayFocusPosition(game) {
  const history = game.move_san_history || [];
  if (!history.length) return null;
  const departPly = Number(game.departure_ply) || 0;
  const upto = departPly > 0 ? departPly - 1 : history.length;
  const chess = new Chess();
  try {
    for (let i = 0; i < upto; i += 1) {
      // chess.js 1.x move() only takes { strict }; the 0.x `sloppy` option was
      // dropped from the API (the plain SAN call is the same behaviour).
      chess.move(history[i]);
    }
  } catch {
    return null;
  }
  const fen = chess.fen();
  let expectedUci = game.expected_move_uci || null;
  if (expectedUci) {
    // Validate the payload move on the derived position; a stale/illegal
    // expected move simply drops the arrow, it never fakes one.
    try {
      chess.move({
        from: expectedUci.slice(0, 2),
        to: expectedUci.slice(2, 4),
        promotion: expectedUci.length > 4 ? expectedUci.slice(4) : undefined,
      });
    } catch {
      expectedUci = null;
    }
  }
  return {
    fen,
    expectedUci,
    playedUci: game.departure_move_uci || null,
    orientation: game.user_color === "black" ? "black" : "white",
  };
}

function replayArrowsFor(pos) {
  const arrows = [];
  if (pos.expectedUci) arrows.push({ from: pos.expectedUci.slice(0, 2), to: pos.expectedUci.slice(2, 4), tone: "good" });
  if (pos.playedUci) arrows.push({ from: pos.playedUci.slice(0, 2), to: pos.playedUci.slice(2, 4), tone: "bad" });
  return arrows;
}

// Mini board + arrow overlay. Same grid/piece contract as the Library preview
// (parseFenBoard/pieceSvg injected from app.js so the user's piece style is
// honoured); arrows are square-to-square overlays keyed by square name.
function replayFocusBoardHtml(game, renderers) {
  const pos = replayFocusPosition(game);
  if (!pos || !renderers || !renderers.parseFenBoard || !renderers.pieceSvg) return "";
  const pieces = renderers.parseFenBoard(pos.fen);
  const ranks = pos.orientation === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = pos.orientation === "black" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  let squares = "";
  for (const rank of ranks) {
    for (const fi of files) {
      const sq = `${MINI_FILES[fi]}${rank}`;
      const dark = (rank + fi) % 2 === 1;
      const p = pieces[sq];
      squares += `<div class="scout-minisquare ${dark ? "dark" : "light"}" data-square="${sq}">${p ? renderers.pieceSvg(p) : ""}</div>`;
    }
  }
  const coord = (square) => {
    const fileIndex = MINI_FILES.indexOf(square[0]);
    const rank = Number(square[1]);
    const x = (pos.orientation === "black" ? 7 - fileIndex : fileIndex) * 12.5 + 6.25;
    const y = (pos.orientation === "black" ? rank - 1 : 8 - rank) * 12.5 + 6.25;
    return [x, y];
  };
  // Each arrow is ONE closed outline (shaft + head), so a translucent fill
  // never double-darkens where a separate line and head overlap, and the
  // head is clearly wider than the shaft. The played move is drawn first so
  // the expected move stays readable when both leave the same square.
  const arrows = replayArrowsFor(pos)
    .reverse()
    .map((a) => {
      const [x1, y1] = coord(a.from);
      const [x2, y2] = coord(a.to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) return "";
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const shaft = 1.4; // half-width, board = 100 units
      const headHalf = 3.6;
      const headLen = Math.min(5.5, len * 0.6);
      const bx = x2 - ux * headLen;
      const by = y2 - uy * headLen;
      const pt = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;
      const points = [
        pt(x1 - uy * shaft, y1 + ux * shaft),
        pt(bx - uy * shaft, by + ux * shaft),
        pt(bx - uy * headHalf, by + ux * headHalf),
        pt(x2, y2),
        pt(bx + uy * headHalf, by - ux * headHalf),
        pt(bx + uy * shaft, by - ux * shaft),
        pt(x1 + uy * shaft, y1 - ux * shaft),
      ].join(" ");
      return `<polygon class="t-${a.tone}" points="${points}" />`;
    })
    .join("");
  const svg = arrows
    ? `<svg class="replay-arrows" viewBox="0 0 100 100" aria-hidden="true">${arrows}</svg>`
    : "";
  return `<div class="focus-board" data-testid="replay-focus-board"><div class="scout-miniboard" aria-hidden="true">${squares}</div>${svg}</div>`;
}

// Display-only result text: "1/2-1/2" wraps onto two lines in the narrow
// Result column, the half glyph keeps a draw on one line.
export function displayReplayResult(result) {
  const text = String(result || "*");
  return text === "1/2-1/2" ? "½–½" : text;
}

// Move-number prefix for a half-move: ply 1 → "1.", ply 2 → "1…", ply 5 → "3.".
// "Ply 2" / "matched 2 plies" was engine jargon (UX walkthrough 2026-10-01 P2-9).
export function moveNumberLabel(ply) {
  const n = Number(ply) || 0;
  if (n < 1) return "";
  const moveNumber = Math.ceil(n / 2);
  return n % 2 === 1 ? `${moveNumber}.` : `${moveNumber}…`;
}

// "1… c5": the move-number prefix plus the SAN played on that half-move.
export function plyMoveLabel(ply, history) {
  const label = moveNumberLabel(ply);
  if (!label) return "";
  const san = (history || [])[Number(ply) - 1];
  return san ? `${label} ${san}` : label;
}

// Short local date for a game's ISO finish time ("Sep 28"; the year only when
// it is not the current one). Empty when the payload has no usable date.
export function formatReplayDate(iso, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString("en-US", options);
}

// Bring an element into view when less than half of it (or of the viewport,
// for tall elements) is on screen — e.g. the Games detail card that renders
// below the ledger in the stacked layout. Honours prefers-reduced-motion.
export function revealIfOffscreen(el, win = globalThis.window) {
  if (!el || typeof el.getBoundingClientRect !== "function" || typeof el.scrollIntoView !== "function") {
    return false;
  }
  const viewH = Number(win?.innerHeight) || 0;
  if (!viewH) return false;
  const rect = el.getBoundingClientRect();
  const visible = Math.min(rect.bottom, viewH) - Math.max(rect.top, 0);
  if (visible >= Math.min(rect.height, viewH) * 0.5) return false;
  const reduce = Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  return true;
}

export function createReplayView({
  escapeHtml,
  boardRenderers = null,
  getReplayFilter,
  isGameOpen,
  onToggleFilter,
  onToggleGame,
  onTrainMiss,
  onBuildReply,
  onAnalyze,
}) {
  // The focus board renders through app.js's FEN/piece-SVG helpers so it keeps
  // the product's active piece style; without them the card falls back to
  // text-only detail (the pre-prototype rendering).
  const renderers = boardRenderers && boardRenderers.parseFenBoard && boardRenderers.pieceSvg ? boardRenderers : null;
  // Index of the row the user just clicked; the next render reveals its detail.
  let pendingRevealIndex = null;
  function renderReplaySummary(payload) {
    const el = document.getElementById("replay-summary");
    if (!el) return;
    const games = (payload && payload.games) || [];
    if (!games.length) {
      el.hidden = true;
      return;
    }
    const counts = { "in-prep": 0, "user-error": 0, "left-prep": 0, "no-prep": 0 };
    games.forEach((game) => {
      counts[replayGameKind(game)] += 1;
    });
    const activeFilter = getReplayFilter();
    const chips = Object.entries(REPLAY_KINDS)
      .filter(([kind]) => counts[kind] > 0)
      .map(
        ([kind, meta]) =>
          `<button type="button" class="sum-chip t-${meta.tone}${
            activeFilter === kind ? " is-on" : ""
          }" data-filter="${kind}" aria-pressed="${activeFilter === kind}">${meta.icon} ${counts[kind]} ${meta.label}</button>`
      );
    const queued = Number(payload.misses_recorded) || 0;
    const queuedHtml = queued
      ? `<span class="queued" title="Recorded as recall misses">+${queued} queued for training</span>`
      : "";
    el.innerHTML = chips.join("") + queuedHtml;
    el.hidden = false;
    el.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => onToggleFilter(btn.dataset.filter));
    });
  }

  function replayDepartureSan(game) {
    const history = game.move_san_history || [];
    const index = Number(game.departure_ply || 0) - 1;
    return index >= 0 && index < history.length ? history[index] : "";
  }

  function renderReplayMoveLine(game) {
    const history = game.move_san_history || [];
    if (!history.length) return '<span class="muted">No moves recorded.</span>';
    const departPly = game.departure_ply;
    const matched = Number(game.matched_plies) || 0;
    const tone = REPLAY_KINDS[replayGameKind(game)].tone;
    return history
      .map((san, index) => {
        const ply = index + 1;
        const moveNumber = Math.ceil(ply / 2);
        const isWhite = ply % 2 === 1;
        let num = "";
        if (isWhite) num = `<span class="mn">${moveNumber}.</span>`;
        else if (ply === 1 || ply === matched + 1) num = `<span class="mn">${moveNumber}…</span>`;
        const classes = [];
        if (ply <= matched) classes.push("inprep");
        // Departure tone mirrors its outcome (✗ left prep, ⚡ novelty).
        if (ply === departPly) classes.push("dep", `t-${tone}`);
        return `<span class="mvw">${num}<span class="${classes.join(" ")}">${escapeHtml(san)}</span></span>`;
      })
      .join(" ");
  }

  function renderReplayDetail(game) {
    const lines = [];
    if (game.repertoire_name) {
      lines.push(
        `Repertoire: <strong>${escapeHtml(game.repertoire_name)}</strong> · ${
          Number(game.matched_plies) > 0
            ? `in prep through ${escapeHtml(plyMoveLabel(game.matched_plies, game.move_san_history))}`
            : "left prep on the first move"
        }`
      );
    } else {
      lines.push(`Played as ${escapeHtml(game.user_color)}, but no active repertoire matched.`);
    }
    if (game.departure_reason === "user_left_preparation") {
      const expected = game.expected_move_san ? ` (expected <strong>${escapeHtml(game.expected_move_san)}</strong>)` : "";
      const playedSan = replayDepartureSan(game);
      const played = playedSan ? ` <strong>${escapeHtml(playedSan)}</strong>` : "";
      const queued = game.training_recorded
        ? " Added to your training queue."
        : " Already in your training queue.";
      lines.push(`You diverged at ${moveNumberLabel(game.departure_ply)}${played}${expected}.${queued}`);
    } else if (game.departure_reason === "opponent_unprepared_branch") {
      const playedSan = replayDepartureSan(game);
      const played = playedSan ? ` <strong>${escapeHtml(playedSan)}</strong>` : "";
      if (isDifferentOpening(game)) {
        lines.push(
          `Opponent chose a different opening at ${moveNumberLabel(game.departure_ply)}${played}, before your repertoire got going. Add a reply to cover it.`
        );
      } else {
        lines.push(`Opponent took an unprepared branch at ${moveNumberLabel(game.departure_ply)}${played}.`);
      }
    } else if (game.departure_reason === "game_stayed_in_preparation") {
      lines.push("Game stayed entirely within preparation. Nice.");
    } else if (game.departure_reason === "no_repertoire_for_color") {
      lines.push("No active repertoire defined for the colour you played.");
    }
    return lines.map((line) => `<li>${line}</li>`).join("");
  }

  // "You" is resolved against the payload's own user_color, never guessed.
  function playerName(game, side) {
    return game.user_color === side ? "You" : escapeHtml(game[side] || "?");
  }

  function renderReplayRow(game, index, selectedIndex, { showAccount = true } = {}) {
    const kind = replayGameKind(game);
    const meta = REPLAY_KINDS[kind];
    const open = index === selectedIndex;
    // Second line: the finish date, plus the source account only when the
    // list mixes several accounts (one account repeated on every row is noise;
    // the ledger header names it once instead).
    const date = formatReplayDate(game.finished_at);
    const subParts = [];
    if (date) subParts.push(`<time class="lr-date" datetime="${escapeHtml(game.finished_at)}">${escapeHtml(date)}</time>`);
    if (showAccount && game.source_account) {
      subParts.push(`<i class="acct" title="Fetched from this linked account">${escapeHtml(game.source_account)}</i>`);
    }
    const source = subParts.length ? `<small>${subParts.join(" · ")}</small>` : "";
    const preview = (game.move_san_history || []).slice(0, 6).join(" ");
    const departure = game.departure_ply
      ? plyMoveLabel(game.departure_ply, game.move_san_history)
      : meta.departure || "—";
    return (
      `<button type="button" class="lr${open ? " is-open" : ""}" data-index="${index}" aria-pressed="${open}">` +
      `<span><i class="kind-badge t-${meta.tone}">${escapeHtml(replayBadge(game, meta))}</i></span>` +
      `<span class="players"><span class="pl"><b>${playerName(game, "white")}</b> vs <b>${playerName(game, "black")}</b></span>${source}</span>` +
      `<span class="res ${replayResultClass(game)}">${escapeHtml(displayReplayResult(game.result))}</span>` +
      `<span class="open-prev">${escapeHtml(preview)}${preview ? "…" : ""}</span>` +
      `<span class="num">${escapeHtml(departure)}</span>` +
      "</button>"
    );
  }

  function renderReplayFocus(game, index) {
    const kind = replayGameKind(game);
    const meta = REPLAY_KINDS[kind];
    const boardHtml = replayFocusBoardHtml(game, renderers);
    const lichessLink = game.lichess_id
      ? `<a class="btn ghost" target="_blank" rel="noopener noreferrer" href="https://lichess.org/${escapeHtml(game.lichess_id)}" title="Open on Lichess">lichess ↗</a>`
      : "";
    const actions = [];
    if (kind === "user-error") {
      actions.push(`<button class="btn primary" data-act="train" data-index="${index}">Train</button>`);
    }
    if (kind === "left-prep" && game.repertoire_id) {
      actions.push(`<button class="btn primary" data-act="build" data-index="${index}">Add reply</button>`);
    }
    if ((game.move_san_history || []).length) {
      actions.push(`<button class="btn" data-act="analyze" data-index="${index}">Analyze</button>`);
    }
    return (
      `<section class="focus card" aria-label="Preparation detail">` +
      `<div class="focus-top${boardHtml ? "" : " no-board"}">${boardHtml}` +
      `<div class="focus-info"><div class="eyebrow">Preparation detail · ${escapeHtml(displayReplayResult(game.result))}</div>` +
      `<h2>${escapeHtml(game.white || "?")} vs ${escapeHtml(game.black || "?")}</h2>` +
      `<i class="kind-badge t-${meta.tone}">${escapeHtml(replayBadge(game, meta))}</i>` +
      `<ul class="reasons">${renderReplayDetail(game)}</ul>` +
      `<div class="actions">${actions.join("")}${lichessLink}</div></div></div>` +
      `<div class="moveline">${renderReplayMoveLine(game)}</div>` +
      `</section>`
    );
  }

  function renderReplayResults(payload) {
    const container = document.getElementById("replay-results");
    renderReplaySummary(payload);
    if (!payload || !payload.games || !payload.games.length) {
      container.innerHTML =
        '<div class="empty-state big"><div class="es-mark">♙</div><h3>No recent games found</h3></div>';
      return;
    }
    const filter = getReplayFilter();
    const rows = payload.games
      .map((game, index) => ({ game, index }))
      .filter(({ game }) => !filter || replayGameKind(game) === filter);
    if (!rows.length) {
      container.innerHTML =
        '<div class="empty-state big"><div class="es-mark">♙</div><h3>No games in this bucket</h3></div>';
      return;
    }
    const selectedIndex = rows.find(({ index }) => isGameOpen(index))?.index ?? rows[0].index;
    const focused = rows.find(({ index }) => index === selectedIndex);
    const accounts = new Set(payload.games.map((game) => game.source_account).filter(Boolean));
    const showAccount = accounts.size > 1;
    const singleAccount = accounts.size === 1 ? [...accounts][0] : "";
    const accountNote = singleAccount
      ? ` · <i class="acct" title="Fetched from this linked account">${escapeHtml(singleAccount)}</i>`
      : "";
    // A row click re-renders the list: keep the ledger's scroll position and
    // the keyboard focus on the clicked row, then reveal the detail card.
    const revealIndex = pendingRevealIndex;
    pendingRevealIndex = null;
    const ledgerScroll = revealIndex != null ? container.querySelector?.(".ledger-table")?.scrollTop || 0 : 0;
    container.innerHTML =
      `<div class="triage"><section class="ledger card" aria-label="Games to review">` +
      `<header class="card-head"><h2>Games to review</h2><span class="faint">${rows.length} shown${accountNote}</span></header>` +
      `<div class="ledger-table"><div class="lr head" aria-hidden="true"><span>Preparation</span><span>Game</span><span>Result</span><span>First moves</span><span>Departure</span></div>` +
      rows.map(({ game, index }) => renderReplayRow(game, index, selectedIndex, { showAccount })).join("") +
      `</div></section>${renderReplayFocus(focused.game, focused.index)}</div>`;
    container.querySelectorAll(".lr[data-index]").forEach((row) => {
      row.addEventListener("click", () => {
        pendingRevealIndex = Number(row.dataset.index);
        onToggleGame(Number(row.dataset.index));
      });
    });
    if (revealIndex != null && revealIndex === focused.index) {
      const table = container.querySelector?.(".ledger-table");
      if (table && ledgerScroll) table.scrollTop = ledgerScroll;
      container.querySelector?.(`.lr[data-index="${revealIndex}"]`)?.focus?.({ preventScroll: true });
      revealIfOffscreen(container.querySelector?.(".focus"));
    }
    container.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const game = payload.games[Number(btn.dataset.index)];
        if (!game) return;
        const act = btn.dataset.act;
        // Hand the destination the decision position too (F-06): the app-side
        // handoff stores it as the anchor FEN.
        const focus = replayFocusPosition(game);
        if (act === "train") onTrainMiss(game, focus);
        else if (act === "build") onBuildReply(game, focus);
        else if (act === "analyze") onAnalyze(game, focus);
      });
    });
  }

  return {
    renderReplayResults,
  };
}
