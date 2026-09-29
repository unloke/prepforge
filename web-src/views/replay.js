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
  const arrows = replayArrowsFor(pos)
    .map((a) => {
      const [x1, y1] = coord(a.from);
      const [x2, y2] = coord(a.to);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const head = 4.5;
      const ex = x2 - ux * 4;
      const ey = y2 - uy * 4;
      const wing = head * 0.62;
      return `<g class="t-${a.tone}"><line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" /><polygon points="${x2},${y2} ${ex - ux * head - uy * wing},${ey - uy * head + ux * wing} ${ex - ux * head + uy * wing},${ey - uy * head - ux * wing}" /></g>`;
    })
    .join("");
  const svg = arrows
    ? `<svg class="replay-arrows" viewBox="0 0 100 100" aria-hidden="true">${arrows}</svg>`
    : "";
  return `<div class="focus-board" data-testid="replay-focus-board"><div class="scout-miniboard" aria-hidden="true">${squares}</div>${svg}</div>`;
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
        ? " Added to your training queue."
        : " Already in your training queue.";
      lines.push(`You diverged on ply ${game.departure_ply}${played}${expected}.${queued}`);
    } else if (game.departure_reason === "opponent_unprepared_branch") {
      const playedSan = replayDepartureSan(game);
      const played = playedSan ? ` <strong>${escapeHtml(playedSan)}</strong>` : "";
      lines.push(`Opponent took an unprepared branch on ply ${game.departure_ply}${played}.`);
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

  function renderReplayRow(game, index, selectedIndex) {
    const kind = replayGameKind(game);
    const meta = REPLAY_KINDS[kind];
    const open = index === selectedIndex;
    const source = game.source_account
      ? `<small><i class="acct" title="Fetched from this linked account">${escapeHtml(game.source_account)}</i></small>`
      : "";
    const preview = (game.move_san_history || []).slice(0, 6).join(" ");
    const departure = game.departure_ply ? `Ply ${Number(game.departure_ply)}` : meta.departure || "—";
    return (
      `<button type="button" class="lr${open ? " is-open" : ""}" data-index="${index}" aria-pressed="${open}">` +
      `<span><i class="kind-badge t-${meta.tone}">${escapeHtml(meta.badge)}</i></span>` +
      `<span class="players"><span class="pl"><b>${playerName(game, "white")}</b> vs <b>${playerName(game, "black")}</b></span>${source}</span>` +
      `<span class="res ${replayResultClass(game)}">${escapeHtml(game.result || "*")}</span>` +
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
      `<div class="focus-info"><div class="eyebrow">Preparation detail · ${escapeHtml(game.result || "*")}</div>` +
      `<h2>${escapeHtml(game.white || "?")} vs ${escapeHtml(game.black || "?")}</h2>` +
      `<i class="kind-badge t-${meta.tone}">${escapeHtml(meta.badge)}</i>` +
      `<ul class="reasons">${renderReplayDetail(game)}</ul>` +
      `<div class="actions">${actions.join("")}${lichessLink}</div></div></div>` +
      `<div class="moveline">${renderReplayMoveLine(game)}</div>` +
      `<div class="legend"><span><i class="k-inprep"></i>in prep</span>${
        game.departure_ply ? `<span><i class="k-dep"></i>departure</span>` : ""
      }${
        kind === "user-error"
          ? `<span><i class="k-arrow-good"></i>expected</span><span><i class="k-arrow-bad"></i>played</span>`
          : ""
      }</div></section>`
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
    container.innerHTML =
      `<div class="triage"><section class="ledger card" aria-label="Games to review">` +
      `<header class="card-head"><h2>Games to review</h2><span class="faint">${rows.length} shown</span></header>` +
      `<div class="ledger-table"><div class="lr head" aria-hidden="true"><span>Preparation</span><span>Game</span><span>Result</span><span>Opening</span><span>Departure</span></div>` +
      rows.map(({ game, index }) => renderReplayRow(game, index, selectedIndex)).join("") +
      `</div></section>${renderReplayFocus(focused.game, focused.index)}</div>`;
    container.querySelectorAll(".lr[data-index]").forEach((row) => {
      row.addEventListener("click", () => onToggleGame(Number(row.dataset.index)));
    });
    container.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const game = payload.games[Number(btn.dataset.index)];
        if (!game) return;
        const act = btn.dataset.act;
        if (act === "train") onTrainMiss();
        else if (act === "build") onBuildReply(game);
        else if (act === "analyze") onAnalyze(game);
      });
    });
  }

  return {
    renderReplayResults,
  };
}
