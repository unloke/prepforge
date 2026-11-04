# Documentation screenshots

Captured from a fresh `npm run build` on the dates below. These are browser screenshots
of the app with fixture-backed accounts and chess data, not design mockups or
production user records. The captures demonstrate layout and navigation; they
do not establish live engine output or production service availability.

| File | Viewport | Date | Source |
| --- | --- | --- | --- |
| `repertoire-desktop.png` | 1440 × 900 | 2026-11-02 | Isolated real API account, Open games · White, 21 moves / 5 lines, selected Bb5 |
| `repertoire-mobile.png` | 390 × 844 | 2026-11-02 | Same account and tree at Bb5; occasional actions in More |
| `repertoire-atlas.png` | 1440 × 900 | 2026-11-03 | Isolated real API account, London System Repertoire · White, 643 moves / 79 routes; move-only Preparation profile |
| `repertoire-discussion.png` | 1440 × 900 | 2026-11-02 | Same tree, Morgan/Alex discussion at Bb5 |
| `repertoire-undo.png` | 1440 × 900 | 2026-10-30 | Same fixture, deleted branch and compact Undo |
| `train-session.png` | 1440 × 900 | 2026-10-30 | Same fixture, live Due queue session |
| `train-desktop.png` | 1440 × 900 | 2026-10-27 | Train viewport smoke, home state |

The October capture server supplies `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`. The November captures use the
in-app browser against an isolated FastAPI/SQLite server, with a completed
training run and a saved analysis in the account. They do not verify Stockfish
inside that browser. Do not hide banners or alter the app DOM to prepare screenshots.

The November 3 five-axis Atlas capture uses headless Chromium and an isolated
FastAPI/SQLite account with a branched repertoire, saved analyzed game and completed
training run. Before and after use the same London System Repertoire · White,
643 moves / 79 routes, at 1440 × 900, 1000 × 650 and 390 × 844. The previous five-axis image is retained in Git at `bab295f5`; the current
documentation image uses the calibrated move-content formulas on the same data. Desktop header height stays 47 CSS pixels and phone header 61;
there are no console errors or horizontal overflow. The large index, compact
metric rows, route map and type/layout styling remain; only metric data and on-demand tooltips change. Mobile body scrolling accommodates the fifth metric.

The fixture derives from saved Lichess study `2EaSmZtz`: its sixteen nonempty
standard-start chapters are merged by move prefix, all annotations omitted, then
imported through the real API. The raw corpus remains unchanged. The displayed
Preparation index is 81; Replies / Reach / Depth / Consistency / Ease round to
85 / 82 / 86 / 79 / 60. Prefix merging produces one selected plan per occurrence,
so this fixture is not identical to the research converter's separate chapter
occurrences; its index is not the raw study's report value. Imprint is personal
training data. Neither annotation quantity nor an engine contributes to scoring.

## Refresh

Build first. The training home fixture smoke accepts a screenshot output directory:

```powershell
npm run build
New-Item -ItemType Directory -Force tmp/docs-shots | Out-Null
$env:UI_V2_SHOTS = (Resolve-Path tmp/docs-shots).Path
$env:UI_V2_TAG = "docs"
node scripts/smoke/ui-v2/train-viewport-smoke.mjs
```

The October repertoire, Undo and live training captures use the real app server
with an isolated local database. After building, run:

```powershell
$env:E2E_BASE_URL = 'http://127.0.0.1:9876'
node tests/e2e/train_repertoire_flow_smoke.mjs
```

The smoke creates its own fixture account and repertoire. Copy
`out/train-repertoire-flow/repertoire-1440.png`, `repertoire-390.png`,
`undo-desktop.png` and `train-desktop.png` to the corresponding documentation
assets above. Do not run the fixture-creating test against production.

For the November collaboration captures, create two local fixture members and
grant one edit access. Build five branches under e4/d4, complete a training run
and save an analysis. Have the editor add a continuation and a note, and have
both members post at Bb5. Capture Build at Bb5, open Atlas, and open Discuss.
For mobile, select Bb5 at 390 × 844. Open Atlas through More → Explore;
open Activity and Discuss position through More → Collaborate. The three
occasional actions are no longer a standing toolbar.
Use the same database for any before/after pair. New-feature comparisons show
the old workspace where that feature was absent; operation comparisons must
be labelled separately (for example detached → reattached).

The menu and loading review is in `designs/loading-alignment/index.html`, with
desktop and phone before/after images plus CSS-pixel geometry JSON. Its baseline
is `5aea536c`, after the original collaboration implementation. The earlier
22 functional comparisons against `799b4e38` are retained in its
`feature-walkthrough/` folder; their toolbar positions have been superseded.
Games uses the same four-result local JSON response for both versions. Scout
uses the same 24-game local PGN response, processed by the real app. These
external response fixtures do not establish live service behavior.

Capture loading and settled states without changing viewport or scroll offset.
Measure row height, column positions, board size and section boundaries with
`getBoundingClientRect()`; retain those raw values alongside each PNG. Unknown
row counts and text wrapping are data-dependent, not promises of equal total
page height. Settings Appearance, Board and Engine render directly; the Account
loading comparison is the global boot hold, not an account-shaped skeleton.
The frozen Analyze baseline displays an engine-isolation warning; preserve it
and label the environment difference instead of attributing it to a UI change.

Inspect the desktop and mobile images before replacing these files. Use the
repertoire desktop/mobile captures, live session and Undo captures, and the
`train-home` desktop capture; preserve their original dimensions. Keep the English and Traditional Chinese introductions
pointing at the same assets. Update this capture date and provenance when the
images change.
