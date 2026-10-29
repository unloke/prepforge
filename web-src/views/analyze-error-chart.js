import { html } from "../html.js";

const WORD = { white: "White", black: "Black", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder", missed: "Missed win" };
const fractionOf = (report, ply) => (ply - report.from) / Math.max(1, report.to - report.from);
const heightOf = (row, maxLoss) => (row.loss ?? 0) / maxLoss * 42;
const labelOf = (row) => `${WORD[row.side]} ${row.label} · ${WORD[row.grade]}${row.loss == null ? " · loss unavailable" : ` · ${Math.round(row.loss)}% winning chances lost`}`;

// A shared move axis: White's losses rise, Black's fall. Position is loss;
// colour and shape are grade. Details appear on demand in one stable readout.
export function errorChartHtml(report) {
  if (!report.errors.length) return html`<section class="rp-sec"><h3 class="rp-h">Errors</h3><span class="rp-no-errors">No errors</span></section>`;
  const maxLoss = Math.max(10, Math.ceil(Math.max(...report.errors.map((r) => r.loss ?? 0)) / 10) * 10);
  const firstMove = Math.ceil(report.from / 2), lastMove = Math.ceil(report.to / 2);
  const middleMove = Math.floor((firstMove + lastMove) / 2);
  return html`<section class="rp-sec rp-errors"><div class="rp-sec-head"><h3 class="rp-h">Errors</h3><button type="button" class="rp-error-key" popovertarget="rp-errors-key" aria-label="Chart key"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5m0-8v1"/></svg></button></div>
    <div class="rp-error-key-content" id="rp-errors-key" popover>
      <span><i class="rp-disc rp-white"></i>White ↑<i class="rp-disc rp-black"></i>Black ↓</span><span>→ Move<span class="rp-key-loss">↕ Winning chances lost</span></span>
      <span class="rp-error-key-grades"><i class="rp-error-stone g-inaccuracy"></i> Inaccuracy<i class="rp-error-stone g-mistake"></i> Mistake<i class="rp-error-stone g-blunder"></i> Blunder${report.errors.some((r) => r.grade === "missed") ? html`<i class="rp-error-stone g-missed"></i> Missed win` : ""}</span>
    </div><div class="rp-error-chart" role="group" aria-label="${`Errors by move and winning chances lost, shared scale 0 to ${maxLoss}%`}"><div class="rp-error-plot">
    <svg class="rp-error-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 8H100M0 92H100"/><path class="rp-error-axis-line" d="M0 50H100"/></svg>
    <i class="rp-disc rp-white rp-error-side-white" title="White" aria-label="White"></i><i class="rp-disc rp-black rp-error-side-black" title="Black" aria-label="Black"></i>
    <span class="rp-error-scale rp-error-scale-white" aria-hidden="true">${maxLoss}%</span><span class="rp-error-scale rp-error-scale-black" aria-hidden="true">${maxLoss}%</span>
    <i class="rp-error-cursor" hidden></i>
    ${report.errors.map((row) => html`<button type="button" class="rp-error rp-error-${row.side} g-${row.grade}${row.loss == null ? " is-unknown" : ""}" style="left:${fractionOf(report, row.ply) * 100}%;top:${50 + (row.side === "white" ? -1 : 1) * heightOf(row, maxLoss)}%" data-ply="${row.ply}" data-km-ply="${row.ply}" aria-label="${labelOf(row)}"><i class="rp-error-stone" aria-hidden="true"></i></button>`)}
    <div class="rp-error-moves" aria-hidden="true"><span style="left:0%">${firstMove}</span>${middleMove > firstMove && middleMove < lastMove ? html`<span style="left:${fractionOf(report, middleMove * 2 - 1) * 100}%">${middleMove}</span>` : ""}${lastMove > firstMove ? html`<span style="left:100%">${lastMove}</span>` : ""}</div>
    </div><output class="rp-error-readout" hidden></output></div></section>`;
}

export function bindErrorChart(host, report, onJump, onPeek = () => {}) {
  const chart = host.querySelector?.(".rp-error-chart");
  if (!chart) return;
  const readout = chart.querySelector("output");
  const cursor = chart.querySelector(".rp-error-cursor");
  const plot = chart.querySelector(".rp-error-plot");
  const markers = [...chart.querySelectorAll(".rp-error")];
  let activePly = null;
  let previewPly = null;
  const rowOf = (target) => report.errors.find((r) => r.ply === Number(target?.closest?.(".rp-error")?.dataset.ply));
  const show = (row, preview = true) => {
    if (preview && previewPly !== row.ply) {
      previewPly = row.ply;
      onPeek(row.ply);
    }
    if (activePly === row.ply) return;
    activePly = row.ply;
    readout.innerHTML = html`<i class="rp-disc rp-${row.side}" aria-hidden="true"></i><b>${row.label}</b><span class="g-${row.grade}">${WORD[row.grade]}</span><span>${row.loss == null ? "–" : `−${Math.round(row.loss)}%`}</span>`;
    readout.setAttribute("aria-label", labelOf(row));
    readout.hidden = false;
    cursor.style.left = `${fractionOf(report, row.ply) * 100}%`;
    cursor.hidden = false;
    markers.forEach((el) => el.classList.toggle("is-hovered", Number(el.dataset.ply) === row.ply));
  };
  const hide = () => {
    endPeek();
    activePly = null;
    readout.hidden = cursor.hidden = true;
    markers.forEach((el) => el.classList.remove("is-hovered"));
  };
  const endPeek = () => {
    if (previewPly == null) return;
    previewPly = null;
    onPeek(null);
  };
  // The whole plot scrubs the timeline, including the space between markers.
  // Use the shared move axis so vertical movement cannot flip between players.
  const nearest = (event) => {
    const bounds = plot.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    let best = null, distance = Infinity;
    for (const row of report.errors) {
      const d = Math.abs(x - fractionOf(report, row.ply));
      if (d < distance) { best = row; distance = d; }
    }
    return best;
  };
  chart.onpointermove = (event) => {
    if (event.pointerType === "touch") return;
    const row = nearest(event);
    if (row) show(row); else hide();
  };
  chart.onpointerleave = () => {
    const row = rowOf(chart.querySelector(":focus-visible"));
    if (row) show(row, previewPly != null); else hide();
  };
  chart.onclick = (event) => {
    const row = event.detail === 0 ? rowOf(event.target) : nearest(event);
    if (row) {
      if (event.detail !== 0) markers.find((el) => Number(el.dataset.ply) === row.ply).focus({ preventScroll: true });
      endPeek();
      show(row, false);
      onJump(row.ply);
    }
    event.stopPropagation();
  };
  chart.addEventListener("focusin", (event) => { const row = rowOf(event.target); if (row) show(row, event.target.matches?.(":focus-visible")); });
  chart.addEventListener("focusout", (event) => { if (!rowOf(event.relatedTarget)) hide(); });
  // Navigation belongs to the page's current board position, not marker focus
  // (which can stay behind after Home/End). Buttons keep native Enter/Space.
  chart.onkeydown = (event) => {
    if (event.key === "Escape") hide();
  };
  return hide;
}
