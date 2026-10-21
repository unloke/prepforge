import { html } from '../html.js';
import { activateModal } from '../core/modals.js';
import { HISTORY_LIMITS, readTrainingHistory, trainingHistoryUsage } from '../train-history.js';
import './train-history.css';

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const modeLabel = run => (run.mode === 'blitz' ? 'Blitz' : 'Smart queue');

// First answers only: retried and demonstrated moves never entered `correct`
// or `mistakes`, and skipped cards were never answered at all.
function score(run) {
  const attempts = run.correct + run.mistakes;
  return { attempts, label: attempts ? `${run.correct} of ${attempts}` : null,
    pct: attempts ? Math.round((run.correct / attempts) * 100) : null };
}

const pctText = scored => (scored.pct === null ? '—' : `${scored.pct}%`);

function runName(run) {
  return run.repertoires.length ? run.repertoires.join(' · ') : 'Smart queue';
}

function lead(run) {
  const scored = score(run);
  const figure = (value, label, attr, cls = '') =>
    html`<div class="th-figure ${cls}"><b ${attr}>${value}</b><span>${label}</span></div>`;
  return html`<section class="th-lead" aria-label="Latest run">
    <div class="th-lead-head"><span class="th-lead-label">Latest</span><span class="th-when">${modeLabel(run)} · <time datetime="${run.finishedAt}">${DATE.format(new Date(run.finishedAt))}</time></span></div>
    <h3 class="th-name" title="${runName(run)}">${runName(run)}</h3>
    <div class="th-figures">
      <div class="th-figure is-lead"><b data-history-first-try>${pctText(scored)}</b><span>${scored.label ? `${scored.label} first try` : 'no first answers'}</span></div>
      ${figure(run.cards, 'cards', 'data-history-cards')}
      ${figure(run.mistakes, 'missed', 'data-history-missed', run.mistakes ? 'is-missed' : '')}
      ${figure(run.skipped, 'skipped', 'data-history-skipped')}
    </div>
  </section>`;
}

const row = run => {
  const scored = score(run);
  return html`<li class="th-run" title="${run.cards} cards · ${scored.label ? `${scored.label} first try` : 'no first answers'} · ${run.mistakes} missed · ${run.skipped} skipped">
    <div class="th-run-main"><b class="th-name" title="${runName(run)}">${runName(run)}</b>
      <span class="th-when">${modeLabel(run)} · <time datetime="${run.finishedAt}">${DATE.format(new Date(run.finishedAt))}</time></span></div>
    <div class="th-run-score"><b>${pctText(scored)}</b><span>${scored.label ? `${scored.label} first try` : 'no first answers'}</span></div>
  </li>`;
};

function body(runs, usage) {
  if (!runs.length) {
    return html`<div class="th-empty"><b>No runs saved yet</b>
      <p>Finish a Smart queue or Blitz session and it lands here.</p></div>`;
  }
  const [latest, ...earlier] = runs;
  return html`${lead(latest)}${earlier.length ? html`<h3 class="th-list-title">Earlier runs</h3>
    <ol class="th-runs">${earlier.map(row)}</ol>` : ''}`;
}

const storageLine = usage => `${usage.runs} of ${HISTORY_LIMITS.runs} runs kept`;

export function openTrainingHistory(ownerId) {
  if (!ownerId) return;
  document.getElementById('training-history-dialog')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'training-history-dialog';
  overlay.className = 'modal-overlay';
  let content, foot;
  try {
    const usage = trainingHistoryUsage(ownerId);
    content = body(readTrainingHistory(ownerId), usage);
    foot = html`<footer class="th-foot"><span title="Older runs drop off as new ones arrive; nothing leaves this browser.">${storageLine(usage)}</span></footer>`;
  } catch {
    content = html`<div class="th-empty is-error" role="alert"><b>History unavailable</b>
      <p>Allow site storage for this site, then reopen History.</p></div>`;
    foot = '';
  }
  overlay.innerHTML = html`<section class="modal training-history" role="dialog" aria-modal="true" aria-labelledby="training-history-title">
    <header class="th-head"><div class="th-titles">
        <h2 class="modal-title" id="training-history-title">Training history</h2>
        <span class="th-scope">Smart queue and Blitz · this browser</span></div>
      <button class="btn sm" type="button" data-close>Close</button></header>
    <div class="th-body">${content}</div>${foot}</section>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });
  activateModal(overlay, { initialFocus: overlay.querySelector('[data-close]') });
}
