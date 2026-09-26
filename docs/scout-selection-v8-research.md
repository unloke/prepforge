# Production preparation selection study — 2026-09-26

Baseline: `7f79e9d`, branch `fix/scout-production-evidence`. The scope is default
Scout, not v13. Reproduce with:

```sh
node scripts/scout-production-selection-study.mjs docs/scout-selection-after.json
npx vitest run scout
```

## Objective and evidence

Given a single opponent, filtered historical games and a budget K ≤ 12 per colour,
choose an observed, non-nested route set S to maximize a conservative proxy for
useful preparation coverage. Each recommendation costs one slot. We do not have
measured study time, learning efficacy, future games or a calibrated preparation
win-probability model; the objective is consequently a decision proxy, not expected
Elo or a claim of causal improvement.

For route r, n is the number of games reaching its **entire prefix**, and N is
the same-colour, same-speed corpus size. Let L(n,N) be the Wilson lower endpoint
using z=1.96. This is conservative *observed coverage*, including historical user
choices; it is not a forecast conditional on the user's chosen repertoire.
The separate weakest-opponent-decision Jeffreys gate stays at 10%.

Let s be the opponent's full-prefix empirical score percentage, b their baseline,
and m the Maia opponent WDL expected score (or b when missing):

```
posteriorScore = (n*s + 2*m)/(n+2)
weakness      = max(0, b-posteriorScore)/100
engine        = max(cp,0)/(100+max(cp,0))
opportunity   = engine*(1+weakness)
value(r)      = L(n,N)*opportunity
F(S)          = sum(value(r) for r in S)
```

A user-favourable mate sets engine=1. An unavailable engine uses 0.1 as an explicit
provisional fallback, not an invented evaluation; an assessed nonpositive edge
does not qualify. Maia supplies at most two pseudo-games to the *opportunity*
estimate, never to n, N or route plausibility. Its maximum change to opportunity
is bounded by engine × 2/(n+2). Strong personal evidence therefore dominates it.

Opening-family membership has no role in the final objective, pre-engine queue,
engine ranking, Maia scheduling or final selection. A set containing twelve routes
from one family is correct when these are the most valuable non-overlapping
preparation targets. Nested routes are mutually exclusive, so their historical
game coverage cannot count twice. Non-nested observed prefixes represent disjoint
historical route buckets; their conservative values add.

The first implementation explored concave family coverage. The user's subsequent
product clarification explicitly rejected that goal. It remains a research
comparator only, and has been removed from every production decision. This is an
objective correction, not a change to the evidence estimator.

The z, 100cp saturation scale, two pseudo-games and 0.1
fallback are stated modeling choices, not fitted optimal parameters. Unlike the
old formula, each has one role. A depth increment earns no bonus; it needs better
opportunity sufficient to compensate for lost conservative coverage.

## Why the baseline loses quality

1. Terminal-only candidates omit useful shared trunks when no game stops there.
2. Family-prefix struggle can promote a one-game deep route as though it has the
   family's evidence. Exact-terminal games then replace full-prefix support in
   both collapse stages; a 40+40 trunk is incorrectly tied with its 40-game child.
3. The pre-engine prior floor, engine OR-gates and final Maia-first comparator
   optimize different criteria. Prior and struggle amplify the same history twice.
4. High empirical opponent performance vetoes real engine opportunities. Raw
   engine magnitude can outweigh relevance in the final weakness comparator.
5. An available Maia result beats an unavailable one regardless of personal
   evidence. Successful backup reads also displace unassessed candidates before
   the final selector sees them.
6. `prefilterMaiaLines` formerly returned the original line without its assessed
   metrics, and report lookup replaced passed candidates with bare branches.
7. Two destructive nested passes can disagree; pairwise first-match replacement
   is not a set optimization and can miss a better collection of disjoint preparation targets.
8. A successfully assessed empty engine set could trigger fallback and reintroduce
   the rejected lines. The new runtime distinguishes no evaluations from assessed
   non-opportunities and positions with no usable reply.

## Approaches evaluated

| Method | Statistical behavior | Set behavior | Cost / decision |
| --- | --- | --- | --- |
| Frozen baseline | Tiny samples and enrichment availability can dominate | Terminal-count pairwise collapse | Cheap; rejected |
| Wilson evidence times bounded opportunity, independent sort | Stable support penalty; bounded engine and Maia | Antichain greedy | Cheap; an early parent blocks better child combinations |
| MMR-style same-family discount | Same evidence estimator | Fixed 0.5 family penalty | Rejected: sacrifices practical value for an unwanted diversity goal |
| Greedy marginal concave family coverage | Same estimator | Family diminishing returns plus antichain greedy | Rejected: wrong product goal and early-parent lock-in |
| **Budgeted prefix-tree DP** | Same estimator | **Exact optimum of F over the supplied antichain candidates** | Small K=12; selected |

We also considered the Jeffreys posterior mean as the sole relevance estimator.
At 1/1, 2/2 and 40/40 it yields .750, .833 and .988; Wilson lower endpoints are
.207, .342 and .912. The posterior mean is appropriate for the baseline conditional
plausibility gate but insufficiently conservative as the sole reliable-coverage
signal. Wilson makes the uncertainty cost explicit without inventing population
route frequencies or borrowing ancestor counts as full-route observations.

Wilson's endpoint follows the [NIST interval definition](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
These are per-route descriptive bounds under binomial assumptions, not simultaneous
confidence guarantees after selection, nor guarantees under opponent drift.
The classic [Nemhauser–Wolsey–Fisher coverage research](https://dial.uclouvain.be/pr/boreal/en/object/boreal%3A66601)
motivated testing marginal coverage. Its cardinality-only greedy guarantee does
not directly apply to our additional antichain constraint. The tree structure lets
us solve the additive value objective with the antichain constraint exactly instead.

## Synthetic results

The initial ten cases were committed before changing production (`c08ecb3`);
`scout-selection-before.json` records those actual baseline outputs. The additional
parent-versus-two-children case exposed the greedy solver limitation. The two
family scenarios were then explicitly corrected to prefer the higher-value routes
even when they share a family; the original JSON is historical, not the current
expected-policy contract. Frozen
baseline and greedy comparators live only in `research/`, never in production.
The harness compares final selection on the same fixed rows; separate integration
tests cover candidate creation, prefilter, report transport and live fallback.
Symbolic routes in the family flood isolate selection rather than chess legality.

| Scenario | Baseline | Final DP |
| --- | --- | --- |
| 40-game trunk + 1-game child | trunk | trunk |
| 40-game trunk + 2-game child | trunk | trunk |
| Stable 70/80 continuation with stronger opportunity | child | child |
| Same observed percentage, 1/2 vs 40/80 samples | small sample | larger sample |
| Frequent +5cp vs less frequent +200cp | opportunity | opportunity |
| 60-game +60cp vs 1-game +2000cp | rare outlier | relevant route |
| Maia conflicts with personal support | Maia favourite | personal evidence |
| Three nested routes | trunk | trunk |
| Two slots, competing families; A routes have higher value | A + A | A + A |
| Eight distinct A continuations, individually better than B/C | A + A + A | A + A + A |
| Parent individually best, two children jointly better | two children | two children |

Expected-policy agreement: baseline **8/11**, independent **10/11**, MMR **8/11**,
greedy concave family coverage **8/11**, final DP **11/11**. These hand-designed examples
are regression criteria, not an unbiased benchmark, empirical win-rate estimate
or proof that the utility parameters are optimal.

Regression tests additionally compare DP to exhaustive enumeration on 40 seeded
eight-candidate trees at budgets 1–4 (160 comparisons), verify reversed input order,
no depth reward, zero opportunities, perfect small samples, twelve targets from
one family, invariance to family labels, the hard 12-slot cap,
generated nonterminal trunks, retained engine metrics, and assessed-empty fallback.

Local Node measurement (300 candidates, 40 plies, 25 runs): median **1.24ms**, p95
**4.74ms**, max **9.71ms**. This is a selector microbenchmark, not a measured
Stockfish/ONNX/browser latency guarantee. At most 300 leaf positions per colour,
depth 8 and three engine workers remain; Maia still targets 12 successful reads
globally, with 64 attempts/backups at most. No new dependencies or network sources.

## Limits and follow-up evidence

Exactness applies to this objective and the supplied, capped candidate set. Engine
preselection remains a heuristic under a compute budget; we cannot know the best
unassessed position. Historical support may penalize a route reachable by choosing
a previously uncommon user move. This intentionally prefers demonstrated personal
coverage over optimistic conditional products, but is not a solved repertoire
policy problem. The antichain constraint cannot measure shared preparation work between
non-nested transpositions or different user replies to the same opponent pattern. Engine depth 8,
game-result confounding and drift remain limitations of the existing sources.

Future quality claims require a held-out opponent corpus and measured preparation
outcomes. Neither v13 nor a new data collection/UI project is included in this change.

## Final verification

Implementation commit: `d77262a` (following characterization commit `c08ecb3`).
Final checked implementation uses additive preparation value, with no family objective.

| Check | Result |
| --- | --- |
| Scout targeted Vitest, including final selector and prefilter regressions | Passed; final full run includes 762 Scout tests across 43 files |
| Full `npx vitest run` | 1,574 passed, 101 files, zero failures |
| `npm run lint:js -- --quiet` | Passed, zero errors; existing repository warnings remain in non-quiet output |
| `npm run build:e2e` + `pytest -m e2e tests/e2e/test_scout_smoke.py -q -rs` | Scout and refutation E2E both passed (2/2); existing Starlette/httpx deprecation warning |
| `npm run build` | Passed; final assets are the production build, not the E2E build |
| `node scripts/check-bundle-size.mjs` | Passed without budget changes |
| Main app chunk | 290.9 KiB raw / 92.3 KiB gzip |
| Maia worker / stylesheet | 156.9 KiB / 149.2 KiB raw; within existing limits |

The Windows E2E run used the existing Python 3.13 environment with this worktree's
`src` on `PYTHONPATH`. The global Python lacked FastAPI, so it was not used to
report a skipped or successful test. No dependency changes were needed.
