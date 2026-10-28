import { html } from "../html.js";

const WORD = { white: "White", black: "Black", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder", missed: "Missed win" };
const fractionOf = (report, ply) => (ply - report.from) / Math.max(1, report.to - report.from);
const heightOf = (row, maxLoss) => (row.loss ?? 0) / maxLoss * 42;
const labelOf = (row) => `${WORD[row.side]} ${row.label} · ${WORD[row.grade]}${row.loss == null ? " · loss unavailable" : ` · ${Math.round(row.loss)}% winning chances lost`}`;

// Fox's review uses the game's own black/white stones and a shared move axis.
// White rises and Black falls from one move axis. Distance is measured loss;
// the stone identifies the player and the coloured fin carries the grade.
export function errorChartHtml(report) {
  if (!report.errors.length) return html`<section class="rp-sec"><h3 class="rp-h">Errors</h3><span class="rp-no-errors">No errors</span></section>`;
  const maxLoss = Math.max(10, Math.ceil(Math.max(...report.errors.map((r) => r.loss ?? 0)) / 10) * 10);
  return html`<section class="rp-sec rp-errors"><div class="rp-sec-head"><h3 class="rp-h">Errors</h3><button type="button" class="rp-error-key" popovertarget="rp-errors-key" aria-label="Chart key"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5m0-8v1"/></svg></button></div>
    <div class="rp-error-key-content" id="rp-errors-key" popover>
      <span><i class="rp-disc rp-white"></i>White ↑<i class="rp-disc rp-black"></i>Black ↓</span><span>→ Move number</span><span>↕ Winning chances lost</span>
      <span class="rp-error-key-grades"><b class="g-inaccuracy">?!</b> Inaccuracy<b class="g-mistake">?</b> Mistake<b class="g-blunder">??</b> Blunder${report.errors.some((r) => r.grade === "missed") ? html`<b class="g-missed">×</b> Missed win` : ""}</span>
    </div><div class="rp-error-chart" role="group" aria-label="${`Errors by move and winning chances lost, shared scale 0 to ${maxLoss}%`}"><div class="rp-error-plot">
    <svg class="rp-error-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 8H100M0 92H100"/><path class="rp-error-axis-line" d="M0 50H100"/></svg>
    <i class="rp-disc rp-white rp-error-side-white" title="White" aria-label="White"></i><i class="rp-disc rp-black rp-error-side-black" title="Black" aria-label="Black"></i>
    ${report.errors.map((row) => html`<i class="rp-error-fin rp-error-${row.side} g-${row.grade}" style="left:${fractionOf(report, row.ply) * 100}%;height:${heightOf(row, maxLoss)}%" aria-hidden="true"></i>`)}
    <i class="rp-error-cursor" hidden></i>
    ${report.errors.map((row) => html`<button type="button" class="rp-error rp-error-${row.side} g-${row.grade}${row.loss == null ? " is-unknown" : ""}" style="left:${fractionOf(report, row.ply) * 100}%;top:${50 + (row.side === "white" ? -1 : 1) * heightOf(row, maxLoss)}%" data-ply="${row.ply}" data-km-ply="${row.ply}" aria-label="${labelOf(row)}"><i class="rp-error-stone" aria-hidden="true"></i></button>`)}
    </div><output class="rp-error-readout" hidden></output></div></section>`;
}

export function bindErrorChart(host, report, onJump) {
  const chart = host.querySelector?.(".rp-error-chart");
  if (!chart) return;
  const readout = chart.querySelector("output");
  const cursor = chart.querySelector(".rp-error-cursor");
  const markers = [...chart.querySelectorAll(".rp-error")];
  const rowOf = (target) => report.errors.find((r) => r.ply === Number(target?.closest?.(".rp-error")?.dataset.ply));
  const show = (row) => {
    readout.innerHTML = html`<i class="rp-disc rp-${row.side}" aria-hidden="true"></i><b>${row.label}</b><span class="g-${row.grade}">${WORD[row.grade]}</span><span>${row.loss == null ? "–" : `−${Math.round(row.loss)}%`}</span>`;
    readout.setAttribute("aria-label", labelOf(row));
    readout.hidden = false;
    cursor.style.left = `${fractionOf(report, row.ply) * 100}%`;
    cursor.hidden = false;
    markers.forEach((el) => el.classList.toggle("is-hovered", Number(el.dataset.ply) === row.ply));
  };
  const hide = () => {
    readout.hidden = cursor.hidden = true;
    markers.forEach((el) => el.classList.remove("is-hovered"));
  };
  // Resolve overlapping 44px targets by distance to the actual stone, so a
  // later button cannot steal a nearby move's pointer/touch event.
  const nearest = (event) => {
    let best = null, distance = 22;
    for (const marker of markers) {
      const b = marker.getBoundingClientRect();
      const d = Math.hypot(event.clientX - b.left - b.width / 2, event.clientY - b.top - b.height / 2);
      if (d <= distance) { best = marker; distance = d; }
    }
    return rowOf(best);
  };
  chart.onpointermove = (event) => {
    const row = nearest(event) || rowOf(chart.querySelector(":focus"));
    if (row) show(row); else hide();
  };
  chart.onpointerleave = () => {
    const row = rowOf(chart.querySelector(":focus"));
    if (row) show(row); else hide();
  };
  chart.onclick = (event) => {
    const row = event.detail === 0 ? rowOf(event.target) : nearest(event);
    if (row) { show(row); onJump(row.ply); }
    event.stopPropagation();
  };
  chart.addEventListener("focusin", (event) => { const row = rowOf(event.target); if (row) show(row); });
  chart.addEventListener("focusout", (event) => { if (!rowOf(event.relatedTarget)) hide(); });
  chart.onkeydown = (event) => {
    if (event.key === "Escape") hide();
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const index = markers.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = markers[(index + (event.key === "ArrowLeft" ? markers.length - 1 : 1)) % markers.length];
    next.focus();
    onJump(Number(next.dataset.ply));
  };
}
