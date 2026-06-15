// Bundle-size regression gate. Run after `npm run build` (CI's `js` job).
//
// The deploy build is committed and served from Render's free tier with no CDN,
// so the main entry chunk's size directly sets first-load cost. This fails the
// build if the main `assets/index-*.js` grows past a budget, catching an
// accidental heavy import before it ships. Raise LIMITS intentionally (with the
// reason) when a real feature legitimately grows a bundle.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath, URL } from "node:url";

const ASSETS_DIR = fileURLToPath(
  new URL("../src/prepforge_chess/web/static/assets", import.meta.url),
);

// Per-chunk raw-byte budgets. Keyed by the chunk's stable prefix (Vite appends a
// content hash). Current sizes (2026-06): index ~280 KB, maia3-worker ~157 KB.
// Budgets carry ~25% headroom so normal growth passes but a doubling fails.
const LIMITS = [
  { prefix: "index-", suffix: ".js", maxBytes: 360_000, label: "main app chunk" },
  { prefix: "maia3-worker-", suffix: ".js", maxBytes: 220_000, label: "maia3 worker chunk" },
  { prefix: "index-", suffix: ".css", maxBytes: 90_000, label: "main stylesheet" },
];

let files;
try {
  files = readdirSync(ASSETS_DIR);
} catch {
  console.error(`[bundle-size] assets dir not found: ${ASSETS_DIR}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const failures = [];
for (const { prefix, suffix, maxBytes, label } of LIMITS) {
  const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix) && !f.endsWith(".map"));
  if (matches.length === 0) {
    failures.push(`missing chunk: ${prefix}*${suffix} (${label}) — build output incomplete?`);
    continue;
  }
  for (const name of matches) {
    const bytes = statSync(`${ASSETS_DIR}/${name}`).size;
    const gz = gzipSync(readFileSync(`${ASSETS_DIR}/${name}`)).length;
    const kib = (bytes / 1024).toFixed(1);
    const gzKib = (gz / 1024).toFixed(1);
    const status = bytes > maxBytes ? "FAIL" : "ok";
    console.log(
      `[bundle-size] ${status}  ${name}  ${kib} KiB (gz ${gzKib})  budget ${(maxBytes / 1024).toFixed(0)} KiB  — ${label}`,
    );
    if (bytes > maxBytes) {
      failures.push(
        `${name} is ${kib} KiB, over the ${(maxBytes / 1024).toFixed(0)} KiB budget for the ${label}.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("\n[bundle-size] budget exceeded:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nIf this growth is intentional, raise the matching budget in scripts/check-bundle-size.mjs.",
  );
  process.exit(1);
}
console.log("[bundle-size] all chunks within budget.");
