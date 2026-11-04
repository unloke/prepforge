# Move-graph preparation research

The primary evidence is a deterministic audit of **38 saved public Lichess studies** using legal moves and positions, with no annotation scoring, engine, LLM or network. [move_graph_audit.py](move_graph_audit.py) produced [move-graph-results.json](move-graph-results.json): all 38 completed; all recorded corpus invariance checks passed. Original audit work took 6.36 seconds; the full audit plus invariance checks took 38.48 seconds on the recorded machine. These are audit timings, not browser latency or the Preparation evaluator runtime.

[Direct move-tree examples](content-review-examples.md) show opponent handling, move-order transpositions, repeated positions and endpoints. Detailed uncommented repertoires can contain substantial preparation. A stored losing line can be a demonstration; the graph alone does not recover author intent.

## Production Preparation profile

Atlas keeps the large index, radar, compact metric rows and route map. The radar
now has five axes. The calculation uses only enabled legal moves, positions and
prepared/mainline flags. It runs locally in a cancellable worker; no annotations,
engine, LLM, popularity or network enter the score.

The [38-study re-review](content-review.md) records sampled paths and the failure →
revision cycle. [Calibration](ranking-calibration.json) applies controlled damage
to all 45 side reports. [Rankings](ranking-review.md) compare before/after results,
matched opening families and parameter sensitivity. All data informed development;
these are development checks, not independent good/bad quality validation.

At each occurrence, select the best own tier: prepared mainline, prepared,
mainline, then other moves. All tied plans coexist; chapter merging never chooses
one by UCI alphabet. Core traversal uses preferred tiers on both sides. Other
opponent moves can establish answered breadth but do not dilute core completion.
This separates core plans from short side illustrations structurally; it cannot
infer author intent when a demonstration is itself a preferred chapter line.

Opening completion reuses `coach/material.js`'s `gamePhase`. It requires consecutive
non-opening positions, two quiet plies (no captures, promotions or checks), and no
current check. This avoids ending at the first phase switch during an exchange.
After completion, later model-game moves earn nothing. A **32-ply relative bound**
applies when no completion is found; a scope starting outside opening uses that
relative bound without immediate completion. Winning mate/stalemate complete the
route; a stored loss stops it. Repetition stops before its edge earns depth.
This is a stage heuristic, not a proof that tactics are resolved.

| Facet | Definition |
| --- | --- |
| Replies | Stored own replies / unique core own positions requiring a reply before completion or the bound |
| Reach | `100 × (1+B)/(5+B)`, where B counts answered opponent choices beyond the first at each distinct in-scope position; no bonus for own alternatives or copies |
| Depth | Mean core-plan survival through the bound; opening completion or winning mate/stalemate absorb survival; an opponent move without the required own answer earns nothing |
| Consistency | Repeated own positions whose nonempty preferred reply sets share a move / eligible repeated groups; ignore local empty endpoints |
| Ease | Mean overlap of next-two-own-action plans in comparable positions; same complete own setup, material, opponent king/castling phase, opponent pawns differing by at most one relocation; checks excluded |

No comparison data means a dash, not an invented 100. Plans with exchanged action
order can match. Exact position+choice contexts collapse duplicates. Ease weights
comparable positions equally, rather than letting prolific copies dominate.

The total is **sqrt(Reach × Depth)**. Missing replies already stop Depth;
including their availability ratio again rewarded hiding unanswered frontier
positions in the first phase trial. Replies stays visible as a diagnostic.
Consistency and Ease describe choice/learning load; intentional alternatives do
not lower the total. Reach's scale of four additional alternatives is a product
convention checked at scales two/four/eight, not fitted against likes. Stored
branch weights are equal, not empirical encounter probabilities. Unrecorded
opponent moves are unknown. No structural score certifies chess strength or
holistic teaching quality.

Position identity includes pieces, turn, castling and legal en passant, excluding
clocks. Equivalent continuations merge only within scope. Every enabled tree edge
is legally validated, including excluded illustrative descendants. The converter
canonicalizes chapter order, removes exact duplicate chapters and attaches
connected custom starts; disconnected starts are reported, not invented.

`atlas-quality.js` and `atlas-ease.js` implement the production calculation.
`evaluate-preparation.mjs` executes it on the corpus with annotation, raw chapter
copy, assembled tree copy and reverse chapter checks. `calibrate-preparation.mjs`
replays the same corpus and controlled mutations. See their JSON reports for
per-study values and recorded timings. The UI's five-axis capture uses the same
populated London fixture before and after, at 1440/1000/390 pixels. A 2,000-node
Chromium worker check completed in 177 ms while 17 UI heartbeat ticks fired.
These are measured samples, not universal runtime guarantees.

Run from the repository root:

```powershell
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/review-content.py
node research/atlas-quality/calibrate-preparation.mjs
node research/atlas-quality/write-ranking-report.mjs
node research/atlas-quality/evaluate-preparation.mjs
```

## Evidence and interpretation

The [all-38 catalog](catalog.md) retains source/title, corpus role, saved likes and earlier manual instructional judgments with [review A](review-a.md), [B](review-b.md) and [C](review-c.md). [Manual classifications](manual-review-labels.json) explicitly mark their target limitation. These are **wrong-target labels for move-content quality validation**: a low standalone-course-clarity judgment does not establish a poor repertoire. In particular LLNDy032 has developed Alapin/French branches despite its earlier instructional label. Do not train or validate a move-content grader against these labels as-is.

High likes are positive-unlabeled reception evidence; low/missing likes are unknown. Neither likes nor manual labels determine the profile or its weights. The corpus informed method design and is not an untouched holdout. No empirical Lichess frequency snapshot was acquired; the anonymous acquisition attempt returned 401, as recorded in the [content examples](content-review-examples.md). Uniform stored-move weights must not be presented as Lichess frequencies or Maia probabilities.

The rejected [annotation-rate findings](rejected-documentation-findings.md) and [engine path-score findings](rejected-engine-findings.md), with their frozen [historical aggregate](evaluate-summary.json), document failed quality-grading approaches. They do not validate the current preparation index. Original PGNs, hashes and attribution remain in [corpus/manifest.json](corpus/manifest.json); reception snapshots remain in [corpus/stars.json](corpus/stars.json).

## Reproduce the completed structural audit

```powershell
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/move_graph_audit.py
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/move_graph_audit.test.py
node research/atlas-quality/evaluate-preparation.mjs
```

These commands perform no source acquisition or quality grading. Raw graph counts, source examples and invariance results establish what was inspected; they do not establish tactical soundness, real-world coverage or an overall good/bad ranking.
