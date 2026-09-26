import { rankGamePlan as baselineRanking } from "../research/scout-selection-baseline.js";
import { greedyPreparationRoutes } from "../research/scout-selection-greedy.js";
// Reproducible decision scenarios, not claims of measured playing-strength gains.
import { rankGamePlan } from '../web-src/scout.js';
import { preparationValue, nestedRoutes } from '../web-src/scout-preparation-value.js';
import { writeFileSync } from 'node:fs';

const routeFamily = r => r.ucis.slice(0, 2).join(">");
const make = (id, path, support, total, cp, maia = null, terminal = support) => ({
  id, ucis: path.split(' '), sans: path.split(' '), games: terminal,
  routeSupportGames: support, evidenceGames: total, routeReach: 0.8,
  scorePct: 30, routeScorePct: 30, w: 0, d: 0, l: terminal,
  share: support / total, prefilterScore: cp, maiaScorePct: maia,
});
const trunk = 'e2e4 e7e5 g1f3 b8c6';
export const scenarios = [
  { name: "parent-vs-two-children", budget: 2, expected: ["right","left"], rows: [make("parent",trunk,81,100,50,null,1),make("left",trunk+" f1c4 f8c5",40,100,100),make("right",trunk+" f1b5 a7a6",40,100,100)] },
  { name: 'sparse-child-1', budget: 1, expected: ['trunk'], rows: [make('trunk',trunk,41,100,30,null,40),make('child',trunk+' f1c4 f8c5',1,100,35)] },
  { name: 'sparse-child-2', budget: 1, expected: ['trunk'], rows: [make('trunk',trunk,42,100,30,null,40),make('child',trunk+' f1c4 f8c5',2,100,35)] },
  { name: 'stable-deeper', budget: 1, expected: ['child'], rows: [make('trunk',trunk,80,100,30,null,10),make('child',trunk+' f1c4 f8c5',70,100,100)] },
  { name: 'equal-percent-different-n', budget: 1, expected: ['large'], rows: [make('small','e2e4 c7c5',1,2,80,10),make('large','d2d4 d7d5',40,80,80,40)] },
  { name: 'frequency-opportunity', budget: 1, expected: ['opportunity'], rows: [make('frequent','e2e4 c7c5',80,100,5),make('opportunity','d2d4 d7d5',20,100,200)] },
  { name: 'rare-huge-engine', budget: 1, expected: ['relevant'], rows: [make('relevant','e2e4 c7c5',60,100,60),make('rare','d2d4 d7d5',1,100,2000)] },
  { name: 'maia-personal-conflict', budget: 1, expected: ['personal'], rows: [make('personal','e2e4 c7c5',60,100,60,65),make('maia','d2d4 d7d5',2,100,120,5)] },
  { name: 'nested-chain', budget: 3, expected: ['trunk'], rows: [make('trunk',trunk,80,100,40,null,40),make('child',trunk+' f1c4 f8c5',40,100,45,null,30),make('deep',trunk+' f1c4 f8c5 d2d3 d7d6',10,100,50)] },
  { name: 'families-compete', budget: 2, expected: ['a1','a2'], rows: [make('a1',trunk+' f1c4 f8c5',30,100,100),make('a2',trunk+' f1b5 a7a6',28,100,100),make('b','d2d4 d7d5 c2c4 e7e6',22,100,100)] },
  { name: 'family-flood', budget: 3, expected: ['a0','a1','a2'], rows: [...Array.from({length:8},(_,i)=>make('a'+i,trunk+' choice'+i+' reply',10,100,100)),make('b','d2d4 d7d5',9,100,100),make('c','c2c4 e7e5',8,100,100)] },
];

function independent(rows, budget) {
  const out=[];
  for(const r of [...rows].sort((a,b)=>preparationValue(b).value-preparationValue(a).value)) {
    if(!out.some(s=>nestedRoutes(s,r))) out.push(r);
    if(out.length===budget) break;
  }
  return out;
}
function mmr(rows,budget) {
  const out=[];
  while(out.length<budget) {
    const pool=rows.filter(r=>!out.some(s=>nestedRoutes(s,r)));
    pool.sort((a,b)=>score(b)-score(a));
    function score(r) { return preparationValue(r).value * (out.some(s=>routeFamily(s)===routeFamily(r)) ? 0.5 : 1); }
    if(!pool.length) break;
    out.push(pool[0]);
  }
  return out;
}
export function study() {
  return scenarios.map(s=>({scenario:s.name, expected:s.expected,
    baseline:baselineRanking(s.rows,50,{limit:s.budget}).map(r=>r.id),
    greedy:greedyPreparationRoutes(s.rows,{limit:s.budget}).map(r=>r.id),
    production:rankGamePlan(s.rows,50,{limit:s.budget}).map(r=>r.id),
    independent:independent(s.rows,s.budget).map(r=>r.id),
    mmr:mmr(s.rows,s.budget).map(r=>r.id),
  }));
}
if(process.argv[1]?.endsWith('scout-production-selection-study.mjs')) {
  const results=study();
  console.table(results.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v]))));
  if(process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(results,null,2)+'\n');
}
