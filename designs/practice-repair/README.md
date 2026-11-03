# Practice interaction repair

The implementation retains PrepForge's existing board, typography and colours,
following the requested local baoyu-design skill. Screenshots are browser captures,
not mockups.

Changes:

- Practice starts directly in its session state; async setup does not briefly
  return to Home or start a second view transition.
- Drill / Practice switches content on desktop as well as phones.
- Promotion opens after the pointer gesture finishes. Opening an auto popover
  during pointerdown/pointerup let the same gesture dismiss it immediately.
  Choices use the moving piece's colour, support underpromotion, and are
  cancelled when the position changes. Escape and the board scrim cancel too.
- Players can hold pieces and queue a single premove while the opponent thinks.
  The opponent's final legal moves validate that queue before execution.
  An empty-square press cancels it and clears user arrows/circles.
- Invalid drops return silently. Player moves apply synchronously, avoiding
  a partial move across asynchronous callbacks.

Validation:

- `npm test`: 3,199 tests passed across 303 files.
- `npm run lint:js`: CSS guard and ESLint (existing warnings remain).
- `npm run build`: production assets.
- `node scripts/smoke/ui-v2/train-viewport-smoke.mjs`: production Home,
  session, result and history flows at desktop, phone and short-phone sizes.
- `node scripts/smoke/ui-v2/board-rewind-smoke.mjs`: shared board motion,
  captures, castling, promotion, variations and Practice takeback; 142/142 checks passed.
- `node scripts/smoke/ui-v2/practice-interaction-smoke.mjs`: run Vite on
  `127.0.0.1:5191` first. Covers desktop and touch-enabled phone input,
  both colours, click/tap and drag promotion, underpromotion, premove execution,
  invalidation, cancellation and an opponent reply while a piece is held.

The focused interaction smoke controls Maia replies deterministically; it does
not measure a real model download or inference speed. No production deployment
is included.
