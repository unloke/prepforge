// Archived pre-2026-09-26 prior, used only by historical studies.
import { triePrefixStats, wilsonScoreUpperPct, SLIP_MIN_GAMES } from "../web-src/scout.js";
const SCOUT_STRUGGLE_PRIOR_FLOOR = 0.08;
/**
 * Empirical "struggle" for one opening branch, resolved at the deepest prefix
 * with enough games to trust (n ≥ minGames). Solves the granularity-vs-sample-size
 * tension: a rare deep leaf borrows its struggle signal from the line family it belongs
 * to, instead of asserting anything from an n=1 leaf.
 *   struggle  — 0..1, how far the family's Wilson-upper score sits below the opponent's
 *               own baseline (0 = at/above baseline, no measured weakness).
 *   offModal  — retained as diagnostic evidence; it does not improve ranking.
 *   prefixGames — family sample size backing the struggle signal.
 */
export function branchStruggle(trie, ucis, baselineScorePct = 50, { minGames = SLIP_MIN_GAMES } = {}) {
  const empty = { struggle: 0, offModal: 1, prefixGames: 0, prefixPly: -1, scorePct: null };
  if (!trie || !ucis?.length) return empty;
  const stats = triePrefixStats(trie, ucis);
  if (!stats.length) return empty;
  let chosen = null;
  for (let i = stats.length - 1; i >= 0; i -= 1) {
    if (stats[i].gameCount >= minGames) {
      chosen = stats[i];
      break;
    }
  }
  const terminal = stats[stats.length - 1];
  const offModal = terminal.moveShare > 0 ? Math.min(50, 1 / Math.max(terminal.moveShare, 0.02)) : 1;
  if (!chosen) {
    return { struggle: 0, offModal, prefixGames: 0, prefixPly: -1, scorePct: null };
  }
  const wilsonUpper = wilsonScoreUpperPct(chosen.w, chosen.d, chosen.l);
  const struggle = Math.max(0, baselineScorePct - wilsonUpper) / 100;
  return {
    struggle,
    offModal,
    prefixGames: chosen.gameCount,
    prefixPly: chosen.ply,
    scorePct: chosen.scorePct,
  };
}

/**
 * Cheap (no-engine) prior for which branches deserve a Stockfish read. Centred on
 * exploitability — empirical struggle, without a rarity reward. Family-level
 * reproducibility (log of prefix games) keeps truly one-off noise from crowding out
 * recurring weaknesses. Falls back to branchScore when no trie is available.
 */
export function branchExploitabilityPrior(branch, { trie, baselineScorePct = 50 } = {}) {
  if (!trie) return branch?.branchScore ?? 0;
  const struggle = branch?.exploitabilityStruggle;
  const prefixGames = branch?.prefixGames;
  const stats = (struggle == null || prefixGames == null)
    ? branchStruggle(trie, branch?.ucis, baselineScorePct)
    : null;
  const s = struggle ?? stats?.struggle ?? 0;
  const n = prefixGames ?? stats?.prefixGames ?? 0;
  const reproducibility = Math.log1p(n) + 0.1;
  return (s + SCOUT_STRUGGLE_PRIOR_FLOOR) * reproducibility;
}
