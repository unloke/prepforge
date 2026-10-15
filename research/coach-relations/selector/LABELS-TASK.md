# Label table for a candidate-reason selector

Folder: research/coach-relations (a rule-based chess Coach: explain.py writes one short reason per
graded move from two single-PV Stockfish lines; facts come from positional.py / enumerate.py).
Write only under selector/. Do not edit other files, do not commit. Keep code short, no shims.

Write `selector/labels.py` producing `selector/labels.jsonl`, one row per judged card:
- sol board checks: guard-check, bp-check, qc-check, pr-check, kl-check, plus their r1/ r2/
  subfolders: `out/check.jsonl` joined to `items.jsonl` by `i`. Fact type = folder (guard=defender,
  bp=bishop_pair, qc=queen_chased, pr=promotion, kl=king_leaves). Keep every boolean field as a
  label (correct/facts, reason/main reason, ...) and the note.
- sol A/B verdicts: `ab*/run-output/judge/out/*.jsonl` (pair_id, verdict A/B/tie/both_bad,
  issues per side) with `ab*/run-output/BLIND-KEY.json` (`pairs[pid]` gives id, which side is
  "relations"/"production", and `facts`). Label from the relations side: won/lost/tie/both_bad and
  its issues.
- the user's reviews: `ab*/human-review/HUMAN-REVIEW.json` (`reviews[]`: pair_id, verdict, issues,
  note), mapped through the same BLIND-KEY; source "user".
Row fields: source (sol_check/sol_ab/user), round/folder, card id, fact types, coach text if
present, grade and loss in cp if present in the items, labels, note.
Then add per-card features by rerunning explain on the card where possible (see make_ab.py: its
`--reads` setup, tactics.READ caches under artifacts/benchmarks/coach-relations-20261014, and
make_ab.row/explain.explain); features: chosen fact type, its line (played/best), first ply,
whether the other line has the same fact type, loss (row["loss"]), grade, number of facts. Never
start fresh engine searches over many cards: if a card is not in the caches, leave features empty.

Finish with `selector/LABELS.md`: counts per source and fact type, and how many rows got features.
