import { html } from "../html.js";
import { enterRows } from "../list-enter.js";
import { TRAINING_SYNC_TEXT } from "../sync-chip.js";
import { START_FEN, moveLineHtml, moveTextHtml, walkPathText } from "../move-text.js";
// Train tab rendering (lazy-loaded from app.js).

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

// The tail as move links when the path plays from the start position (each move
// peeks at its position); otherwise the plain tail.
function lineTailHtml(line, plies = 2) {
  const walked = walkPathText(line);
  if (!walked) return lineTail(line, plies);
  const tail = walked.plies.slice(-plies);
  return moveLineHtml(tail[0].fenBefore, tail.map((p) => p.san), tail.map((p) => p.uci), { focusable: false });
}

export function createTrainView({
  appState,
  boards,
  renderSyncChip,
  setTrainBanner,
  updateTrainTurnBadge,
  onStreakRendered,
}) {
  // The coach sub line is clamped to two lines; a tap on the banner shows the
  // rest. The full text also sits in the element title for hover.
  document.getElementById("train-banner")?.addEventListener("click", () => {
    document.getElementById("train-banner-sub")?.classList.toggle("expanded");
  });
  document.getElementById("train-line-path")?.addEventListener("click", (event) => {
    const el = event.currentTarget;
    el.setAttribute("aria-expanded", String(el.getAttribute("aria-expanded") !== "true"));
  });

  function renderTrainSync() {
    const el = document.getElementById("train-sync");
    if (!el) return;
    const quiet = !TRAINING_SYNC_TEXT.includes(appState.trainSyncState);
    renderSyncChip(el, appState.trainSyncState, "training");
    el.hidden = quiet;
    if (quiet) el.textContent = "";
  }

  // One stats line: the run and the misses, first answers only.
  function renderTrainStats() {
    const s = appState.trainStats || { correct: 0, mistakes: 0, streak: 0 };
    onStreakRendered(s.streak);
    const parts = [];
    if (s.streak) parts.push(`${s.streak} in a row`);
    if (s.mistakes) parts.push(`${s.mistakes} missed`);
    document.getElementById("train-stats-line").textContent = parts.join(" · ");
  }

  // The header's one progress figure and the one bar under it.
  function paintProgress(done, total) {
    total = Math.max(1, total);
    document.getElementById("train-line-label").textContent = `${Math.min(done + 1, total)} / ${total}`;
    document.getElementById("train-progress-fill").style.width = `${Math.round((done / total) * 100)}%`;
    const bar = document.getElementById("train-progress");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(Math.max(0, Math.min(done, total))));
  }

  function renderTraining(prompt, { keepBanner = false } = {}) {
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
    if (!keepBanner) setTrainBanner("move", "Your move", "");
    updateTrainTurnBadge(side);
    paintCardKind(null);
    renderLinePath("");
    // Rehearsal has no queue: drop a smart session's "Up next" rows.
    const upnext = document.getElementById("train-upnext");
    if (upnext) upnext.hidden = true;
    paintProgress(prompt.current_index || 0, prompt.total_lines || 1);
    const name = (appState.training && appState.training.repertoire_name) || "Repertoire";
    const color = (appState.training && appState.training.color) || "white";
    document.getElementById("train-board-label").textContent = `${name} · you play ${color}`;
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
      html`<span class="faint">Up next</span>${upcoming
        .map((card) => {
          const kind = smart.cardKinds[card.kind]?.label || card.kind || "";
          const rep = card.repertoire_name || smart.repertoireName || "";
          const dot = card.color === "black" ? "black" : "white";
          // Name the position, never the answer: every card can come back as
          // a recall test.
          // The card for a line's very first move asks about the starting
          // position: its path is empty, so name it instead of leaving the row
          // blank next to the rows that do carry a line. "Start" was the
          // button's word sitting in a row that has no button; this says which
          // position the card is about.
          const line = lineTailHtml(card.targets?.[0]?.line);
          const tail = line
            ? html`<span class="un-line">${line}</span>`
            : html`<span class="un-line is-plain">First move</span>`;
          return (
            html`<div class="un-row"><span class="kchip k-${card.kind || "polish"}">${kind}</span><span class="un-what"><span class="un-rep"><span class="color-dot ${dot}"></span>${rep}</span>${tail}</span></div>`
          );
        })}`;
    // The rows arrive one by one, with the app's shared stagger.
    enterRows(host);
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
    // The path is one control (it expands); its moves only peek.
    el.innerHTML = line ? html`<bdi>${moveTextHtml(line, { fen: START_FEN }, { focusable: false })}</bdi>` : "";
  }

  function renderSmartProgress(prompt) {
    renderLinePath(prompt.target?.line || "");
    paintProgress(prompt.card_index, prompt.total_cards);
    paintCardKind(prompt.kind);
    renderUpNext();
  }

  return {
    renderTrainSync,
    renderTrainStats,
    renderTraining,
    renderSmartProgress,
  };
}
