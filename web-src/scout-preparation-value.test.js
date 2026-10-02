import { describe, it, expect } from 'vitest';
import { preparationValue, selectPreparationRoutes } from './scout-preparation-value.js';
const row = (ucis, overrides = {}) => ({ ucis, games: 15, scorePct: 30, conditionalReach: 0.4, prefilterScore: 0, ...overrides });
const select = (rows, options = {}) => selectPreparationRoutes(rows, { baseline: 70, oppColor: 'white', ...options });

describe('v10 reachable historical weakness', () => {
  it('chooses supported weakness over frequent strength and singleton disasters', () => {
    const weak = row(['weak']);
    expect(select([row(['strong'], { games: 40, scorePct: 85, conditionalReach: 0.8 }), row(['singleton'], { games: 1, scorePct: 0, prefilterScore: 1000 }), weak], { limit: 1 }).map(r => r.ucis)).toEqual([weak.ucis]);
  });
  it('models draws explicitly in posterior mean and variance', () => {
    const e = preparationValue(row(['a'], { selectionWdl: { w: 1, d: 4, l: 5, weight: 10, weightSquared: 10 }, selectionBaseline: { score: 0.7, prior: { w: 0.6, d: 0.2, l: 0.2 } } }));
    const mu = (5.8 + 0.5 * 5.6) / 18;
    expect(e.shrunkScore).toBeCloseTo(mu);
    expect(e.sigma ** 2).toBeCloseTo(((5.8 + 0.25 * 5.6) / 18 - mu ** 2) / 19);
    expect(e.value).toBeCloseTo(0.4 * Math.max(0, 0.7 - mu - 0.5 * e.sigma));
  });
  it('requires raw n >= 3 and n_eff >= 2 without a weighted n floor', () => {
    const input = row(['a'], { games: 3, selectionWdl: { w: 0, d: 0, l: 2.7, weight: 2.7, weightSquared: 2.43 } });
    expect(preparationValue(input, 70).value).toBeGreaterThan(0);
    expect(preparationValue({ ...input, selectionWdl: { ...input.selectionWdl, weightSquared: 7 } }, 70).value).toBe(0);
  });
  it('ignores our move frequency in reach while preserving confidence effects', () => {
    const make = n => row(['a','b','c','d'], { games: n, preparationDecisions: [{ ply: 2, moveGames: 80, parentGames: 100 }, { ply: 4, moveGames: n, parentGames: n }] });
    expect(preparationValue(make(1), 70).conditionalReach).toBeCloseTo(0.8);
    expect(preparationValue(make(40), 70).conditionalReach).toBeCloseTo(0.8);
    expect(preparationValue(make(1), 70).value).toBe(0);
    expect(preparationValue(make(40), 70).value).toBeGreaterThan(0);
  });
  it('gates cumulative reach and weakest-choice plausibility separately', () => {
    const input = row(['a','b','c','d','e'], { routeReach: 0.4, preparationDecisions: [1,3,5].map(ply => ({ ply, moveGames: 40, parentGames: 100 })) });
    expect(preparationValue(input, 70).conditionalReach).toBeCloseTo(0.064);
    expect(preparationValue(input, 70).value).toBe(0);
    // A rarely reached line is never a weak spot, only a filler behind one.
    const weak = row(['w']);
    expect(select([row(['a'], { conditionalReach: 0.01 }), weak]).map(r => r.ucis)).toEqual([['w'], ['a']]);
    expect(select([row(['a'], { routeReach: 0.09 })])).toEqual([]);
  });
  it('keeps alternative user moves as separate rows', () => {
    expect(select([row(['a','x','i']), row(['a','y','j'])])).toHaveLength(2);
    expect(select([row(['a','x']), row(['b','y'])], { oppColor: 'black' })).toHaveLength(2);
  });
  it('accepts usable CP, rejects losing CP and opponent mates', () => {
    for (const cp of [-75,-20,0,5]) expect(select([row(['a'], { prefilterScore: cp })])).toHaveLength(1);
    expect(select([row(['a'], { prefilterScore: -76 })])).toEqual([]);
    expect(select([row(['a'], { userMate: -2, prefilterScore: 1000 })])).toEqual([]);
  });
  it('charges depth by the evidence anchor, not the full line length', () => {
    const anchored = row(['a','b','c','d','e','f','g'], { anchorUcis: ['a','b','c'], evidencePlies: 3 });
    const longer = { ...anchored, ucis: [...anchored.ucis, 'h', 'i', 'j', 'k', 'l', 'm'] };
    expect(preparationValue(longer, 70).value).toBeCloseTo(preparationValue(anchored, 70).value);
    const deepAnchor = { ...longer, evidencePlies: longer.ucis.length };
    expect(preparationValue(deepAnchor, 70).value).toBeLessThan(preparationValue(longer, 70).value);
  });
  it('fills unused slots with non-weak lines, likeliest and least comfortable first', () => {
    const usual = row(['a'], { scorePct: 70 }), comfortable = row(['b'], { scorePct: 95 });
    for (const input of [[usual, comfortable], [comfortable, usual]])
      expect(select(input).map(r => r.ucis)).toEqual([['a'], ['b']]);
    const rare = row(['c'], { scorePct: 70, conditionalReach: 0.05 });
    expect(select([rare, usual]).map(r => r.ucis)).toEqual([['a'], ['c']]);
    expect(select([])).toEqual([]);
    expect(select([usual], { limit: 0 })).toEqual([]);
  });
  it('gives each anchor one row and never a second continuation past it', () => {
    const full = (tail, extra = {}) => row(['p','q','r','s','t','u','v', ...tail], extra);
    const a1 = full(['a1'], { anchorUcis: ['p','q','r'], continuationShare: 0.6 });
    const a2 = full(['a2'], { anchorUcis: ['p','q','r'], continuationShare: 0.3 });
    const b1 = { ...row(['p','q','x','s','t','u','v','b1'], { scorePct: 60 }), anchorUcis: ['p','q','x'], continuationShare: 0.2 };
    expect(select([a2, b1, a1]).map(r => r.ucis.at(-1))).toEqual(['a1', 'b1']);
  });
  it('shows a family of nested weak branches once', () => {
    const line = (tail, anchorUcis, extra = {}) => ({ ...row(['p','q','r', ...tail], extra), anchorUcis });
    const deep1 = line(['s','t','u','v','w'], ['p','q','r','s','t'], { scorePct: 20 });
    const deep2 = line(['s','t','u','v','x'], ['p','q','r','s','t'], { scorePct: 20 });
    const other = line(['z','y','u','v','w'], ['p','q','r'], { scorePct: 40 });
    for (const input of [[deep1, deep2, other], [other, deep2, deep1]])
      expect(select(input).map(r => r.ucis)).toEqual([deep1.ucis, other.ucis]);
  });
  it('leaves slots empty rather than fill them with lines that differ only past a shared anchor', () => {
    const anchorUcis = ['e4','e5','Nf3','Nc6','d3','Nf6','Be2'];
    const tails = ['O-O','c3','Nbd2','a4'].map(m => ({ ...row([...anchorUcis, 'Be7', m, 'x', 'y'], { scorePct: 75 }), anchorUcis }));
    expect(select(tails)).toHaveLength(1);
  });
  it('prefers lines that reach the end of the opening over stubs', () => {
    const stub = row(['a'], { scorePct: 10 });
    const line = row(['b','c','d','e','f','g','h','i'], { scorePct: 30 });
    expect(select([stub, line]).map(r => r.ucis.length)).toEqual([8, 1]);
  });
  it('dedupes canonical positions using the higher utility without summing support', () => {
    const a = row(['a'], { terminalFen: 'position w - - 0 1', scorePct: 20 });
    const b = row(['b'], { terminalFen: 'position w - - 4 7', scorePct: 40 });
    for (const inputs of [[a,b],[b,a]]) {
      expect(select(inputs).map(r => r.ucis)).toEqual([a.ucis]);
      expect(select(inputs)[0].preparationEvidence.support).toBe(15);
    }
  });
  it('Maia outcomes never alter posterior, support, reach or utility', () => {
    const input = row(['a']);
    for (const maiaScorePct of [0,100,null]) expect(preparationValue({ ...input, maiaScorePct },70)).toEqual(preparationValue(input,70));
  });
  it('caps the budget at twelve without family quotas', () => {
    expect(select(Array.from({ length: 20 }, (_,i) => row(['shared','reply',String(i)])), { limit: 100 })).toHaveLength(12);
  });
});
