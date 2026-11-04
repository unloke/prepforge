// Offline evaluation of the exact documentation core; no engine or network.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { atlasClarity } from '../../web-src/atlas-quality.js';

const DIR = 'research/atlas-quality';
const INPUT = 'tmp/atlas-clarity-inputs.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = fen => fen.split(' ').slice(0, 4).join(' ');
const keys = ['decisionNotes', 'forkSignposts', 'endpointNotes', 'startingNotes'];
const labels = ['Decision notes', 'Fork signposts', 'Endpoint notes', 'Starting notes'];
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const auc = (high, low) => high.length && low.length ? mean(high.flatMap(a => low.map(b => a > b ? 1 : a === b ? .5 : 0))) : null;
const ranks = values => values.map(x => 1 + values.filter(y => y < x).length + (values.filter(y => y === x).length - 1) / 2);
function correlation(x, y) {
  if (x.length < 2) return null;
  const mx = mean(x), my = mean(y);
  const numerator = x.reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0);
  const denominator = Math.sqrt(x.reduce((a, v) => a + (v - mx) ** 2, 0) * y.reduce((a, v) => a + (v - my) ** 2, 0));
  return denominator ? numerator / denominator : null;
}
function manualReviews() {
  const result = new Map(), provenance = [];
  for (const name of ['review-a.md', 'review-b.md', 'review-c.md']) {
    const file = `${DIR}/${name}`;
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    provenance.push({ file, sha256: sha(text) });
    for (const block of text.split(/(?=^##{1,2} )/m)) {
      const header = block.match(/^##{1,2} (?:Index )?(\d+)\s*[—–-]\s*[^\n]*/);
      if (!header) continue;
      const studyId = header[0].match(/\s[—–-]\s([A-Za-z0-9]{8})\s[—–-]/)?.[1]
        || block.match(/Source:\s*\[([A-Za-z0-9]{8})\.pgn\]/)?.[1];
      assert(studyId, `Missing study ID in ${header[0]}`);
      const label = block.match(/\*\*Clarity:\s*(high|medium|low|uncertain)/i)?.[1]
        || header[0].match(/(?:—|–|-)\s*(High|Medium|Low|Uncertain)\b/i)?.[1];
      if (label) {
        const heading = header[0].replace(/^#+ /, '');
        const anchor = heading.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
        result.set(studyId, { label: label.toLowerCase(), reviewerFile: name, manifestIndex: Number(header[1]),
          role: block.match(/Role:\s*([^\n]*?)\.\s*Confidence:/i)?.[1] ?? null,
          confidence: block.match(/Confidence:\s*(high|medium|low|uncertain)/i)?.[1]?.toLowerCase() ?? null,
          evidence: `${name}#${anchor}`, evidenceHeading: heading,
          qualification: 'Single qualitative review of inspected content; role-dependent, not exhaustive or calibrated.' });
      }
    }
  }
  return { labels: result, provenance };
}

const coreHash = sha(fs.readFileSync('web-src/atlas-quality.js'));
const started = performance.now();
const inputs = read(INPUT), manifest = read(`${DIR}/corpus/manifest.json`);
const manual = manualReviews();
const likes = new Map(read(`${DIR}/corpus/stars.json`).map(s => [s.study_id, s]));
assert.equal(sha(fs.readFileSync(`${DIR}/corpus/manifest.json`)), inputs.meta.manifestSha256);
const results = { meta: { generatedUtc: new Date().toISOString(), scorerSha256: coreHash, manifestSha256: inputs.meta.manifestSha256,
  inputProducerSha256: sha(fs.readFileSync(`${DIR}/clarity-inputs.py`)), evaluatorSha256: sha(fs.readFileSync(`${DIR}/clarity-evaluate.mjs`)),
  manualReviews: manual.provenance, noNetwork: true, noEngine: true,
  forestAggregation: 'Exact atlasClarity per merged root. Forest facet counts union canonical positions across scopes and sides, with conservative intersection for repeated contexts. Same equal mean of applicable ratios; no artificial connecting root.',
  warning: 'Documentation presence proxy, not semantic teaching quality. Same reviewed corpus informed design: all comparisons exploratory, no untouched holdout. High likes positive-unlabeled; low/missing likes unknown.' }, studies: [] };

for (const study of inputs.studies) {
  const source = manifest.find(s => s.id === study.studyId);
  assert.equal(sha(fs.readFileSync(`${DIR}/corpus/${source.file}`)), study.pgnSha256);
  assert.equal(study.parseErrors.length, 0);
  const scopes = [], maps = keys.map(() => new Map());
  const colors = study.color === 'both' ? ['white', 'black'] : [study.color];
  const record = (metric, key, pass) => maps[metric].set(key, (maps[metric].get(key) ?? true) && pass);
  for (const scope of study.mergedRootScopes) {
    const children = new Map();
    for (const node of scope.nodes) {
      if (!children.has(node.parent_id)) children.set(node.parent_id, []);
      children.get(node.parent_id).push(node);
    }
    for (const side of colors) {
      const exact = atlasClarity({ nodes: scope.nodes, myColor: side, rootNodeId: scope.rootNodeId });
      scopes.push({ rootNodeId: scope.rootNodeId, rootPositionKey: scope.rootPositionKey, side, ...exact });
      for (const node of scope.nodes) {
        const next = children.get(node.id) || [];
        // Actual core on the local decision/fork context, not a second prose detector.
        // Only root decision/fork facets are read; synthetic child endpoints are ignored.
        const local = atlasClarity({ myColor: side, nodes: [{ ...node, id: 'root', parent_id: null },
          ...next.map((child, i) => ({ ...child, id: `c${i}`, parent_id: 'root' }))] });
        const position = canonical(node.fen);
        for (const i of [0, 1]) {
          const facet = local.facets[i];
          if (facet.denominator) {
            assert.equal(facet.denominator, 1);
            record(i, position, facet.numerator === 1);
          }
        }
        if (!next.length) record(2, position, local.facets[2].numerator === 1);
        if (node.id === scope.rootNodeId) record(3, position, local.facets[3].numerator === 1);
      }
    }
  }
  const facets = keys.map((key, i) => {
    const denominator = maps[i].size, numerator = [...maps[i].values()].filter(Boolean).length;
    return { key, label: labels[i], numerator, denominator, value: denominator ? numerator / denominator * 100 : null };
  });
  const nonempty = scopes.some(s => s.counts.moves > 0);
  const score = nonempty ? mean(facets.filter(f => f.value !== null).map(f => f.value)) : null;
  const popularity = likes.get(study.studyId);
  results.studies.push({ studyId: study.studyId, title: study.title, role: study.role, color: study.color, pgnSha256: study.pgnSha256,
    score, facets, mergedRootCount: study.mergedRootScopes.length, exactRootScores: scopes,
    manual: manual.labels.get(study.studyId) || { label: 'unreviewed' },
    likes: popularity?.status === 'observed' ? popularity.likes : null,
    likesInterpretation: 'Positive-unlabeled external evidence; low or missing is unknown, not a negative label.' });
  console.log(JSON.stringify({ studyId: study.studyId, score: score === null ? null : +score.toFixed(2), manual: results.studies.at(-1).manual.label,
    elapsedMs: Math.round(performance.now() - started) }));
}
const reviewed = results.studies.filter(s => ['high', 'medium', 'low'].includes(s.manual.label) && s.score !== null);
const high = reviewed.filter(s => s.manual.label === 'high'), low = reviewed.filter(s => s.manual.label === 'low');
results.comparison = { reviewedStudies: reviewed.length, unreviewedOrUncertain: results.studies.length - reviewed.length,
  cohorts: ['high', 'medium', 'low'].map(label => ({ label, n: reviewed.filter(s => s.manual.label === label).length,
    meanScore: mean(reviewed.filter(s => s.manual.label === label).map(s => s.score)) })),
  highVersusLowAuc: auc(high.map(s => s.score), low.map(s => s.score)),
  manualOrdinalSpearman: correlation(ranks(reviewed.map(s => ({ low: 1, medium: 2, high: 3 })[s.manual.label])), ranks(reviewed.map(s => s.score))),
  caution: 'Small subjective, role-dependent labels; design and evaluation share studies. No fitted threshold, no true-quality calibration.' };
results.popularityContext = { highestLikedTen: [...results.studies].filter(s => s.likes !== null).sort((a, b) => b.likes - a.likes).slice(0, 10)
  .map(s => ({ studyId: s.studyId, likes: s.likes, score: s.score, manual: s.manual.label })),
  interpretation: 'Descriptive reception only. No regression, negative class, cutoff or success criterion derived from likes.' };
assert.equal(sha(fs.readFileSync('web-src/atlas-quality.js')), coreHash, 'scorer changed during run; rerun');
results.meta.elapsedMs = Math.round(performance.now() - started);
fs.writeFileSync(`${DIR}/clarity-results.json`, JSON.stringify(results, null, 2) + '\n');
fs.writeFileSync(`${DIR}/manual-review-labels.json`, JSON.stringify({
  interpretation: 'Manual instructional judgments independent of documentation scores, engines and likes. Null confidence means not explicitly specified by reviewer.',
  sources: manual.provenance,
  studies: results.studies.map(s => ({ studyId: s.studyId, corpusRole: s.role, ...s.manual }))
}, null, 2) + '\n');
const cell = value => String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll('\n', ' ');
const catalog = ['# Corpus catalog', '',
  'All 38 studies in manifest order. Manual clarity is a role-dependent reading of content; Documentation is the four-signal presence proxy, not a validated quality ranking. High likes are positive-unlabeled reception evidence; low/missing likes are unknown. No weights were fitted to either.', '',
  '| Source / title | Corpus role | Likes | Manual clarity | Documentation /100 | Review evidence |',
  '| --- | --- | ---: | --- | ---: | --- |',
  ...results.studies.map(s => `| [${cell(s.title)}](https://lichess.org/study/${s.studyId}) | ${cell(s.role)} | ${cell(s.likes)} | ${s.manual.label} | ${s.score === null ? 'unknown' : s.score.toFixed(1)} | ${s.manual.evidence ? `[review](${s.manual.evidence})` : 'not yet reviewed'} |`), '',
  'Original PGNs, source hashes and chapter attribution: [manifest](corpus/manifest.json). Exact numerators/denominators and scorer provenance: [results](clarity-results.json). Role/confidence and exact evidence headings: [manual classifications](manual-review-labels.json).', ''];
fs.writeFileSync(`${DIR}/catalog.md`, catalog.join('\n'));
console.log(JSON.stringify(results.comparison));
