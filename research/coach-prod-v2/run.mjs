// Production coach prose on the coach-v5 reads: Stockfish 19 full NNUE at depth 22, a research
// setting, not the product's (Analyze reads with lite at 12, then 16 where the router asks;
// research/coach-relations/prod-depth runs that). Run from the repo root:
//   node research/coach-prod-v2/run.mjs <ids.json|all> <out.jsonl>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { buildMoveFeatures, buildCommentary } from "../../web-src/coach/bundle.js";

const V5 = "research/sft/experiment/coach-v5-20261011";
const [idsArg, outPath] = process.argv.slice(2);
const positions = new Map(readFileSync(`${V5}/positions.jsonl`, "utf8").trim().split(/\r?\n/).map((l) => { const p = JSON.parse(l); return [p.id, p]; }));
const reads = new Map();
for (const f of readdirSync(`${V5}/reads`).filter((f) => f.endsWith(".out.jsonl"))) {
  for (const l of readFileSync(`${V5}/reads/${f}`, "utf8").trim().split(/\r?\n/).filter(Boolean)) { const r = JSON.parse(l); reads.set(r.id, r); }
}
const ids = idsArg === "all" ? [...reads.keys()] : JSON.parse(readFileSync(idsArg, "utf8"));

function sans(fen, ucis) {
  const b = new Chess(fen), out = [];
  for (const u of ucis) { try { out.push(b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })?.san); } catch { break; } }
  return out;
}
// Stored reads are side-to-move POV; features want White POV.
function line(fen, r) {
  const s = fen.split(" ")[1] === "b" ? -1 : 1;
  return { uci: r.pv[0], san: sans(fen, r.pv.slice(0, 1))[0], cp: r.cp === null ? null : s * r.cp, mate: r.mate === null ? null : s * r.mate, pvUci: r.pv, pvSan: sans(fen, r.pv) };
}

export function features(id) {
  const p = positions.get(id), r = reads.get(id);
  const b = new Chess(p.fenBefore);
  const mv = b.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), promotion: p.uci[4] });
  const fenAfter = b.fen();
  const mover = mv.color === "w" ? "white" : "black";
  const after = r.after ? line(fenAfter, r.after) : { cp: b.isCheckmate() ? null : 0, mate: b.isCheckmate() ? (mover === "white" ? 1 : -1) : null, pvUci: [], pvSan: [] };
  return buildMoveFeatures({ mover, uci: p.uci, san: mv.san, fenBefore: p.fenBefore, fenAfter, moveNumber: Number(p.fenBefore.split(" ")[5]),
    beforeEval: { lines: [line(p.fenBefore, r.before)] }, afterEval: { cp: after.cp, mate: after.mate, pvUci: after.pvUci, pvSan: after.pvSan } });
}

if (outPath) {
  const rows = ids.map((id) => { const f = features(id); return { id, fen: f.fenBefore, fenAfter: f.fenAfter, mover: f.mover, moveNumber: f.moveNumber, uci: f.uci, san: f.san, bestUci: f.bestUci, bestSan: f.bestSan, isBest: f.isBest, code: f.classification.code, prose: buildCommentary(f, { selfSide: f.mover }).prose }; });
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
