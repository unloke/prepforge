import { html } from "../html.js";

const WORD = { white: "White", black: "Black", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder", missed: "Missed win" };
const X0 = 8, X1 = 632, MID = 62, HEIGHT = 46;
const xOf = (report, ply) => X0 + (ply - report.from) / Math.max(1, report.to - report.from) * (X1 - X0);
const labelOf = (row) => `${WORD[row.side]} ${row.label} · ${WORD[row.grade]}${row.loss == null ? "" : ` · ${Math.round(row.loss)}% winning chances lost`}`;

// The shared move axis and opposite player lanes follow Lichess's analysis
// and move-time charts. Height measures win-chance loss on a fixed 0–100 scale.
export function errorChartHtml(report) {
  if (!report.errors.length) return html`<section class="rp-sec"><h3 class="rp-h">Errors</h3><span class="rp-no-errors">No errors</span></section>`;
  return html`<section class="rp-sec rp-errors"><h3 class="rp-h">Errors</h3><div class="rp-error-chart"><svg viewBox="0 0 640 140" preserveAspectRatio="none" role="group" aria-label="Errors by player and winning chances lost">
    <path class="rp-error-grid" d="M8 16H632M8 62H632M8 108H632"/>
    ${report.errors.map((row) => {
      const x = xOf(report, row.ply);
      const height = row.loss == null ? 0 : row.loss / 100 * HEIGHT;
      const y = row.side === "white" ? MID - height : MID;
      return html`<g class="rp-error rp-error-${row.side} g-${row.grade}" role="button" tabindex="0" data-ply="${row.ply}" data-km-ply="${row.ply}" aria-label="${labelOf(row)}"><title>${labelOf(row)}</title><rect class="rp-error-hit" x="${x - 7}" y="${row.side === "white" ? 12 : 62}" width="14" height="50"/><rect class="rp-error-bar" x="${x - 2}" y="${y}" width="4" height="${height}"/><circle class="rp-error-point" cx="${x}" cy="${row.side === "white" ? y : MID + height}" r="3"/></g>`;
    })}
    </svg><i class="rp-disc rp-lane-white" title="White" aria-label="White"></i><i class="rp-disc rp-black rp-lane-black" title="Black" aria-label="Black"></i><output class="rp-error-readout" hidden></output></div></section>`;
}

export function bindErrorChart(host, report, onJump) {
  const chart = host.querySelector?.(".rp-error-chart");
  if (!chart) return;
  const readout = chart.querySelector("output");
  const show = (row) => {
    readout.textContent = labelOf(row);
    readout.hidden = false;
    chart.querySelectorAll(".rp-error").forEach((el) => el.classList.toggle("is-hovered", Number(el.dataset.ply) === row.ply));
  };
  const nearest = (event) => {
    const bounds = chart.querySelector("svg").getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 640;
    const side = (event.clientY - bounds.top) / bounds.height * 140 < MID ? "white" : "black";
    const rows = report.errors.filter((r) => r.side === side);
    return rows.reduce((best, row) => !best || Math.abs(xOf(report, row.ply) - x) < Math.abs(xOf(report, best.ply) - x) ? row : best, null);
  };
  chart.onpointermove = (event) => { const row = nearest(event); if (row) show(row); };
  chart.onpointerleave = () => {
    readout.hidden = true;
    chart.querySelectorAll(".is-hovered").forEach((el) => el.classList.remove("is-hovered"));
  };
  chart.onclick = (event) => {
    const row = nearest(event);
    if (row) { show(row); onJump(row.ply); }
    event.stopPropagation();
  };
  chart.onfocusin = (event) => {
    const row = report.errors.find((r) => r.ply === Number(event.target.dataset.ply));
    if (row) show(row);
  };
  chart.onfocusout = chart.onpointerleave;
  chart.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const ply = Number(event.target.dataset.ply);
    if (report.errors.some((r) => r.ply === ply)) { event.preventDefault(); onJump(ply); }
  };
}
