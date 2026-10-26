// The engine pane while the live engine is off: the analysis run's own line for
// the shown position (its eval, the moves as move links, the depth), the way
// Lichess shows its server line before the local engine starts. The run already
// saved it (position_evals), so nothing is computed but the line's SAN.
import { Chess } from "chess.js";
import { html } from "../html.js";
import { moveLineHtml } from "../move-text.js";
import { formatEval } from "./analyze-report.js";

const PV_SHOWN = 8;

// The eval as the figure over the board prints it ("−0.64"); mates and won
// positions as the report reads them.
function evalText(ev) {
  const cp = ev.score_cp;
  if (ev.mate_in != null || cp == null || Math.abs(cp) >= 10000) return formatEval(ev);
  return `${cp > 0 ? "+" : cp < 0 ? "−" : ""}${Math.abs(cp / 100).toFixed(2)}`;
}

function sanLine(fen, ucis) {
  const sans = [];
  try {
    const board = new Chess(fen);
    for (const uci of ucis) {
      const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
      if (!move) break;
      sans.push(move.san);
    }
  } catch (_) {
    /* an illegal step ends the line where it stood */
  }
  return sans;
}

/** The saved line for `fen` as markup, or "" when the run has none there. */
export function savedLineHtml(evals, fen) {
  const ev = fen && evals ? evals[fen] : null;
  const ucis = Array.isArray(ev?.pv) ? ev.pv.slice(0, PV_SHOWN) : [];
  if (!ev || !ucis.length) return "";
  const sans = sanLine(fen, ucis);
  if (!sans.length) return "";
  return html`<b class="sl-eval">${evalText(ev)}</b><span class="sl-pv">${moveLineHtml(fen, sans, ucis)}</span><span class="sl-depth" title="Search depth">d${ev.depth ?? "–"}</span>`;
}

/** Paint the shown position's saved line into #analysis-saved-line. */
export function paintSavedLine(appState) {
  const host = typeof document !== "undefined" && document.getElementById("analysis-saved-line");
  if (!host) return;
  const node = appState.analysisTree?.byId?.get(appState.analysisCurrentNodeId || "root");
  const markup = savedLineHtml(appState.analysis?.position_evals, node?.fenAfter);
  host.innerHTML = markup;
  host.hidden = !markup;
}
