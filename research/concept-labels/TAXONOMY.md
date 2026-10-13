# Concept taxonomy (2026-10-13)

`taxonomy.json` was curated by hand from an open-vocabulary pass: Qwen3-4B named the chess ideas
in 30,000 random GameKnot comments with no candidate list (20,103 distinct phrases; 1,560 in 3+
comments, clustered with bge-base at cosine 0.10-0.30). Output:
`artifacts/benchmarks/concept-labels-20261012/phrases-output/`.

Curation rules:
- Dropped the model's catch-all phrases ("tactical idea" 771, "positional idea", "plan",
  "evaluation idea", "strategic idea"): sampled comments under them name unrelated things.
- Kept close-but-different ideas apart, each with a definition that separates it:
  initiative (dictating play with threats), pressure (sustained pressure on a target),
  piece_activity (scope and mobility), counterplay (the defender's own chances),
  tempo (time), development (opening mobilisation).
- Merged only spelling and phrasing variants (center/centre control, counter-attack, mate in two
  / mating net / threat of mate), and state/negation pairs of one idea (space and cramped,
  king safety and exposed king).
- "tactical threat" (636) is mostly "the threat is X winning Y" and attacked pieces, so it is
  `threat`; "exchange sacrifice" (114) was mostly misused for plain exchanges, so exchanges are
  `trades` and real sacrifices `sacrifice`.
- Rare canonical ideas are kept (opposition, zugzwang, bad_bishop, seventh_rank): they label
  comments even when too rare for the router (the probe trains concepts with 200+ positives).
