# Scout selection regression corpus

`ericrosen-selection.json` pins 1,187 public EricRosen Lichess games from the
existing `tmp/scout-ericrosen-1200.json` acquisition used by the prior Scout studies.
Each `gameId` resolves to `https://lichess.org/<gameId>`. It preserves actual UCI,
SAN, opening paths, colour, score, speed, date and termination; it omits unrelated
rating/clock/UI fields. No moves or outcomes were synthesized. This reproduces the
same shallow-prefix failure class reported for #80; it is not a claimed capture
of the user's unspecified opponent/session.

SHA256 (repository LF bytes): `9c1782cf3fd11034b44232bb08c5878d8aefd7d88e4345be70f50941bff45987`.

`selection-stockfish.json` contains real Stockfish **19 lite single**, depth **8**,
16 MiB hash, `ucinewgame` reset per FEN, single-PV reads for the union of old/new
300-candidate queues per colour (890 distinct FENs). Scores are converted from
side-to-move to White POV before the production prefilter converts to user POV.
Terminal positions without a legal move have no usable reply. No Maia outputs
are fabricated; Maia effects are covered separately by deterministic unit tests.

Engine fixture SHA256 (repository LF bytes): `ea199bb20f8eaa98a5b7362d2da0555095ab1996958cafb4ee206beee0a05c27`.

Reproduce offline:

```sh
node scripts/scout-selection-v2-study.mjs
npx vitest run web-src/scout-selection-v2.test.js
```

To regenerate engine reads using the installed package:

```sh
node scripts/scout-selection-v2-study.mjs --refresh-engine
```

Results are descriptive regression evidence, not held-out prediction accuracy or
measured improvement in human preparation outcomes.
