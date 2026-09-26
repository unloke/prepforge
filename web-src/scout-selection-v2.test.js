import { describe, expect, it } from 'vitest';
import games from '../tests/fixtures/scout/ericrosen-selection.json';
import engine from '../tests/fixtures/scout/selection-stockfish.json';
import { buildOpeningTrie, rankedOpeningBranches, rankGamePlan, fenAfterLine, opponentColorBaseline } from './scout.js';
import { rankPrefilterCandidates } from './scout-prefilter.js';
import { preparationValue, preparationDecisionWeights, selectPreparationRoutes, nestedRoutes } from './scout-preparation-value.js';

describe('observed decision preparation (#80)', () => {
  it.each(['white','black'])('replaces broad %s prefixes with observed preparation routes', color => {
    const trie = buildOpeningTrie(games,color,{maxPlies:Infinity});
    const rows = rankedOpeningBranches(games,color,{trie,limit:300}).branches;
    const selected = rankGamePlan(rows,50,{oppColor:color});
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(selected.filter(r=>r.ucis.length<=2)).toEqual([]);
    expect(selected.some(r=>r.routeSupportGames===1)).toBe(true);
    for (const route of selected) {
      expect(games.some(g=>g.color===color && route.ucis.every((u,i)=>g.ucis[i]===u))).toBe(true);
      expect(selected.filter(r=>nestedRoutes(r,route))).toHaveLength(1);
    }
    expect(rankGamePlan([...rows].reverse(),50,{oppColor:color}).map(r=>r.line)).toEqual(selected.map(r=>r.line));
  });

  it.each(['white','black'])('retains concrete %s routes through actual Stockfish assessment', color => {
    const baseline=opponentColorBaseline(games,color);
    const rows=rankedOpeningBranches(games,color,{trie:buildOpeningTrie(games,color,{maxPlies:Infinity}),limit:300,baselineScorePct:baseline}).branches;
    const evaluated=rankPrefilterCandidates(rows,new Map(Object.entries(engine.evals)),{fenAfterLine,oppColor:color,baselineScorePct:baseline});
    const selected=rankGamePlan(evaluated.map(e=>e.line),baseline,{oppColor:color});
    expect(selected).toHaveLength(12);
    expect(selected.every(r=>r.ucis.length>2 && r.preparationDecisions.length && r.hasUserReply)).toBe(true);
    expect(selected.some(r=>r.routeSupportGames===1)).toBe(true);
  });

  it('does not penalize an uncommon user choice as an unlikely opponent choice', () => {
    const make = n => ({ucis:['e2e4','c7c5','g1f3','d7d6'],games:n,
      routeSupportGames:n,evidenceGames:100,prefilterScore:50,
      preparationDecisions:[{ply:2,moveGames:80,parentGames:100},{ply:4,moveGames:n,parentGames:n}]});
    const one = preparationValue(make(1));
    const many = preparationValue(make(40));
    expect(one.conditionalReach).toBeCloseTo(0.8);
    expect(many.conditionalReach).toBeCloseTo(0.8);
    expect(one.value).toBeGreaterThan(many.value/2);
    expect(one.value).toBeLessThan(many.value);
  });

  it('a rare opponent response loses reach; extending an unobserved path earns nothing', () => {
    const route = {ucis:['a','b'],games:1,preparationDecisions:[{ply:2,moveGames:1,parentGames:100}]};
    const common = {...route, preparationDecisions:[{ply:2,moveGames:1,parentGames:1}]};
    expect(preparationValue(route).conditionalReach).toBeCloseTo(0.01);
    expect(preparationValue(common).value).toBeGreaterThan(preparationValue(route).value*50);
    expect(preparationValue({...common,ucis:['a','b','c','d']}).value).toBe(preparationValue(common).value);
  });

  it('a single-game continuation adds preparation beyond a high-support trunk', () => {
    const parent={ucis:['a','b'],games:40,prefilterScore:30,
      preparationDecisions:[{ply:2,moveGames:40,parentGames:40}]};
    const child={...parent,ucis:['a','b','c','d'],games:1,
      preparationDecisions:[...parent.preparationDecisions,{ply:4,moveGames:1,parentGames:1}]};
    expect(selectPreparationRoutes([parent,child]).map(r=>r.ucis)).toEqual([child.ucis]);
  });

  it('bounds repeated evidence from one trajectory, without giving raw length a bonus', () => {
    const row={games:1,ucis:Array(80).fill('move'),preparationDecisions:Array.from({length:40},(_,i)=>({ply:2*i+2,moveGames:1,parentGames:1}))};
    expect(preparationValue(row).decisionCoverage).toBeLessThan(2/3);
    expect(preparationValue(row).decisionCoverage).toBeGreaterThan(0.6);
  });

  it('keeps a short actionable mate instead of imposing a minimum length', () => {
    const parent={ucis:['a','b'],games:40,mateIn:2,
      preparationDecisions:[{ply:2,moveGames:40,parentGames:40}]};
    const child={...parent,ucis:['a','b','c','d'],games:1,mateIn:0,prefilterScore:1,
      preparationDecisions:[...parent.preparationDecisions,{ply:4,moveGames:1,parentGames:1}]};
    expect(selectPreparationRoutes([child,parent],{limit:1}).map(r=>r.ucis)).toEqual([parent.ucis]);
  });

  it('does not reward duplicate routes or allow engine/decision credit without actual support', () => {
    const row={ucis:['a','b'],games:1,prefilterScore:100,preparationDecisions:[{ply:2,moveGames:1,parentGames:1}]};
    expect(selectPreparationRoutes([row,row,row])).toHaveLength(1);
    expect(selectPreparationRoutes([{...row,games:0}])).toEqual([]);
  });

  it('uses bounded Maia evidence without changing opponent reach or decision coverage', () => {
    const row={games:50,scorePct:20,prefilterScore:100,ucis:['a','b'],preparationDecisions:[{ply:2,moveGames:50,parentGames:60}]};
    const low=preparationValue({...row,maiaScorePct:0});
    const high=preparationValue({...row,maiaScorePct:100});
    expect(low.conditionalReach).toBe(high.conditionalReach);
    expect(low.decisionCoverage).toBe(high.decisionCoverage);
    expect(low.value-high.value).toBeLessThan(2/52);
  });

  it('matches exhaustive unique-decision optimization, not additive route scores', () => {
    let seed=1927;
    const random=()=>((seed=(1664525*seed+1013904223)>>>0)/2**32);
    const paths=[['a'],['a','x','b'],['a','x','c'],['a','y','d'],['e'],['e','z','f']];
    const objective=set=>{
      const edges=new Map();
      let terminal=0;
      for(const row of set) {
        terminal+=preparationValue(row).terminalValue;
        for(const d of preparationDecisionWeights(row)) edges.set(row.ucis.slice(0,d.ply).join('>'),d.weight);
      }
      return terminal+[...edges.values()].reduce((a,b)=>a+b,0);
    };
    for(let sample=0;sample<30;sample++) {
      const rows=paths.map(ucis=>({ucis,games:4,prefilterScore:10+300*random(),
        preparationDecisions:ucis.length===1?[{ply:1,moveGames:40,parentGames:80}]:[{ply:1,moveGames:40,parentGames:80},{ply:3,moveGames:4,parentGames:8}]}));
      for(const limit of [1,2,3]) {
        let optimum=0;
        for(let mask=0;mask<2**rows.length;mask++) {
          const set=rows.filter((_,i)=>mask&(1<<i));
          if(set.length>limit || set.some((r,i)=>set.slice(i+1).some(s=>nestedRoutes(r,s)))) continue;
          optimum=Math.max(optimum,objective(set));
        }
        expect(objective(selectPreparationRoutes(rows,{limit}))).toBeCloseTo(optimum,10);
      }
    }
  });
});
