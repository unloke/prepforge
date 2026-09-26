import { describe, expect, it } from 'vitest';
import { trimRankedBranches, SCOUT_BRANCH_HARD_CEILING } from './scout.js';

describe('bounded evidence-driven engine queue', () => {
  const route = (family, i, n = 10) => ({ ucis: [family,'reply',String(i)], games:n, evidenceGames:100 });
  it('retains thin data for engine assessment instead of calling it noise', () => {
    const rows = Array.from({length:110},(_,i)=>route(String(i),i,1));
    expect(trimRankedBranches(rows)).toHaveLength(110);
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
    expect(trimRankedBranches([{ucis:['e2e4'],games:40},{ucis:['e2e4','e7e5','g1f3'],games:1}])).toHaveLength(2);
  });
  it('handles empty input', () => {
    expect(trimRankedBranches([])).toEqual([]);
    expect(trimRankedBranches(undefined)).toEqual([]);
  });
});
