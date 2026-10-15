# Selector labels

Generated with `py -B selector/labels.py`.

1062 judged rows; 952 distinct card IDs. Each judgment remains a separate row, including repeated cards and user reviews.

| Source | Rows | With features |
| --- | ---: | ---: |
| sol_check | 171 | 171 |
| sol_ab | 810 | 810 |
| user | 81 | 81 |

Fact types are the check folder's type or the sealed key's historical `facts`. `null` means the key did not record facts; `[]` means it recorded no chosen fact. Types count once per row, so rows with multiple types appear in multiple counts.

| Fact type | sol_check | sol_ab | user | Total |
| --- | ---: | ---: | ---: | ---: |
| bishop_pair | 62 | 10 | 5 | 77 |
| castling | 0 | 6 | 0 | 6 |
| defender | 40 | 0 | 0 | 40 |
| forced_mate | 0 | 3 | 0 | 3 |
| fork | 0 | 14 | 2 | 16 |
| king_leaves | 9 | 0 | 0 | 9 |
| mate | 0 | 5 | 1 | 6 |
| mate_threat | 0 | 17 | 0 | 17 |
| material | 0 | 214 | 26 | 240 |
| no fact | 0 | 153 | 12 | 165 |
| outpost | 0 | 4 | 0 | 4 |
| passed_pawn | 0 | 12 | 2 | 14 |
| pawn_weakness | 0 | 29 | 3 | 32 |
| piece_harassed | 0 | 19 | 4 | 23 |
| promotion | 20 | 10 | 2 | 32 |
| queen_chased | 40 | 10 | 4 | 54 |
| restricted | 0 | 3 | 1 | 4 |
| trades | 0 | 10 | 1 | 11 |
| unknown | 0 | 300 | 20 | 320 |

| Folder | Rows | With features |
| --- | ---: | ---: |
| ab | 70 | 70 |
| ab10 | 40 | 40 |
| ab11 | 90 | 90 |
| ab12 | 41 | 41 |
| ab2 | 60 | 60 |
| ab3 | 70 | 70 |
| ab4 | 60 | 60 |
| ab5 | 60 | 60 |
| ab6 | 100 | 100 |
| ab7 | 110 | 110 |
| ab8 | 90 | 90 |
| ab9 | 100 | 100 |
| bp-check | 22 | 22 |
| bp-check/r1 | 20 | 20 |
| bp-check/r2 | 20 | 20 |
| guard-check | 20 | 20 |
| guard-check/r1 | 20 | 20 |
| kl-check | 9 | 9 |
| pr-check | 20 | 20 |
| qc-check | 20 | 20 |
| qc-check/r1 | 20 | 20 |

Features: **1062/1062 rows**. Empty features: none.

Feature inputs follow make_ab.py: rounds ab–ab5 use positions.jsonl (v5 cut lines); later rounds and board checks use make_ab.row on the production-depth out/{fresh1,fresh2,fresh3,fresh4,v5}/cards.jsonl full lines. The v5 kernel supplies 22 board-check cards absent from fresh*. Grade and loss_cp use that input where available; unknown loss remains null.

Read 25 additional cache files plus tactics.CACHE (112019 cached FENs). The analyse entry point is replaced by a cache-only lookup; no engine searches or cache writes occur. A missing input or any required FEN missing from the cache leaves the entire features object empty. Unexpected errors stop generation.

Features use the current explain.explain result: chosen_fact_type, line, and first_ply refer to its first chosen fact (null when none). other_line_same_type checks the enumerator's candidates, captured during that exact explain call, before explain's wording filters; null when there is no chosen fact. num_facts counts those candidate facts; num_chosen_facts counts the facts selected for the reason. loss is row['loss'] in centipawns, null when unavailable. Historical coach text and fact_types are never replaced by the rerun.

Check labels preserve every boolean field, including false values. A/B labels store the relations-side outcome (won/lost/tie/both_bad) and its issues; pair_id and relations_side retain the unblinding link. Judge main_reason and confidence are kept in labels; note preserves the user/check note or the judge's why verbatim. All text is read and written as UTF-8 without normalization.
