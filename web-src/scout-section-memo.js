import { buildScoutStats } from "./scout-stats.js";

// Every enrichment step (Stockfish, path guard, Maia, explorer, aggregation)
// redraws both colour sections from the same games. Two of the section's passes
// read every game, yet change only with the games, the speed filter and the trie:
// the last result per colour is kept and reused while those are the same.
// Scout's game list only grows (appended while streaming), so its length marks
// a change; a new Start or a new fixture is a new array.

function lastResultPerColor() {
  const last = new Map();
  return (color, key, compute) => {
    const hit = last.get(color);
    if (hit && hit.key.length === key.length && hit.key.every((value, i) => Object.is(value, key[i]))) return hit.value;
    const value = compute();
    last.set(color, { key, value });
    return value;
  };
}

const statsMemo = lastResultPerColor();
const branchesMemo = lastResultPerColor();

/** buildScoutStats for one colour, reused while the games and speed filter hold. */
export function memoScoutStats(games, { color, speedFilter = "all" }) {
  return statsMemo(color, [games, games?.length, speedFilter],
    () => buildScoutStats(games, { color, speedFilter }));
}

/**
 * scoutModule.rankedOpeningBranches, reused while its inputs hold. The live trie
 * grows in place, so its gameCount is part of the key beside its identity.
 */
export function memoRankedOpeningBranches(scoutModule, games, color, options) {
  const { speedFilter = "all", trie = null, baselineScorePct, limit } = options;
  return branchesMemo(color,
    [scoutModule.rankedOpeningBranches, games, games?.length, speedFilter, trie, trie?.gameCount, trie?.count, baselineScorePct, limit],
    () => scoutModule.rankedOpeningBranches(games, color, options));
}
