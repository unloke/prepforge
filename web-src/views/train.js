// Train tab rendering (lazy-loaded from app.js).

// Mirrors services/scheduler.py DEFAULT_NEW_CAP.
export const SMART_NEW_CAP = 4;

// Health counts moves, not cards. The scheduler merges consecutive review
// moves into cards and may add polish, so only name the available moves here.
export function sessionPreviewText(health) {
  if (!health) return "";
  const reviews = (Number(health.weak) || 0) + (Number(health.due) || 0);
  const fresh = Number(health.untrained) || 0;
  const parts = [];
  if (reviews) parts.push(`${reviews} review move${reviews === 1 ? "" : "s"} ready`);
  if (fresh) parts.push(`${fresh} new available (up to ${Math.min(SMART_NEW_CAP, fresh)} this session)`);
  if (!parts.length) return health.trainable > 0 ? "Nothing due — polish available" : "No moves to train yet";
  return parts.join(" · ");
}

export function createTrainView({
  appState,
  boards,
  escapeHtml,
  renderSyncChip,
  setTrainBanner,
  updateTrainTurnBadge,
  smartKindLabels,
  smartKindTitles,
  onStreakRendered,
}) {
  function renderTrainSync() {
    const el = document.getElementById("train-sync");
    if (!el) return;
    renderSyncChip(el, appState.trainSyncState, "training");
  }

  function renderTrainStats() {
    const s = appState.trainStats || { correct: 0, mistakes: 0, streak: 0, history: [], lastStreak: 0 };
    const streakEl = document.getElementById("train-stat-streak");
    const flame = "";
    streakEl.innerHTML = `${s.streak}${flame}`;
    const chip = streakEl.closest(".stat");
    if (chip) {
      chip.classList.toggle(
        "at-risk",
        !!(appState.trainReview && appState.trainReview.savedStreak > 0 && s.streak === 0)
      );
      if (s.streak > (s.lastStreak || 0)) {
        chip.classList.remove("pop");
        void chip.offsetWidth;
        chip.classList.add("pop");
        if (s.streak > 0 && s.streak % 5 === 0) chip.classList.add("milestone");
        else chip.classList.remove("milestone");
      }
    }
    onStreakRendered(s.streak);
    document.getElementById("train-stat-correct").textContent = s.correct;
    document.getElementById("train-stat-mistakes").textContent = s.mistakes;
    const total = s.correct + s.mistakes;
    // Labelled, not a bare "67%": first-try accuracy for this session.
    document.getElementById("train-accuracy").textContent = total
      ? `${Math.round((s.correct / total) * 100)}% first try`
      : "";
    const trail = document.getElementById("train-line-trail");
    if (!s.history.length) {
      trail.innerHTML = '<span class="trail-empty">No moves yet</span>';
    } else {
      trail.innerHTML = s.history
        .slice(-26)
        .map((ok) => `<i class="${ok ? "ok" : "no"}"></i>`)
        .join("");
    }
  }

  function renderTraining(prompt) {
    if (!prompt) return;
    boards.train.setEngineArrow(null);
    // The opponent's reply stays highlighted as the cue while the board is
    // already on this position; a jump to another line starts clean.
    const board = boards.train;
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: board.fen === prompt.fen_before ? board.lastMove || null : null,
    });
    const side = (prompt.fen_before || "").split(" ")[1] === "b" ? "black" : "white";
    setTrainBanner("move", "Your move", "Play your prepared idea on the board");
    updateTrainTurnBadge(side);
    const total = prompt.total_lines || 1;
    document.getElementById("train-line-label").textContent =
      `Line ${(prompt.current_index || 0) + 1} / ${total}`;
    paintCardKind(null);
    document.getElementById("train-progress-fill").style.width =
      `${Math.round(((prompt.current_index || 0) / Math.max(1, total)) * 100)}%`;
    const name = (appState.training && appState.training.repertoire_name) || "Repertoire";
    const color = (appState.training && appState.training.color) || "white";
    document.getElementById("train-board-label").textContent = `${name} - you play ${color}`;
  }

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
    // One progress bar only (cards done, above). The queue's make-up is told by the
    // labelled chips; a second, always-full composition bar read as an unlabeled
    // duplicate progress bar (UX 2026-09-30 P2-10).
    const bar = document.getElementById("train-queue-bar");
    if (bar) {
      bar.hidden = true;
      bar.innerHTML = "";
    }
    const cluster = smart.phaseCluster;
    const phaseChip =
      cluster && cluster.total
        ? `<span class="kchip phase" title="Most cards sit in ${escapeHtml(cluster.majorityLabel.toLowerCase())}">${escapeHtml(cluster.majorityLabel)} coach · ${cluster.counts[cluster.majority]}/${cluster.total}</span>`
        : "";
    document.getElementById("train-queue-legend").innerHTML =
      kinds
        .map(
          (k) =>
            `<span class="kchip k-${k}" title="${escapeHtml(smartKindTitles[k] || "")}">${counts[k]} ${k}</span>`
        )
        .join("") + phaseChip;
  }

  // "Up next" preview: the next few cards in the real queue, so a mixed session
  // hopping between repertoires never surprises. Reads only appState.smart.queue —
  // no second source of truth, nothing rendered when the queue is missing.
  function renderUpNext() {
    const host = document.getElementById("train-upnext");
    if (!host) return;
    const smart = appState.smart;
    const queue = smart && smart.queue;
    if (!queue || !queue.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    const upcoming = [];
    for (let d = 1; upcoming.length < 3 && smart.cardIndex + d < queue.length; d++) {
      const card = queue[smart.cardIndex + d];
      if (card) upcoming.push(card);
    }
    if (!upcoming.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    host.innerHTML =
      '<small class="faint">Up next</small>' +
      upcoming
        .map((card) => {
          const kind = smartKindLabels[card.kind] || card.kind || "";
          const rep = card.repertoire_name || smart.repertoireName || "";
          const dot = card.color === "black" ? "black" : "white";
          // Only a new move is shown before it is asked (the card demonstrates
          // it anyway). Weak/due/polish cards test recall, so printing their
          // answer here would give it away (UX walkthrough 2026-10-01 P1-2).
          const target = card.kind === "new" && card.targets && card.targets[0];
          const lineTail = target && target.san ? escapeHtml(target.san) : "";
          return (
            `<div class="un-row">` +
            `<span class="kchip k-${escapeHtml(card.kind || "polish")}">${escapeHtml(kind)}</span>` +
            `<span class="un-rep"><span class="color-dot ${dot}"></span>${escapeHtml(rep)}</span>` +
            `<span class="un-line">${lineTail}</span>` +
            "</div>"
          );
        })
        .join("");
  }

  // Card kind chip beside the counter (smart queue only; rehearsal has none).
  function paintCardKind(kind) {
    const chip = document.getElementById("train-card-kind");
    if (!chip) return;
    chip.hidden = !kind;
    chip.className = kind ? `kchip k-${kind}` : "kchip";
    chip.textContent = kind ? smartKindLabels[kind] || kind : "";
  }

  function renderSmartProgress(prompt) {
    const total = Math.max(1, prompt.total_cards);
    document.getElementById("train-line-label").textContent =
      `Card ${Math.min(prompt.card_index + 1, total)} / ${total}`;
    paintCardKind(prompt.kind);
    renderUpNext();
    document.getElementById("train-progress-fill").style.width =
      `${Math.round((prompt.card_index / total) * 100)}%`;
    const dots = document.getElementById("train-card-dots");
    if (dots) {
      dots.innerHTML =
        prompt.targets_total > 1
          ? Array.from({ length: prompt.targets_total }, (_, i) => {
              const cls = i < prompt.target_index ? "done" : i === prompt.target_index ? "cur" : "";
              return `<i class="${cls}"></i>`;
            }).join("") +
            `<span class="faint">move ${prompt.target_index + 1} of ${prompt.targets_total} in this card</span>`
          : "";
    }
  }

  function renderSmartSummary(smart, stats, after, dayStreak) {
    const panel = document.getElementById("train-summary");
    if (!panel) return;
    const queue = document.getElementById("train-queue");
    if (queue) queue.hidden = true;
    const firstTries = (stats.correct || 0) + (stats.mistakes || 0);
    const acc = firstTries ? `${Math.round(((stats.correct || 0) / firstTries) * 100)}%` : "—";
    const statCells = [
      [smart.cardsDone, "cards"],
      [acc, "first try"],
      [stats.best || 0, "best in a row"],
    ];
    const day = dayStreak;
    if (day && day.current > 0) statCells.push([`\u{1F525}${day.current}`, "day streak"]);
    document.getElementById("train-summary-stats").innerHTML = statCells
      .map(
        ([value, label]) =>
          `<div><b>${value}</b><span>${label}</span></div>`
      )
      .join("");
    const deltaEl = document.getElementById("train-summary-delta");
    const footEl = document.getElementById("train-summary-foot");
    const before = smart.healthBefore;
    if (before && after && after.health) {
      deltaEl.innerHTML = [
        ["mastered", "Mastered", "mastered", 1],
        ["learning", "Learning", "learning", 0],
        ["due", "Due", "due", -1],
        ["weak", "Weak", "weak", -1],
        ["untrained", "New", "new", -1],
      ]
        .map(([key, label, kind, goodDir]) => {
          const now = after.health[key] || 0;
          const diff = now - (before[key] || 0);
          const tone = diff * goodDir > 0 ? "up" : diff * goodDir < 0 ? "down" : "";
          const delta = diff === 0 ? "" : `${diff > 0 ? "+" : "−"}${Math.abs(diff)}`;
          return (
            `<div class="tsum-row"><span><i class="k-${kind}"></i>${label}</span>` +
            `<span class="num">${now}</span><span class="num ${tone}">${delta}</span></div>`
          );
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

  return {
    renderTrainSync,
    renderTrainStats,
    renderTraining,
    renderSmartQueueStrip,
    renderSmartProgress,
    renderSmartSummary,
  };
}
