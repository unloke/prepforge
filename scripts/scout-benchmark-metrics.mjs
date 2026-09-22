const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
}

export function pressureMetrics(wdl, opponentColor, alternatives = []) {
  // WDL entries are white-perspective expected points after every half-move.
  const ours = wdl.map((v) => opponentColor === "white" ? 1 - v : v);
  const afterOurMove = ours.filter((_, index) => index % 2 === (opponentColor === "white" ? 1 : 0));
  const opponentDeltas = ours.flatMap((v, index) =>
    index > 0 && index % 2 === (opponentColor === "white" ? 0 : 1)
      ? [Math.max(0, v - ours[index - 1])] : []);
  const totalGain = Math.max(0, ours.at(-1) - (ours[0] || 0.5));
  const largest = Math.max(0, ...opponentDeltas);
  const weights = alternatives.filter((a) => Number.isFinite(a.probability) && Number.isFinite(a.userWdl));
  const weightTotal = weights.reduce((sum, a) => sum + a.probability, 0);
  return {
    pressureFloor: quantile(afterOurMove, 0.1),
    pressureConsistency: mean(afterOurMove.map((v) => v >= 0.55 ? 1 : 0)),
    largestOpponentBlunderGain: largest,
    blunderDependency: totalGain > 0 ? Math.min(1, largest / totalGain) : 0,
    robustness: weightTotal ? weights.reduce((sum, a) =>
      sum + a.probability * (a.userWdl >= 0.55 ? 1 : 0), 0) / weightTotal : null,
  };
}
