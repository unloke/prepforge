import { describe, expect, it } from 'vitest';
import { trimRankedBranches, SCOUT_BRANCH_HARD_CEILING } from './scout.js';

describe('bounded evidence-driven engine queue', () => {
  // No Maia read yet: the queue is ordered by how reliably they reach each line,
  // and history (games / scorePct) must not decide it.
  const route = (family, i, n = 10) => ({ ucis: [family,'reply',String(i)], games:n, scorePct:0, conditionalReach:0.4, evidenceGames:100 });
  it('spends engine reads on the lines they reach, not on singleton history', () => {
    const singles = Array.from({length:110},(_,i)=>({ ...route(String(i),i,1), conditionalReach: 0.01, routeReach: 0.05 }));
    const played = Array.from({length:5},(_,i)=>({ ...route(`s${i}`,i), routeReach: 0.9 }));
    expect(trimRankedBranches([...singles, ...played],{ceiling:5}).map(r=>r.games)).toEqual([10,10,10,10,10]);
  });
  it('caps actual engine reads', () => {
    const rows = Array.from({length:450},(_,i)=>route(String(i),i));
    expect(trimRankedBranches(rows)).toHaveLength(SCOUT_BRANCH_HARD_CEILING);
  });
  it('does not displace stronger personal opportunities to diversify families', () => {
    const rows = [...Array.from({length:40},(_,i)=>route('a',i)),route('b',1,9)];
    expect(trimRankedBranches(rows,{ceiling:2}).map(r=>r.ucis[0])).toEqual(['a','a']);
  });
  it('retains parent and child until opportunity is measured', () => {
    expect(trimRankedBranches([route('e2e4',0,40), {...route('e2e4',0,10),ucis:['e2e4','reply','0','tail','move']}])).toHaveLength(2);
  });
  it('ranks a line Maia rates low above one it rates high, at equal reach', () => {
    const weak = { ...route('a',0,10), maiaScorePct: 20 };
    const strong = { ...route('b',0,10), maiaScorePct: 80 };
    expect(trimRankedBranches([strong, weak],{ceiling:1}).map(r=>r.ucis[0])).toEqual(['a']);
  });
  it('handles empty input', () => {
    expect(trimRankedBranches([])).toEqual([]);
    expect(trimRankedBranches(undefined)).toEqual([]);
  });
});
