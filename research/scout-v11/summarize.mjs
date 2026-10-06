// Aggregate v10 vs v11 sessions against the pre-registered criteria in PROTOCOL.md.
// node summarize.mjs <outDir> [<knownOutDir>]
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [outDir, knownDir] = process.argv.slice(2);
const load = dir => readdirSync(resolve(dir, "sessions")).filter(f => f.endsWith(".json")).sort()
  .map(f => JSON.parse(readFileSync(resolve(dir, "sessions", f), "utf8")));
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };
const pct = x => x === null || !Number.isFinite(x) ? "n/a" : `${(100 * x).toFixed(1)}%`;

function aggregate(all) {
  const valid = all.filter(s => s.v10ReplayMatchesAudit !== false);
  const arm = name => {
    const a = valid.map(s => s.arms[name]);
    return { masks: sum(a, x => x.masks), fullFails: sum(a, x => x.fullFails), ownUnsafe: sum(a, x => x.ownUnsafe),
      rows: sum(a, x => x.rows), weak: sum(a, x => x.weak), unknown: sum(a, x => x.unknown), over100: sum(a, x => x.over100),
      riskFlags: sum(a, x => x.flags.risk), unverifiedFlags: sum(a, x => x.flags.unverified), flaggedMasks: sum(a, x => x.flaggedMasks),
      changedRows: sum(a, x => x.changedRows), sessionsChanged: a.filter(x => x.changedRows > 0).length,
      medianNodeRatio: median(a.map(x => x.nodeRatio).filter(Number.isFinite)), maxNodeRatio: Math.max(0, ...a.map(x => x.nodeRatio ?? 0)),
      medianAuditReads: median(a.map(x => x.auditReads ?? 0)), budgetExhausted: a.filter(x => x.budgetExhausted).length,
      sumValue: sum(a, x => x.sumValue), sumSoftValue: sum(a, x => x.sumSoftValue),
      meanReach: sum(a, x => x.meanReach ?? 0) / a.length, minReach: Math.min(...a.map(x => x.minReach)), minSupport: Math.min(...a.map(x => x.minSupport)),
      medianWorstCp: median(a.map(x => x.worstCp).filter(Number.isFinite)) };
  };
  const arms = Object.fromEntries(["v10", "v11", "v11-uncapped"].map(n => [n, arm(n)]));
  const perSession = valid.map(s => ({ id: s.id, split: s.split, v10: s.arms.v10.masks, v11: s.arms.v11.masks, uncapped: s.arms["v11-uncapped"].masks,
    rows: [s.arms.v10.rows, s.arms.v11.rows], weak: [s.arms.v10.weak, s.arms.v11.weak], changed: s.arms.v11.changedRows,
    ratio: s.arms.v11.nodeRatio, uncappedRatio: s.arms["v11-uncapped"].nodeRatio, worstCp: [s.arms.v10.worstCp, s.arms.v11.worstCp] }));
  const rec = valid.flatMap(s => s.recall).filter(r => r.native.status === "complete");
  const positives = rec.filter(r => r.native.ownUnsafe), maskPositives = rec.filter(r => r.native.mask);
  const recall = { rows: rec.length, nativeOwnUnsafe: positives.length, depth8Hits: positives.filter(r => r.depth8Unsafe).length,
    recall: positives.length ? positives.filter(r => r.depth8Unsafe).length / positives.length : null,
    maskRecall: maskPositives.length ? maskPositives.filter(r => r.depth8Unsafe).length / maskPositives.length : null,
    falseAlarms: rec.filter(r => !r.native.ownUnsafe && r.depth8Unsafe).length,
    fullAuditMedianNodeRatio: median(valid.map(s => s.v10LeafNodes ? sum(s.recall, r => r.nodes) / s.v10LeafNodes : null).filter(Number.isFinite)) };
  const reduction = arms.v10.masks ? 1 - arms.v11.masks / arms.v10.masks : null;
  const criteria = {
    maskReduction40: reduction !== null && reduction >= 0.4,
    noSessionMoreMasks: perSession.every(s => s.v11 <= s.v10),
    sameRowCount: perSession.every(s => s.rows[1] === s.rows[0]),
    weakCountKept: perSession.every(s => s.weak[1] >= s.weak[0]),
    extraNodesUnder40: arms.v11.maxNodeRatio < 0.4,
  };
  const kill = { depth8RecallBelow60: recall.recall !== null && recall.recall < 0.6, maskReductionBelow20: reduction === null || reduction < 0.2 };
  return { sessions: all.length, valid: valid.length, replayMismatches: all.length - valid.length, reduction,
    uncappedReduction: arms.v10.masks ? 1 - arms["v11-uncapped"].masks / arms.v10.masks : null,
    arms, recall, criteria, kill, verdict: Object.values(kill).some(Boolean) ? "KILL" : Object.values(criteria).every(Boolean) ? "PASS" : "FAIL", perSession };
}

const main = aggregate(load(outDir));
const known = knownDir && existsSync(resolve(knownDir, "sessions")) ? aggregate(load(knownDir)) : null;
writeFileSync(resolve(outDir, "SUMMARY.json"), JSON.stringify({ status: "complete", main, known }, null, 1));

const line = (name, a) => `| ${name} | ${a.masks} | ${a.fullFails} | ${a.rows} | ${a.weak} | ${a.riskFlags}/${a.unverifiedFlags} | ${a.changedRows} (${a.sessionsChanged}) | ${pct(a.medianNodeRatio)} / ${pct(a.maxNodeRatio)} | ${a.sumValue.toFixed(3)} | ${a.meanReach.toFixed(3)} | ${a.medianWorstCp} |`;
const section = (title, s) => [`## ${title}`, "",
  `Sessions ${s.sessions}（v10 replay 與 audit 不一致：${s.replayMismatches}）。Verdict：**${s.verdict}**。`, "",
  "| Arm | masks | full-path fails | rows | weak | risk/unverified | changed rows (sessions) | extra nodes median / max | Σutility | mean reach | median worst CP |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  line("v10", s.arms.v10), line("v11 (30% cap)", s.arms.v11), line("v11 uncapped (diagnostic)", s.arms["v11-uncapped"]), "",
  `Mask reduction：v11 ${pct(s.reduction)}，uncapped ${pct(s.uncappedReduction)}。`,
  `Depth8 detector recall on native16 own-decision failures：${pct(s.recall.recall)}（${s.recall.depth8Hits}/${s.recall.nativeOwnUnsafe}），mask recall ${pct(s.recall.maskRecall)}，false alarms ${s.recall.falseAlarms}/${s.recall.rows}；full audit of all v10 rows costs median ${pct(s.recall.fullAuditMedianNodeRatio)} of leaf nodes。`, "",
  `Criteria：${JSON.stringify(s.criteria)}`, `Kill：${JSON.stringify(s.kill)}`, ""];
const report = ["# Scout v11 path guard vs v10", "",
  "Native16 只作 evaluator；v11 決策只用 production depth8（Stockfish 19 lite-single, Hash 16）。成本以 Stockfish nodes 計，相對同 session v10 leaf nodes。", "",
  ...section("Train + development", main), ...(known ? section("Known problems（非獨立資料）", known) : [])];
writeFileSync(resolve(outDir, "REPORT.zh-TW.md"), report.join("\n"));
console.log(JSON.stringify({ verdict: main.verdict, reduction: main.reduction, criteria: main.criteria, kill: main.kill, recall: main.recall, known: known && { verdict: known.verdict, reduction: known.reduction } }));
