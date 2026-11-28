import { html } from "../html.js";
import { pieceSvg } from "../board/ui.js";

// Train-shaped practice strip for Analyze's mistake retry. The session owns
// grading and navigation; this only composes its current state.
export function retryPracticeControls(session) {
  const item = session.item;
  const total = session.sequence.length;
  const complete = session.phase === "complete";
  const progress = complete ? total : session.index + (session.phase === "success" ? 1 : 0);
  const count = `${Math.min(session.index + 1, total)} / ${total}`;
  const state = complete
    ? "done"
    : session.phase === "checking" || session.phase === "loading"
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
  if (complete) title = "Practice complete";
  else if (session.phase === "checking") title = session.feedback || "Checking that move…";
  else if (session.phase === "success" || session.phase === "revealed") title = session.feedback;
  else if (session.mistake) title = session.feedback;
  const side = item.side === "black" ? "black" : "white";
  const turn = !complete && session.phase === "guess"
    ? html`<span class="train-turn-badge" data-side="${side}" role="img" aria-label="${side === "white" ? "White" : "Black"} to move" title="${side === "white" ? "White" : "Black"} to move">${pieceSvg(side === "white" ? "K" : "k")}</span>`
    : "";
  let action = "";
  if (session.phase === "revealed") {
    action = html`<button type="button" class="btn sm" data-review="continue">Continue</button>`;
  } else if (session.phase === "guess" || session.phase === "checking") {
    action = html`<button type="button" class="btn sm" data-review="show-move">Show move</button>`;
  }
  return html`
    <header class="train-head cr-practice-head">
      <button type="button" class="btn ghost sm train-back" data-review="${complete ? "back-analysis" : "exit"}" aria-label="Back to analysis" title="Back to analysis">
        <svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Analyze</span>
      </button>
      <div class="train-head-main">
        <span class="train-head-mode">Retry</span>
        ${item.kind === "prep" && state === "move" ? html`<span class="train-scope-chip">Repertoire</span>` : ""}
      </div>
      <span class="train-count">${count}</span>
    </header>
    <div class="prog train-head-prog cr-practice-prog" role="progressbar" aria-label="Practice progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${progress}"><i style="width: ${total ? progress / total * 100 : 0}%"></i></div>
    <section class="coach-banner train-coach cr-practice-coach" data-state="${state}" aria-live="polite">
      <span class="train-coach-icon" aria-hidden="true"></span>
      <div class="train-coach-text">
        <span class="train-coach-title">${title}</span>
        <span class="train-coach-sub"></span>
      </div>
      ${turn}
    </section>
    ${action ? html`<div class="cr-practice-action">${action}</div>` : ""}`;
}
