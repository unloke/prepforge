// Reproduce #80 on pinned public games. --refresh-engine regenerates actual
// Stockfish 19 lite depth-8 reads; normal runs are deterministic and offline.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { buildOpeningTrie, rankedOpeningBranches, fenAfterLine, rankGamePlan, opponentColorBaseline } from '../web-src/scout.js';
import { rankPrefilterCandidates } from '../web-src/scout-prefilter.js';
import { preparationValue as oldValue, selectPreparationRoutes as oldSelect } from '../research/scout-selection-v8.js';
import { preparationValue, preparationDecisionWeights, routeKey } from '../web-src/scout-preparation-value.js';
import { parseFinalDepthScore, parseBestMove } from '../web-src/scout-stockfish-uci.js';

const fixture = 'tests/fixtures/scout/ericrosen-selection.json';
const cacheFile = 'tests/fixtures/scout/selection-stockfish.json';
const games = JSON.parse(readFileSync(fixture,'utf8'));
const inputs = ['white','black'].map(color => {
  const baseline = opponentColorBaseline(games,color);
  const trie = buildOpeningTrie(games,color,{maxPlies:Infinity});
  const all = rankedOpeningBranches(games,color,{trie,limit:0,baselineScorePct:baseline}).branches;
  const before = [...all].sort((a,b)=>oldValue(b,baseline).value-oldValue(a,baseline).value || routeKey(a).localeCompare(routeKey(b))).slice(0,300);
  const after = [...all].sort((a,b)=>preparationValue(b,baseline).value-preparationValue(a,baseline).value || routeKey(a).localeCompare(routeKey(b))).slice(0,300);
  return {color,baseline,all,before,after};
});

if (process.argv.includes('--refresh-engine')) {
  const engine = spawn(process.execPath,[resolve('node_modules/stockfish/bin/stockfish-19-lite-single.js')]);
  let buffer = '';
  let pending;
  engine.stdout.on('data',chunk=>{buffer+=chunk; if(pending?.done(buffer)) pending.resolve(buffer);});
  engine.stderr.on('data',chunk=>process.stderr.write(chunk));
  const command = (cmd,done) => new Promise((resolveCommand,reject)=>{
    const timer=setTimeout(()=>{pending=null;reject(new Error('Stockfish timeout'));},20000);
    buffer=''; pending={done,resolve:value=>{clearTimeout(timer);pending=null;resolveCommand(value);}};
    engine.stdin.write(cmd+'\n');
  });
  const evals={};
  try {
    await command('uci',s=>s.includes('uciok'));
    await command('setoption name Hash value 16\nisready',s=>s.includes('readyok'));
    const fens=[...new Set(inputs.flatMap(i=>[...i.before,...i.after].map(r=>fenAfterLine(r.ucis))))].sort();
    for(const [index,fen] of fens.entries()) {
      await command('ucinewgame\nisready',s=>s.includes('readyok'));
      const output=await command(`position fen ${fen}\ngo depth 8`,s=>s.includes('bestmove'));
      if(!/info depth 8 /.test(output) && !/bestmove \(none\)|bestmove 0000/.test(output)) throw new Error(`Missing depth-8 evaluation: ${output}`);
      const score=parseFinalDepthScore(output,8);
      const sign=fen.split(' ')[1]==='w'?1:-1;
      evals[fen]={score_cp:score.type==='cp'?score.cp*sign:0,
        mate_in:score.type==='mate'?score.value*sign:0,best_move_uci:parseBestMove(output)};
      if(index%100===0) console.log(`Stockfish ${index+1}/${fens.length}`);
    }
    writeFileSync(cacheFile,JSON.stringify({engine:'stockfish-19-lite-single',depth:8,hashMiB:16,resetPerPosition:true,evals},null,2)+'\n');
  } finally { engine.kill(); }
}
const cache=JSON.parse(readFileSync(cacheFile,'utf8'));
const evalMap=new Map(Object.entries(cache.evals));
const summarize = (selected) => {
  const decisions=new Map();
  for(const r of selected) for(const d of preparationDecisionWeights(r)) decisions.set(r.ucis.slice(0,d.ply).join('>'),d.weight);
  return {count:selected.length,shallow:selected.filter(r=>r.ucis.length<=2).length,
    singleGame:selected.filter(r=>r.routeSupportGames===1).length,
    decisionCount:decisions.size,decisionValue:[...decisions.values()].reduce((a,b)=>a+b,0),
    routes:selected.map(r=>({san:r.sans.join(' '),ucis:r.ucis,support:r.routeSupportGames,cp:r.prefilterScore,
      conditionalReach:preparationValue(r).conditionalReach}))};
};
const results=inputs.map(({color,baseline,all,before,after})=>{
  for(const route of [...before,...after]) if(!evalMap.has(fenAfterLine(route.ucis))) throw new Error('Refresh the engine fixture');
  const assess=rows=>rankPrefilterCandidates(rows,evalMap,{fenAfterLine,oppColor:color,baselineScorePct:baseline}).map(e=>e.line);
  return {color,baseline,observedCandidates:all.length,
    fallbackBefore:summarize(oldSelect(before,{baseline})),
    fallbackAfter:summarize(rankGamePlan(after,baseline,{oppColor:color})),
    assessedBefore:summarize(oldSelect(assess(before),{baseline})),
    assessedAfter:summarize(rankGamePlan(assess(after),baseline,{oppColor:color})),
    samePoolBefore:summarize(oldSelect(assess(after),{baseline})),
  };
});
writeFileSync('docs/scout-selection-v2-results.json',JSON.stringify({fixture,games:games.length,engine:cache.engine,depth:cache.depth,
  maia:'unavailable; separately tested as bounded supplemental evidence',results},null,2)+'\n');
console.table(results.flatMap(r=>['fallbackBefore','fallbackAfter','assessedBefore','assessedAfter','samePoolBefore'].map(mode=>({color:r.color,mode,...Object.fromEntries(Object.entries(r[mode]).filter(([k])=>k!=='routes'))}))));
