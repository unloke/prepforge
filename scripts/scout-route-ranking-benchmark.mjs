// Offline scoring v9/v10 comparison. No writes unless --out is supplied.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as old from '../research/scout-v9.js';
import * as current from '../web-src/scout.js';
import { rankPrefilterCandidates as oldAssess, scorePrefilterLine as oldScore } from '../research/scout-prefilter-v9.js';
import { rankPrefilterCandidates as newAssess, scorePrefilterLine as newScore } from '../web-src/scout-prefilter.js';
import { preparationValue, canonicalPosition, routeKey, nestedRoutes } from '../web-src/scout-preparation-value.js';

const fixture = 'tests/fixtures/scout/ericrosen-selection.json';
const cacheFile = 'tests/fixtures/scout/selection-stockfish.json';
const games = JSON.parse(readFileSync(fixture, 'utf8'));
const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
const evals = new Map(Object.entries(cache.evals));
const now = Math.max(...games.map(g => g.datestamp || 0));
const average = values => values.length ? values.reduce((s,v) => s+v,0)/values.length : null;
const percentile = (values,p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;
const lcp = (a,b) => { let i=0; while(i<Math.min(a.length,b.length) && a[i]===b[i]) i++; return i; };
const coverage = rows => {
  const fens = [...new Set(rows.map(r => current.fenAfterLine(r.ucis)))];
  const missing = fens.filter(fen => !evals.has(fen));
  return { candidates: rows.length, distinctReads: fens.length, hits: fens.length-missing.length,
    fraction: fens.length ? (fens.length-missing.length)/fens.length : 1, missingFens: missing };
};
function generate(api,color,limit=300,extra={}) {
  const baseline = api.opponentColorBaseline(games,color);
  const trie = api.buildOpeningTrie(games,color,{maxPlies:Infinity});
  const { branches, ancestorFreq } = api.rankedOpeningBranches(games,color,{trie,limit,baselineScorePct:baseline,now,...extra});
  return { branches, ancestorFreq, baseline, trie };
}
function pipeline(api,assess,color,mode,common) {
  const input = mode === 'same-pool' ? common : generate(api,color);
  const { branches, baseline, ancestorFreq } = input;
  const pool = mode === 'same-pool' ? branches : mode === 'fallback' ? branches : assess(branches,evals,{
    fenAfterLine: api.fenAfterLine,oppColor:color,baselineScorePct:baseline,ancestorFreq }).map(e => e.line);
  return { picks: api.rankGamePlan(pool,baseline,{oppColor:color}), funnel: { queued: branches.length, assessedEligible: pool.length } };
}
function diagnose(pick,evidence,baseline) {
  if (!evidence) throw new Error(`Missing common diagnostics for ${routeKey(pick)}`);
  // Both versions are judged on the same evidence: each pick's anchor (deepest
  // supported opponent-move prefix) from the current diagnostics.
  const r = { ...evidence, ...pick, selectionWdl: evidence.selectionWdl, selectionBaseline: evidence.selectionBaseline,
    preparationDecisions: evidence.preparationDecisions, routeSupportGames: evidence.routeSupportGames,
    routeWdl: evidence.routeWdl, routeScorePct: evidence.routeScorePct, evidencePlies: evidence.evidencePlies,
    conditionalReach: evidence.conditionalReach };
  const e = preparationValue(r,baseline);
  return { san: pick.sans.join(' '), ucis: pick.ucis, plies: pick.ucis.length, anchorPlies: evidence.evidencePlies ?? 0,
    exactGames: evidence.exactGames ?? null,
    opponentOnlyReach: e.conditionalReach, rawReach: e.rawReach,
    weakestChoiceEstimate: evidence.routeReach, rawScore: e.rawScore, shrunkScore: e.shrunkScore,
    n: e.support, nWeighted: e.weightedSupport, nEff: e.effectiveSupport, cp: pick.prefilterScore ?? null,
    mate: pick.userMate ?? pick.mateIn ?? null, utility: pick.preparationEvidence.value, comparableWeaknessUtility: e.value,
    sigma: e.sigma, baseline: e.baseline, canonicalPosition: canonicalPosition(current.fenAfterLine(pick.ucis)) };
}
function setMetrics(rows,color) {
  const overlaps = [], choices = new Map();
  let nestedPairs = 0;
  for(const [i,r] of rows.entries()) {
    for(const s of rows.slice(i+1)) {
      overlaps.push(lcp(r.ucis,s.ucis)/Math.min(r.plies,s.plies));
      if(nestedRoutes(r,s)) nestedPairs++;
    }
    for(let ply=0;ply<r.plies;ply++) {
      if((ply%2===0?'white':'black')===color) continue;
      const key = r.ucis.slice(0,ply).join('>');
      if(!choices.has(key)) choices.set(key,new Set());
      choices.get(key).add(r.ucis[ply]);
    }
  }
  const reach = rows.reduce((s,r) => s+r.opponentOnlyReach,0);
  return { count: rows.length, meanReach: average(rows.map(r => r.opponentOnlyReach)), medianReach: percentile(rows.map(r => r.opponentOnlyReach),0.5),
    meanRawScore: average(rows.map(r => r.rawScore)), meanShrunkScore: average(rows.map(r => r.shrunkScore)),
    reachWeightedShrunkScore: reach ? rows.reduce((s,r) => s+r.opponentOnlyReach*r.shrunkScore,0)/reach : null,
    meanSupport: average(rows.map(r => r.n)), singletonPicks: rows.filter(r => r.n<3).length,
    meanPlies: average(rows.map(r => r.plies)), minPlies: rows.length ? Math.min(...rows.map(r => r.plies)) : null,
    weakPicks: rows.filter(r => r.comparableWeaknessUtility > 0).length,
    meanPairwiseOverlap: average(overlaps) ?? 0, firstTwoPlyFamilies: new Set(rows.map(r => r.ucis.slice(0,2).join('>'))).size,
    nestedPairs, duplicatePositions: rows.length-new Set(rows.map(r => r.canonicalPosition)).size,
    conflictingUserChoiceNodes: [...choices.values()].filter(s => s.size>1).length,
    comparableWeaknessUtility: rows.reduce((s,r) => s+r.comparableWeaknessUtility,0) };
}
function measure(run) {
  const c0=performance.now(); run(); const coldMs=performance.now()-c0;
  for(let i=0;i<4;i++) run();
  const times=[]; let result;
  for(let i=0;i<30;i++) { const start=performance.now(); result=run(); times.push(performance.now()-start); }
  return { ...result, runtime: { coldMs, medianMs: percentile(times,0.5), p95Ms: percentile(times,0.95), warmups:5,runs:30 } };
}
const results=[];
for(const color of ['white','black']) {
  const diagnostics = generate(current,color,0,{plausibleOnly:false});
  const evidence = new Map(diagnostics.branches.map(r => [routeKey(r),r]));
  const oldInput = generate(old,color), newInput = generate(current,color);
  // Common assessed route pool isolates final selection, with each version's evidence.
  const keys = [...new Set([...oldInput.branches,...newInput.branches].map(routeKey))].sort();
  const commonNew = { ...diagnostics, branches: keys.map(k => evidence.get(k)).filter(r => r && evals.has(current.fenAfterLine(r.ucis))) };
  const allOld = new Map(generate(old,color,0).branches.map(r => [routeKey(r),r]));
  const commonOld = { ...oldInput, branches: commonNew.branches.map(r => allOld.get(routeKey(r))).filter(Boolean) };
  for (const [common, score, api] of [[commonOld, oldScore, old], [commonNew, newScore, current]])
    common.branches = common.branches.map(line => {
      const metrics = score(line, evals, { fenAfterLine: api.fenAfterLine, oppColor: color, ancestorFreq: common.ancestorFreq });
      return metrics ? { ...line, ...metrics } : null;
    }).filter(Boolean);
  for(const mode of ['end-to-end','same-pool','fallback']) {
    for(const [version,api,assess,common] of [['OLD v9',old,oldAssess,commonOld],['NEW v10',current,newAssess,commonNew]]) {
      const cacheCoverage = mode === 'fallback' ? null : coverage(mode === 'same-pool' ? common.branches : (version === 'OLD v9' ? oldInput : newInput).branches);
      const timed = measure(() => pipeline(api,assess,color,mode,common));
      // A v9 pick may be a synthesized branching prefix: judge it on the same anchor rule.
      const rows = timed.picks.map(r => diagnose(r,evidence.get(routeKey(r)) ?? current.annotateRouteEvidence({ ucis:r.ucis, sans:r.sans, games:0 },
        diagnostics.trie,color,{ baselineScorePct:diagnostics.baseline }),diagnostics.baseline));
      for(const r of rows) r.maxPrefixOverlap = Math.max(0,...rows.filter(s => s!==r).map(s => lcp(r.ucis,s.ucis)/Math.min(r.plies,s.plies)));
      results.push({color,mode,version,status:mode==='end-to-end' && coverage(newInput.branches).missingFens.length ? 'inconclusive: missing NEW engine reads' : 'complete',
        recommendations:rows,set:setMetrics(rows,color),runtime:timed.runtime,cache:cacheCoverage,funnel:timed.funnel});
    }
  }
}
const comparisons=[];
for(const color of ['white','black']) for(const mode of ['end-to-end','same-pool','fallback']) {
  const [a,b]=results.filter(r => r.color===color && r.mode===mode);
  comparisons.push({color,mode,conclusive:a.status==='complete' && b.status==='complete',acceptance:{
    scoreImprovement5pp: a.set.meanShrunkScore-b.set.meanShrunkScore >= 0.05,
    reachFloor:b.recommendations.every(r => r.opponentOnlyReach>=0.1),
    medianReach:b.set.medianReach>=0.5*a.set.medianReach,
    noSingletons:b.set.singletonPicks===0, fullSlate:b.set.count===12, fullLength:b.set.minPlies>=8,
    weakPicksNotFewer:b.set.weakPicks>=a.set.weakPicks, uniqueRows:b.set.nestedPairs+b.set.duplicatePositions===0,
    medianRuntime:b.runtime.medianMs<=1.25*a.runtime.medianMs,p95Runtime:b.runtime.p95Ms<=1.5*a.runtime.p95Ms,
    engineBudget:mode==='same-pool' ? null : b.funnel.queued<=300 }});
}
const output={fixture,games:games.length,cacheFile,engine:cache.engine,depth:cache.depth,maia:'unavailable; supplemental only',results,comparisons};
const pct = x => x == null ? '-' : `${(100*x).toFixed(1)}%`;
console.log('| Colour | Mode | Version | Picks | Weak | Plies mean/min | Reach mean/median | Opp score raw/shrunk | n mean | n<3 | Overlap | ms cold/median/p95 | Cache |');
console.log('|---|---|---|---:|---:|---|---|---|---:|---:|---:|---|---|');
for(const r of results) console.log(`| ${r.color} | ${r.mode} | ${r.version} | ${r.set.count} | ${r.set.weakPicks} | ${r.set.meanPlies?.toFixed(1) ?? '-'}/${r.set.minPlies ?? '-'} | ${pct(r.set.meanReach)}/${pct(r.set.medianReach)} | ${pct(r.set.meanRawScore)}/${pct(r.set.meanShrunkScore)} | ${r.set.meanSupport?.toFixed(1) ?? '-'} | ${r.set.singletonPicks} | ${r.set.meanPairwiseOverlap.toFixed(3)} | ${r.runtime.coldMs.toFixed(0)}/${r.runtime.medianMs.toFixed(1)}/${r.runtime.p95Ms.toFixed(1)} | ${r.cache ? pct(r.cache.fraction) : '-'} |`);
for(const r of results.filter(r => r.mode==='end-to-end')) console.log(`${r.color} ${r.version}: ${r.status}; missing reads ${r.cache.missingFens.length}`);
console.log(JSON.stringify(output,null,2));
const outIndex=process.argv.indexOf('--out');
if(outIndex>=0) {
  if(!process.argv[outIndex+1]) throw new Error('--out requires a path');
  writeFileSync(process.argv[outIndex+1],JSON.stringify(output,null,2)+'\n');
}
