import { html } from "../html.js";
// Train tab rendering (lazy-loaded from app.js).

// The queue a plain Start serves, in the same terms as the in-session chips:
// "11 cards · 1 weak · 4 new · 6 polish", or what is left of a resumable one.
export function sessionPreviewText(next) {
  if (!next) return "";
  const cards = Number(next.cards) || 0;
  if (!cards) return "No moves to train yet";
  const parts = ["weak", "due", "new", "polish"]
    .filter((kind) => Number(next[kind]) > 0)
    .map((kind) => `${next[kind]} ${kind}`);
  const total = `${cards} card${cards === 1 ? "" : "s"}${next.resumed ? " left" : ""}`;
  return [total, ...parts].join(" · ");
}

// The last plies of a numbered line ("1.e4 c6 2.d4 d5" → "2.d4 d5"): which
// position a card asks about, without its answer.
export function lineTail(line, plies = 2) {
  const tokens = String(line || "").split(" ").filter(Boolean);
  const from = Math.max(0, tokens.length - plies);
  const tail = tokens.slice(from);
  if (tail.length && !/^\d+\./.test(tail[0])) {
    const number = from > 0 && /^(\d+)\./.exec(tokens[from - 1]);
    if (number) tail[0] = `${number[1]}...${tail[0]}`;
  }
  return tail.join(" ");
}

export function createTrainView({
  appState,
  boards,
  renderSyncChip,
  setTrainBanner,
  updateTrainTurnBadge,
  onStreakRendered,
}) {
  document.getElementById("train-line-path")?.addEventListener("click", (event) => {
    const el = event.currentTarget;
    el.setAttribute("aria-expanded", String(el.getAttribute("aria-expanded") !== "true"));
  });

  function renderTrainSync() {
    const el = document.getElementById("train-sync");
    if (!el) return;
    renderSyncChip(el, appState.trainSyncState, "training");
  }

  function renderTrainStats() {
    const s = appState.trainStats || { correct: 0, mistakes: 0, streak: 0, history: [], lastStreak: 0 };
    const streakEl = document.getElementById("train-stat-streak");
    const flame = "";
    streakEl.innerHTML = html`${s.streak}${flame}`;
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
      trail.innerHTML = html`<span class="trail-empty">No moves yet</span>`;
    } else {
      trail.innerHTML = html`${s.history
        .slice(-26)
        .map((ok) => html`<i class="${ok ? "ok" : "no"}"></i>`)}`;
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
    renderLinePath("");
    // Rehearsal has no queue: drop a smart session's "Up next" rows.
    const upnext = document.getElementById("train-upnext");
    if (upnext) upnext.hidden = true;
    document.getElementById("train-progress-fill").style.width =
      `${Math.round(((prompt.current_index || 0) / Math.max(1, total)) * 100)}%`;
    const progress = document.getElementById("train-progress");
    progress?.setAttribute("aria-valuemin", "0");
    progress?.setAttribute("aria-valuemax", String(total));
    progress?.setAttribute("aria-valuenow", String(prompt.current_index || 0));
    progress?.setAttribute("aria-label", "Lines done this session");
    const name = (appState.training && appState.training.repertoire_name) || "Repertoire";
    const color = (appState.training && appState.training.color) || "white";
    document.getElementById("train-board-label").textContent = `${name} · you play ${color}`;
  }

  function renderSmartQueueStrip() {
    const smart = appState.smart;
    const wrap = document.getElementById("train-queue");
    if (!wrap) return;
    const counts = smart && smart.counts;
    const kinds = Object.keys(smart?.cardKinds || {}).filter((k) => counts && counts[k] > 0);
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
        ? html`<span class="kchip phase" title="Most cards sit in ${cluster.majorityLabel.toLowerCase()}">${cluster.majorityLabel} coach · ${cluster.counts[cluster.majority]}/${cluster.total}</span>`
        : "";
    document.getElementById("train-queue-legend").innerHTML =
      html`${kinds
        .map(
          (k) =>
            html`<span class="kchip k-${k}" title="${smart.cardKinds[k].title || ""}">${counts[k]} ${k}</span>`
        )}${phaseChip}`;
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
      html`<small class="faint">Up next</small>${upcoming
        .map((card) => {
          const kind = smart.cardKinds[card.kind]?.label || card.kind || "";
          const rep = card.repertoire_name || smart.repertoireName || "";
          const dot = card.color === "black" ? "black" : "white";
          // Name the position, never the answer: every card can come back as
          // a recall test.
          const tail = lineTail(card.targets?.[0]?.line);
          return (
            html`<div class="un-row"><span class="kchip k-${card.kind || "polish"}">${kind}</span><span class="un-rep"><span class="color-dot ${dot}"></span>${rep}</span><span class="un-line">${tail}</span></div>`
          );
        })}`;
  }

  // Card kind chip beside the counter (smart queue only; rehearsal has none).
  function paintCardKind(kind) {
    const chip = document.getElementById("train-card-kind");
    if (!chip) return;
    chip.hidden = !kind;
    chip.className = kind ? `kchip k-${kind}` : "kchip";
    chip.textContent = kind ? appState.smart.cardKinds[kind]?.label || kind : "";
  }

  // How the card's position arose. One line showing its end; a tap shows it all.
  function renderLinePath(line) {
    const el = document.getElementById("train-line-path");
    if (!el) return;
    el.hidden = !line;
    el.setAttribute("aria-expanded", "false");
    el.title = line || "";
    el.innerHTML = line ? html`<bdi>${line}</bdi>` : "";
  }

  function renderSmartProgress(prompt) {
    renderLinePath(prompt.target?.line || "");
    const total = Math.max(1, prompt.total_cards);
    document.getElementById("train-line-label").textContent =
      `Card ${Math.min(prompt.card_index + 1, total)} / ${total}`;
    paintCardKind(prompt.kind);
    renderUpNext();
    document.getElementById("train-progress-fill").style.width =
      `${Math.round((prompt.card_index / total) * 100)}%`;
    const progress = document.getElementById("train-progress");
    progress?.setAttribute("aria-valuemin", "0");
    progress?.setAttribute("aria-valuemax", String(total));
    progress?.setAttribute("aria-valuenow", String(Math.max(0, Math.min(prompt.card_index, total))));
    progress?.setAttribute("aria-label", "Cards done this session");
    const dots = document.getElementById("train-card-dots");
    if (dots) {
      dots.innerHTML =
        prompt.targets_total > 1
          ? html`${Array.from({ length: prompt.targets_total }, (_, i) => {
              const cls = i < prompt.target_index ? "done" : i === prompt.target_index ? "cur" : "";
              return html`<i class="${cls}"></i>`;
            })}<span class="faint">move ${prompt.target_index + 1} of ${prompt.targets_total} in this card</span>`
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
    document.getElementById("train-summary-stats").innerHTML = html`${statCells
      .map(
        ([value, label]) =>
          html`<div><b>${value}</b><span>${label}</span></div>`
      )}`;
    const deltaEl = document.getElementById("train-summary-delta");
    const footEl = document.getElementById("train-summary-foot");
    const before = smart.healthBefore;
    if (before && after && after.health) {
      deltaEl.innerHTML = html`${[
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
            html`<div class="tsum-row"><span><i class="k-${kind}"></i>${label}</span><span class="num">${now}</span><span class="num ${tone}">${delta}</span></div>`
          );
        })}`;
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
