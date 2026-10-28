import { html } from "./html.js";
import { countOf, nounOf } from "./plural.js";
// What the shared Result card shows for each mode: a title, at most four
// cells, an optional what-changed line and one line of outlook.

const pct = (correct, missed) => (correct + missed ? `${Math.round((correct / (correct + missed)) * 100)}%` : "—");

export function smartResult(smart, stats, after = null) {
  const served = (smart.cardsDone || 0) + (stats.skipped || 0);
  const firstTries = (stats.correct || 0) + (stats.mistakes || 0);
  const cells = [[served, nounOf(served, "card")]];
  if (firstTries) cells.push([pct(stats.correct || 0, stats.mistakes || 0), "first try"]);
  if (stats.learned) cells.push([stats.learned, "learned"]);
  if (firstTries) cells.push([stats.best || 0, "best streak"]);
  if (stats.skipped) cells.push([stats.skipped, "skipped"]);
  return {
    mode: "smart",
    title: smart.blitz ? "Blitz complete" : "Queue complete",
    cells: cells.slice(0, 4),
    delta: after?.health && smart.healthBefore ? healthDelta(smart.healthBefore, after.health) : null,
    foot: after ? (after.due_tomorrow > 0 ? `${countOf(after.due_tomorrow, "review")} due tomorrow` : "Nothing due tomorrow") : "",
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
  const lines = Number(training?.lines?.length) || 0;
  const missed = stats.mistakes || 0;
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
