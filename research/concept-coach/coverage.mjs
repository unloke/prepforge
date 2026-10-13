// How often the Coach's engine-free detectors name each concept a GameKnot comment mentions.
// Engine-line reasons (material won, defends, blocks, reply and cost reasons) need engine reads
// the comments lack, so this is the Coach's floor for those concepts.
// Run from the repo root: node research/concept-coach/coverage.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { describeMove } from "../../web-src/coach/move-facts.js";
import { motifPhrase } from "../../web-src/coach/motifs.js";
import { concept } from "./concepts.mjs";

const LABELS = "artifacts/benchmarks/concept-labels-20261012/freebuff/dataset/labels.jsonl";
const stats = {};
for (const line of readFileSync(LABELS, "utf8").trim().split(/\r?\n/)) {
  const r = JSON.parse(line);
  const named = new Set();
  for (const part of describeMove(r.before, null, r.move).split(/, | and (?=[a-z]+s )/)) if (part) named.add(concept(part));
  const motif = motifPhrase(r.before, null, r.move);
  if (motif) named.add(concept(motif));
  for (const t of new Set([...r.tags, ...named])) {
    const s = (stats[t] ??= { labelled: 0, named: 0, both: 0 });
    s.labelled += r.tags.includes(t);
    s.named += named.has(t);
    s.both += r.tags.includes(t) && named.has(t);
  }
}
for (const s of Object.values(stats)) {
  s.recall = s.labelled ? +(s.both / s.labelled).toFixed(3) : null;
  s.precision = s.named ? +(s.both / s.named).toFixed(3) : null;
}
writeFileSync("research/concept-coach/coverage.json", JSON.stringify(stats, null, 1) + "\n");
console.log(Object.entries(stats).sort((a, b) => b[1].labelled - a[1].labelled).map(([t, s]) => `${t.padEnd(20)} ${String(s.labelled).padStart(5)} recall ${s.recall} precision ${s.precision}`).join("\n"));
