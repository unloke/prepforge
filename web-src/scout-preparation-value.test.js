import { describe, it, expect } from 'vitest';
import { preparationValue, selectPreparationRoutes } from './scout-preparation-value.js';
const row = (ucis, overrides = {}) => ({ ucis, games: 15, scorePct: 30, conditionalReach: 0.4, prefilterScore: 0, maiaScorePct: 20, ...overrides });
const select = (rows, options = {}) => selectPreparationRoutes(rows, { baseline: 70, oppColor: 'white', ...options });

describe('Maia leaf value drives the weak spots', () => {
  it('chooses the supported line Maia rates lowest over a frequent one it rates highly', () => {
    const weak = row(['weak']);
    expect(select([row(['strong'], { games: 40, scorePct: 85, conditionalReach: 0.8, maiaScorePct: 90 }), row(['singleton'], { games: 1, scorePct: 0, prefilterScore: 1000 }), weak], { limit: 1 }).map(r => r.ucis)).toEqual([weak.ucis]);
  });
  it('uses the Maia probability as a probability, never as a pseudo-game', () => {
    const e = preparationValue(row(['a'], { maiaScorePct: 25 }), 70);
    expect(e.maiaScore).toBeCloseTo(0.25);
    expect(e.weakness).toBeCloseTo(0.7 - 0.25);
    expect(e.support).toBe(15);
    // Utility is reach × weakness × engine opportunity / depth cost (cp 0 → no boost).
    expect(e.value).toBeCloseTo(0.4 * (0.7 - 0.25));
  });
  it('rates weakness against the weighted cohort baseline', () => {
    const e = preparationValue(row(['a'], { maiaScorePct: 40, selectionBaseline: { score: 0.62, prior: { w: 0.62, d: 0, l: 0.38 } } }));
    expect(e.baseline).toBeCloseTo(0.62);
    expect(e.weakness).toBeCloseTo(0.22);
  });
  it('gives a line Maia rates at or above their usual result no weak-spot utility', () => {
    expect(preparationValue(row(['a'], { maiaScorePct: 70 }), 70).value).toBe(0);
    expect(preparationValue(row(['a'], { maiaScorePct: 85 }), 70).value).toBe(0);
  });
  it('treats a missing Maia read as no weakness signal, not as 50%', () => {
    const e = preparationValue(row(['a'], { maiaScorePct: null }), 70);
    expect(e.maiaScore).toBeNull();
    expect(e.weakness).toBe(0);
    expect(e.value).toBe(0);
    // It still fills a slot as a likely line, never as a weak spot.
    const picked = select([row(['a'], { maiaScorePct: null })]);
    expect(picked.map(r => r.ucis)).toEqual([['a']]);
    expect(picked[0].preparationEvidence.value).toBe(0);
  });
  it('never reads whole-game results into the utility', () => {
    const a = row(['a'], { routeWdl: { w: 0, d: 0, l: 15 }, maiaScorePct: 30 });
    const b = row(['a'], { routeWdl: { w: 15, d: 0, l: 0 }, maiaScorePct: 30 });
    expect(preparationValue(b, 70)).toEqual(preparationValue(a, 70));
  });
  it('ignores our move frequency in reach while preserving confidence effects', () => {
    const make = n => row(['a','b','c','d'], { games: n, maiaScorePct: 20, preparationDecisions: [{ ply: 2, moveGames: 80, parentGames: 100 }, { ply: 4, moveGames: n, parentGames: n }] });
    expect(preparationValue(make(1), 70).conditionalReach).toBeCloseTo(0.8);
    expect(preparationValue(make(40), 70).conditionalReach).toBeCloseTo(0.8);
    expect(preparationValue(make(1), 70).value).toBe(0);
    expect(preparationValue(make(40), 70).value).toBeGreaterThan(0);
  });
  it('gates cumulative reach and weakest-choice plausibility separately', () => {
    const input = row(['a','b','c','d','e'], { routeReach: 0.4, maiaScorePct: 20, preparationDecisions: [1,3,5].map(ply => ({ ply, moveGames: 40, parentGames: 100 })) });
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
    const usual = row(['a'], { maiaScorePct: 70 }), comfortable = row(['b'], { maiaScorePct: 95 });
    for (const input of [[usual, comfortable], [comfortable, usual]])
      expect(select(input).map(r => r.ucis)).toEqual([['a'], ['b']]);
    const rare = row(['c'], { maiaScorePct: 70, conditionalReach: 0.05 });
    expect(select([rare, usual]).map(r => r.ucis)).toEqual([['a'], ['c']]);
    expect(select([])).toEqual([]);
    expect(select([usual], { limit: 0 })).toEqual([]);
  });
  it('gives each anchor one row and never a second continuation past it', () => {
    const full = (tail, extra = {}) => row(['p','q','r','s','t','u','v', ...tail], extra);
    const a1 = full(['a1'], { anchorUcis: ['p','q','r'], continuationShare: 0.6 });
    const a2 = full(['a2'], { anchorUcis: ['p','q','r'], continuationShare: 0.3 });
    const b1 = { ...row(['p','q','x','s','t','u','v','b1'], { maiaScorePct: 40 }), anchorUcis: ['p','q','x'], continuationShare: 0.2 };
    expect(select([a2, b1, a1]).map(r => r.ucis.at(-1))).toEqual(['a1', 'b1']);
  });
  it('shows a family of nested weak branches once', () => {
    const line = (tail, anchorUcis, extra = {}) => ({ ...row(['p','q','r', ...tail], extra), anchorUcis });
    const deep1 = line(['s','t','u','v','w'], ['p','q','r','s','t'], { maiaScorePct: 50 });
    const deep2 = line(['s','t','u','v','x'], ['p','q','r','s','t'], { maiaScorePct: 50 });
    const other = line(['z','y','u','v','w'], ['p','q','r'], { maiaScorePct: 55 });
    for (const input of [[deep1, deep2, other], [other, deep2, deep1]])
      expect(select(input).map(r => r.ucis)).toEqual([deep1.ucis, other.ucis]);
  });
  it('leaves slots empty rather than fill them with lines that differ only past a shared anchor', () => {
    const anchorUcis = ['e4','e5','Nf3','Nc6','d3','Nf6','Be2'];
    const tails = ['O-O','c3','Nbd2','a4'].map(m => ({ ...row([...anchorUcis, 'Be7', m, 'x', 'y'], { maiaScorePct: 65 }), anchorUcis }));
    expect(select(tails)).toHaveLength(1);
  });
  it('prefers lines that reach the end of the opening over stubs', () => {
    const stub = row(['a'], { maiaScorePct: 10 });
    const line = row(['b','c','d','e','f','g','h','i'], { maiaScorePct: 40 });
    expect(select([stub, line]).map(r => r.ucis.length)).toEqual([8, 1]);
  });
  it('dedupes canonical positions using the higher utility without summing support', () => {
    const a = row(['a'], { terminalFen: 'position w - - 0 1', maiaScorePct: 30 });
    const b = row(['b'], { terminalFen: 'position w - - 4 7', maiaScorePct: 45 });
    for (const inputs of [[a,b],[b,a]]) {
      expect(select(inputs).map(r => r.ucis)).toEqual([a.ucis]);
      expect(select(inputs)[0].preparationEvidence.support).toBe(15);
    }
  });
  it('moves the ranking when only the Maia leaf score changes', () => {
    const a = row(['a'], { maiaScorePct: 0 }), b = row(['b'], { maiaScorePct: 100 });
    expect(select([a, b], { limit: 1 }).map(r => r.ucis)).toEqual([a.ucis]);
    expect(select([{ ...a, maiaScorePct: 100 }, { ...b, maiaScorePct: 0 }], { limit: 1 }).map(r => r.ucis)).toEqual([b.ucis]);
  });
  it('does not move the core priority when only whole-game results change', () => {
    const a = row(['a'], { maiaScorePct: 0, routeWdl: { w: 9, d: 0, l: 1 } });
    const b = row(['b'], { maiaScorePct: 100, routeWdl: { w: 1, d: 0, l: 9 } });
    const swapped = [{ ...a, routeWdl: { w: 1, d: 0, l: 9 } }, { ...b, routeWdl: { w: 9, d: 0, l: 1 } }];
    expect(select([a, b]).map(r => r.ucis)).toEqual(select(swapped).map(r => r.ucis));
    expect(select([a, b])[0].preparationEvidence.value).toBeCloseTo(select(swapped)[0].preparationEvidence.value);
  });
  it('caps the budget at twelve without family quotas', () => {
    expect(select(Array.from({ length: 20 }, (_,i) => row(['shared','reply',String(i)])), { limit: 100 })).toHaveLength(12);
  });
});
