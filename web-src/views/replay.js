// Replay tab rendering (lazy-loaded from app.js).

const REPLAY_KINDS = {
  "in-prep": { icon: "✓", badge: "Stayed in prep", label: "stayed in prep" },
  "user-error": { icon: "✗", badge: "You left prep", label: "you left prep" },
  "left-prep": { icon: "⚡", badge: "Opponent novelty", label: "novelties" },
  "no-prep": { icon: "—", badge: "No repertoire", label: "not covered" },
};

function replayGameKind(game) {
  if (game.in_repertoire && game.departure_reason === "game_stayed_in_preparation")
    return "in-prep";
  if (game.departure_reason === "user_left_preparation") return "user-error";
  if (game.departure_reason === "opponent_unprepared_branch") return "left-prep";
  return "no-prep";
}

export function createReplayView({
  escapeHtml,
  getReplayFilter,
  isGameOpen,
  onToggleFilter,
  onToggleGame,
  onTrainMiss,
  onBuildReply,
  onAnalyze,
}) {
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
          }" data-filter="${kind}" title="Show only these games">${meta.icon} ${counts[kind]} ${meta.label}</button>`
      );
    const queued = Number(payload.misses_recorded) || 0;
    const queuedHtml = queued
      ? `<span class="replay-queued" title="Each forgotten move was recorded as a recall miss — it leads your next smart session">+${queued} queued for training</span>`
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
      if (isDepart) classes.push("ply-mark");
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
        ? " Added to your training queue - the move you forgot is due now."
        : " Already in your training queue.";
      lines.push(`You diverged on ply ${game.departure_ply}${played}${expected}.${queued}`);
    } else if (game.departure_reason === "opponent_unprepared_branch") {
      const playedSan = replayDepartureSan(game);
      const played = playedSan ? ` <strong>${escapeHtml(playedSan)}</strong>` : "";
      lines.push(`Opponent took an unprepared branch on ply ${game.departure_ply}${played}. Add your reply in Build so it never surprises you again.`);
    } else if (game.departure_reason === "game_stayed_in_preparation") {
      lines.push("Game stayed entirely within preparation. Nice.");
    } else if (game.departure_reason === "no_repertoire_for_color") {
      lines.push("No active repertoire defined for the colour you played.");
    }
    return lines.join("<br />");
  }

  function renderReplayCard(game, index) {
    const kind = replayGameKind(game);
    const meta = REPLAY_KINDS[kind];
    const open = isGameOpen(index);
    const players = `${escapeHtml(game.white || "?")} <span class="muted">vs</span> ${escapeHtml(game.black || "?")}`;
    const preview = (game.move_san_history || []).slice(0, 6).join(" ");
    const lichessLink = game.lichess_id
      ? `<a class="link" target="_blank" rel="noopener noreferrer" href="https://lichess.org/${escapeHtml(game.lichess_id)}" title="Open on Lichess">lichess ↗</a>`
      : "";

    const actions = [];
    if (kind === "user-error") {
      actions.push(
        `<button class="btn primary" data-act="train" data-index="${index}" title="The forgotten move is already queued — train it now">Train it now</button>`
      );
    }
    if (kind === "left-prep" && game.repertoire_id) {
      actions.push(
        `<button class="btn primary" data-act="build" data-index="${index}" title="Open Build at the position where the novelty appeared">Add reply in Build</button>`
      );
    }
    if ((game.move_san_history || []).length) {
      actions.push(
        `<button class="btn ghost" data-act="analyze" data-index="${index}" title="Load this game into the Analyze tab">Review in Analyze</button>`
      );
    }

    const body = open
      ? `<div class="replay-row-body">
        <div class="replay-line">${renderReplayMoveLine(game)}</div>
        <div class="replay-detail">${renderReplayDetail(game)}</div>
        <div class="replay-actions">${actions.join("")}${lichessLink}</div>
      </div>`
      : "";
    return `
    <div class="replay-row rk-${kind}${open ? " is-open" : ""}">
      <button type="button" class="replay-row-head" data-index="${index}" aria-expanded="${open}">
        <span class="replay-icon" aria-hidden="true">${meta.icon}</span>
        <span class="players">${players}</span>
        <span class="replay-result">${escapeHtml(game.result || "*")}</span>
        ${open ? "" : `<span class="replay-preview">${escapeHtml(preview)}…</span>`}
        <span class="replay-badge">${escapeHtml(meta.badge)}</span>
        <span class="replay-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
      </button>
      ${body}
    </div>
  `;
  }

  function renderReplayResults(payload) {
    const container = document.getElementById("replay-results");
    renderReplaySummary(payload);
    if (!payload || !payload.games || !payload.games.length) {
      container.innerHTML =
        '<div class="empty-state">No games found, or none played as a color you have a repertoire for.</div>';
      return;
    }
    const filter = getReplayFilter();
    const rows = payload.games
      .map((game, index) => ({ game, index }))
      .filter(({ game }) => !filter || replayGameKind(game) === filter);
    container.innerHTML = rows.length
      ? rows.map(({ game, index }) => renderReplayCard(game, index)).join("")
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