# Move-graph preparation research

The primary evidence is a deterministic audit of **38 saved public Lichess studies** using legal moves and positions, with no annotation scoring, engine, LLM or network. [move_graph_audit.py](move_graph_audit.py) produced [move-graph-results.json](move-graph-results.json): all 38 completed; all recorded corpus invariance checks passed. Original audit work took 6.36 seconds; the full audit plus invariance checks took 38.48 seconds on the recorded machine. These are audit timings, not browser latency or the Preparation evaluator runtime.

[Direct move-tree examples](content-review-examples.md) show opponent handling, move-order transpositions, repeated positions and endpoints. Detailed uncommented repertoires can contain substantial preparation. A stored losing line can be a demonstration; the graph alone does not recover author intent.

## Production Preparation profile

Atlas retains the **Preparation index**, four-facet radar and route map. It runs locally on the selected repertoire root or current-position subtree, using a **16-ply horizon relative to that root**. Every annotation is ignored. Only enabled, reachable legal moves and canonical positions enter the graph; equivalent positions merge their continuations within that scope. Position identity includes side, castling rights and legal en passant, excluding move counters.

Own policy prefers prepared mainline, then prepared, then mainline, then other moves; ties use lexicographic UCI. Opponent choices split equally over distinct stored moves. This is a **stored-route reference, not empirical encounter probability**. Missing opponent alternatives are not assessed. Traversal stops before a repeated-position edge earns depth; it does not infer a draw from position identity alone. Checkmate/stalemate absorb survival regardless of winner, so survival does not certify a favorable result.

Let S(h) be the reference route mass surviving through ply h. Missing continuations and repetitions stop their mass. Let H=16.

| Facet | Definition |
| --- | --- |
| Replies | 100 × unique nonterminal own positions with a stored legal reply / all unique nonterminal own positions, including frontiers |
| Reach | 100 × S(H), including earlier checkmate/stalemate |
| Depth | 100 × sum of S(1)…S(H) / H |
| Move orders | 100 × eligible own-position groups sharing a reply across all distinct occurrence reply sets / eligible groups |

Move orders requires at least two canonical incoming edges or two distinct reply sets for the same position; empty sets participate. Identical copies add neither incoming edges nor reply sets, while a coherent transposition with the same response can qualify. It displays a dash when none qualify. Different own alternatives are not called mistakes. An empty graph has no index. The index is the equal mean of applicable facets: a **product convention, not a validated holistic quality measure**. Reach and Depth are related, not independent supporting evidence. Legal but poor moves can score well; unrecorded opponent choices can expose gaps this reference never visits.

The exact implementation is [atlas-quality.js](../../web-src/atlas-quality.js), export atlasPreparation. The separate [profile evaluator](evaluate-preparation.mjs) runs this exact export and writes preparation-results.json. It checks annotation and duplicated-chapter invariance and records per-study/side distributions, not quality separation. Its PGN converter selects first variations as prepared mainlines for deterministic traversal; this convention does not establish author intent. Connected custom-position chapters join the standard-root scope; disconnected starts are excluded and reported. The structural audit above is a separate result, not a substitute for profile evaluation.

The completed [profile results](preparation-results.json) cover all 38 studies and
45 color reports. Every annotation, duplicated raw chapter, copied scope and
reversed-chapter check passes. The converter canonicalizes chapter order and
removes 24 exact structural duplicates from 724 chapters before custom-root
attachment. This fixes the two initial duplicate-import failures rather than
discarding those checks. Original scoring took 15.90 seconds in aggregate; the
full conversion/evaluation/invariance run took 115.33 seconds. These checks
establish structural invariance, not separation of good and poor repertoires.

The application runs the scorer in a dedicated worker. Closing Atlas or changing
scope terminates that request; only move/position fields enter the worker.
A Chromium check on 2,000 real converted nodes completed in 178.7 ms while the
UI's 10-ms heartbeat fired 17 times. This establishes responsiveness for that
sample, not a universal runtime bound.

Run the offline checks from the repository root in this Windows checkout:

```powershell
.venv313/Scripts/python.exe research/atlas-quality/move_graph_audit.test.py
.venv313/Scripts/python.exe research/atlas-quality/move_graph_audit.py
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
