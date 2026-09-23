# Scout pressure and robustness gate comparison (2026-09-23)

This offline comparison uses the existing chronological held-out `move-results.json`
and Stockfish depth-10 `wdl-results.json`. Run `node
research/scout-benchmark/compare-gated.mjs` to regenerate
`gated-comparison.json`. Production ranking is unchanged.

Scout's target is a likely opponent route with sustained comfortable play for us.
The gate therefore requires the route's Stockfish WDL pressure floor ≥ 0.55,
consistency ≥ 0.8, per-decision Maia-alternative robustness floor ≥ 0.55,
and blunder dependency ≤ 0.5. Ranking among sound candidates would consider
opponent route reach (product of decision probabilities), geometric typicality,
and preparation cost (route length and distinct replies). The existing candidate
lists do not carry calibrated per-decision probabilities, so this comparison does
not pretend to estimate reach or choose a production ranking formula.

The following are the largest available profile split for each player. Move top-1
is pooled across colors in the source benchmark; all route metrics are evaluated
separately by opponent color. `coverage` is held-out opponent decision-point
coverage, `hit` is the conditional recommended move hit, `false` is false-prep
rate, and `stable` is 40→80 game entry Jaccard (first four plies).

| Player / opponent color | Method | Move top-1 | Coverage | Hit | False | Stable | Routes passing gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| EricRosen / white | Maia | .454 | .188 | .917 | .083 | .286 | 0/5 |
| EricRosen / white | residual | .434 | .125 | .000 | 1.000 | .143 | 0/5 |
| EricRosen / black | Maia | .454 | .114 | .700 | .300 | .667 | 0/5 |
| EricRosen / black | residual | .434 | .125 | .727 | .273 | .800 | 0/5 |
| DrNykterstein / white | Maia | .512 | .167 | .500 | .500 | .500 | 0/5 |
| DrNykterstein / white | residual | .556 | .153 | .455 | .545 | .500 | 0/5 |
| DrNykterstein / black | Maia | .512 | .125 | .182 | .818 | .600 | 0/5 |
| DrNykterstein / black | residual | .556 | .125 | .182 | .818 | .600 | 0/5 |
| penguingm1 / white | Maia | .359 | .250 | .600 | .400 | n/a | 0/5 |
| penguingm1 / white | residual | .398 | .250 | .600 | .400 | n/a | 0/4 |
| penguingm1 / black | Maia | .359 | .132 | .889 | .111 | n/a | 0/4 |
| penguingm1 / black | residual | .398 | .132 | .889 | .111 | n/a | 0/4 |

All 57 evaluated routes fail both the pressure and robustness floors: mean
pressure floors by player/color/method range from .378 to .509, and each route
has a zero robustness floor. Personal residual improves pooled move top-1 for
DrNykterstein and penguingm1 but degrades EricRosen at 80 games; for EricRosen
white it also lowers route stability, coverage, and hit rate. More profile data
does not yet yield consistently more reliable recommendations. The available
route sets are top-five *before* gating; held-out coverage after gating is zero.

No candidate clearly beats production ranking on held-out prep usefulness, so
there is no production formula proposal. Next experiment should generate
counterfactual candidate routes with prepared replies and Stockfish pressure
screening before ranking, then measure calibrated per-decision reach and
coverage by color on new chronological held-out windows. Full-line repetition
must not become an eligibility condition. This dataset is small (three players,
10–80 profile games, at most 20 held-out games per split); depth-10 WDL is a
research screen, not a calibrated real-game winning probability.
