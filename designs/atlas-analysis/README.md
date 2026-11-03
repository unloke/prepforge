# Atlas dossier · revision 2

Reviewed 2026-11-02 (America/Phoenix), using baoyu-design.

## Direction

The user requested a more enigmatic scoring treatment with fewer controls.
Revision 2 uses an opening dossier: warm ink, oversized serif index, geometric
fingerprint and four terse facet names. Existing app theme tokens remain in use.
There is one close control; route selection and review-navigation controls were
removed. No standing explanation or formula appears in the interface.

`Atlas-v2.html` and `index.html` are frozen previews of the actual rendered
application, using the populated local review account. Closing the preview opens
the real local workspace. `Atlas-v1.html` preserves the rejected first version.
No external imagery is used.

## Scores

The index is a structural heuristic, not a chess-engine quality rating.
Enabled leaves supply the mean depth and ending distribution. Reach saturates
with mean depth, Weave with route breadth, Poise combines depth consistency and
maturity, and Resolve measures own-side endings weighted by depth. The composite
weights these 35/25/20/20. Empty trees have no score; disabled subtrees are excluded.
The implementation and invariant tests live in `web-src/views/build-atlas*`.

Imprint remains separate personal training evidence: mastered enabled own-side
moves divided by all enabled own-side moves. No training means no Imprint score.
Shared views omit it entirely. Structural scores do not require training history.

## Captures and verification

`real/v2-{1440,768,390}.png` and `real/v2-light.png` use the same 37-move,
four-route Anti-Sicilian repertoire as revision 1. The account also has a
completed training run and a saved analyzed game. This repertoire is untrained;
its structural index is 34.7 while Imprint correctly remains a dash.

- Six Atlas unit tests pass, including structural-score invariants.
- Production build passes; JavaScript lint has zero errors.
- Build viewport smoke passes at 1440, 1180 and 390 pixels, including direct
  opening, dismissal, focus restoration, empty trees and shared privacy.
- `real/v2-browser.json`: no runtime errors or horizontal overflow at desktop,
  tablet or mobile widths; exactly one control; zero running animations when
  reduced motion is enabled. Dark and light screenshots were visually reviewed.

Revision-1 evidence remains under `before/`, `after/`, `inspection/` and the
original `real/before-*`, `real/after-*` files. Its real baseline loaded the
original Atlas module and loading styles into the current app for controlled
comparison. Those reports describe revision 1, not this revision.

The independent Random change remains engine-verified within −1.5 to +1.5,
excluding mate scores. `real/checks.json` and `real/random-browser.json` document
the real browser engine and the production click flow with a controlled Lichess
feed. This does not test live Lichess availability or guarantee a game's result.
