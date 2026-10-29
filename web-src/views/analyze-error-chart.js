import { html } from "../html.js";

const WORD = { white: "White", black: "Black", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder", missed: "Missed win" };
const MARK = { inaccuracy: "?!", mistake: "?", blunder: "??", missed: "×" };
const fractionOf = (report, ply) => report.errors.length === 1 ? 0.5 : report.errors.findIndex((row) => row.ply === ply) / (report.errors.length - 1);
const labelOf = (row) => `${WORD[row.side]} ${row.label} · ${WORD[row.grade]}${row.loss == null ? " · loss unavailable" : ` · ${Math.round(row.loss)}% winning chances lost`}`;

// An ordered trail of mistakes, not an unlabelled numeric plot. Familiar chess
// annotations carry grade; the two lanes carry player. Exact loss is on demand.
export function errorChartHtml(report) {
  if (!report.errors.length) return html`<section class="rp-sec"><h3 class="rp-h">Errors</h3><span class="rp-no-errors">No errors</span></section>`;
  return html`<section class="rp-sec rp-errors"><div class="rp-sec-head"><h3 class="rp-h">Errors</h3><button type="button" class="rp-error-key" popovertarget="rp-errors-key" aria-label="Chart key"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5m0-8v1"/></svg></button></div>
    <div class="rp-error-key-content" id="rp-errors-key" popover>
      <span><i class="rp-disc rp-white"></i>White<i class="rp-disc rp-black"></i>Black</span><span>Errors in move order →</span>
      <span class="rp-error-key-grades">${Object.entries(MARK).filter(([grade]) => grade !== "missed" || report.errors.some((r) => r.grade === grade)).map(([grade, mark]) => html`<i class="rp-error-stone g-${grade}" aria-hidden="true">${mark}</i>${WORD[grade]}`)}</span>
    </div><div class="rp-error-chart" role="group" aria-label="Errors in move order, White above and Black below">
    <i class="rp-disc rp-white rp-error-side-white" title="White" aria-label="White"></i><i class="rp-disc rp-black rp-error-side-black" title="Black" aria-label="Black"></i>
    <div class="rp-error-scroll"><div class="rp-error-plot" style="min-width:${Math.max(0, report.errors.length - 1) * 44}px">
    <i class="rp-error-cursor" hidden></i>
    ${report.errors.map((row) => html`<button type="button" class="rp-error rp-error-${row.side} g-${row.grade}" style="left:${fractionOf(report, row.ply) * 100}%;top:${row.side === "white" ? 25 : 75}%" data-ply="${row.ply}" data-km-ply="${row.ply}" aria-label="${labelOf(row)}"><i class="rp-error-stone" aria-hidden="true">${MARK[row.grade]}</i></button>`)}
    </div></div><output class="rp-error-readout" hidden></output></div></section>`;
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
    readout.innerHTML = html`<i class="rp-disc rp-${row.side}" aria-hidden="true"></i><b>${row.label}</b><span class="g-${row.grade}">${MARK[row.grade]}</span><span>${row.loss == null ? "–" : `−${Math.round(row.loss)}%`}</span>`;
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
  // Scrub the ordered trail, including gaps. Every event owns one column;
  // vertical motion cannot accidentally switch between adjacent players.
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
