import { readFile, writeFile } from 'node:fs/promises';
const read = async (name) => JSON.parse(await readFile(`research/atlas-quality/${name}`, 'utf8'));
const report = await read('ranking-calibration.json');
const manifest = await read('corpus/manifest.json');
const stars = await read('corpus/stars.json');
const rows = report.observations;
const get = (id, color = 'black') => rows.find((r) => r.id === id && r.color === color);
const number = (n) => n == null ? '—' : n.toFixed(1);
const lines = [
  '# Ranking and calibration review', '',
  'These are development comparisons over 38 saved studies / 45 side reports. Every source informed the method; there is no untouched quality holdout. The total describes demonstrated preparation, not chess strength or teaching quality. Low likes are never negative labels. See [content re-review](content-review.md) for sampled move evidence and failed assumptions.', '',
  '## Controlled damage', '',
  `Truncating every tree at eight relative plies increased ${report.shortened_increases.length}/${rows.length} scores. Deleting the continuations of every fifth non-root own decision increased ${report.holes_increases.length}/${rows.length} scores. These transformations are deterministic and documented in calibrate-preparation.mjs; they test missing preparation, not whether authors are good or bad.`, '',
  'The first phase trial still rewarded truncating bbxmDYZV/black by 0.48 points. Horizon scoping alone did not fix it. Removing the second weighting of reply gaps and refusing depth credit for unanswered opponent moves fixes that counterexample. Frozen first-trial numbers are in calibration-baselines.json.', '',
  '## Same-opening comparisons', '',
  '| Broader example / compact example | Before | After | Interpretation |',
  '| --- | --- | --- | --- |',
];
for (const [a, b, color, meaning] of [
  ['A4EBp7Ds', 'UzKIIAtz', 'black', 'French: explicit second-move sidelines versus mostly single chapter routes.'],
  ['PDVt7Kbh', 'jtlLwUvh', 'black', 'Caro: branching two-knights/classical systems versus compact plans.'],
  ['2EaSmZtz', 'artuehhC', 'white', 'London: broader conditional repertoire versus connected narrower course/exercises; roles differ.'],
  ['FwXo3Qhq', 'nYAJ7Km3', 'black', 'Pirc: explicit Bc4/Be2/Bd3 and Nf3/e5 replies versus six compact chapters.'],
  ['1gqDv9cx', 'whCVdUeM', 'black', 'Stafford remains an ambiguity: broader investigation has less complete core routes; not a forced good/bad pair.'],
]) {
  const x = get(a, color), y = get(b, color);
  lines.push(`| ${a} / ${b} | ${number(x.baseline)} / ${number(y.baseline)} | ${number(x.final)} / ${number(y.final)} | ${meaning} |`);
}
lines.push('', '## Sensitivity', '',
  'Reach uses a smooth scale of four additional answered alternatives. Sensitivity is recorded rather than assumed: the London ordering flips at scale two, so that comparison is marginal, not validation of a definite quality preference. French/Caro/Pirc comparisons retain their direction at scales two and eight. The total contains no popularity fitting.', '',
  '| Case | 16-ply bound | 24-ply bound | 32-ply bound |', '| --- | --- | --- | --- |');
for (const id of ['A4EBp7Ds', 'UzKIIAtz', 'PDVt7Kbh', 'jtlLwUvh', '1gqDv9cx', 'whCVdUeM']) {
  const r = get(id), h = r.horizon_sensitivity;
  lines.push(`| ${id} | ${number(h.h16)} | ${number(h.h24)} | ${number(h.h32)} |`);
}
lines.push('', 'The bound still matters for unresolved or undeveloped endpoints. A stable phase boundary makes completed openings independent of later game length, but short demonstration chapters cannot always be recognized from moves alone. The 32-ply bound avoids calling every long single line fully prepared at ply 16; it is not a validated universal opening length.', '',
  '## All side reports', '',
  'Sorted for inspection, not a universal quality leaderboard. Model-game collections and opening samplers have different intended scope. Likes are saved reception context; they do not enter the calculation.', '',
  '| Study / side | Role | Likes | Before | After | Shortened | Missing replies |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of [...rows].sort((a, b) => b.final - a.final)) {
  const m = manifest.find((m) => m.id === r.id), likes = stars.find((s) => s.study_id === r.id)?.likes;
  lines.push(`| [${m.title.replaceAll('|', '/')}](https://lichess.org/study/${r.id}) / ${r.color} | ${r.role} | ${likes ?? '—'} | ${number(r.baseline)} | ${number(r.final)} | ${number(r.shortened.score)} | ${number(r.holes.score)} |`);
}
lines.push('', '| Pair | Scale 2 | Scale 4 | Scale 8 |', '| --- | --- | --- | --- |');
for (const [a, b, color] of [['A4EBp7Ds','UzKIIAtz','black'], ['PDVt7Kbh','jtlLwUvh','black'],
  ['2EaSmZtz','artuehhC','white'], ['FwXo3Qhq','nYAJ7Km3','black'], ['1gqDv9cx','whCVdUeM','black']]) {
  const x = get(a, color), y = get(b, color);
  lines.push(`| ${a} / ${b} | ${[2,4,8].map((scale) => `${number(x.breadth_sensitivity.find((v) => v.scale === scale).score)} / ${number(y.breadth_sensitivity.find((v) => v.scale === scale).score)}`).join(' | ')} |`);
}
await writeFile('research/atlas-quality/ranking-review.md', lines.join('\n') + '\n');
