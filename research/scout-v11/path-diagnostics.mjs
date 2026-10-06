// Descriptive audit only: adjacent fixed-depth scores are not exact regret.
import {adverseMate, lostWinningMate} from './mate-semantics.mjs';
export function diagnosePath(receipts, subjectColor, anchorPlies, gatePlies) {
  const sign=subjectColor==='white'?-1:1;
  const preparing=subjectColor==='white'?'black':'white';
  const missing=receipts.flatMap((r,ply)=>r?[]:[ply]);
  if(missing.length)return {status:'unknown',missingPlies:missing};
  const values=receipts.map(r=>Number.isFinite(r.whiteCp)?sign*r.whiteCp:null);
  const decisions=[];
  for(let ply=1;ply<receipts.length;ply++){
    const mover=ply%2?'white':'black',ours=mover!==subjectColor;
    const change=values[ply]!==null&&values[ply-1]!==null?values[ply]-values[ply-1]:null;
    decisions.push({ply,mover,ours,phase:ply<=anchorPlies?'steering':'continuation',beforeCp:values[ply-1],afterCp:values[ply],
      adjacentLossProxy:ours&&change!==null?Math.max(0,-change):null,opponentRecoveryProxy:!ours&&change!==null?Math.max(0,change):null,
      beforeMate:receipts[ply-1].whiteMate===null?null:sign*receipts[ply-1].whiteMate,
      afterMate:receipts[ply].whiteMate===null?null:sign*receipts[ply].whiteMate,
      beforeTerminalWinner:receipts[ply-1].terminalWinner??null,afterTerminalWinner:receipts[ply].terminalWinner??null});
  }
  const finite=values.filter(Number.isFinite),gate=values[gatePlies];
  const gateMate=receipts[gatePlies].whiteMate===null?null:sign*receipts[gatePlies].whiteMate;
  const winner=receipts[gatePlies].terminalWinner;
  const gateKnown=Number.isFinite(gate)||Number.isFinite(gateMate)||Boolean(winner);
  const gatePass=gateKnown&&winner!==subjectColor&&!(gateMate<0)&&!(Number.isFinite(gate)&&gate< -75);
  const rescued=decisions.filter(d=>!d.ours&&d.beforeCp!==null&&d.afterCp!==null&&d.beforeCp< -75&&d.afterCp>=-75&&d.ply<=gatePlies);
  let longest=0,streak=0;
  for(const d of decisions.filter(d=>d.ours)){streak=d.afterCp!==null&&d.afterCp< -75?streak+1:0;longest=Math.max(longest,streak);}
  return {status:'complete',proxyDefinition:'adjacent scores at fixed depth; not best-response regret',gateCp:gate,gateMate,gateKnown,gatePass,
    worstCp:finite.length?Math.min(...finite):null,worstPlies:finite.length?values.flatMap((v,p)=>v===Math.min(...finite)?[p]:[]):[],
    adverseMatePlies:receipts.flatMap((r,p)=>adverseMate(sign*r.whiteMate,r.terminalWinner,preparing)?[p]:[]),
    terminalWinners:receipts.flatMap((r,p)=>r.terminalWinner?[{ply:p,winner:r.terminalWinner}]:[]),
    disadvantagedOwnDecisions:decisions.filter(d=>d.ours&&d.afterCp!==null&&d.afterCp< -75).length,
    longestDisadvantagedOwnDecisionStreak:longest,
    adverseMateDecisions:decisions.filter(d=>d.ours&&adverseMate(d.afterMate,d.afterTerminalWinner,preparing)).map(d=>d.ply),
    lostWinningMateDecisions:decisions.filter(d=>d.ours&&lostWinningMate(d.beforeMate,d.afterMate,d.afterTerminalWinner,preparing)).map(d=>d.ply),
    endpointMasksEarlierDisadvantage:gatePass&&values.slice(0,gatePlies).some(v=>v!==null&&v< -75),
    opponentRescueCrossings:rescued,decisions,
    byPhase:Object.fromEntries(['steering','continuation'].map(phase=>{
      const ds=decisions.filter(d=>d.ours&&d.phase===phase),loss=ds.map(d=>d.adjacentLossProxy).filter(Number.isFinite);
      return [phase,{decisions:ds.length,meanAdjacentLossProxy:loss.length?loss.reduce((a,b)=>a+b,0)/loss.length:null,
        maxAdjacentLossProxy:loss.length?Math.max(...loss):null,over100:loss.filter(v=>v>100).length}];
    }))};
}
