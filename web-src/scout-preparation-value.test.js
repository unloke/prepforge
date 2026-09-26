import { describe, it, expect } from 'vitest';
import { scenarios } from '../scripts/scout-production-selection-study.mjs';
import { preparationValue, selectPreparationRoutes, nestedRoutes } from './scout-preparation-value.js';

describe('preparation value and marginal coverage', () => {
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
});
