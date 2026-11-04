import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { calibratedAtlasValue } from '../../web-src/atlas-calibration.js';
import { scorerFingerprint } from './scorer-fingerprint.mjs';

const read = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const fit = await read('facet-fit-results.json');
const labels = await readFile(new URL('facet-judgments.json', import.meta.url));
assert.equal(createHash('sha256').update(labels).digest('hex'), fit.judgments_sha256);
const features = await read('facet-features.json');
const evaluated = await read('preparation-results.json');
assert.equal(await scorerFingerprint(), evaluated.scorer_sha256);
const reports = new Map(evaluated.studies.flatMap((study) => study.reports.map((r) => [`${study.study_id}/${r.color}`, r])));
for (const row of features.rows) {
  const actual = reports.get(`${row.id}/${row.color}`);
  for (const [key, metric] of Object.entries(fit.metrics)) {
    const target = metric.rows.find((r) => r.id === row.id && r.color === row.color);
    const shipped = key === 'overall' ? actual.score : actual.facets.find((f) => f.key === key).value;
    assert(Math.abs(calibratedAtlasValue(key, row.features) - target.fitted) < 0.00001, `Coefficient mismatch ${row.id}/${key}`);
    assert(Math.abs(shipped - target.fitted) < 0.00001, `Corpus output mismatch ${row.id}/${key}`);
  }
}
assert.equal(features.rows.length, 45);
console.log('270 fitted values match shipped coefficients and fresh-PGN corpus outputs; frozen judgment and scorer hashes verified.');
