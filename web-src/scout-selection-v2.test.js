import { describe, expect, it } from 'vitest';
import games from '../tests/fixtures/scout/ericrosen-selection.json';
import engine from '../tests/fixtures/scout/selection-stockfish.json';
import { buildOpeningTrie, rankedOpeningBranches, rankGamePlan, fenAfterLine, opponentColorBaseline } from './scout.js';
import { rankPrefilterCandidates } from './scout-prefilter.js';
import { nestedRoutes, canonicalPosition } from './scout-preparation-value.js';

// One colour replays ~1,200 real games through chess.js cold (no memo yet): 2-4 s
// alone, past the 5 s default once the whole suite shares the CPU. The budget is
// the work's, not a hang guard.
describe('v10 observed route pipeline', { timeout: 30_000 }, () => {
  it.each(['white','black'])('fills twelve full observed %s lines, Maia weak spots first, assessed and in fallback', color => {
    const baseline = opponentColorBaseline(games,color);
    const rows = rankedOpeningBranches(games,color,{ trie: buildOpeningTrie(games,color,{ maxPlies: Infinity }),limit: 300,baselineScorePct: baseline }).branches;
    const assessed = rankPrefilterCandidates(rows,new Map(Object.entries(engine.evals)),{ fenAfterLine,oppColor: color,baselineScorePct: baseline }).map(e => e.line);
    // Half the pool gets a Maia read below their usual result, half above it.
    const withMaia = pool => pool.map((r,i) => ({ ...r, maiaScorePct: baseline - 20 + (i % 2) * 40 }));
    for (const pool of [rows,assessed]) {
      // Without a Maia read there is no weakness signal, only filler.
      const unread = rankGamePlan(pool,baseline,{ oppColor: color });
      expect(unread).toHaveLength(12);
      expect(unread.every(r => r.preparationEvidence.value === 0)).toBe(true);
      const rated = withMaia(pool);
      const selected = rankGamePlan(rated,baseline,{ oppColor: color });
      expect(selected).toHaveLength(12);
      // Weak spots lead; the rest of the slate follows without one.
      const weak = selected.map(r => r.preparationEvidence.value > 0);
      expect(weak).toContain(true);
      expect(weak.indexOf(false) === -1 || !weak.slice(weak.indexOf(false)).includes(true)).toBe(true);
      for (const route of selected) {
        expect(games.some(g => g.color === color && route.ucis.every((u,i) => g.ucis[i] === u))).toBe(true);
        expect(route.routeSupportGames).toBeGreaterThanOrEqual(3);
        expect(route.ucis.length).toBeGreaterThanOrEqual(8);
        expect(route.anchorUcis).toEqual(route.ucis.slice(0, route.anchorUcis.length));
        expect(selected.filter(r => nestedRoutes(r,route))).toHaveLength(1);
      }
      expect(new Set(selected.map(r => canonicalPosition(r.terminalFen))).size).toBe(selected.length);
      expect(rankGamePlan([...rated].reverse(),baseline,{ oppColor: color }).map(r => r.line)).toEqual(selected.map(r => r.line));
    }
  });
});
