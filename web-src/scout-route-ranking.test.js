import { describe, expect, it, vi } from 'vitest';
import { buildOpeningTrie, rankedOpeningBranches, rankGamePlan, createOpeningTrie, insertGameIntoTrie, fenAfterLine } from './scout.js';
import { preparationValue, canonicalPosition } from './scout-preparation-value.js';
import { collectPrefilterFens, runStockfishPrefilter, prefilterCacheKey, rankPrefilterCandidates } from './scout-prefilter.js';
import { computeMaiaScopeKey } from './scout-maia.js';
import { buildScoutSectionSummary } from './scout-summary.js';

const DAY = 86400000, NEWEST = 1800000000000;
const game = (i, score, ucis, age = 0, extra = {}) => ({ gameId: String(i), score, ucis,
  sans: ucis, color: 'black', speed: 'blitz', datestamp: NEWEST-age*DAY, ...extra });
function corpus(recentLosses) {
  return [
    ...Array.from({ length: 6 }, (_,i) => game(`loss-${i}`,0,['e2e4','e7e5'],recentLosses ? 0 : 720)),
    ...Array.from({ length: 6 }, (_,i) => game(`win-${i}`,1,['e2e4','e7e5'],recentLosses ? 720 : 0)),
    ...Array.from({ length: 30 }, (_,i) => game(`base-${i}`,1,['e2e4','c7c5'])),
  ];
}
const observed = (games,trie) => rankedOpeningBranches(games,'black',{ limit:0,trie, speedFilter:'blitz' }).branches;

describe('v10 evidence and cache boundaries', () => {
  it.each([0, 0.5, 1])('does not invent weakness in a uniform outcome cohort (%s)', score => {
    const games = Array.from({ length: 20 }, (_,i) => game(i,score,['e2e4','e7e5']));
    const plan = rankGamePlan(observed(games),100*score,{ oppColor:'black' });
    expect(plan.every(r => r.preparationEvidence.value === 0 && r.preparationEvidence.weakness === 0)).toBe(true);
  });
  it('recent wins erase old weakness with matching recency-weighted baseline', () => {
    const recentWins = observed(corpus(false)).find(r => r.ucis[1] === 'e7e5');
    const recentLosses = observed(corpus(true)).find(r => r.ucis[1] === 'e7e5');
    expect(recentWins.routeSupportGames).toBe(12);
    expect(recentWins.selectionWdl.l).toBeCloseTo(6/256);
    expect(recentWins.selectionBaseline.score).toBeCloseTo(36/(36+6/256));
    expect(preparationValue(recentWins).value).toBe(0);
    expect(preparationValue(recentLosses).value).toBeGreaterThan(0);
  });
  it('anchors selection at the newest colour/speed/collapse eligible game', () => {
    const games = [...corpus(true), game('wrong-colour',1,['d2d4'], -90,{ color:'white' }),
      game('wrong-speed',1,['d2d4','d7d5'],-180,{ speed:'rapid' }),
      game('collapse',0,['e2e4','e7e5'],-270,{ status:'resign',totalPly:2,clockInitialSeconds:180,clockCsAfterPly:[17000,17000] })];
    const trie = buildOpeningTrie(games,'black',{ speedFilter:'blitz',maxPlies:Infinity });
    expect(trie.selectionAnchorTs).toBe(NEWEST);
    expect(trie.gameCount).toBe(42);
  });
  it('rebuilds streaming selection weights before applying a fixed-strength prior', () => {
    const games = corpus(true), stream = createOpeningTrie();
    for (const g of games) insertGameIntoTrie(stream,g,'black',{ anchorTs:NEWEST+500*DAY,maxPlies:Infinity });
    const streamed = observed(games,stream), batch = observed(games);
    expect(streamed.map(r => r.selectionWdl)).toEqual(batch.map(r => r.selectionWdl));
    expect(rankGamePlan(streamed,50,{ oppColor:'black' })).toEqual(rankGamePlan(batch,50,{ oppColor:'black' }));
  });
  it('counter-only transpositions reuse engine reads and select one representative', async () => {
    const paths = [['g1f3','g8f6','g2g3','g7g6'],['g2g3','g7g6','g1f3','g8f6']];
    const rows = paths.map((ucis,i) => ({ ucis,sans:ucis,games:10,routeScorePct:0,
      conditionalReach:0.5,terminalFen:fenAfterLine(ucis),oppColor:'black',id:i }));
    expect(rows[0].terminalFen).not.toBe(rows[1].terminalFen);
    expect(canonicalPosition(rows[0].terminalFen)).toBe(canonicalPosition(rows[1].terminalFen));
    expect(collectPrefilterFens(rows,{ fenAfterLine,oppColor:'black' })).toHaveLength(1);
    const cache = new Map([[prefilterCacheKey(rows[1].terminalFen),{ score_cp:-20,best_move_uci:'f1g2',complete:true }]]);
    const analyze = vi.fn();
    const result = await runStockfishPrefilter(rows,{ fenAfterLine,oppColor:'black',cache,analyzeGamePositions:analyze });
    expect(analyze).not.toHaveBeenCalled();
    expect(result.ranked).toHaveLength(2);
    const plan = rankGamePlan(result.ranked.map(e => e.line),50,{ oppColor:'black' });
    expect(plan).toHaveLength(1);
    expect(plan[0].routeSupportGames ?? plan[0].games).toBe(10);
  });
  it('engine gates allow supported weakness at -20 CP and reject -76 or opponent mates', () => {
    const ucis = ['e2e4','e7e5'];
    const row = { ucis,sans:ucis,games:15,scorePct:30,conditionalReach:0.4 };
    for (const [cp,mate,count] of [[-20,0,1],[-75,0,1],[-76,0,0],[1000,-2,0]]) {
      const evals = new Map([[fenAfterLine(ucis),{ score_cp:cp,mate_in:mate,best_move_uci:'g1f3' }]]);
      expect(rankPrefilterCandidates([row],evals,{ fenAfterLine,oppColor:'black',baselineScorePct:70 })).toHaveLength(count);
    }
  });
  it('Maia attempt scope changes with cohort identity, not game order', () => {
    const options = { activeSpeed:'blitz',ratings:{ white:1800,black:1800 },gameCount:2 };
    const a = computeMaiaScopeKey({ ...options,games:[{ gameId:'a' },{ gameId:'b' }] });
    expect(a).toBe(computeMaiaScopeKey({ ...options,games:[{ gameId:'b' },{ gameId:'a' }] }));
    expect(a).not.toBe(computeMaiaScopeKey({ ...options,games:[{ gameId:'a' },{ gameId:'c' }] }));
    expect(a).toMatch(/\|10$/);
  });
  it('summary confidence uses full-prefix support, even when no game ends at that prefix', () => {
    const summary = buildScoutSectionSummary({ predictability:{ topMove:{san:'e4',share:1},games:20,label:'predictable' } },{
      username:'rival',prepTargets:[{ games:0,routeSupportGames:20,routeScorePct:30,scorePct:100,
        sans:['e4'],ucis:['e2e4'],prepCategory:'attack' }] });
    expect(summary.headline).toContain('30%');
    expect(summary.headline).toContain('20 games');
  });
});
