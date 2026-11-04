# Move-content diagnostics: six direct PGN inspections

Scope: directly parsed the saved raw PGNs below with python-chess, replayed their moves and inspected branches, endpoints and matching positions. No annotation, comment, title, evaluation, popularity or LLM output enters the proposed measures. Chapter titles/links below only locate the evidence for a human reader. No engine ran. These are preparation diagnostics, not a validated numeric judgment of good/bad repertoire quality.

**Correction to the earlier review:** sparse explanation does not establish poor move content. The earlier low instructional-clarity label for *Complete Repertoire* must not be reused as a negative repertoire-quality label. Its bare trees contain substantial concrete response handling. Conversely, annotating every node with `1`, adding verbose prose, or deleting all prose must leave every diagnostic here unchanged.

## Six examples, using actual move branches

### 1. London System Repertoire: coherent setup and an exact transposition repair

Raw source: [2EaSmZtz.pgn](corpus/2EaSmZtz.pgn), [London System Basics](https://lichess.org/study/2EaSmZtz/C8pUIq2K) and [London vs Old Benoni](https://lichess.org/study/2EaSmZtz/DDiPVb0p).

The Basics tree develops `1.d4 d5 2.Bf4 Nf6 3.e3 e6 4.c3 c5 5.Nd2 Nc6 6.Ngf3 Bd6 7.Bg3 O-O 8.Bd3`. It also stores `5...cxd4 6.exd4` and `7...Bxg3 8.hxg3`. This is positive concrete evidence of a repeatable setup plus responses that preserve or deliberately alter its pawn structure. Nothing about that finding needs prose. Stopping after development is not inherently defective: the stated assessment horizon must determine what continuation is required.

The Old Benoni main route is `1.d4 c5 2.d5 Nf6 3.Nc3 e6 4.e4 d6 5.Nf3 Be7 6.Be2 O-O 7.O-O`. Another stored route is `1.d4 c5 2.d5 Nf6 3.Nc3 d6 4.e4 e6 5.Nf3` and stops there. Replaying both confirms the same board position, side, castling rights and legal en-passant state after 5.Nf3. One occurrence has `...Be7`; the other has no continuation.

**Actionable judgment:** the shorter occurrence has an available position-equivalent continuation, not necessarily a missing chess answer. Link/reuse it within the same preparation scope. Copying that line should not earn extra coverage. The transition from a London setup to a d5/e4 center is a different stored response to a different Black opening, not an inconsistency merely because White's piece setup changes.

### 2. London Lifetime Repertoire: a narrow stored answer cannot establish universal readiness

Raw source: [artuehhC.pgn](corpus/artuehhC.pgn), [London line #1](https://lichess.org/study/artuehhC/BOsMGGU7).

Its main route is `1.d4 d5 2.Bf4 Nf6 3.e3 c5 4.c3 Nc6 5.Nd2 Qb6 6.Qb3 Qxb3 7.axb3`. An alternative recapture continues `7.Nxb3 c4 8.Nd2 b5 9.Ngf3`. The stored moves provide an answer to a concrete queen attack and explore a different recapture's pawn advance. The side alternatives `4.Nf3` and `4.Bb5+` stop immediately.

**Actionable judgment:** assess the opponent alternatives at the actual Black-to-move positions, rather than awarding breadth for the extra White alternatives. The line ends with White's king and several pieces still undeveloped, so it establishes that the queen-pressure sequence is answered, not that White is prepared through a longer opening horizon. Whether other chapters fill those positions requires position lookup first; absence in this one chapter is not study-wide absence. The bare moves do not say whether those short White alternatives are recommendations, demonstrations or quiz answers. Selecting the first variation is a deterministic traversal convention, not a recovered author intention.

### 3. King's Gambit: a bad opponent move can lead to a fully resolved stored response

Raw source: [ACmyH8gC.pgn](corpus/ACmyH8gC.pgn), [KGA: Punish 4...f6??](https://lichess.org/study/ACmyH8gC/hryv87g2). The chapter begins from the position after `1.e4 e5 2.f4 exf4`.

The stored main route is `3.Nf3 g5 4.h4 f6 5.Nxg5 fxg5 6.Qh5+ Ke7 7.Qxg5+ Ke8 8.Qh5+ Ke7 9.Qe5+ Kf7 10.Bc4+ Kg6 11.h5+ Kh6 12.Qxf4+ Qg5 13.Qxf8+ Qg7 14.d4#`. Replaying confirms actual checkmate. At `7.Qxg5+`, the tree also stores `7...Nf6 8.e5`; at `12.Qxf4+`, it stores `12...Kg7 13.h6+ Nxh6 14.Qxh6#`.

**Actionable judgment:** this is concrete preparation for particular Black replies, with genuinely terminal mating branches and a nonterminal alternative. Do not penalize the presence of `...f6`, reward material similarity to a preferred opening, or mistake one mating route for coverage of all defenses. Legal-move replay can establish checkmate. It cannot establish that every defense has been answered without examining the missing alternatives. Their empirical likelihood belongs in response coverage, not in an engine judgment.

### 4. Caro-Kann Living Repertoire: the same position can have intentionally different continuations

Raw source: [8Uztu7Xx.pgn](corpus/8Uztu7Xx.pgn), [Chapter #15: Advance Variation, Short Variation](https://lichess.org/study/8Uztu7Xx/1aa9xVHw) and [Middlegame Plan #8](https://lichess.org/study/8Uztu7Xx/n6qPnXnz).

The opening tree includes `1.e4 c6 2.d4 d5 3.e5 Bf5 4.Nf3 e6 5.c3`, followed by `5...Nd7`. The other chapter begins `1.e4 c6 2.Nf3 d5 3.e5 Bf5 4.d4 e6 5.c3 h6 6.Nbd2 Be7 7.Nb3 f6`. Replay confirms an exact position match after 5.c3 despite the different move orders. The second line eventually reaches `23.O-O-O Rh2 24.Rg8+`, a non-checkmating endpoint.

**Actionable judgment:** identify the shared position and different Black choices; do not classify them as conflicting or combine them into one chosen Black policy automatically. The graph alone cannot tell whether both are intended alternatives or one is a recorded game. Long continuation and an endpoint in check do not resolve that role question. For an explicitly chosen Black policy, use its selected edge; use the other occurrence for a possible continuation suggestion, subject to scope. This is a concrete limit on automatic union of all chapters, not a reason to discard the useful graph relation.

### 5. Crush the Caro-Kann: chapter boundaries are not preparation boundaries

Raw source: [CfSYkcMp.pgn](corpus/CfSYkcMp.pgn), [4...Qxd5](https://lichess.org/study/CfSYkcMp/t4y0mQGT), followed by chapters [10...Bh5](https://lichess.org/study/CfSYkcMp/rWcHyu3p), [10...Bg4](https://lichess.org/study/CfSYkcMp/ejHOmbxv), [10...Ba4](https://lichess.org/study/CfSYkcMp/hLjI5BgD).

From `1.e4 c6 2.c4 d5 3.exd5 cxd5 4.cxd5`, the stored line is `4...Qxd5 5.d4 Nc6 6.Nf3 Bg4 7.Nc3 Bxf3 8.Nxd5 Bxd1 9.Nc7+ Kd7 10.Nxa8`. Its apparent endpoint is exactly the starting position of all three later chapters, which store the three different Black bishop retreats. Position matching establishes the continuation without interpreting a chapter name or comment. Treating 10.Nxa8 as an isolated unfinished leaf would be a false alarm.

Also replayed: `1.e4 c5 2.c3 d5 3.exd5 Qxd5 4.d4 cxd4 5.cxd4` and `1.e4 c6 2.c4 d5 3.exd5 cxd5 4.cxd5 Qxd5 5.d4` reach the same position. This demonstrates why opening names and move-string prefixes are inadequate identities. The separate stored `4...Nf6 5.d4 Nxd5 6.Nc3 e6 7.Bd3 Bb4 8.Ne2` ends in a developing middlegame rather than the tactical queen-exchange sequence.

**Actionable judgment:** scope-compatible cross-chapter stitching preserves actual preparedness. These distinct White opening choices should be assessed separately, not averaged as though White randomly selects one. Their relative strategic merit is not established by their graph shapes.

### 6. Complete Repertoire: uncommented moves can supply meaningful defense and resolution

Raw source: [2XxhfIAJ.pgn](corpus/2XxhfIAJ.pgn), [Danish/Center Game (B)](https://lichess.org/study/2XxhfIAJ/aL40Y6Qr).

After `1.e4 e5 2.d4 exd4`, the tree distinguishes `3.c3 d5` from `3.Qxd4 Nf6 4.Nc3 Nc6 5.Qe3 Bb4 6.a3 Ba5 7.Bd2`. After `3.c3 d5 4.exd5 Nf6`, it stores responses to White's `5.cxd4`, `5.Bb5+`, `5.c4` and `5.Qxd4`. These are actual alternative pawn captures/checks, not merely decorative branching.

The last alternative resolves through `5.Qxd4 Qxd5 6.Qxd5 Nxd5`. The position has no queens and is not in check. It is a plausible boundary for opening preparation; lack of comments does not diminish the supplied queen-exchange answer. Another branch runs `5.cxd4 Bb4+ 6.Nc3 Nxd5 7.Bd2 O-O 8.Be2 Re8 9.Nxd5 Qxd5 10.Bxb4 Qxg2` and stops, leaving White to move with the black queen on g2 and the rook on h1 exposed. That is a concrete frontier to inspect, not proof that Black's choice is wrong. The much longer main route reaches a rook ending after exchanges rather than stopping at the opening's first tactic.

**Revised judgment:** this is a credible move-preparation candidate with substantive opponent handling, even without prose. The inspected branches do not establish complete coverage or strategic correctness, but they refute a negative label based on annotation sparsity. The queenless endpoint and the queen-on-g2 frontier should not be declared equally complete merely because both are leaves, nor should a hand-coded material rule declare either good/bad.

## Three feasible diagnostics to implement

These are proposals, not previously validated quality measures. Input is legal move graph, repertoire side, explicit root/current-position scope, enabled edges, selected own policy and optional empirical opponent probabilities. No prose/annotations, engines or LLM calls are needed. Keep the measures separate; do not average them into a purported content-quality score.

### 1. Opponent replies answered, weighted by observed frequency

At each opponent-to-move position, compute `sum n(move)/N(position)` for returned opponent moves that lead to an explicitly selected own reply, or to an actual terminal position. Existing storage of an opponent edge alone is insufficient. The local result identifies where a repertoire handles commonly faced replies; rank concrete missing moves by conditional reach times frequency. For the Danish example, the White fifth-move alternatives are the relevant external choices when evaluating Black; extra Black alternatives are not additional opponent coverage.

Lichess Explorer exposes move outcome counts and position totals, with query filters; those counts can supply empirical frequencies. This is source capability, not evidence of any repertoire's numeric coverage. See the [official explorer query definitions](https://github.com/lichess-org/lila-openingexplorer/blob/master/src/api/query.rs) and [response definitions](https://github.com/lichess-org/lila-openingexplorer/blob/master/src/api/response.rs). No frequency payload was downloaded in this review, so no empirical percentages are claimed.

Reuse `runCoverageScan` in `web-src/coverage.js` through its existing `provider.predictions({fen,rating})` interface. Adapt `web-src/explorer.js` move `share` values; do not build another probability scanner or multiply by game-winning percentages. `normalizeExplorer` already divides move totals by the position total. The current server proxy pins 12 moves, blitz/rapid/classical and validated rating buckets (`src/prepforge_chess/api/routers/lichess.py`). Retain unreturned probability as unknown, never normalize the returned top moves to 100%. Zero sampled games, request failure and missing own-policy selection are unknown, not poor moves. State population and root. Empirical coverage is a proposed alternate evidence source; the existing Maia production provider remains a different probability model, not empirical Lichess benchmarking.

### 2. Prepared continuation to a declared horizon, with explicit frontier reasons

Report probability mass reaching the chosen horizon or a legal terminal state before its first missing answer, alongside gap and unknown mass. This is the existing scanner's principal job. A short profile at fixed relative horizons can show whether the repertoire answers only the immediate reply or continues further. A local percentage and a path/horizon percentage answer different questions; do not multiply local averages to approximate path coverage.

Reuse the scanner and, if a profile is needed, collect depth summaries in that same traversal. Separate actual checkmate/stalemate from a chapter leaf, missing own reply, missing opponent edge, and budget cutoff. For opening diagnostics do not treat automatic clock/repetition adjudications as universal position identity: repetition is history-dependent. Position keys for opening lookup omit counters, while legal-terminal checks and repetition handling must retain the appropriate state. The current scanner uses `Chess.isGameOver()`; review that predicate before changing it to a graph-based model.

The King's Gambit mating path has a mechanically verified terminal endpoint. The London setup at 8.Bd3 and the Danish queenless position are ordinary frontier positions: neither should receive a bad-move penalty, but neither proves preparation to a longer horizon. Cross-chapter lookup must precede frontier classification, as the Caro-Kann 10.Nxa8 example demonstrates. At horizon boundaries the present scanner also requires an own answer before enqueueing an opponent edge; document that convention or change it with explicit tests rather than silently comparing different definitions.

### 3. Transposition continuation repairs

Index legal canonical positions and distinct outgoing UCI edges in the selected scope. Identity includes pieces, side, castling rights and legally relevant en passant; omit move counters for opening lookup. For each occurrence that ends or lacks a selected reply, report whether another in-scope occurrence supplies one. Show the pair of paths and available continuation, not a reward for having many transpositions. Exact duplicate copies add no edges and cannot improve this diagnostic.

The London Old Benoni pair is an immediate repair example. The Caro-Kann chapter-root match is a cross-chapter stitch. The two Advance Variation routes demonstrate why a shared position is not permission to merge different own choices automatically. Offer equivalent continuations for confirmation or reuse within an already selected policy; do not silently import every edge from every chapter. A repetition cycle is not infinite depth: bound traversal by the declared horizon and account for history where needed.

## Implementation boundary, cost and uncertainty

Build one position/edge index from enabled reachable content, pruning disabled ancestors. Its expected construction/storage cost is linear in move occurrences plus distinct edges; legal replay is bounded per edge. Use that index as a continuation lookup for the existing traversal. Deduplicate explorer requests per canonical position and population; the browser client already serializes requests and shares pending reads. Retain the current scan budget (default horizon 16 plies, 200 queried opponent nodes) and reuse its unknown/budget reporting. Worst-case new explorer reads are bounded by queried distinct positions, not full legal-tree expansion. Network latency dominates and was not measured here; no claim of instant scans or new cache requirement is justified.

On a raw PGN without explicit policy, the graph cannot distinguish a deliberately demonstrated own error from an intended own move. First/mainline is available as a reproducible provisional choice, but must not be called author-recommended. Assess a chosen line or request explicit preparation choices; do not penalize every alternative as though it were played. This is a concrete identifiability limit, not a need for expensive semantic processing.

These diagnostics can expose unanswered frequently played replies, short preparation relative to a chosen horizon, and reusable continuations hidden by move order. They cannot determine strategic coherence, sound compensation, whether a quiet endpoint is sufficiently understood, or good/bad move quality from shape alone. A deliberately losing legal policy can be broad and deep; a strong focused policy can be short. The useful feasible product is actionable move-preparation diagnostics with scope and unknowns, not an unsupported numeric quality score. The same move graph with no comments, every node `1`, or verbose comments produces identical results.

## Acquisition check and prior-label correction

An anonymous request to the public Lichess player explorer on 2026-11-03 returned HTTP 401 (`play=e2e4`, blitz, ratings 1600/1800/2000, 30 moves, no example games). No frequency response was acquired. Missing access was not converted into a zero score. The existing application supports authenticated Explorer reads; move-graph analysis itself runs offline and needs no engine, LLM or paid inference.

The prior low teaching label for LLNDy032 also must not be treated as a negative repertoire label. Direct inspection finds multiple Alapin replies (`2...Nf6`, `...e6`, `...d5`, `...d6`, `...g6`) and substantive French branches. One concrete White frontier is the Elephant branch ending at `1.e4 e5 2.Nf3 d5`. That is an own-to-move endpoint to inspect within a declared preparation horizon, not evidence that the whole repertoire is poor.
