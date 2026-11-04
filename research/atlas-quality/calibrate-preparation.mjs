// Development evidence, not an independent holdout or chess-strength benchmark.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { atlasPreparation } from '../../web-src/atlas-quality.js';

const before = JSON.parse(await readFile('research/atlas-quality/calibration-baselines.json', 'utf8'));
const source = await readFile('web-src/atlas-quality.js');
const child = spawn(fileURLToPath(new URL('../../.venv313/Scripts/python.exe', import.meta.url)),
  [fileURLToPath(new URL('convert_preparation.py', import.meta.url))],
  { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'inherit'] });
const exit = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Converter exit ${code}`)));
});
const observations = [];
const unit = (r, key) => r.facets.find((f) => f.key === key).value;
for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  const children = new Map();
  for (const n of row.nodes) {
    if (!children.has(n.parent_id)) children.set(n.parent_id, []);
    children.get(n.parent_id).push(n);
  }
  for (const color of row.color === 'both' ? ['white', 'black'] : [row.color]) {
    const assess = (nodes, horizon = 32) => atlasPreparation({ nodes, myColor: color, horizon });
    const original = assess(row.nodes);
    const shortened = assess(row.nodes.filter((n) => (n.ply || 0) <= 8));
    // Delete one fifth of non-root own decisions and every descendant beneath
    // them. This deliberately creates gaps, rather than treating low likes as bad.
    const missing = new Set(), stack = [];
    for (const n of row.nodes) if (n.id !== 'root' && Number(n.id) % 5 === 0 &&
      n.fen.split(' ')[1] === (color === 'white' ? 'w' : 'b')) {
      stack.push(...(children.get(n.id) || []));
    }
    while (stack.length) {
      const n = stack.pop();
      if (missing.has(n.id)) continue;
      missing.add(n.id);
      stack.push(...(children.get(n.id) || []));
    }
    const holes = assess(row.nodes.filter((n) => !missing.has(n.id)));
    const h16 = assess(row.nodes, 16), h24 = assess(row.nodes, 24);
    const variants = [2, 4, 8].map((scale) => {
      const reach = 100 * (1 + original.counts.answeredAlternatives) / (1 + scale + original.counts.answeredAlternatives);
      return { scale, score: Math.sqrt(unit(original, 'depth') * reach) };
    });
    observations.push({ id: row.id, color, role: row.role,
      baseline: before.reports.find((r) => r.id === row.id && r.color === color).score,
      final: original.score, facets: original.facets.map(({ key, value }) => ({ key, value })), counts: original.counts,
      shortened: { score: shortened.score, delta: shortened.score - original.score },
      holes: { removed_nodes: missing.size, score: holes.score, delta: holes.score - original.score },
      horizon_sensitivity: { h16: h16.score, h24: h24.score, h32: original.score }, breadth_sensitivity: variants });
    process.stderr.write(`${row.id}/${color}: ${original.score.toFixed(1)}, short ${shortened.score?.toFixed(1)}, holes ${holes.score?.toFixed(1)}\n`);
  }
}
await exit;
if (!(await readFile('web-src/atlas-quality.js')).equals(source)) throw new Error('Source changed during calibration');
const output = { scorer_sha256: createHash('sha256').update(source).digest('hex'),
  method: 'All 38 studies informed development. Structural damage is controlled evidence of missing preparation, not a label that an author or chess choice is bad. Baseline is frozen at commit 11d8952f. No likes or text fitting.',
  reports: observations.length,
  shortened_increases: observations.filter((r) => r.shortened.delta > 1e-8).map((r) => [r.id, r.color, r.shortened.delta]),
  holes_increases: observations.filter((r) => r.holes.delta > 1e-8).map((r) => [r.id, r.color, r.holes.delta]),
  observations };
await writeFile('research/atlas-quality/ranking-calibration.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ reports: output.reports, shortened_increases: output.shortened_increases, holes_increases: output.holes_increases }, null, 2));
