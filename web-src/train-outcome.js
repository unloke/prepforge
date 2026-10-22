// The line a finished Smart queue / Blitz session ends on. New moves are taught,
// not graded: they are counted as learned, apart from the review moves whose
// first answers make the recall score.
export function smartSessionOutcomeText(smart = {}, stats = {}) {
  const correct = Number(stats.correct) || 0;
  const missed = Number(stats.mistakes) || 0;
  const learned = Number(stats.learned) || 0;
  const retried = Number(stats.learnedRetry) || 0;
  const scored = correct + missed;
  const taught = learned
    ? `${learned} new move${learned === 1 ? "" : "s"} learned${retried ? ` (${retried} needed a retry)` : ""}. `
    : "";
  const recall = scored
    ? `${taught}First-try recall: ${correct} of ${scored} review move${scored === 1 ? "" : "s"}.`
    : `${taught}Nothing due for review yet.`;
  const details = [];
  if (missed) details.push(`${missed} missed first try`);
  if (smart.retriesFixed) details.push(`${smart.retriesFixed} fixed on retry`);
  if (smart.blitz && smart.timeouts) details.push(`${smart.timeouts} timed out`);
  if (stats.skipped) details.push(`${stats.skipped} skipped`);
  return details.length ? `${recall} ${details.join(" · ")}.` : recall;
}
