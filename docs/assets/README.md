# Documentation screenshots

Captured on 2026-10-27 from a fresh `npm run build`. These are browser screenshots
of the app with fixture-backed accounts and chess data, not design mockups or
production user records. The captures demonstrate layout and navigation; they
do not establish live engine output or production service availability.

| File | Viewport | Source |
| --- | --- | --- |
| `repertoire-desktop.png` | 1440 × 900 | Repertoire viewport smoke, Caro-Kann fixture |
| `repertoire-mobile.png` | 390 × 844 | Same repertoire fixture on mobile |
| `train-desktop.png` | 1440 × 900 | Train viewport smoke, home state |

The repertoire capture server supplies `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`, matching the app server. The
tracked viewport smoke's static server omits these headers; add them to a scratch
copy of that server when refreshing the repertoire images. Do not hide banners
or alter the app DOM to prepare screenshots.

## Refresh

Build first. The existing smoke scripts accept a screenshot output directory:

```powershell
npm run build
New-Item -ItemType Directory -Force tmp/docs-shots | Out-Null
$env:UI_V2_SHOTS = (Resolve-Path tmp/docs-shots).Path
$env:UI_V2_TAG = "docs"
node scripts/smoke/ui-v2/build-viewport-smoke.mjs
node scripts/smoke/ui-v2/train-viewport-smoke.mjs
```

For an isolated repertoire capture, copy `build-viewport-smoke.mjs` into a scratch
location, set its `ROOT` to the repository's absolute path, and add the two headers
above in its HTTP request handler. Run that copy with the same output variables.
Keep the fixtures and rendering unchanged.

Inspect the desktop and mobile images before replacing these files. Use the
repertoire desktop/mobile captures and the `train-home` desktop capture; preserve
their original dimensions. Keep the English and Traditional Chinese introductions
pointing at the same assets. Update this capture date and provenance when the
images change.
