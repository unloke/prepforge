# Scout selection v2: prepare observed decisions, not shallow game buckets

2026-09-26. Base: latest `origin/main` at `60506849c71a04875a7ddd79fd8f23c06b6e3120`.
Branch: `fix/scout-selection-v2`. Production implementation: `27083ff`.
The preceding study is archived in [v8 research](scout-selection-v8-research.md).

## Root cause and reproduced failure

Version 8 maximized `sum(WilsonLower(fullRouteGames, allGames) * opportunity)`
over a prefix antichain. The DP correctly solved that objective; the objective
was wrong for this preparation task.

1. A parent contains all descendant historical games. With similar bounded engine
   values it earns more support than any continuation. Splitting games into child
   buckets also pays multiple Wilson uncertainty penalties. A parent therefore
   usually beats both a child and a collection of children.
2. `fullRouteGames / allGames` includes the frequencies of historical **user**
   choices. It penalizes a route that we can deliberately enter as if those moves
   were uncertain opponent responses. A 1/1 response after our uncommon move is
   not a 1/N opponent tendency.
3. A two-ply family label and a specific preparation route had identical utility
   semantics. Knowing only `1.e4 c5` received credit for every later game without
   preparing those later decisions. No part of the objective valued that content.
4. The same single-route score ordered the 300-entry engine queue, so shallow
   support could suppress concrete candidates before the final DP saw them.
5. Existing synthetic tests explicitly required the 40-game trunk to beat its
   single-game continuation. They protected support arithmetic but accidentally
   prescribed the undesirable product behavior.

The pinned 1,187-game EricRosen corpus reproduces this failure class, including
`e4 c5` and `d4 Nf6`. It is not a capture of the unspecified original user session
or a claim that all four reported lines occur in this opponent's selected set.
Before Stockfish, v8 returns only `d4` and `e4` for White, and 11 two-ply routes
out of 12 for Black. With real depth-8 Stockfish reads, Black still has **8/12**
two-ply recommendations. Tests were run red before changing the implementation.

## Alternatives investigated

| Model | What it fixes | Why chosen or rejected |
| --- | --- | --- |
| v8 Wilson full-route coverage | Makes support uncertainty explicit | Optimizes historical buckets, double-penalizes our choices and inherently favors ancestors |
| Minimum depth / singleton rejection | Changes visible symptoms | Rejects valid short tactics or deep observed lines without measuring their content |
| Opponent-only conditional product × leaf opportunity | Removes historical user-choice penalty | Parent still has at least the child's reach; does not value preparation content |
| Linear sum of observed decision credits | Values concrete continuations | First real-corpus iteration rewarded repeated moves from the same single game too strongly |
| Sum of single-route decision utilities | Values decisions | Repeated shared prefixes would earn credit once for every selected route |
| **Diminishing unique decision coverage + bounded leaf opportunity** | Values observed content, separates control from prediction, discounts repeated evidence | **Selected; tree structure admits exact budgeted optimization** |

Decision-theoretic modeling separates controllable actions from uncertain
responses; see [Kearns, Mansour and Ng](https://ai.stanford.edu/~ang/papers/ijcai99-largemdp.pdf)
for the general planning setting. We do not implement their sampling algorithm
or claim its guarantees. Weighted coverage motivates counting a shared preparation
fact once; see [Nemhauser, Wolsey and Fisher](https://dial.uclouvain.be/pr/boreal/en/object/boreal%3A66601).
Our prefix-tree structure permits an exact DP instead of applying a cardinality-only
greedy guarantee to an antichain-constrained problem. The concrete utility below
is an explicit product model, not a formula established by either paper.

## Evidence and utility

Every candidate is an actual opening prefix ending on the opponent's move. For
its opponent decisions `j`, the exact filtered trie supplies `m_j` games choosing
the response and `n_j` games reaching its parent. User moves have no probability
factor. No population move probability or Maia policy is substituted for these
counts.

```
p_j = m_j / n_j
P_j = product(p_i for opponent decisions i <= j)
rho_j = m_j / (m_j + 2)
k_j = number of preceding consecutive opponent decisions with the same m_j
w_j = P_j * rho_j * 2^(-k_j)
```

`P_j` is a descriptive empirical plug-in reach under the user's specified moves,
not a calibrated next-game forecast. In particular a sparse 1/1 is not asserted
to be certain: its evidence credit is only 1/3. Raw frequencies avoid compounding
Jeffreys pseudo-count penalties at every step of the same single observed game.
The separate existing weakest-decision Jeffreys plausibility gate remains 10%.

Along a nested prefix, unchanged support count means the same supporting game
set. Additional moves from it provide more preparation content, but not independent
samples. Geometric diminishing returns bound that block's total credit by
`2*rho`, even for a very long game. A single-game tail therefore receives positive,
bounded credit rather than either an exclusion or unbounded length reward.
When the supporting set changes, the new branch starts a new evidence block.
The reliability pseudo-count 2 and discount 1/2 are stated modeling choices,
not learned/calibrated optimal parameters.

Leaf opportunity retains the existing bounded Stockfish/Maia semantics:

```
posteriorOpponentScore = (support*personalScore + 2*maiaOrBaseline)/(support+2)
weakness = max(0, baseline-posteriorOpponentScore)/100
engine = max(cp,0)/(100+max(cp,0))
# user-favourable mate: 1; unavailable engine: provisional 0.1
opportunity = engine*(1+weakness)
terminalValue = P_last * support/(support+2) * opportunity
```

Maia contributes at most two pseudo-games only to this leaf outcome signal. Its
influence decays with personal support; it never changes decision counts, reach,
eligibility or adds a route. The existing positive-opportunity/actionable-reply
Stockfish gate remains, so the current product still targets exploitable positions.
An assessed empty set is never silently replaced by an engine-free fallback.

The production path supplies complete conditional evidence. For an external or
legacy caller supplying only route counts, there is no basis to reconstruct
conditional decisions: no decision credit is invented, and Wilson observed
coverage remains the conservative terminal-only fallback. The `coverage` field is
also retained as a diagnostic; it is not multiplied into complete-evidence route
utility.

## Exact set selection

For a feasible set S of at most 12 non-nested routes:

```
F(S) = sum(w_e for unique opponent-decision edges covered by S)
       + sum(terminalValue(r) for r in S)
```

Every shared decision edge is counted once. Different user choices describe
available preparation alternatives, not independent future-game events, so F is
not a probability and may exceed one. This selects a preparation portfolio; it
does not force a single coherent repertoire choice at every user turn.

For each node and slot count, the DP combines child solutions by knapsack
convolution, compares with stopping at the candidate at that node, then adds the
node's edge credit once to each nonempty solution. The ancestor edge credits are
common to all choices below that node. This gives exact optimality for F on the
supplied tree/candidate set. Equal utility prefers fewer slots, then deterministic
UCI traversal (and an equal-value ancestor). Display and queue sorting use the
single-route utility; those values must not be summed to describe set utility.

An ancestor now gets credit only for decisions it actually prepares. Its
continuation keeps that shared credit and can add observed response content;
it need not overcome a global n/N penalty for our chosen moves. The model has no
minimum length rule: a strong short tactical opportunity can still beat a weak
continuation. Extending the UCI array without new observed decision evidence earns
nothing. Nested recommendations and duplicate routes cannot consume extra slots.

## Real before/after

Run the committed reproduction:

```sh
node scripts/scout-selection-v2-study.mjs
# Optional: regenerate actual Stockfish reads using the installed package
node scripts/scout-selection-v2-study.mjs --refresh-engine
npx vitest run web-src/scout-selection-v2.test.js
```

[Fixture provenance and hashes](../tests/fixtures/scout/README.md).
[Complete results and selected SAN/UCI routes](scout-selection-v2-results.json).
The same actual Stockfish 19 lite, depth-8 evaluations are cached for the union
of both 300-candidate queues: 890 distinct FENs. No Maia outputs are synthesized.

| Opponent / pipeline | Routes before → after | Routes ≤2 plies before → after | Unique prepared opponent decisions before → after |
| --- | --- | --- | --- |
| White, engine unavailable | 2 → 12 | 2 → 0 | 2 → 147 |
| Black, engine unavailable | 12 → 12 | 11 → 0 | 13 → 138 |
| White, real Stockfish | 12 → 12 | 0 → 0 | 53 → 143 |
| Black, real Stockfish | 12 → 12 | **8 → 0** | **29 → 139** |

Examples from Black's assessed results: v8 selects `e4 e5` (n=175), `e4 c5`
(n=69), and `d4 Nf6` (n=31). Version 9 selects observed concrete lines such as
`e4 e5 Nf3 Nf6 Nxe5 Nc6 Nxc6 dxc6 d3 Bc5 Be2 h5 c3 Ng4 d4 Qh4 g3 Qf6 f3 h4
Bf4 hxg3 Bxg3 Ne3 Qd2 Ng2+` (n=1, user +365cp), and the observed continuation
`d4 d5 c4 e6 Nf3 Nf6 g3 dxc4 Bg2 Bb4+ Bd2 c5 Bxb4 cxb4 Ne5 O-O a3 Nd5 Nxc4
Nc6 O-O a5 Qd2 b5 Ne3 Ba6` (n=1, user +118cp).

The same-new-queue comparator isolates the final objective: v8 covers 94/27
unique decisions for White/Black on that identical assessed pool, versus
143/139 with v9. Thus the effect is not solely changing engine queue allocation.
Singleton counts after real assessment are 12/12 White and 11/12 Black. Those
are reported transparently, not treated as a target metric or automatically as
poor quality: all moves are observed and full-route counts remain exactly one.
More prepared decisions is an in-sample descriptive measure, not demonstrated
win-rate improvement or evidence that these particular long lines are optimal
for every user's study time.

## Regression and verification

The new regression suite covers real engine-unavailable and engine-assessed
failures in both colours; uncommon user choices; uncommon opponent responses;
single-game continuations; repeated evidence saturation; bounded Maia; short mate
opportunities; zero support; duplicate routes; and 90 brute-force comparisons
against the unique-edge objective. Existing 160 terminal-only DP comparisons and
support transport tests remain. Old trunk-wins expectations were explicitly
changed; their evidence count assertions were retained.

| Check | Result |
| --- | --- |
| Full `npx vitest run` | 1,586 passed, 102 files |
| `npm run test:research` | 92 passed, 5 files |
| `npm run lint:js -- --quiet` | Passed, zero errors |
| `npm run build:e2e` + Scout/refutation pytest E2E | 2 passed, no skips |
| `tests/test_scout_production_boundary.py` | Passed |
| Final `npm run build` | Passed; production assets restored after E2E |
| `node scripts/check-bundle-size.mjs` | Passed, no budget changes |
| Main app / Maia worker / CSS | 290.9 KiB raw (92.3 gzip) / 156.9 KiB / 149.2 KiB |

The existing Windows Python 3.13 environment was used with this worktree's `src`
on `PYTHONPATH`. Existing Vite mixed static/dynamic-import notices and the existing
Starlette/httpx deprecation warning remain; there were no failed or skipped checks.

## Limits

This is a preparation-content proxy, not a calibrated expected win gain. The two
reliability/discount constants are transparent assumptions; a held-out multi-player
study and measured learning outcomes would be needed to tune them scientifically.
The 300-read queue is still heuristic, and exact optimality is only over supplied
candidates. The existing opening extractor may retain lengthy routes; slots do
not measure study minutes. Exact path keys do not deduplicate transpositions.
The existing positive-engine gate, depth-8 uncertainty, outcome confounding,
selection bias and opponent drift remain limitations. Engine-free output is
provisional. None of these limitations warrants discarding a route merely for
being deep or having one observed game.
