import { html } from "./html.js";
import { countOf, nounOf } from "./plural.js";
// What the shared Result card shows for each mode: a title, at most four
// cells, an optional what-changed line and one line of outlook.

const pct = (correct, missed) => (correct + missed ? `${Math.round((correct / (correct + missed)) * 100)}%` : "—");

function tailMoves(line, plies = 2) {
  const tokens = String(line || "").split(" ").filter(Boolean);
  return tokens.slice(Math.max(0, tokens.length - plies)).join(" ");
}

export function missedRecapHtml(items = []) {
  if (!Array.isArray(items) || !items.length) return "";
  return html`<span class="faint">Missed in this run</span>${items.map((item, idx) => {
    const context = item.line ? tailMoves(item.line) : item.repertoireName || "";
    return html`<button type="button" class="train-missed-row" data-missed-index="${idx}">${context ? html`<span class="train-missed-ctx">${context}</span><span class="train-missed-arrow" aria-hidden="true">→</span>` : ""}<b class="train-missed-san">${item.san}</b>${item.line && item.repertoireName ? html`<span class="train-missed-rep">${item.repertoireName}</span>` : ""}</button>`;
  })}`;
}

export function smartResult(smart, stats, after = null) {
  const served = (smart.cardsDone || 0) + (stats.skipped || 0);
  const firstTries = (stats.correct || 0) + (stats.mistakes || 0);
  const cells = [[served, nounOf(served, "card")]];
  if (firstTries) cells.push([pct(stats.correct || 0, stats.mistakes || 0), "first try"]);
  if (stats.learned) cells.push([stats.learned, "learned"]);
  if (firstTries) cells.push([stats.best || 0, "best streak"]);
  if (stats.skipped) cells.push([stats.skipped, "skipped"]);
  const missedTargets = !smart.mixed && smart.repertoireId && smart.missedNodeIds?.length
    ? { repertoireId: smart.repertoireId, targets: [...smart.missedNodeIds] }
    : null;
  const missedItems = Array.isArray(smart.missedItems) ? [...smart.missedItems] : [];
  return {
    mode: "smart",
    title: smart.blitz ? "Blitz complete" : "Queue complete",
    cells: cells.slice(0, 4),
    delta: after?.health && smart.healthBefore ? healthDelta(smart.healthBefore, after.health) : null,
    foot: after ? (after.due_tomorrow > 0 ? `${countOf(after.due_tomorrow, "review")} due tomorrow` : "Nothing due tomorrow") : "",
    missedDrill: missedTargets,
    missedItems,
    recapHtml: missedRecapHtml(missedItems),
  };
}

// One line of what the session moved: only the buckets that changed.
export function healthDelta(before, now) {
  const rows = [["mastered", "Mastered", 1], ["learning", "Learning", 0], ["due", "Due", -1], ["weak", "Weak", -1], ["untrained", "New", -1]]
    .map(([key, label, good]) => {
      const diff = (now[key] || 0) - (before[key] || 0);
      return diff ? { key, label, value: now[key] || 0, diff, tone: diff * good > 0 ? "up" : diff * good < 0 ? "down" : "" } : null;
    })
    .filter(Boolean);
  if (!rows.length) return null;
  return html`${rows.map((r) => html`<span class="tsum-item"><i class="k-${r.key === "untrained" ? "new" : r.key}"></i>${r.label} ${r.value} <b class="${r.tone}">${r.diff > 0 ? "+" : "−"}${Math.abs(r.diff)}</b></span>`)}`;
}

export function drillResult(training, stats) {
  const lines = Number(training?.line_order?.length) || 0;
  const missed = stats.mistakes || 0;
  const targets = training?.missedNodeIds?.length ? training.missedNodeIds : training?.mistakes;
  const missedDrill = training?.repertoire_id && Array.isArray(targets) && targets.length
    ? { repertoireId: training.repertoire_id, targets: [...targets] }
    : null;
  const missedItems = Array.isArray(training?.missedItems) ? [...training.missedItems] : [];
  return {
    mode: "all_lines",
    title: "Rehearsal complete",
    cells: [
      [lines, nounOf(lines, "line")],
      ...((stats.correct || 0) + missed ? [[pct(stats.correct || 0, missed), "first try"], [missed, "missed"]] : []),
      ...(stats.skipped ? [[stats.skipped, "skipped"]] : []),
    ],
    delta: null,
    foot: training?.repertoire_name || "",
    missedDrill,
    missedItems,
    recapHtml: missedRecapHtml(missedItems),
  };
}

// A finished game: how it ended, how far it went, which side you had.
export function playResult(play) {
  const moves = (play.history || []).filter((ply) => ply.by === "user").length;
  const score = play.result && play.result !== "*" ? [[play.result, "result"]] : [];
  return {
    mode: "play",
    title: play.ended || "Game over",
    cells: [...score, [moves, nounOf(moves, "move")], [play.userColor === "black" ? "Black" : "White", "you played"]],
    delta: null,
    foot: play.failure || "",
  };
}
