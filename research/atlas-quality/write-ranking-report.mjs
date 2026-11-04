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
  'Baseline values are frozen at bab295f5. Current formulas fit the independent move-content judgments in facet-judgments.json; see [per-facet targets and family validation](facet-validation.md) and [failure/revision review](facet-calibration-review.md). These are development judgments, not external expert labels.', '',
  '## Same-opening comparisons', '',
  '| Broader example / compact example | Before | After | Interpretation |',
  '| --- | --- | --- | --- |',
];
for (const [a, b, color, meaning] of [
  ['A4EBp7Ds', 'UzKIIAtz', 'black', 'French: explicit second-move sidelines versus mostly single chapter routes.'],
  ['PDVt7Kbh', 'jtlLwUvh', 'black', 'Caro: branching two-knights/classical systems versus compact plans.'],
  ['2EaSmZtz', 'artuehhC', 'white', 'London: broader conditional repertoire versus connected narrower course/exercises; roles differ.'],
  ['FwXo3Qhq', 'nYAJ7Km3', 'black', 'Pirc: explicit Bc4/Be2/Bd3 and Nf3/e5 replies versus six compact chapters.'],
  ['1gqDv9cx', 'whCVdUeM', 'black', 'Stafford: broader noncooperative defenses now outrank the narrower trap set; both are legitimate scoped resources.'],
]) {
  const x = get(a, color), y = get(b, color);
  lines.push(`| ${a} / ${b} | ${number(x.baseline)} / ${number(y.baseline)} | ${number(x.final)} / ${number(y.final)} | ${meaning} |`);
}
lines.push('', '## Sensitivity', '',
  'Coefficients were fitted at the 32-ply bound. Other bounds change the available evidence and are development sensitivity checks, not separately calibrated models. Stored branch weights are not opponent frequencies.', '',
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
await writeFile('research/atlas-quality/ranking-review.md', lines.join('\n') + '\n');
