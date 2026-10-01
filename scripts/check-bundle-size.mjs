// Bundle-size regression gate. Run after `npm run build` (CI's `js` job).
//
// The deploy build is committed and served from Render's free tier with no CDN,
// so the main entry chunk's size directly sets first-load cost. This fails the
// build if the main `assets/index-*.js` grows past a budget, catching an
// accidental heavy import before it ships. Raise LIMITS intentionally (with the
// reason) when a real feature legitimately grows a bundle.
//
// Measured baseline at origin/main 43383b2 (2026-09-18): main index 252.9 KiB
// raw / 80.3 KiB gzip and stylesheet 113.3 KiB raw / 21.1 KiB gzip. The
// Source Composer brought the latest main baseline to 290,886 B JS / 129,655 B
// CSS. Workspace routing, CSRF keepalive, skip-link, status semantics, and
// coarse/mobile accessibility guards intentionally add ~3.0 KiB JS and 0.5 KiB
// CSS. These ceilings cover that reviewed delta while retaining a narrow gate;
// gzip remains independently capped at 95,000 B. The desktop-workspace follow-up
// (Build-tab Maia idle pre-warm + one-rAF Generate feedback yield) adds ~0.2 KiB
// raw to the main chunk; gzip is unchanged. The study-workspace integration
// (viewport-height board sizing + max-content board column + sidebar Train
// coach + inline topbar status slot) adds ~0.4 KiB JS and ~1.3 KiB CSS raw;
// gzip stays within the existing caps. The roving-focus keyboard navigation
// (a11y, 2026-09) adds ~1.1 KiB raw: the roving tabindex walker in BoardController
// plus the orientation-aware arrow geometry module (web-src/board-navigation.js);
// gzip grows well under its cap. This is INTENTIONAL a11y growth, not a loosened
// gate — origin/main's baseline already sat at the previous 297,000 B ceiling,
// so a real feature cannot fit without headroom. The prototype design-system
// integration (2026-09-27: ink-blue token palette, 60px icon rail with 204px
// overlay, mobile bottom tab bar + More sheet, top-bar view titles) adds
// ~0.04 KiB JS raw (view-title map + sheet wiring) and ~3.8 KiB CSS raw (rail /
// tabbar / sheet primitives + the token layer). Ceilings move by exactly that
// reviewed delta; gzip stays within its existing cap. The ui-v2 page internals
// (2026-09-27: Library table + filter bar + preview, Repertoire workspace,
// Train up-next, Games focus board, Scout colour tabs, Analyze eval bar, Teams
// detail sheet, Settings section nav) add ~4.6 KiB CSS raw — measured
// 157,912 → 162,742 B of the built index-*.css against origin/main b521bff —
// and ~0.6 KiB JS raw of eager view glue (the page renderers themselves stay
// in lazy chunks); gzip stays within its caps.
// The 2026-09-30 UX walkthrough adds sign-in/resume state, isolated Explorer
// previews, Build loading guards and Analyze/Train integration. The production
// main chunk is now ~319.4 KB raw / 99.3 KB gzip; allow only 320 KB / 100 KB.
// Keep worker and CSS budgets unchanged; this accounts for the reviewed UX delta.
// The 2026-10-01 walkthrough fixes (repertoire color select, Explorer failure
// reasons, sign-in modal guards, hint retention, Games move labels, Scout
// source reset, Teams sign-in CTA) grow the main chunk 319,444 → 322,032 B
// raw and 99,236 → 100,208 B gzip; allow 323 KB / 101 KB.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath, URL } from "node:url";

const ASSETS_DIR = fileURLToPath(
  new URL("../src/prepforge_chess/web/static/assets", import.meta.url),
);

// Per-chunk budgets. Keyed by the chunk's stable prefix (Vite appends a content
// hash). maxGzipBytes is checked only when set (main app chunk today).
const LIMITS = [
  {
    prefix: "index-",
    suffix: ".js",
    maxBytes: 323_000, // reviewed walkthrough fixes (see measured deltas above)
    maxGzipBytes: 101_000,
    label: "main app chunk",
  },
  { prefix: "maia3-worker-", suffix: ".js", maxBytes: 220_000, label: "maia3 worker chunk" },
  // The reviewed Games triage and Teams workspace styles bring the built sheet
  // to about 151 KiB; the prototype design-system integration (rail/tabbar/
  // sheet + token palette) adds ~3.8 KiB and the ui-v2 page internals add
  // ~4.8 KiB measured (157,912 → 162,742 B vs origin/main b521bff), so the
  // narrow ceiling moves to 163 KB.
  { prefix: "index-", suffix: ".css", maxBytes: 163_000, label: "main stylesheet" },
];

let files;
try {
  files = readdirSync(ASSETS_DIR);
} catch {
  console.error(`[bundle-size] assets dir not found: ${ASSETS_DIR}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const failures = [];
for (const { prefix, suffix, maxBytes, maxGzipBytes, label } of LIMITS) {
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
    const rawOk = bytes <= maxBytes;
    const gzipOk = maxGzipBytes == null || gz <= maxGzipBytes;
    const status = rawOk && gzipOk ? "ok" : "FAIL";
    const rawBudgetKib = (maxBytes / 1024).toFixed(0);
    const budgetText =
      maxGzipBytes != null
        ? `budget raw ${rawBudgetKib} KiB / gz ${(maxGzipBytes / 1024).toFixed(0)} KiB`
        : `budget ${rawBudgetKib} KiB`;
    console.log(
      `[bundle-size] ${status}  ${name}  ${kib} KiB (gz ${gzKib})  ${budgetText}  — ${label}`,
    );
    if (!rawOk) {
      failures.push(
        `${name} is ${kib} KiB raw, over the ${rawBudgetKib} KiB raw budget for the ${label}.`,
      );
    }
    if (!gzipOk) {
      failures.push(
        `${name} is ${gzKib} KiB gzip, over the ${(maxGzipBytes / 1024).toFixed(0)} KiB gzip budget for the ${label}.`,
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
