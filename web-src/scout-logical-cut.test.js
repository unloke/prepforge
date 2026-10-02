import { describe, expect, it } from 'vitest';
import { trimRankedBranches, SCOUT_BRANCH_HARD_CEILING } from './scout.js';

describe('bounded evidence-driven engine queue', () => {
  const route = (family, i, n = 10) => ({ ucis: [family,'reply',String(i)], games:n, scorePct:0, conditionalReach:0.4, evidenceGames:100 });
  it('spends engine reads on supported evidence before singleton history', () => {
    const rows = [...Array.from({length:110},(_,i)=>route(String(i),i,1)), ...Array.from({length:5},(_,i)=>route(`s${i}`,i))];
    expect(trimRankedBranches(rows,{ceiling:5}).map(r=>r.games)).toEqual([10,10,10,10,10]);
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
  it('handles empty input', () => {
    expect(trimRankedBranches([])).toEqual([]);
    expect(trimRankedBranches(undefined)).toEqual([]);
  });
});
