// Browser-side cost of a router: features of each screen read plus one model call per move.
//
//   node infer-bench.mjs <models.json> <reads.ndjson> [positions=3000]
import { readFileSync } from "node:fs";

import { positionFeatures } from "./features.mjs";
import { predict } from "./predict.mjs";

const [modelsPath, readsPath, count] = process.argv.slice(2);
const models = JSON.parse(readFileSync(modelsPath, "utf8"));
const reads = readFileSync(readsPath, "utf8").split("\n").filter(Boolean).slice(0, Number(count) || 3000).map((l) => JSON.parse(l));
// Warm up, then time the features of every position.
for (const r of reads.slice(0, 200)) positionFeatures(r.fen, r.it);
let t0 = performance.now();
const feats = reads.map((r) => positionFeatures(r.fen, r.it));
const featureUs = ((performance.now() - t0) * 1000) / reads.length;
const result = { positions: reads.length, featureUsPerPosition: +featureUs.toFixed(1), models: {} };
for (const [name, m] of Object.entries(models)) {
  const width = m.names.length;
  const rows = feats.slice(1).map((f, i) => (width > f.length * 2 ? [...feats[i], ...f] : f).concat(new Array(width).fill(0)).slice(0, width));
  for (const x of rows.slice(0, 200)) predict(m, x);
  t0 = performance.now();
  let sink = 0;
  for (let rep = 0; rep < 5; rep++) for (const x of rows) sink += predict(m, x);
  const us = ((performance.now() - t0) * 1000) / (rows.length * 5);
  result.models[name] = { usPerCall: +us.toFixed(2), bytes: JSON.stringify(m).length, sink: Number.isFinite(sink) };
}
console.log(JSON.stringify(result));
