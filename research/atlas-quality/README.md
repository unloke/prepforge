# Move-graph preparation research

The primary evidence is a deterministic audit of **38 saved public Lichess studies** using legal moves and positions, with no annotation scoring, engine, LLM or network. [move_graph_audit.py](move_graph_audit.py) produced [move-graph-results.json](move-graph-results.json): all 38 completed; all recorded corpus invariance checks passed. Original audit work took 6.36 seconds; the full audit plus invariance checks took 38.48 seconds on the recorded machine. These are audit timings, not browser latency or the Preparation evaluator runtime.

[Direct move-tree examples](content-review-examples.md) show opponent handling, move-order transpositions, repeated positions and endpoints. Detailed uncommented repertoires can contain substantial preparation. A stored losing line can be a demonstration; the graph alone does not recover author intent.

## Production Preparation profile

Atlas keeps the large index, radar, compact metric rows and route map. The radar
now has five axes. The calculation uses only enabled legal moves, positions and
prepared/mainline flags. It runs locally in a cancellable worker; no annotations,
engine, LLM, popularity or network enter the score.

[Qualitative facet calibration](facet-calibration-review.md) records the current
failure → revision cycle. [Frozen judgments](facet-judgments.json), committed before
fitting, give every reviewed side five subjective scores with separate move-based
rationales. [Validation](facet-validation.md) lists all targets, shipped fits,
family-held-out predictions and worst remaining errors. These are single-reviewer
development judgments, not independent expert quality certification.

Each occurrence selects the best own tier: prepared mainline, prepared, mainline,
then other. Tied plans coexist. Core traversal follows preferred tiers on both
sides; other opponent moves can establish supported breadth without diluting core
depth. Short illustrative author intent cannot always be recovered from this.
Opening completion reuses `gamePhase`, consecutive non-opening positions and two
quiet plies without check. Subsequent model-game moves earn nothing. A 32-ply
scope-relative bound limits unresolved openings; winning mate/stalemate complete,
while losses and repetition stop progress.

| Facet | Content observations fitted to qualitative judgments |
| --- | --- |
| Replies | Supported response continuations and route/deployment adequacy |
| Reach | Supported opponent alternatives across positions and per route, plus adequacy |
| Depth | Core completion and own deployment at distinct core endpoints |
| Consistency | Early choice burden, shared repeated replies and staged pawn-setup reuse |
| Ease | Two-action reuse in matching pawn structures/development stages, quiet actions and choice burden |

Preparation fits supported breadth and geometric route/deployment adequacy to
separate overall judgments. Difficulty does not reduce the total. Follow-up
support examines at most six plies: a single own answer supplies no support,
two supply half, three supply full support. Stable opening end or a winning
terminal position also supplies support. See the calibration review for precise
feature conventions, rejected candidates and limitations.

Ease comparisons match own pawn structure, developed-minor count, material, king
positions and castling phase; opponent pawns may differ by one relocation. Checks
are excluded. No comparisons means a dash. Consistency can estimate single-plan
coherence without repeated positions, but absence of observed contradictions is
not proof. Equal stored weights are not empirical encounter probabilities.
Unrecorded opponent moves are unknown. No score certifies tactical soundness.

Position identity includes pieces, turn, castling and legal en passant, excluding
clocks. Equivalent continuations merge only within scope. Every enabled tree edge
is legally validated, including excluded illustrative descendants. The converter
canonicalizes chapter order, removes exact duplicate chapters and attaches
connected custom starts; disconnected starts are reported, not invented.

`atlas-quality.js`, `atlas-content-features.js`, `atlas-ease.js` and the small
`atlas-calibration.js` coefficient tables implement the local calculation.
`evaluate-preparation.mjs` executes it on the corpus with annotation, raw chapter
copy, assembled tree copy and reverse chapter checks. `calibrate-preparation.mjs`
replays the same corpus and controlled mutations. See their JSON reports for
per-study values and recorded timings. The UI's five-axis capture uses the same
populated London fixture before and after, at 1440/1000/390 pixels. Recorded worker/browser checks use the same populated fixture; their timings
are measured samples, not universal runtime guarantees.

Run from the repository root:

```powershell
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/review-content.py
node research/atlas-quality/calibrate-preparation.mjs
node research/atlas-quality/write-ranking-report.mjs
node research/atlas-quality/evaluate-preparation.mjs
```

## Evidence and interpretation

The [all-38 catalog](catalog.md) retains source/title, corpus role, saved likes and earlier manual instructional judgments with [review A](review-a.md), [B](review-b.md) and [C](review-c.md). [Manual classifications](manual-review-labels.json) explicitly mark their target limitation. These are **wrong-target labels for move-content quality validation**: a low standalone-course-clarity judgment does not establish a poor repertoire. In particular LLNDy032 has developed Alapin/French branches despite its earlier instructional label. Do not train or validate a move-content grader against these labels as-is.

High likes are positive-unlabeled reception evidence; low/missing likes are unknown. Likes and the earlier course-clarity labels do not determine the profile. The
new frozen facet judgments explicitly rate move content and fit its coefficients. The corpus informed method design and is not an untouched holdout. No empirical Lichess frequency snapshot was acquired; the anonymous acquisition attempt returned 401, as recorded in the [content examples](content-review-examples.md). Uniform stored-move weights must not be presented as Lichess frequencies or Maia probabilities.

The rejected [annotation-rate findings](rejected-documentation-findings.md) and [engine path-score findings](rejected-engine-findings.md), with their frozen [historical aggregate](evaluate-summary.json), document failed quality-grading approaches. They do not validate the current preparation index. Original PGNs, hashes and attribution remain in [corpus/manifest.json](corpus/manifest.json); reception snapshots remain in [corpus/stars.json](corpus/stars.json).

## Reproduce the completed structural audit

```powershell
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/move_graph_audit.py
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/move_graph_audit.test.py
node research/atlas-quality/evaluate-preparation.mjs
```

These commands perform no source acquisition or fitting; they execute the shipped
move-content estimates and invariance checks. Raw graph counts, source examples and invariance results establish what was inspected; they do not establish tactical soundness, real-world coverage or an overall good/bad ranking.
