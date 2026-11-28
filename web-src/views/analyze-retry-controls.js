import { html } from "../html.js";
import { pieceSvg } from "../board/ui.js";
import { GRADE_WORD, retryStats } from "../analyze-retry.js";

function pipStateFor(session, idx) {
  const saved = session.outcomes[idx];
  if (session.phase === "complete") return saved || "clean";
  if (idx < session.index) return saved || "clean";
  if (idx > session.index) return saved || "pending";
  if (session.phase === "success") return saved || "clean";
  if (session.phase === "revealed") return "missed";
  return "active";
}

function progressBarHtml(session, total, progress) {
  if (total > 0 && total <= 16) {
    const pips = session.sequence.map((_, idx) => html`<i class="cr-pip" data-pip="${pipStateFor(session, idx)}"></i>`);
    return html`<div class="prog train-head-prog cr-practice-prog is-segmented" style="--n: ${total}" role="progressbar" aria-label="Practice progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${progress}">${pips}</div>`;
  }
  return html`<div class="prog train-head-prog cr-practice-prog" role="progressbar" aria-label="Practice progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${progress}"><i style="width: ${total ? (progress / total) * 100 : 0}%"></i></div>`;
}

function scopeChipHtml(session) {
  const item = session.item;
  if (item.kind === "prep") {
    return html`<span class="train-scope-chip">${item.repName || "Repertoire"}</span>`;
  }
  const word = GRADE_WORD[item.grade] || "Mistake";
  return html`<span class="train-scope-chip cr-grade-chip g-${item.grade || "mistake"}">${item.label ? `${item.label} · ${word}` : word}</span>`;
}

function prepActionHtml(session) {
  return html`<button type="button" class="btn ghost sm" data-review="train-prep"${session.prepSaved || session.prepSaving ? " disabled" : ""}>${session.prepSaved ? "Added to Train" : session.prepSaving ? "Saving…" : "Add to training"}</button>`;
}

function actionsHtml(session, total) {
  const item = session.item;
  const busy = session.phase === "checking";
  if (session.phase === "guess" || busy) {
    const canSkip = session.index + 1 < total;
    return html`
      <button type="button" class="btn ghost sm" data-review="hint"${session.hintLevel >= 1 || busy ? " disabled" : ""}>Hint</button>
      <button type="button" class="btn sm" data-review="show-move"${busy ? " disabled" : ""}>Show move</button>
      ${canSkip ? html`<button type="button" class="btn ghost sm" data-review="skip"${busy ? " disabled" : ""}>Skip</button>` : ""}`;
  }
  if (session.phase === "revealed") {
    const prepBtn = item.kind === "prep" && session.canTrainPrep && item.repId && item.prescribedNodeId ? prepActionHtml(session) : "";
    const followBtn = session.followSteps?.length > 1
      ? html`<button type="button" class="btn sm" data-review="follow-up"${session.followingUp ? " disabled" : ""}>${session.followingUp ? "Playing…" : "Follow-up"}</button>`
      : "";
    return html`${prepBtn}${followBtn}<button type="button" class="btn primary sm" data-review="continue">Continue</button>`;
  }
  return "";
}

const OUTCOME_LABEL = { clean: "First try", recovered: "Recovered", missed: "Missed" };
const OUTCOME_GLYPH = { clean: "✓", recovered: "↺", missed: "×" };

function recapRowsHtml(session) {
  return session.sequence.map((item, idx) => {
    const outcome = session.outcomes[idx] || "clean";
    const bestSan = item.kind === "prep"
      ? (item.answers || []).map((a) => a.san).join(" / ")
      : item.answers?.[0]?.san || "";
    const meta = item.kind === "prep"
      ? item.repName || "Repertoire"
      : GRADE_WORD[item.grade] || "Mistake";
    const selected = session.inspectIndex === idx ? " is-selected" : "";
    return html`
      <button type="button" class="cr-recap-row${selected}" data-review="inspect" data-index="${idx}" aria-pressed="${session.inspectIndex === idx ? "true" : "false"}" title="${OUTCOME_LABEL[outcome]} · inspect on board">
        <span class="cr-recap-mark" data-outcome="${outcome}" aria-hidden="true">${OUTCOME_GLYPH[outcome]}</span>
        <span class="cr-recap-moves"><span class="cr-recap-played">${item.label}</span><span class="cr-recap-arrow" aria-hidden="true">→</span><b class="cr-recap-best">${bestSan}</b></span>
        <span class="cr-recap-meta">${meta}</span>
      </button>`;
  });
}

function completeSummaryHtml(session, total) {
  const stats = retryStats(session);
  const prepBtn = stats.prepTarget && session.canTrainPrep ? prepActionHtml(session) : "";
  const cells = [
    html`<span><b>${stats.clean} / ${total}</b> first try</span>`,
    ...(stats.recovered ? [html`<span class="sum-sep">·</span><span><b>${stats.recovered}</b> recovered</span>`] : []),
    ...(stats.missed ? [html`<span class="sum-sep">·</span><span><b>${stats.missed}</b> missed</span>`] : []),
  ];
  const primary = stats.retryable.length
    ? html`<button type="button" class="btn ghost sm" data-review="retry-all">Again</button><button type="button" class="btn primary sm" data-review="retry-missed">Retry missed (${stats.retryable.length})</button>`
    : html`<button type="button" class="btn ghost sm" data-review="retry-all">Again</button><button type="button" class="btn primary sm" data-review="back-analysis">Done</button>`;
  return html`
    <header class="train-head cr-practice-head">
      <button type="button" class="btn ghost sm train-back" data-review="back-analysis" aria-label="Back to analysis" title="Back to analysis">
        <svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Analyze</span>
      </button>
      <div class="train-head-main">
        <span class="train-head-mode">Retry</span>
        ${session.round > 1 ? html`<span class="train-scope-chip">Round ${session.round}</span>` : ""}
      </div>
      <span class="train-count">${total} / ${total}</span>
    </header>
    ${progressBarHtml(session, total, total)}
    <section class="cr-summary" data-state="done" aria-live="polite">
      <div class="cr-summary-head">
        <h3 class="train-summary-title">Practice complete</h3>
        <p class="sum-line">${cells}</p>
      </div>
      <div class="cr-recap" role="group" aria-label="Reviewed positions">${recapRowsHtml(session)}</div>
      <div class="cr-practice-action">${prepBtn}${primary}</div>
    </section>`;
}

// Practice strip & dedicated completion recap for Analyze Retry (analyze-retry.js).
export function retryPracticeControls(session) {
  const item = session.item;
  const total = session.sequence.length;
  if (session.phase === "complete") return completeSummaryHtml(session, total);
  const progress = session.index + (session.phase === "success" ? 1 : 0);
  const count = `${Math.min(session.index + 1, total)} / ${total}`;
  const state = session.phase === "checking" || session.phase === "loading"
    ? "runin"
    : session.phase === "success"
      ? "correct"
      : session.phase === "revealed"
        ? "reveal"
        : session.mistake
          ? "wrong"
          : "move";
  const question = item.kind === "prep" ? "Which move did you prepare here?" : "What would you play here?";
  let title = question;
  if (session.phase === "checking") title = session.feedback || "Checking that move…";
  else if (session.phase === "success" || session.phase === "revealed") title = session.feedback;
  else if (session.mistake) title = session.feedback;
  const side = item.side === "black" ? "black" : "white";
  const turn = session.phase === "guess"
    ? html`<span class="train-turn-badge" data-side="${side}" role="img" aria-label="${side === "white" ? "White" : "Black"} to move" title="${side === "white" ? "White" : "Black"} to move">${pieceSvg(side === "white" ? "K" : "k")}</span>`
    : "";
  const action = actionsHtml(session, total);
  const modeTitle = session.round > 1 ? `Retry · Round ${session.round}` : "Retry";
  return html`
    <header class="train-head cr-practice-head">
      <button type="button" class="btn ghost sm train-back" data-review="exit" aria-label="Back to analysis" title="Back to analysis">
        <svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Analyze</span>
      </button>
      <div class="train-head-main">
        <span class="train-head-mode">${modeTitle}</span>
        ${scopeChipHtml(session)}
      </div>
      <span class="train-count">${count}</span>
    </header>
    ${progressBarHtml(session, total, progress)}
    <section class="coach-banner train-coach cr-practice-coach" data-state="${state}" aria-live="polite">
      <span class="train-coach-icon" aria-hidden="true"></span>
      <div class="train-coach-text">
        <span class="train-coach-title">${title}</span>
        <span class="train-coach-sub">${session.sub || ""}</span>
      </div>
      ${turn}
    </section>
    ${action ? html`<div class="cr-practice-action">${action}</div>` : ""}`;
}
