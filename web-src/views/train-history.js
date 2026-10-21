import { html } from '../html.js';
import { activateModal } from '../core/modals.js';
import { readTrainingHistory } from '../train-history.js';
import './train-history.css';

export function openTrainingHistory(ownerId) {
  if (!ownerId) return;
  document.getElementById('training-history-dialog')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'training-history-dialog';
  overlay.className = 'modal-overlay';
  let content;
  try {
    const runs = readTrainingHistory(ownerId);
    content = runs.length ? html`<ol class="training-history-list">${runs.map(run => {
      const attempts = run.correct + run.mistakes;
      const firstTry = attempts ? `${run.correct}/${attempts}` : '—';
      return html`<li class="training-history-row">
        <div class="training-history-session"><b>${run.repertoires.join(' · ') || 'Smart queue'}</b>
          <span>${run.mode === 'blitz' ? 'Blitz' : 'Smart queue'}</span>
          <time datetime="${run.finishedAt}">${new Date(run.finishedAt).toLocaleString()}</time></div>
        <dl><div><dt>Cards</dt><dd>${run.cards}</dd></div><div><dt title="First answers; demonstrated and skipped moves are excluded">First try</dt><dd>${firstTry}</dd></div>
          <div><dt>Mistakes</dt><dd>${run.mistakes}</dd></div><div><dt>Skipped</dt><dd>${run.skipped}</dd></div></dl>
      </li>`;
    })}</ol>` : html`<div class="empty-state">Complete a Smart queue session to add your first record.</div>`;
  } catch {
    content = html`<p role="alert">History unavailable. Allow site storage, then reopen History.</p>`;
  }
  overlay.innerHTML = html`<section class="modal training-history" role="dialog" aria-modal="true" aria-labelledby="training-history-title">
    <header class="training-history-head"><div><h2 class="modal-title" id="training-history-title">Smart queue history</h2><span class="muted">This browser</span></div>
      <button class="btn sm" type="button" data-close>Close</button></header>${content}</section>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });
  activateModal(overlay, { initialFocus: overlay.querySelector('[data-close]') });
}
