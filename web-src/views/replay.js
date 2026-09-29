// Replay tab rendering (lazy-loaded from app.js).

import { Chess } from "chess.js";
import "./replay.css";

const REPLAY_KINDS = {
  "in-prep": { icon: "✓", badge: "Stayed in prep", label: "stayed in prep" },
  "user-error": { icon: "✗", badge: "You left prep", label: "you left prep" },
  "left-prep": { icon: "⚡", badge: "Opponent novelty", label: "novelties" },
  "no-prep": { icon: "—", badge: "No repertoire", label: "not covered", departure: "—" },
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
  } catch (_) {
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
    } catch (_) {
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
  return `<div class="replay-focus-board" data-testid="replay-focus-board"><div class="scout-miniboard" aria-hidden="true">${squares}</div>${svg}</div>`;
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
          `<button type="button" class="replay-chip rk-${kind}${
            activeFilter === kind ? " is-on" : ""
          }" data-filter="${kind}">${meta.icon} ${counts[kind]} ${meta.label}</button>`
      );
    const queued = Number(payload.misses_recorded) || 0;
    const queuedHtml = queued
      ? `<span class="replay-queued" title="Recorded as recall misses">+${queued} queued for training</span>`
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
      if (isDepart) {
        classes.push("ply-mark");
        // Departure tone mirrors its outcome (✗ left prep, ⚡ novelty, ✓ stayed).
        const kind = replayGameKind(game);
        if (kind === "user-error") classes.push("t-bad");
        else if (kind === "left-prep") classes.push("t-warn");
        else if (kind === "in-prep") classes.push("t-good");
      }
      parts.push(`<span class="${classes.join(" ")}">${escapeHtml(san)}</span>`);
    });
    return parts.join(" ");
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
    return lines.join("<br />");
  }

  function renderReplayCard(game, index, selectedIndex) {
    const kind = replayGameKind(game);
    const meta = REPLAY_KINDS[kind];
    const open = index === selectedIndex;
    const source = game.source_account
      ? ` <span class="replay-source" title="Fetched from this linked account">${escapeHtml(game.source_account)}</span>`
      : "";
    const players = `${escapeHtml(game.white || "?")} <span class="muted">vs</span> ${escapeHtml(game.black || "?")}${source}`;
    const preview = (game.move_san_history || []).slice(0, 6).join(" ");
    const lichessLink = game.lichess_id
      ? `<a class="link" target="_blank" rel="noopener noreferrer" href="https://lichess.org/${escapeHtml(game.lichess_id)}" title="Open on Lichess">lichess ↗</a>`
      : "";

    const actions = [];
    if (kind === "user-error") {
      actions.push(
        `<button class="btn primary" data-act="train" data-index="${index}">Train</button>`
      );
    }
    if (kind === "left-prep" && game.repertoire_id) {
      actions.push(
        `<button class="btn primary" data-act="build" data-index="${index}">Add reply</button>`
      );
    }
    if ((game.move_san_history || []).length) {
      actions.push(
        `<button class="btn ghost" data-act="analyze" data-index="${index}">Analyze</button>`
      );
    }

    const body = `<div class="replay-row-body">
        <div class="replay-line">${renderReplayMoveLine(game)}</div>
        <div class="replay-detail">${renderReplayDetail(game)}</div>
        <div class="replay-actions">${actions.join("")}${lichessLink}</div>
      </div>`;
    const departure = game.departure_ply ? `Ply ${Number(game.departure_ply)}` : meta.departure || "—";
    const card = `
    <div class="replay-row rk-${kind}${open ? " is-open" : ""}">
      <button type="button" class="replay-row-head" data-index="${index}" aria-pressed="${open}">
        <span class="replay-badge rk-${kind}">${escapeHtml(meta.badge)}</span>
        <span class="players">${players}</span>
        <span class="replay-result ${replayResultClass(game)}">${escapeHtml(game.result || "*")}</span>
        <span class="replay-preview">${escapeHtml(preview)}${preview ? "…" : ""}</span>
        <span class="replay-departure">${escapeHtml(departure)}</span>
      </button>
    </div>
  `;
    return { card, body, players, meta, kind, game };
  }

  function renderReplayResults(payload) {
    const container = document.getElementById("replay-results");
    renderReplaySummary(payload);
    if (!payload || !payload.games || !payload.games.length) {
      container.innerHTML =
        '<div class="empty-state">No recent games found.</div>';
      return;
    }
    const filter = getReplayFilter();
    const rows = payload.games
      .map((game, index) => ({ game, index }))
      .filter(({ game }) => !filter || replayGameKind(game) === filter);
    const selectedIndex = rows.find(({ index }) => isGameOpen(index))?.index ?? rows[0]?.index;
    const focused = rows.find(({ index }) => index === selectedIndex);
    const selected = focused ? renderReplayCard(focused.game, focused.index, selectedIndex) : null;
    container.innerHTML = rows.length
      ? `<div class="replay-triage"><div class="replay-ledger"><div class="replay-ledger-head"><h4>Games to review</h4><span>${rows.length} shown</span></div><div class="replay-ledger-columns" aria-hidden="true"><span>Preparation</span><span>Game</span><span>Result</span><span>Opening</span><span>Departure</span></div><div class="replay-game-list">${rows.map(({ game, index }) => renderReplayCard(game, index, selectedIndex).card).join("")}</div></div><section class="replay-focus" aria-label="Selected game"><div class="replay-focus-top">${replayFocusBoardHtml(focused.game, renderers)}<div class="replay-focus-info"><div class="replay-focus-eyebrow">Preparation detail <span>${escapeHtml(focused.game.result || "*")}</span></div><h4>${selected.players}</h4><span class="replay-badge rk-${selected.kind}">${escapeHtml(selected.meta.badge)}</span>${selected.body}</div></div><div class="replay-legend"><span><i class="k-inprep"></i>in prep</span>${focused.game.departure_ply ? `<span><i class="k-dep"></i>departure</span>` : ""}${selected.kind === "user-error" ? `<span><i class="k-arrow-good"></i>expected</span><span><i class="k-arrow-bad"></i>played</span>` : ""}</div></section></div>`
      : '<div class="empty-state">No games in this bucket.</div>';
    container.querySelectorAll(".replay-row-head").forEach((head) => {
      head.addEventListener("click", () => onToggleGame(Number(head.dataset.index)));
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
