# Work to hand out (2026-10-15)

Context for anyone picking this up: `research/coach-relations` is a rule-based Coach that writes one
short English reason for a graded chess move from two single-PV Stockfish lines (best, played).
No LLM at runtime; heavy compute on Kaggle. Read `advanced-ideas/PLAN.md` and `explain.py` /
`positional.py` first. User taste: one reason, short, concrete pieces/squares/moves, no evaluation
sentence, bare over vague. No legacy code or compatibility shims.

## freebuff (research with code; output = a script + a short findings note in the task folder)

F1. **Label table for the selector.** Gather every judged candidate so far into one table:
    sol board checks (`guard-check`, `bp-check`, `qc-check`, `pr-check`, each `out/check.jsonl`
    joined to `items.jsonl`), sol A/B verdicts (`ab*/run-output/judge/out/*.jsonl` with
    `BLIND-KEY.json`) and the user's reviews (`ab*/human-review/HUMAN-REVIEW.json`, notes sets).
    Per row: card id, fact type, line (played/best), first ply, loss in cp, grade, persistence,
    whether the other line shares it, labels (correct, main reason, won/lost, missed_key_point).
    Deliver `selector/labels.py` and `labels.jsonl`, plus counts per fact type. No model yet.

F2. **Development tempo as a measure.** The user's notes keep saying "出子速度" (ab12 pair-002,
    pair-011; notes1 card 001). Define a count computable from one line (minor pieces leaving
    the back rank, castling, moves made with tempo vs. moves spent retreating) over the first 8
    plies of both lines. On the 28k-card pool (Kaggle caches; see `make_ab.py --reads`), report
    how often the gap is ≥2 tempi, and pull 20 examples for a board check. Question: can it
    become a fact "Bxc4 lets White develop N, B and castle while Black's queen moves twice", or is
    it only a selector feature?

F3. **queen_chased without net tempo.** `positional.queen_chases` counts a chase even when the
    chasing piece also has to go back (sol r2 item 18 in `qc-check`). Add the check that the
    chasers stay on their new squares (or gain something) and measure the drop on the pool's 69
    triggers. Report before/after examples.

## Hark (investigation / chess judgement; answer in prose, with the board reasoning)

H1. **King safety after a minor-piece trade** (ab12 pair-006 and pair-007). In pair-006 the user
    says Bd3 lets ...Nxd3 and then ...f5 becomes playable because after exf6 the bishop can
    retake. What board evidence would let a program say this (which recaptures change, which
    pawn break opens), and what one-sentence template would a coach use?

H2. **King too far from a passed pawn** (notes1 card 002 Kh2, ab12 pair-005). When pieces are
    still on the board, when is "the king walked away from the d-pawn" a fair reason, and when is
    it misleading? Is rule-of-the-square or king distance to the stop square the right measure?
    (We are testing a detector: the played king move increases distance to an enemy passed pawn's
    queening square, the pawn advances at once in the played line and not in the best line.)

H3. **Development as the reason.** For a ~2000 reader, when is "lets the opponent develop with
    tempo" the main reason rather than a side note? Suggest thresholds we can count (tempi,
    pieces developed, queen moves).

H4. **Doubled rooks / solid structure** (ab12 pair-008: "雙車太穩不好求勝"). Is there a concrete,
    checkable way to say a move lets the opponent consolidate (rooks doubled on an open file,
    no targets left), or should such cards stay bare?
