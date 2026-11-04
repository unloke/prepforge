// Optional cached converter stream only accelerates local iteration. Default
// regenerates from immutable PGNs with the converter's invariance assertions.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { atlasPreparation } from '../../web-src/atlas-quality.js';

const base = new URL('./', import.meta.url);
const labels = await readFile(new URL('facet-judgments.json', base));
const manifest = JSON.parse(await readFile(new URL('corpus/manifest.json', base)));
let input, completion;
if (process.argv[2]) input = createReadStream(process.argv[2]);
else {
  const child = spawn(fileURLToPath(new URL('../../.venv313/Scripts/python.exe', base)),
    [fileURLToPath(new URL('convert_preparation.py', base))],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'inherit'] });
  input = child.stdout;
  completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Converter exit ${code}`)));
  });
}
const rows = [], ids = new Set();
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  const item = JSON.parse(line);
  assert(!ids.has(item.id)); ids.add(item.id);
  const source = manifest.find((m) => m.id === item.id);
  assert.equal(source.sha256, item.sha256);
  for (const color of item.color === 'both' ? ['white', 'black'] : [item.color]) {
    const result = atlasPreparation({ nodes: item.nodes, myColor: color });
    rows.push({ id: item.id, color, features: result.features,
      score: result.score, facets: Object.fromEntries(result.facets.map((f) => [f.key, f.value])) });
  }
}
await completion;
assert.equal(ids.size, 38); assert.equal(rows.length, 45);
await writeFile(new URL('facet-features.json', base), JSON.stringify({
  judgments_sha256: createHash('sha256').update(labels).digest('hex'), rows,
}, null, 2) + '\n');
console.log(`${rows.length} feature rows`);
