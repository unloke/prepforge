# Finding: v10 Scout plans change between sessions on the same games

Recorded 2026-10-05 on `research/scout-v11-path-guard`. This finding is separate from the path guard and is not fixed in that change.

## Observation

calmzone, both colours, 500 newest Lichess games. There were two back-to-back runs on the local dev build with `?scoutPathGuard=0`, so this is pure v10 and no path-guard code ran.
11 of the 24 plan rows differed: 3 white and 8 black. The order differed too.

Earlier guarded sessions showed the same effect. Their v10 control set (`[scout-path-guard]` debug log) was not the same from one session to the next.

The game set could have changed by a new game between runs, but that is unlikely to move 8 black rows within minutes. The next check should pin the game IDs.

## Cause (measured)

The prefilter reads depth-8 leaves with pooled workers, which share a dynamic queue. Each worker sends `ucinewgame` once, so the transposition table carries over from one position to the next. Which positions came before a read depends on scheduling, and that changes the result:

| 71 leaf/path positions, Stockfish 19 lite single, depth 8 | Result |
|---|---|
| fresh hash per read, repeated | 0 / 71 differ |
| one hash carried, forward order vs fresh | 69 / 71 differ, max 93 cp, 11 cross ±75 |
| one hash carried, reverse order vs fresh | 69 / 71 differ, max 113 cp, 13 cross ±75 |

Crossing ±75 changes the v10 leaf gate (`engineOk`) and the engine term `E`. That changes the candidate set and the ranking. The script used is `research/scout-v11/engine.mjs` (`newLine` + `read`).

## Not caused by the path guard

- It reproduces with the guard off.
- The guard uses its own provider. That provider is not pooled and starts a new game per line. Its reads are depth-bounded and node-bounded, not time-bounded, so the guard cannot change prefilter reads.

## Options (not done)

- Send `ucinewgame` before each prefilter read, which matches the research `fresh` semantics. Cost is unmeasured in the browser.
- Or assign positions to workers deterministically and order each worker's queue.
- Either change alters v10 rankings and needs its own benchmark run against the frozen corpus.
