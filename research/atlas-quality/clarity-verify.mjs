// Verify saved results against present source bytes; no engine/network/large fixture.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const dir = 'research/atlas-quality';
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const sha = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const results = read(`${dir}/clarity-results.json`);
const manifest = read(`${dir}/corpus/manifest.json`);
assert.equal(results.meta.scorerSha256, sha('web-src/atlas-quality.js'));
assert.equal(results.meta.manifestSha256, sha(`${dir}/corpus/manifest.json`));
assert.equal(results.meta.inputProducerSha256, sha(`${dir}/clarity-inputs.py`));
assert.equal(results.meta.evaluatorSha256, sha(`${dir}/clarity-evaluate.mjs`));
for (const source of results.meta.manualReviews) assert.equal(source.sha256, sha(source.file));
assert.equal(manifest.length, 38);
assert.deepEqual(results.studies.map(s => s.studyId), manifest.map(s => s.id));
assert.equal(new Set(manifest.map(s => s.id)).size, 38);
let scopes = 0;
function verifyScore(value) {
  for (const f of value.facets) {
    assert(Number.isInteger(f.numerator) && Number.isInteger(f.denominator));
    assert(f.numerator >= 0 && f.numerator <= f.denominator);
    const expected = f.denominator ? 100 * f.numerator / f.denominator : null;
    assert(expected === null ? f.value === null : Math.abs(f.value - expected) < 1e-10);
  }
  if (value.score !== null) {
    const applicable = value.facets.filter(f => f.value !== null);
    assert(Math.abs(value.score - applicable.reduce((sum, f) => sum + f.value, 0) / applicable.length) < 1e-10);
  }
}
for (const [i, study] of results.studies.entries()) {
  assert.equal(study.pgnSha256, manifest[i].sha256);
  assert.equal(study.pgnSha256, sha(`${dir}/corpus/${manifest[i].file}`));
  verifyScore(study);
  for (const root of study.exactRootScores) verifyScore(root);
  scopes += study.mergedRootCount;
  if (study.manual.label !== 'unreviewed') {
    const text = fs.readFileSync(`${dir}/${study.manual.reviewerFile}`, 'utf8');
    assert(text.includes(` ${study.manual.evidenceHeading}`));
  }
}
const labels = read(`${dir}/manual-review-labels.json`);
assert.deepEqual(labels.studies.map(s => s.label), results.studies.map(s => s.manual.label));
const catalog = fs.readFileSync(`${dir}/catalog.md`, 'utf8');
for (const study of results.studies) assert(catalog.includes(`https://lichess.org/study/${study.studyId}`));
assert.equal(scopes, 105);
console.log(JSON.stringify({verifiedStudies: 38, mergedRootScopes: scopes, scorerSha256: results.meta.scorerSha256,
  verification: 'Source/scorer/review hashes, all facet arithmetic, catalog coverage and manual evidence headings passed.'}));
