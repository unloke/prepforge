// Before/after of the coach's prose on the coach-precision sample (tmp/coach-precision-rows.json,
// written by scripts/coach/opponent-read-sample.mjs). Prints every move whose read changed.
//   node scripts/coach/reason-diff.mjs [--all-reads] [--json out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { buildCommentary } from "../../web-src/coach/bundle.js";

const snap = JSON.parse(readFileSync("tmp/coach-precision-rows.json", "utf8"));
const allReads = process.argv.includes("--all-reads");
const jsonAt = process.argv.indexOf("--json");
const out = [];
const counts = {};
for (const r of snap.rows) {
  for (const read of allReads ? ["own", "opponent"] : [r.actualRead]) {
    const opp = read === "opponent";
    const selfSide = opp ? (r.mover === "white" ? "black" : "white") : r.mover;
    const now = buildCommentary(opp ? { ...r.features, opponentRead: true } : r.features, { selfSide }).prose;
    if (now === r[read]) continue;
    const c = (counts[`${read} ${r.code}`] ??= 0);
    counts[`${read} ${r.code}`] = c + 1;
    out.push({ id: `${r.game}/${r.ply}`, san: r.san, code: r.code, read, fen: r.fenBefore, playedPv: r.features.playedPvUci?.slice(0, 6), bestPv: r.features.bestPvUci?.slice(0, 6), old: r[read], now });
  }
}
for (const o of out) console.log(`${o.id} ${o.san} [${o.code}; ${o.read}]\n  fen ${o.fen}\n  played ${o.playedPv?.join(" ")} | best ${o.bestPv?.join(" ")}\n  OLD ${o.old}\n  NEW ${o.now}`);
console.log(counts, "changed:", out.length);
if (jsonAt >= 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2));
