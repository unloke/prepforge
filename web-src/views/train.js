// Train tab rendering (lazy-loaded from app.js).

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
    renderSyncChip(el, appState.trainSyncState);
  }

  function renderTrainStats() {
    const s = appState.trainStats || { correct: 0, mistakes: 0, streak: 0, history: [], lastStreak: 0 };
    const streakEl = document.getElementById("train-stat-streak");
    const flame = "";
    streakEl.innerHTML = `${s.streak}${flame}`;
    const chip = streakEl.closest(".train-stat");
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

  function renderTraining(prompt) {
    if (!prompt) return;
    boards.train.setEngineArrow(null);
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: null,
    });
    const side = (prompt.fen_before || "").split(" ")[1] === "b" ? "black" : "white";
    setTrainBanner("move", `${side === "white" ? "White" : "Black"} to move`, "Play your prepared move on the board");
    updateTrainTurnBadge(side);
    const total = prompt.total_lines || 1;
    document.getElementById("train-line-label").textContent =
      `Line ${(prompt.current_index || 0) + 1} / ${total}`;
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
    document.getElementById("train-queue-bar").innerHTML = kinds
      .map((k) => `<span class="tq-seg tq-${k}" style="flex:${counts[k]}"></span>`)
      .join("");
    document.getElementById("train-queue-legend").innerHTML = kinds
      .map(
        (k) =>
          `<span class="tq-chip tq-${k}" title="${escapeHtml(smartKindTitles[k] || "")}">${counts[k]} ${k}</span>`
      )
      .join("");
  }

  function renderSmartProgress(prompt) {
    const total = Math.max(1, prompt.total_cards);
    document.getElementById("train-line-label").textContent =
      `Card ${Math.min(prompt.card_index + 1, total)} / ${total} · ${smartKindLabels[prompt.kind] || prompt.kind}`;
    document.getElementById("train-progress-fill").style.width =
      `${Math.round((prompt.card_index / total) * 100)}%`;
    const dots = document.getElementById("train-card-dots");
    if (dots) {
      dots.innerHTML =
        prompt.targets_total > 1
          ? Array.from({ length: prompt.targets_total }, (_, i) => {
              const cls = i < prompt.target_index ? "done" : i === prompt.target_index ? "now" : "";
              return `<span class="card-dot ${cls}"></span>`;
            }).join("")
          : "";
    }
  }

  function renderSmartSummary(smart, stats, after, dayStreak) {
    const panel = document.getElementById("train-summary");
    if (!panel) return;
    const queue = document.getElementById("train-queue");
    if (queue) queue.hidden = true;
    const firstTries = (stats.correct || 0) + (stats.mistakes || 0);
    const acc = firstTries ? Math.round(((stats.correct || 0) / firstTries) * 100) : 100;
    const statCells = [
      [smart.cardsDone, "cards"],
      [`${acc}%`, "first try"],
      [stats.best || 0, "best in a row"],
    ];
    const day = dayStreak;
    if (day && day.current > 0) statCells.push([`\u{1F525}${day.current}`, "day streak"]);
    document.getElementById("train-summary-stats").innerHTML = statCells
      .map(
        ([value, label]) =>
          `<div class="tsum-stat"><span class="tsum-value">${value}</span><span class="tsum-label">${label}</span></div>`
      )
      .join("");
    const deltaEl = document.getElementById("train-summary-delta");
    const footEl = document.getElementById("train-summary-foot");
    const before = smart.healthBefore;
    if (before && after && after.health) {
      deltaEl.innerHTML = [
        ["mastered", "Mastered", "good", 1],
        ["learning", "Learning", "", 0],
        ["due", "Due", "warn", -1],
        ["weak", "Weak", "bad", -1],
        ["untrained", "New", "", -1],
      ]
        .map(([key, label, cls, goodDir]) => {
          const now = after.health[key] || 0;
          const diff = now - (before[key] || 0);
          const tone = diff * goodDir > 0 ? "up" : diff * goodDir < 0 ? "down" : "";
          const delta =
            diff === 0
              ? ""
              : `<span class="tsum-delta ${tone}">${diff > 0 ? "+" : ""}${diff}</span>`;
          return `<div class="tsum-row ${cls}"><span>${label}</span><span class="tsum-num">${now}${delta}</span></div>`;
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