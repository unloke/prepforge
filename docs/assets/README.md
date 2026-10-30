# Documentation screenshots

Captured from a fresh `npm run build` on the dates below. These are browser screenshots
of the app with fixture-backed accounts and chess data, not design mockups or
production user records. The captures demonstrate layout and navigation; they
do not establish live engine output or production service availability.

| File | Viewport | Date | Source |
| --- | --- | --- | --- |
| `repertoire-desktop.png` | 1440 × 900 | 2026-10-30 | Real API training/repertoire smoke, Open games fixture |
| `repertoire-mobile.png` | 390 × 844 | 2026-10-30 | Same repertoire fixture on mobile |
| `repertoire-undo.png` | 1440 × 900 | 2026-10-30 | Same fixture, deleted branch and compact Undo |
| `train-session.png` | 1440 × 900 | 2026-10-30 | Same fixture, live Due queue session |
| `train-desktop.png` | 1440 × 900 | 2026-10-27 | Train viewport smoke, home state |

The real API capture server supplies `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`. Do not hide banners or alter
the app DOM to prepare screenshots.

## Refresh

Build first. The training home fixture smoke accepts a screenshot output directory:

```powershell
npm run build
New-Item -ItemType Directory -Force tmp/docs-shots | Out-Null
$env:UI_V2_SHOTS = (Resolve-Path tmp/docs-shots).Path
$env:UI_V2_TAG = "docs"
node scripts/smoke/ui-v2/train-viewport-smoke.mjs
```

The current repertoire, Undo and live training captures use the real app server
with an isolated local database. After building, run:

```powershell
$env:E2E_BASE_URL = 'http://127.0.0.1:9876'
node tests/e2e/train_repertoire_flow_smoke.mjs
```

The smoke creates its own fixture account and repertoire. Copy
`out/train-repertoire-flow/repertoire-1440.png`, `repertoire-390.png`,
`undo-desktop.png` and `train-desktop.png` to the corresponding documentation
assets above. Do not run the fixture-creating test against production.

Inspect the desktop and mobile images before replacing these files. Use the
repertoire desktop/mobile captures, live session and Undo captures, and the
`train-home` desktop capture; preserve their original dimensions. Keep the English and Traditional Chinese introductions
pointing at the same assets. Update this capture date and provenance when the
images change.
