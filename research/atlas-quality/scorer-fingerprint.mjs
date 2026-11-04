import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function scorerFingerprint() {
  const files = ['atlas-quality.js', 'atlas-content-features.js', 'atlas-ease.js', 'atlas-calibration.js', 'coach/material.js'];
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name);
    hash.update(await readFile(new URL(`../../web-src/${name}`, import.meta.url)));
  }
  return hash.digest('hex');
}
