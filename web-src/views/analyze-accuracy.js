import { moveAccuracy } from "../explain.js";

// Lichess gameAccuracy: mean of volatility-weighted and harmonic move accuracy.
// https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala
export function averageAccuracy(rows) {
  if (!rows.length) return null;
  const wins = [rows[0].winBefore, ...rows.map((r) => r.winAfter)];
  const size = Math.min(8, Math.max(2, Math.floor(rows.length / 10)));
  const window = wins.slice(0, size);
  const windows = Array.from({ length: Math.min(size, wins.length) - 2 }, () => window);
  for (let i = 0; i + size <= wins.length; i++) windows.push(wins.slice(i, i + size));
  const samples = rows.map((row, i) => {
    const values = windows[i];
    if (row.winBefore == null || row.winAfter == null || !values || values.some((v) => v == null)) return null;
    const mean = values.reduce((s, n) => s + n, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((s, n) => s + (n - mean) ** 2, 0) / values.length);
    const flip = (v) => row.side === "black" ? 100 - v : v;
    return { side: row.side, accuracy: moveAccuracy(flip(row.winBefore), flip(row.winAfter)), weight: Math.min(12, Math.max(0.5, deviation)) };
  }).filter(Boolean);
  const side = (color) => {
    const own = samples.filter((s) => s.side === color);
    if (!own.length) return null;
    const weight = own.reduce((s, r) => s + r.weight, 0);
    const weighted = own.reduce((s, r) => s + r.accuracy * r.weight, 0) / weight;
    const harmonic = own.length / own.reduce((s, r) => s + 1 / Math.max(1, r.accuracy), 0);
    return Math.round((weighted + harmonic) / 2);
  };
  return { white: side("white"), black: side("black") };
}
