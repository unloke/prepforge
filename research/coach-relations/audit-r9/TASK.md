# Coverage audit: why the coach misses the key point

Each line of `items.jsonl` is a chess move where our rule-based coach did not name the main reason
the move was worse than the engine's best move. You get the position (`fen`, `side_to_move`), the
engine lines after the played move (`played`) and after the best move (`best`), the coach's text,
the judge's own `judge_main_reason`, and sometimes a strong human player's note (`human_note`,
Chinese; when present it outranks the judge).

The coach works from executable detectors on the two engine lines: material won or lost (counted
when the exchange settles), mate and mate threats, forks, castling rights lost, passed pawns made,
doubled or isolated pawns, holes, outposts, pieces with no safe square, pieces chased back, trades.
It looks at the lines up to a horizon: 4 plies, extended through checks, captures and delayed
recaptures, at most 10.

For every item decide, after checking the board yourself (python-chess is available; no engine):

- `key_reason`: one sentence, the reason a coach should give (correct it if the judge is wrong).
- `category`, one of:
  - `detector_missing`: a concrete, checkable board pattern no current detector covers (name it);
  - `horizon`: an existing detector would catch it, but it happens past the horizon or the
    horizon stops too early (say at which ply);
  - `strategic`: a plan or long-term idea (pawn break, bad bishop, king safety, piece activity,
    tempo) that needs a new, more abstract detector — say what it would test;
  - `wrong_line`: the reason only shows by comparing moves outside the two given lines;
  - `nothing_teachable`: the difference is engine-precise and has no human-sized reason.
- `motif`: a short snake_case name for the pattern (reuse names across items when they match).
- `predicate`: one or two sentences: how a program could test it on the given lines/boards.

Append one JSON object per item to `out/audit.jsonl`:
{"item": ..., "key_reason": ..., "category": ..., "motif": ..., "predicate": ...}
Do every item. Write only to `out/`.
