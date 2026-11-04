// Research-only execution of the shipped scorer; no fitting or quality labels.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { atlasPreparation, ATLAS_QUALITY_VERSION } from '../../web-src/atlas-quality.js';

const base = new URL('./', import.meta.url);
const sourceAtStart = await readFile(new URL('../../web-src/atlas-quality.js', base));
const readJson = async (name) => JSON.parse(await readFile(new URL(name, base), 'utf8'));
const stars = new Map((await readJson('corpus/stars.json')).map((r) => [r.study_id, r.likes]));
const started = performance.now();
const child = spawn(fileURLToPath(new URL('../../.venv313/Scripts/python.exe', base)),
  [fileURLToPath(new URL('convert_preparation.py', base))], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'inherit'] });
const exit = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Converter exit ${code}`)));
});
const rows = [];
function analytical(result) {
  const { occurrences, ...counts } = result.counts;
  return { ...result, counts };
}
for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
  const item = JSON.parse(line);
  assert(Object.values(item.annotation_conversion_invariance).every(Boolean));
  assert(item.reverse_chapters_exact_input_invariance);
  const sides = item.color === 'both' ? ['white', 'black'] : [item.color];
  const reports = [];
  for (const color of sides) {
    const evaluate = (nodes) => atlasPreparation({ nodes, myColor: color, rootNodeId: 'root', horizon: 32 });
    const t0 = performance.now();
    const original = evaluate(item.nodes);
    const originalMs = performance.now() - t0;
    const t1 = performance.now();
    const checks = { reversed_chapters_exact_input: item.reverse_chapters_exact_input_invariance };
    for (const [mode, comment] of [['empty', ''], ['ones', '1']]) {
      const mutated = item.nodes.map((n) => ({ ...n, comment, starting_comment: comment,
        nags: mode === 'empty' ? [] : [1], title: comment, arrows: [] }));
      checks[mode] = JSON.stringify(evaluate(mutated)) === JSON.stringify(original);
    }
    const duplicated = evaluate(item.duplicate_nodes);
    const reimportSame = JSON.stringify(duplicated) === JSON.stringify(original);
    const clonedNodes = [...item.nodes, ...item.nodes.filter((n) => n.id !== 'root').map((n) => ({ ...n,
      id: `copy-${n.id}`, parent_id: n.parent_id === 'root' ? 'root' : `copy-${n.parent_id}` }))];
    checks.duplicate_same_graph = JSON.stringify(analytical(evaluate(clonedNodes))) === JSON.stringify(analytical(original));
    assert(Object.values(checks).every(Boolean), `${item.id}/${color}: scorer invariance failed`);
    assert(reimportSame, `${item.id}/${color}: duplicated raw chapter conversion changed analytical output`);
    reports.push({ color, score: original.score,
      facets: original.facets.map(({ key, value, numerator, denominator }) => ({ key, value, numerator, denominator })),
      counts: original.counts, stop_reasons: original.stopReasons, invariance: checks,
      raw_chapter_reimport: { invariant: reimportSame,
        ...(reimportSame ? {} : { score: duplicated.score, counts: duplicated.counts,
          facets: duplicated.facets.map(({ key, value, numerator, denominator }) => ({ key, value, numerator, denominator })) }) },
      milliseconds: { original: originalMs, invariance: performance.now() - t1 } });
  }
  rows.push({ study_id: item.id, raw_sha256: item.sha256, role: item.role,
    likes: stars.get(item.id) ?? null, scope: item.scope, duplicate_scope: item.duplicate_scope,
    annotation_conversion_invariance: item.annotation_conversion_invariance,
    conversion_seconds: item.conversion_seconds, reports });
  process.stderr.write(`${rows.length}/38 ${item.id}: ${reports.map((r) => `${r.color} ${r.score?.toFixed(2) ?? 'null'}`).join(', ')}; invariant ${reports.every((r) => Object.values(r.invariance).every(Boolean))}\n`);
}
await exit;
assert.equal(rows.length, 38);
const reports = rows.flatMap((r) => r.reports);
const distribution = (values) => {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return { applicable: sorted.length, unavailable: values.length - sorted.length,
    min: sorted[0] ?? null, median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null, max: sorted.at(-1) ?? null };
};
const summarize = (rs) => ({ side_reports: rs.length, index: distribution(rs.map((r) => r.score)),
  facets: Object.fromEntries(['replies', 'reach', 'depth', 'moveOrders', 'ease'].map((key) => [key,
    distribution(rs.map((r) => r.facets.find((f) => f.key === key).value))])) });
const roles = [...new Set(rows.map((r) => r.role))].sort();
const source = await readFile(new URL('../../web-src/atlas-quality.js', base));
assert(source.equals(sourceAtStart), 'Scorer changed during run: rerun final implementation');
const highLikes = [...rows].filter((r) => r.likes !== null).sort((a, b) => b.likes - a.likes).slice(0, 5);
const output = { algorithm_version: ATLAS_QUALITY_VERSION, scorer_sha256: createHash('sha256').update(source).digest('hex'),
  method: { horizon_plies: 32, root: 'single standard initial position',
    scope: 'Exact structural chapter duplicates removed and canonical signatures sorted by canonical start position and ordered UCI tree including mainline flags before attachment. All non-diagram chapter trees rooted at standard or directed-reachable custom starts; disconnected starts excluded and reported. Standard chapter roots collapse into one root; connected custom roots attach to their first existing occurrence in that canonical order.',
    own_policy: 'PGN first variation sets is_mainline/is_prepared=true; alternatives false. Select the best own tier within each occurrence; union tied chapter plans. Core Depth follows preferred tiers for both sides. This is structural selection, not recovered author intent. All moves legally validated.',
    interpretation: 'Opening completion uses existing gamePhase plus consecutive non-opening positions and two quiet plies; bound at 32 relative plies. Replies describes core availability; Reach counts answered opponent alternatives; Depth follows core plans and stops before unanswered opponent moves. Total sqrt(Reach * Depth) avoids double-counting missing replies. Consistency/Ease describe learning load. No annotations, engines, network, likes or manual labels enter scorer. Not empirical coverage or validated holistic quality.',
    likes: 'Observed source likes shown only as external positive-unlabeled context: high may support usefulness; low/missing unknown. No threshold, fitting, negative label or validation claim.',
    invariance: 'Original versus empty/1 annotation fields and PGN mutation conversion; exact assembled tree copied under the same root, excluding occurrence count only.',
    custom_attachment_limitation: 'First-occurrence custom attachment is an explicit import convention, not author intent. Structural chapter deduplication and sorting make exact raw copies and raw chapter reordering inert. Different scope composition may affect occurrence reply sets; study indices are not scope-equivalent quality comparisons.' },
  totals: { studies: rows.length, side_reports: reports.length, ...summarize(reports),
    original_scoring_ms: reports.reduce((sum, r) => sum + r.milliseconds.original, 0),
    invariance_scoring_ms: reports.reduce((sum, r) => sum + r.milliseconds.invariance, 0),
    wall_seconds: (performance.now() - started) / 1000,
    all_annotation_invariant: reports.every((r) => r.invariance.empty && r.invariance.ones),
    all_duplicate_graph_invariant: reports.every((r) => r.invariance.duplicate_same_graph),
    all_reversed_chapter_inputs_exact: reports.every((r) => r.invariance.reversed_chapters_exact_input),
    raw_chapter_reimport_changed_reports: reports.filter((r) => !r.raw_chapter_reimport.invariant).length },
  by_role: Object.fromEntries(roles.map((role) => [role, summarize(rows.filter((r) => r.role === role).flatMap((r) => r.reports))])),
  highest_likes_context: { selection: 'Five most-liked studies within this convenience sample, descriptive positive-unlabeled context only; remaining studies are not negatives.',
    study_ids: highLikes.map((r) => r.study_id), ...summarize(highLikes.flatMap((r) => r.reports)) },
  studies: rows };
await writeFile(new URL('preparation-results.json', base), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output.totals, null, 2));
