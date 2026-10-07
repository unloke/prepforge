# Coach precision research

Branch: `coach-precise-explanations`. Research only; no production coach, app, or bundle changes. No commit.

## Finding and recommendation

Across **24 games, depth 14, 2,236 moves**, **934 moves (41.8%)** have no concrete explanation for the move. The conservative prototype supplies **126 new reasons**, removing **13.5% of those gaps**. Explanation coverage rises from **58.2% to 63.9%**; **808 gaps remain**. Gains: 56 own reads and 70 opponent reads; 87 sound moves and 39 errors. Error gaps improve by 27.1%, sound-move gaps by 11.0%.

Recommend the five board-fact families below, with the stated comparison and legality gates: **defending a threatened target, escaping attack, a concrete best-move attack, physically blocking a passed pawn, and an attack enabled by the played move's PV reply**. Defense and escape also apply to the better alternative on errors. Use their narrow wording, never upgrade it to "saves", "wins", "must move", "with tempo", or "stops promotion". Keep the existing prose whenever no proof passes.

**72 accepted changed moves were manually checked against their FEN and both PVs, with zero remaining observed false positives.** This is a manual review by the research agent, not an independent human annotation panel or a guarantee on unseen positions. Three misleading explanations were rejected across pilot/audit stages, and five wrong pawn-ownership renderings were corrected; every case is listed below.

## Measurement and reproduction

Source: the first 24 entries with at least 30 plies in `tests/fixtures/scout/ericrosen-selection.json`, in fixture order. This is a reproducible convenience sample of one player's games, not representative player-population data. Both colours' actual moves are included. The fixture's `game.color` denotes the opponent: actual own reads use the other colour as selfSide; actual opponent reads use `opponentRead: true`. Counterfactual own and opponent reads are also retained for every move.

Stockfish package 19.0.0, `stockfish-19-lite-single.js` in Node; fixed depth 14, before MultiPV 2, after MultiPV 1, White-POV scores. The existing depth/FEN/MultiPV cache is reused. Warm transposition-table and prior-cache history can affect PV choice. This is a measurement of these frozen reads, not a claim that depth 14 proves chess optimality. Terminal moves are included: checkmate prose is tested from SAN; terminal mate/zero scores only supply the feature input. The expected and collected move counts both equal 2,236, with no missing positions.

```powershell
node scripts/coach/opponent-read-sample.mjs --games 24 --depth 14 --quiet
node research/coach-precision/compare.mjs
node research/coach-precision/families.mjs
npx.cmd vitest run --config vitest.research.config.mjs research/coach-precision/detectors.test.js
npx.cmd vitest run web-src/coach
```

The sampler checkpoints engine reads after each game and writes `tmp/coach-precision-rows.json`, including features, FENs, UCI/PVs and both old reads. Comparison normally reuses that exact 24-game depth-14 snapshot; `--rebuild` reconstructs features/prose from the engine cache. It prints OLD/NEW for **every** move, including unchanged moves, and writes machine-readable comparisons and counts under `tmp/`. `--quiet` prints only counts. `measurement.json` freezes the final counts. `family-counts.json` records candidate counts and the full extended-material candidate lines. No new engine searches are needed by the detectors.

Classification uses a finite inventory of actual concrete production phrases, including captures, recaptures, exchanges, mate/check, specific attacks, development, castling, central pawn facts, passed pawns and open files. A legal-only forced move is a concrete constraint. A grade, standing change, bare reply SAN, popularity, generic necessity or a better SAN alone is **fallback**. Opponent answer/status tails are removed for the main count: "Answer with Nf5, attacking..." can explain the user's answer without explaining the opponent's move. This is intentionally a count of the move's reason, rather than of tactical words anywhere in the paragraph. All 73 audit baselines were also inspected manually. This phrase inventory is tied to today's copy; recheck it when production wording changes.

An early keyword/counting pass missed "gives you a pawn/rook", incorrectly treating existing material explanations as gaps. That was fixed before the random audit and final measurement. The old script also scanned reply-only tails, which could credit a fact about the answer as a reason for the played move. The final measurement trims those tails.

## Gap by classification

| Code | Concrete | Fallback | New reasons |
|---|---:|---:|---:|
| best | 1003 | 672 | 74 |
| good | 118 | 118 | 13 |
| inaccuracy | 62 | 99 | 24 |
| blunder | 68 | 21 | 7 |
| mistake | 29 | 24 | 8 |
| forced | 22 | 0 | 0 |

## Gap by move kind

Quiet types use chess.js piece letters. Capture includes en passant; promotions and castles have their own categories.

| Kind | Concrete | Fallback | New reasons |
|---|---:|---:|---:|
| quiet pawn | 236 | 203 | 17 |
| quiet n | 172 | 104 | 14 |
| quiet b | 134 | 105 | 20 |
| castle | 31 | 3 | 2 |
| capture | 395 | 62 | 7 |
| quiet q | 93 | 97 | 31 |
| quiet r | 129 | 122 | 25 |
| quiet k | 103 | 238 | 10 |
| promotion | 9 | 0 | 0 |

| Actual read | Concrete | Fallback | New reasons |
|---|---:|---:|---:|
| own | 703 | 414 | 56 |
| opponent | 599 | 520 | 70 |

Counterfactual whole-sample own reads: 1,379 concrete / 857 fallback; opponent reads: 1,267 concrete / 969 fallback. These are alternative voices on the same moves, not another 4,472 independent observations. Quiet king moves (238 gaps), quiet pawns (203), and quiet rooks (122) dominate the remaining problem. Maia is not run: great/brilliant are supported fallback branches but have no observations in this sample.

## All fallback shapes found in current production

- `bestProse`: "is the best move here / is spot on / is exactly right / is accurate / is the right move". `goodProse`: "is fine", optionally naming a slightly more precise alternative.
- `greatProse`: generic "keeps the position together where most moves would not" or "the only move that holds" without a point; `brilliantProse`: "is a hidden resource". These branches were read, but no Maia-driven classifications were sampled.
- `errorConsequence`: bare "allows [reply]" or "isn't the right idea here"; `betterSentence`: "[best] was the move" or a standing/keeping clause. `errorProse`'s inaccuracy branch discards nonmaterial consequences and reduces them to "is slightly inaccurate", "[best] was better", and perhaps a standing change.
- `opponentSlip`: "[move] is a little loose. [best] was better for them"; "is a mistake. They should have played [best]"; "is a blunder. They had to play [best]"; or a slip grade without an alternative.
- `soundLead`: "is accurate / is the best move here / is a good move by them", "is a reasonable move", "is playable", "is a strong find", "is a brilliant find", or a generic only-move find when point is empty.
- `opponentProse` also deliberately suppresses the move point in already-lost positions: "is their most stubborn try / doesn't change much, but you're still winning". These count as gaps, but the prototype preserves that standing rather than rebranding a lost position as good.
- `answerSentence` gives a reply and a standing, often without a point. A bare answer is not evidence that the move has been explained. Checkmate and legal-only forced moves are already explained constraints and are not replaced.

## Diagnosed families, frequency and proof

The **72 accepted before/after examples** in `samples.md` are the diagnosis set: **47 sound moves and 25 errors**, exceeding the required 40 positions. Each includes the before FEN, played and best PV in UCI and SAN, a short reason and a manual verdict. These reasons were checked from the board, not guessed from the grade. Candidate frequencies below are board/PV predicate matches over the 934 gaps; overlapping matches are not added together. Allocated gains reflect detector priority and actual read gating.

| Family | Candidate matches | Allocated gain | Priority |
|---|---:|---:|---|
| Add a legal defender to a capture threat | 50 on actual moves; 5 alternatives | 44 sound + 5 best-defense | Highest: specific target and legal recapture |
| Move an attacked piece clear | 38 actual; 1 alternative | 36 sound + 1 best-escape | Highest: legal escape, no forced-tempo inference |
| Best move newly attacks a target | 29 | 28 | High, after excluding equivalent played attacks |
| Physically block a passed pawn | 23 raw front-square candidates; 8 strict matches | 7 | High precision, small observed gain |
| PV reply creates a profitable attack absent after best | 5 | 5 | High precision, small observed gain |

### `defend` - 44 added reasons

The actual move is a noncapture; neither before nor after side-to-move is in check. A **specific stationary friendly nonking target** is attacked and has positive opponent SEE before. The moved piece becomes a new defender. After the opponent's cheapest **legal** capture of that target, the new defender has a **legal recapture**; geometric `attackers()` alone is insufficient for pinned defenders. Opponent SEE becomes nonpositive, with a non-null result. The target remains on its square through four played-PV plies, and the defender survives the first reply. Existing defenders are allowed: the extra defender can resolve an overloaded target. This is single-square exchange evidence, not a complete tactical search.

Template: `defends the {piece} on {square}`; opponent read: `defends their {piece} on {square}`. Say "defends", never "saves" or "makes safe". Later loss after the defender moves does not falsify the immediate claim; `KiCreL8W/115` illustrates that boundary.

### `escape` - 36 added reasons

A nonpawn, nonking moved piece was attacked, geometrically undefended and legally capturable for positive opponent SEE. After its legal noncapturing move, its destination has **no enemy attacker at all**. Check moves are excluded. The assertion is about the immediate board; the opponent can create another attack later.

Template: `moves the {piece} out of attack`. No "must move", "forced retreat", "gains tempo" or claim that the next PV move is compulsory.

### `best-defend` / `best-escape` - 5 / 1 added reasons

Apply the same proof to the first move of the **best PV**, substituting that PV for the continuation. The move is an error, the alternative differs, and the actual move does not solve the same target under the same detector. Name what the better alternative does, instead of inventing a loss on the played line.

Templates: `{best} was better: it {clause}.` / `They should have played {best}, which {clause}.` Defense belongs to them; escape refers to the moved piece. The best-escape sample is a census of one, not strong prevalence evidence.

### `best-attack` - 28 added reasons

An error's distinct best move creates an attack from its moved piece on a specifically named enemy target. The moved piece has a **legal capture** of that target when its turn is restored with en passant cleared. Existing `winnableTargets` requires positive target SEE and rejects an immediately lost attacker. This moved-piece attack was not already present from its origin. The actual moved piece does **not** offer the equivalent profitable target attack. Checking best moves are excluded rather than embellished. The phrase states an attack, not forced material gain; the best PV is retained for review.

Template: `{best} was better: it attacks the {piece} on {square}.` / `They should have played {best}, which attacks your {piece} on {square}.`

### `reply-attack` - 5 added reasons

An error's **first played-PV reply** creates a legal, profitable moved-piece attack on a named mover-owned target, absent from that reply piece's origin. Replay the **identical reply UCI after the best move**: it must be illegal there or fail the same profitable-target test. The victim must still be the same type/colour on the same square in the best-move position, so moving the victim elsewhere is not counted as an equivalent-board comparison. Check replies are excluded. This is a concrete allowed attack; no assertion that the reply or subsequent retreat is the only move.

Template: `allows {reply}, attacking the {piece} on {square}`; opponent read uses `their {piece}`. The verdict and better move remain, without another reason clause.

### `passed-block` - 7 added reasons

Sound noncapture only. Before the move, the enemy pawn has **no opposing pawn ahead on its own or adjacent files**, and its immediately-forward square is empty. The move occupies exactly that square. The blocker is not a positive-SEE capture target. Both pawn and blocker remain on those squares throughout four legal played-PV plies. Checking moves and shorter/invalid continuations produce silence.

Template: `blocks the passed pawn on {square}`; opponent read **`blocks your passed pawn on {square}`**. This blocks its forward push, not every capture route or every other pawn's promotion. `ehz1gRmt/149` is the deliberate counterexample: a3 is blocked while b2 promotes.

### Integration limits

`propose` operates only on old fallback prose, preserves silence on unproven moves, and selects **one** reason: reply attack -> best attack -> best defense for errors; defense/escape -> passed block for sound moves. It uses existing imports and pure chess.js functions, no DOM, network, extra engine, dependency or production mutation. Accepted reason clauses are at most seven words. Rendered prototypes use at most two sentences. Own/colour reads use "the"; opponent target ownership uses "their" for defenders/reply victims and "your" for best-move attack/block victims. Already-lost standing is retained.

The comparison renderer intentionally spends the second sentence on the concrete alternative for errors; it can omit a previous evaluation/status or bare answer sentence to retain two sentences. This is research wording for review, not a production integration patch. A shipping implementation should insert the clause at the existing fallback branch while preserving useful status/reply facts within the same sentence budget.

## Validation and every rejected explanation

Selection: deterministic shuffle, seed **61006**, first 60 proposals from the pre-final defense/attack population; five supplements to cover rare families; one next-random eligible replacement for the rejected defense; then a census of the seven new passed-block proposals. **73 unique cases** reviewed, **72 final changed cases retained**. The retained core contains 60 random changed cases; supplemental cases are not silently described as random. FEN and **both** PVs were read manually. Auxiliary attack/defender and legal-move checks supported that review. `audit-selection.json` freezes the initial proposals; `audit-verdicts.json` records verdicts; `samples.md` renders final wording and preserves rejected wording. `write-samples.mjs` regenerates the document from the frozen selection and final comparison output, not new adjudications.

| Detector | Final audited | Remaining wrong reasons | Observed final FP rate | Allocated coverage gain |
|---|---:|---:|---:|---:|
| defend | 19 | 0 | 0/19 | 44 |
| escape | 21 | 0 | 0/21 | 36 |
| best-defend | 5 (census) | 0 | 0/5 | 5 |
| best-escape | 1 (census) | 0 | 0/1 | 1 |
| best-attack | 14 | 0 | 0/14 | 28 |
| reply-attack | 5 (census) | 0 | 0/5 | 5 |
| passed-block | 7 (census) | 0 | 0/7 | 7 |

Finite observed zero rates are not zero population rates. Rare-family samples are particularly small, and the same agent developed and reviewed the rules. Exact clauses name only legal board facts to reduce that dependence.

**Pilot causal false positives (purposive inspection, no population-rate estimate):**

1. `4QZyMzwa/18`, Qa5; FEN `rn1qk2r/pp2ppb1/5np1/2Pp3p/5B1P/2N1PP2/PPPQ1P2/R3KB1R b KQkq - 0 9`. Proposed Nbd7 "attacks the pawn on c5". **Qa5 also attacks c5**. That true fact did not explain the difference. Require absence of the equivalent played-move attack; now suppressed.
2. `KiCreL8W/52`, Qc5; FEN `2r3k1/1p3p1p/pq2b1p1/3p3P/8/1PP1P1P1/P2Q2B1/4R1K1 b - - 0 26`. Proposed Qc7 "attacks the pawn on c3". **Qc5 also attacks c3**. Same tightening; now suppressed. Both are real-FEN negative unit tests in `pilot-rejections.json`.

**Random-audit semantic false positive:**

3. `7rGNXCJX/58`, Qf7; FEN and both PVs are case 60 in `samples.md`. Proposed "defends their pawn on g7". Played PV starts `Qf7 Qxf7 Bxf7 Bh4`: the new queen defender disappears on the first reply. The factual instantaneous defense is misleading as the move's point. Before tightening: **1/20 defend cases = 5%** in this review; after requiring defender survival, **0/19** retained. Keep old text. An additional legal-recapture gate conservatively withholds `ehz1gRmt/98` Kf3: it prevents Kxe2 by king control, but the detector cannot demonstrate its prescribed target-capture/new-defender-recapture sequence. That is a withheld true defense, not another wrong accepted reason.

**Passed-block rendering false positives, all corrected and retested:**

The first opponent template wrongly used "their passed pawn". These are **the user's pawns**, not the mover's. Initial complete-output FP rate for this new family was **5/7 (71.4%)** even though all seven blocking facts were correct. Final rate is **0/7** after the ownership fix.

4. `ehz1gRmt/75`, Ke1: black pawn e2 -> **your** passed pawn.
5. `ehz1gRmt/149`, Ka2: black pawn a3 -> **your** passed pawn.
6. `7rGNXCJX/56`, Be6: white pawn e5 -> **your** passed pawn.
7. `7rGNXCJX/82`, Bf7: white pawn f6 -> **your** passed pawn.
8. `7rGNXCJX/170`, Kf7: white pawn f6 -> **your** passed pawn.

All five final renderings were manually rechecked. The ownership unit tests also cover the two own-read blocks, ensuring they retain "the". No other false positives were observed in the reviewed cases.

## Considered and withheld

- **Extend material reading past eight plies:** 19 fallback errors acquire a negative material net at a quiet point within 20 plies when the eight-ply read did not. The candidate SAN lines are saved in `family-counts.json`. This is a frequency of later line losses, not 19 proven forced losses caused by the played move. Example `uF2xKIUB/15` Bxf7+ traverses captures on both wings and rook/knight exchanges. Blind endpoint subtraction can attach distant exchanges, sacrifices or compensation to the wrong cause. Do not ship a larger window alone.
- **General tempo / "must move":** an attack and a PV retreat do not establish that every other reply loses. Say only the named attack or escape. `4Nuw3P4T/71` b5 is instructive: the best PV answers Nxe5, not a knight retreat.
- **King safety:** three fallback errors lose castling rights without castling, and five push a pawn next to a back-rank king. Both facts can be counted precisely, but neither proves why the move is an error; king moves can be necessary and shield pushes can provide luft or win material. No safety-loss explanation shipped.
- **Passed pawn created:** three raw fallback moves satisfy a new-passership predicate: two are errors (exf3 is immediately recaptured; e6 does not explain why the move was inaccurate), and the sole sound example dxe3 (`SUANl0sI/82`) is followed by Kxe3 on PV ply six. With only one short-lived sound candidate, this was lower priority. A new passer alone does not establish that creating it explains the grade or wins a race. The blocker's narrower physically occupied-square fact survived review; race/win claims did not get a detector.
- **Piece left undefended/trapped:** being undefended alone is not a threat. The defense family requires a legal, positive-SEE prior capture. Trap language needs proof that legal escapes/checks/counterplay all fail, which a single PV does not provide. No trap detector shipped.
- **Trading into won/lost endgames:** both evaluations and PV endpoints can suggest this, but a generic evaluation change does not prove the trade caused it. Production already names concrete exchanges and some opposite-bishop transitions. No blanket endgame-label explanation added.
- **Mate threats:** existing mate-score and mate-in-PV branches already explain many direct cases. No prevalence claim for hidden mate threats is made here. A new "threatens mate" rule would need explicit legal mating continuation and defense checks, not merely a check or attack near the king.
- **`describeAnyThreat` / null move:** geometry alone can suggest pinned-piece threats or ignore counterchecks. The shipped prototype uses a narrow turn-restored **legal capture** and exchange check on a named square; it makes no full-position null-move-engine inference. Full null-move threat search would be a separate research experiment with fresh engine evidence.
- **Best-move descriptive facts:** 48 fallback errors have a best move with an existing description but no accepted best-attack detector. Development, castling and open-file occupation can be truthful yet unrelated to the actual evaluation loss. Copying all of them into "was better because..." would overstate causality.
- **Quiet king/rook plans, space and "improves the position":** these dominate silence but do not admit the narrow proofs used here. Keep the fallback until a specific threat, block, legal attack or other equally concrete criterion can be demonstrated.

## Checks and artifacts

- Prototype: **39 vitest tests passed**, including real sample FENs for every detector, rejection of equivalent attacks and immediately exchanged defenders, incomplete-PV silence, and pawn ownership.
- Existing production coach: **204 tests / 11 files passed**. Production code was read only.
- Final comparison and candidate counts were regenerated after tightening. Every accepted clause fits the short reason budget.
- Files: `detectors.js`, `compare.mjs`, `families.mjs`, `detectors.test.js`, real-FEN `fixtures.json`, `pilot-rejections.json`, frozen `audit-selection.json`, `audit-verdicts.json`, `measurement.json`, `family-counts.json`, `samples.md`, and small reproducibility helpers. All new/edited task files are within the authorized research/scripts/tmp paths.
