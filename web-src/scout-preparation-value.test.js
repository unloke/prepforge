import { describe, it, expect } from 'vitest';
import { scenarios } from '../scripts/scout-production-selection-study.mjs';
import { preparationValue, selectPreparationRoutes, nestedRoutes } from './scout-preparation-value.js';

describe('budgeted practical preparation value', () => {
  it.each(scenarios)('$name', ({ rows, budget, expected }) => {
    for (const input of [rows, [...rows].reverse()]) {
      const result = selectPreparationRoutes(input, { limit: budget });
      expect(result.map(r => r.id)).toEqual(expected);
      expect(result.every((r,i) => result.slice(i+1).every(s => !nestedRoutes(r,s)))).toBe(true);
    }
  });
  it('never treats tiny perfect samples as certain', () => {
    const values = [1,2,40].map(n => preparationValue({ games:n, evidenceGames:n }).coverage);
    expect(values[0]).toBeLessThan(values[1]);
    expect(values[1]).toBeLessThan(values[2]);
    expect(values[2]).toBeLessThan(1);
  });
  it('Maia opportunity influence decays with personal support, and never changes coverage', () => {
    const delta = n => [0,100].map(maiaScorePct => preparationValue({games:n,scorePct:30,maiaScorePct}));
    expect(delta(2)[0].coverage).toBe(delta(2)[1].coverage);
    expect(delta(100)[0].opportunity-delta(100)[1].opportunity).toBeLessThan(delta(2)[0].opportunity-delta(2)[1].opportunity);
  });
  it('empty, zero budget, zero edge and impossible routes do not fill slots', () => {
    expect(selectPreparationRoutes([])).toEqual([]);
    expect(selectPreparationRoutes(scenarios[0].rows,{limit:0})).toEqual([]);
    expect(selectPreparationRoutes([{ucis:['e2e4'],games:10,prefilterScore:0}])).toEqual([]);
    expect(selectPreparationRoutes([{ucis:['e2e4'],games:10,routeReach:0.09}])).toEqual([]);
  });
  it('matches exhaustive subset search on small trees, including one-ply parents', () => {
    let seed = 4129;
    const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
    const paths = [['a'],['a','x'],['a','x','i'],['a','x','j'],['a','y'],['b','x'],['b','x','i'],['c','x']];
    for (let sample = 0; sample < 40; sample++) {
      const rows = paths.map(ucis => ({ucis,games:1+Math.floor(random()*80),evidenceGames:100,prefilterScore:random()*300}));
      const objective = set => set.reduce((sum, route) => sum + preparationValue(route).value, 0);
      for (const limit of [1,2,3,4]) {
        let optimum = 0;
        for (let mask=0;mask<2**rows.length;mask++) {
          const set = rows.filter((_,i)=>mask & (1<<i));
          if (set.length>limit || set.some((r,i)=>set.slice(i+1).some(s=>nestedRoutes(r,s)))) continue;
          optimum = Math.max(optimum,objective(set));
        }
        expect(objective(selectPreparationRoutes(rows,{limit}))).toBeCloseTo(optimum,10);
      }
    }
  });
  it('depth alone does not improve utility; identical evidence prefers the shorter representative', () => {
    const parent = {ucis:['e2e4','e7e5'],games:40,evidenceGames:50,prefilterScore:40};
    const child = {...parent,ucis:[...parent.ucis,'g1f3','b8c6']};
    expect(selectPreparationRoutes([child,parent]).map(r=>r.ucis)).toEqual([parent.ucis]);
  });
  it('always enforces the product cap even for larger requested budgets', () => {
    const rows = Array.from({length:20},(_,i)=>({ucis:[String(i),'reply'],games:2}));
    expect(selectPreparationRoutes(rows,{limit:100})).toHaveLength(12);
  });
  it('can spend all twelve targets on distinct valuable continuations in one family', () => {
    const strong = Array.from({length:12},(_,i)=>({
      id: `strong-${i}`, ucis:['e2e4','c7c5',`continuation-${i}`],
      games:20,evidenceGames:300,prefilterScore:100,
    }));
    const alternatives = ['d2d4','c2c4','g1f3'].map(move=>({
      id:move,ucis:[move,'reply'],games:10,evidenceGames:300,prefilterScore:50,
    }));
    const chosen = selectPreparationRoutes([...alternatives,...strong]);
    expect(chosen).toHaveLength(12);
    expect(chosen.every(r=>r.id.startsWith('strong-'))).toBe(true);
  });
  it('changing family labels without changing overlap does not change selected values', () => {
    const rows = Array.from({length:8},(_,i)=>({
      ucis:['shared','reply',String(i)],games:5+i,evidenceGames:100,prefilterScore:100,
    }));
    const splitFamilies = rows.map((r,i)=>({...r,ucis:[String(i),'reply','tail']}));
    const values = input => selectPreparationRoutes(input,{limit:4}).map(r=>r.preparationEvidence.value);
    expect(values(rows)).toEqual(values(splitFamilies));
  });
});
