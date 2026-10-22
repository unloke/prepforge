import { html } from '../html.js';
import { modalDialog, openModal } from '../core/dialog.js';
import { HISTORY_LIMITS, readTrainingHistory } from '../train-history.js';
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
// A run of new moves only has no first answers; it still taught something.
const scoreLabel = (run, scored) =>
  scored.label ? `${scored.label} first try` : run.learned ? `${run.learned} learned` : 'no first answers';

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
      <div class="th-figure is-lead"><b data-history-first-try>${pctText(scored)}</b><span>${scoreLabel(run, scored)}</span></div>
      ${figure(run.cards, 'cards', 'data-history-cards')}
      ${figure(run.mistakes, 'missed', 'data-history-missed', run.mistakes ? 'is-missed' : '')}
      ${figure(run.skipped, 'skipped', 'data-history-skipped')}
    </div>
  </section>`;
}

const row = run => {
  const scored = score(run);
  return html`<li class="th-run" title="${run.cards} cards · ${scoreLabel(run, scored)} · ${run.mistakes} missed · ${run.skipped} skipped">
    <div class="th-run-main"><b class="th-name" title="${runName(run)}">${runName(run)}</b>
      <span class="th-when">${modeLabel(run)} · <time datetime="${run.finishedAt}">${DATE.format(new Date(run.finishedAt))}</time></span></div>
    <div class="th-run-score"><b>${pctText(scored)}</b><span>${scoreLabel(run, scored)}</span></div>
  </li>`;
};

function body(runs) {
  if (!runs.length) {
    return html`<div class="th-empty"><b>No runs saved yet</b>
      <p>Finish a Smart queue or Blitz session and it lands here.</p></div>`;
  }
  const [latest, ...earlier] = runs;
  return html`${lead(latest)}${earlier.length ? html`<h3 class="th-list-title">Earlier runs</h3>
    <ol class="th-runs">${earlier.map(row)}</ol>` : ''}`;
}

// The count that is actually there. When the byte bound is what stopped the
// list, "N of 100" would promise slots the account can never fill, so the
// footer states the count and the rule behind it lives in the tooltip.
const storageLine = count => `${count} saved run${count === 1 ? '' : 's'}`;
const retentionNote = `Keeps up to ${HISTORY_LIMITS.runs} recent runs within ${Math.round(HISTORY_LIMITS.bytes / 1024)} KiB in this browser`;

export function openTrainingHistory(ownerId) {
  if (!ownerId) return;
  document.getElementById('training-history-dialog')?.remove();
  const overlay = modalDialog('training-history', { id: 'training-history-dialog' });
  let content, foot;
  try {
    const runs = readTrainingHistory(ownerId);
    content = body(runs);
    foot = html`<footer class="th-foot"><span title="${retentionNote}">${storageLine(runs.length)}</span></footer>`;
  } catch {
    content = html`<div class="th-empty is-error" role="alert"><b>History unavailable</b>
      <p>Allow site storage for this site, then reopen History.</p></div>`;
    foot = '';
  }
  overlay.innerHTML = html`<header class="th-head"><div class="th-titles">
        <h2 class="modal-title" id="training-history-title">Training history</h2>
        <span class="th-scope">Smart queue and Blitz · this browser</span></div>
      <button class="btn sm" type="button" data-close>Close</button></header>
    <div class="th-body">${content}</div>${foot}`;
  const close = openModal(overlay, { initialFocus: overlay.querySelector('[data-close]') });
  overlay.querySelector('[data-close]').addEventListener('click', () => close());
}
