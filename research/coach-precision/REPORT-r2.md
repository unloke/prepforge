# Coach precision research — round 2

Research only. No commit; no production edits. The round-1 production port was in progress during this work, so the main experiment uses the original frozen rows and an isolated copy of the round-1 board helpers.

## Finding and recommendation

Round 2 supplies **17 additional actual error reasons** in the 24-game sample: **16.2% of the 105 remaining error gaps**. Across both voices it supplies **33 reasons on 18 distinct moves**, filling **15.8% of 209 fallback reads**. Every changed error, including the extra counterfactual-only case, was hand-audited against its FEN and both full legal PVs. **Zero false positives remain in the accepted census**. Two true capture facts were rejected as misleading comparative explanations and are listed below.

Recommend **literal best-move prevention of a PV reply**, **a reply pawn attack followed by the attacked piece's retreat**, and **a safe immediate best-move capture that the played line does not equally collect**. A **best move preempting a near-term pawn chase** and an **exchange removing a pawn-supported outpost knight** are also precise, but each has only one observation; the outpost case is in a counterfactual opponent voice. Discovered attacks have an experimental prototype but no new eligible observations; do not treat that family as validated or a coverage gain.

The gain is modest. Error explanation coverage rises from **198/303 (65.3%) after round 1 to 215/303 (71.0%)**. **88/303 errors (29.0%) still have no short concrete reason justified by the supplied evidence**, or **83.8% of the 105 round-1 actual error gaps**. Across both voices, **176/606 error reads (29.0%)** remain silent. At the unique-position level, **92/110 (83.6%)** of the diagnosis census have no accepted short clause in either fallback voice.

These are evidence-bounded adjudications, not claims that those chess errors are intrinsically inexplicable. Several can support a longer lesson about a king route, an exchange composition, or central timing. A missing detector alone was not the verdict: each silent case has an individual board/PV diagnosis in `samples-r2.md`. We withheld clauses when an attractive board fact was shared by both branches, captured compensation incorrectly, or did not establish why this move was the error.

## Measurement and reproduction

Main sample: the original **24 games, 2,236 moves, depth 14**, containing **303 inaccuracy/mistake/blunder moves**. No fresh main-sample engine searches or feature rebuilding. `tmp/coach-precision-rows.json` retains both original voices, before FEN, classification, best/played UCI PVs and engine-derived features. The round-1 semantic inventory and reason precedence are preserved. Reproduced main-sample round-1 totals are **144 initial actual error fallbacks, 39 round-1 gains, 105 remaining**; both voices: **287, 78, 209**.

The complete diagnosis census is **110 distinct errors / 209 fallback reads**, rather than only the 105 actual reads. A move may have a concrete own read but a fallback opponent read, or vice versa. Both voices and both PVs appear for every census entry, including unchanged errors. The two voices are alternative readings of the same position, not independent observations. Error codes are frozen sample classifications; no current production wording determines the main population.

```powershell
node research/coach-precision/compare-r2.mjs --quiet
node research/coach-precision/probe-families-r2.mjs
node research/coach-precision/compare-r2.mjs --heldout --quiet
node research/coach-precision/audit-r2.mjs
npx.cmd vitest run --config vitest.research.config.mjs --cache=false research/coach-precision/detectors-r2.test.js research/coach-precision/detectors.test.js
```

The audit writer uses the already-reviewed fixed ordinal census; it refuses a different census size. It does not make new adjudications. `audit-r2.json` records each reviewed move's ID, voices, accepted clause or silence, and rationale. `fixtures-r2.json` freezes those adjudicated golden families/clauses for tests. `measurement-r2.json` freezes both sets of counts and classification totals.

Main comparisons import only chess.js and `frozen-r1/`, with SHA-256 source hashes in `frozen-r1/manifest.json`. The original round-1 research files were left unchanged. The frozen helper copies match the round-1 coverage counts; they do not track ongoing production edits. Stockfish 19 lite is used only for held-out sampling, with before MultiPV 2 / after MultiPV 1 and fixed depth 14. There are no new detector engine calls or dependencies.

## Gap by classification

Actual player reads only:

| Code | Errors | Round-1 remaining | Round-2 gain | Still silent |
|---|---:|---:|---:|---:|
| inaccuracy | 161 | 75 | 9 | 66 |
| mistake | 53 | 16 | 4 | 12 |
| blunder | 89 | 14 | 4 | 10 |
| Total | 303 | 105 | 17 | 88 |

The original all-move coverage moves from **63.9% to 64.6%** (1,428 to 1,445 explained moves out of 2,236); sound-move prose is unchanged. The principal denominator here is errors, not all moves.

## All remaining fallback shapes

Same inventory as round 1: a grade alone; a better SAN alone; a bare allowed reply; an evaluation/standing change; the opponent slip templates; and reply-only answer tails that do not explain the opponent's move. The main census compares against **round-1 output**, not against today's mutable production coach. Existing material, check, development and concrete attack prose is preserved under that inventory even when a longer coaching explanation might improve it.

New own templates are exactly `X allows R, which {clause}.` and `Y was better: it {clause}.` Opponent reads use `their` for the piece the user's reply attacks, `your` for a piece their better move takes/removes, and `They should have played Y, which {clause}.` The prevention reply is numbered: **`h5 was better: it stops 47...h5`**, distinguishing the two colours' identically named moves. No reason claims compulsory retreat, forced gain, a won ending, or permanent safety.

## Diagnosed families, frequency and proof

Candidate counts are distinct moves in the **110-position census**, before voice gating and precedence. They overlap. Actual gains count only the fixture player's actual read.

| Family | Candidate moves | Changed moves, either voice | Changed reads, both voices | Actual gain |
|---|---:|---:|---:|---:|
| Literal best-move prevention | 11 | 10 | 20 | 10 |
| Reply pawn chase | 4 | 4 | 7 | 4 |
| Preempt near-term pawn chase | 1 | 1 | 2 | 1 |
| Safe best capture | 2 | 2 | 3 | 2 |
| Remove supported outpost knight | 1 | 1 | 1 | 0 |
| Reply discovery | 0 | 0 | 0 | 0 |

The extra prevention candidate, e64PHVIv/2, is allocated to pawn chase. The outpost exchange only changes iIbxaesL/30's opponent voice; its own read already contains a development consequence credited by the round-1 inventory. l2iiK67l/62's own voice already names the rook attack, and 9oLH8Czy/125's own voice already has a concrete ending/material explanation.

### `best-stops` — 10 actual gains

Play the actual move and its first PV reply. Require a **noncapturing, nonpromoting reply to a square empty before the error**. The same opposing piece must exist at its original square in the before and best boards. The best move must not give check: making a quiet reply illegal only because it fails to evade check is a temporary postponement, not prevention. Then replay the exact reply UCI after the best move: it must be **illegal**. No static-SEE-only `stops` assertions are accepted.

Eight candidates occupy the square an opposing pawn wants to advance into: h5, f5, h6, b5 or e5. Two king moves use adjacency: Ke4 prevents Kf3, and Kf3 prevents Ke4. One further pawn move e3 controls d2 and prevents Kd2. These sum to eleven candidates, with e5 allocated to the chase family instead. The rule states only the exact stopped move; it does not say every plan or advance is stopped.

Examples: iIbxaesL/93, /94, /118, /119; Qgb5C4uK/54–56; ehz1gRmt/35, /70; 4Nuw3P4T/72. No broad opposition detector is needed for the king examples: square control and legal moves prove their narrow clauses.

### `reply-pawn-chase` — 4 actual gains

The first reply is a pawn move that **newly legally attacks a named mover-owned nonpawn/nonking piece**. The next played-PV move must move that exact piece without capturing to a square the reply pawn no longer attacks. The pawn itself must not have positive opponent SEE immediately after its advance. The same reply after the best move must be illegal or not attack the same piece identity. Track that identity through differing played/best first moves; a knight just developed to f6 can still be on g8 after the best move.

This extends round 1 where nonpositive SEE on a defended victim suppressed the attack. The actual board plus the actual PV retreat justify **`attacks the knight on f6`**, even though the pawn would lose value in an immediate exchange. Do not convert it into `wins a tempo`, `forces a retreat`, or `wins the knight`.

Examples: iIbxaesL/6, U2Q0fCnr/6 and e64PHVIv/2 allow e5 against Nf6; l2iiK67l/62 allows h5 against Rg6. Counterexamples U2Q0fCnr/14 and /16, and rqNPaT0r/25 remain silent: the identical pawn reply still attacks the same piece after the alternative.

### `best-preempt-pawn` — one actual gain

The played PV's fourth ply is a noncapturing opposing pawn advance, followed immediately by a noncapturing retreat of the piece it legally attacks. Best must move that exact piece immediately without capturing or checking. The pawn's original square/type/colour must be unchanged from the before board. Replaying that pawn advance immediately after best must remain legal but no longer attack the relocated piece. The played advance itself must not be a positive-SEE target. This is prevention of an attack, **not** prevention of the legal pawn push.

SUANl0sI/33: f4 Ng7 Bd3 h4 Nf1 permits the h4 attack on Ng3. Best Nf1 instead relocates that knight before the attack; h4 after Nf1 cannot capture it on f1. Clause **`moves the knight clear of h4`**, opponent voice **`moves their knight clear of h4`**. This late training-census addition has no held-out firing and no independent validation.

### `best-capture` — 2 actual gains

A distinct best move legally captures a specific enemy target. Exclude en passant, promotion and the actual move capturing that target immediately. The best PV must resolve profitably at its **first quiet point within eight plies**, rather than relying on a later unrelated gain. The best capturer must not be a positive-SEE capture target. Say **`takes`**, not `wins`.

Track the victim through the played eight-ply PV. If that branch also collects the same victim with an equal material gain, suppress the reason. If collecting it trades away equal-value own material, the comparison can still explain the better move: 9oLH8Czy/125's Ke2 Rxe3+ Kxe3 trades the rooks, while Rxg3 takes the enemy rook and retains White's. Its one-ply best PV has no quiet-point continuation; the narrow exception requires no legal immediate recapture on the destination and no check in the resulting position. White Kf2 makes Black Kxg3 illegal.

4Nuw3P4T/7: Nxe5 takes e5; Black replies Bd4, not a recapture. Black later takes e4, so `wins a pawn` would be wrong. The literal `takes the pawn on e5` is the accepted clause. The played Bc4 branch leaves that target intact.

### `best-outpost-exchange` — one counterfactual gain

Best captures an enemy knight advanced into the other side's half (White rank 5+, Black rank 4−). A friendly pawn supports the knight, and no enemy pawn on an adjacent file is behind the knight in its own advance direction, so a pawn advance cannot chase it. The best PV must **legally recapture the best minor piece with a supporting pawn on that square**, completing an equal minor exchange. This recapture checks legality, including pinned pawn support. The actual first move must not perform the same capture.

iIbxaesL/30: Bxe5 dxe5 removes the supported Ne5; Bc8 leaves it there. Clause: **`removes your outpost knight on e5`**. This does not promise material gain or permanent square ownership. With only one eligible voice, recommend it as a small optional extension, not a demonstrated common source of coverage.

### `reply-discovery` — experimental, zero new observations

After the first reply, a **stationary bishop/rook/queen** must newly have a legal, profitable capture of the same stationary target; the moved reply piece is not the attacker. Replay the same reply after best: it must be illegal or fail that legal/profitable target test, with the same target preserved after best. This narrow candidate has no remaining-gap or held-out observations. Its implementation is exploratory; it is not validated by the zero-match count and should not be ported on that basis.

## Validation and every rejected explanation

**All 18 changed distinct errors / 33 renderings** were hand-reviewed, along with all 92 silent census positions. Accepted clauses and the complete FEN / UCI / SAN / before-after record are in `samples-r2.md`. This is the same research agent developing and reviewing the rules, not an independent human panel.

| Family | Audited changed moves | Audited renderings | Final observed wrong renderings |
|---|---:|---:|---:|
| best-stops | 10 | 20 | 0/20 |
| reply-pawn-chase | 4 | 7 | 0/7 |
| best-preempt-pawn | 1 | 2 | 0/2 |
| best-capture | 2 | 3 | 0/3 |
| best-outpost-exchange | 1 | 1 | 0/1 |
| Total | 18 | 33 | 0/33 |

Every false positive observed during this round:

1. **U2Q0fCnr/29, Bd3**: `Bxd4 was better: it takes the pawn on d4.` True capture fact, wrong comparative explanation: Bd3 h6 Bxd4 also collects that same pawn within three plies. Added the played-line victim-identity/equal-material gate; final silence.
2. **MoIMR1WB/6, Bg4**: `Nxd5 was better: it takes the pawn on d5.` The played branch collects that same pawn within seven plies, after a bishop exchange. Same gate; final silence.

The initial four best-capture candidates therefore had **2/4 misleading comparative reasons (50%)**; final retained census **0/2 changed moves, 0/3 renderings**. This is a purposively investigated family, not an unbiased pilot FP estimate. Numbering the prevented reply also repaired ambiguous, although factually correct, `h5 stops h5` / `f5 stops f5` copy. No wrong ownership or other accepted reason was observed.

The initial ownership test chose Ke2's already-concrete own voice and correctly received null; the test selection was fixed to an eligible both-voice pawn capture. A diagnostic structure script initially omitted square metadata from `chess.get()`; fixed before recording family counts. The generic rendering test initially required the preemptive-chase clause to name its proof-origin g3, although the intended clause names the impending h4 advance; its contract was corrected. None was a wrong accepted explanation.

## Considered and withheld

`probe-families-r2.mjs` records all candidate IDs and details in `family-counts-r2.json`. These are **counts of predicates, not accepted coach explanations**.

| Requested candidate | Raw distinct positions | Result |
|---|---:|---|
| Checking first reply | 8 (7 actual gaps) | No new check/tempo reason |
| Same checking piece captures on its next PV move | 1 | Equal exchange, no causal gain proved |
| Reply enters mover's camp with nonpositive SEE | 10 | No new attributable invasion reason |
| Rook reply reaches seventh rank | 1 | Also available after best |
| Pawn reply fully opens mover king's file | 0 | No candidate under the explicit full-file criterion |
| Sole geometric defender removed | 31 | Geometry alone inadequate |
| Sole legal recapturer removed and target taken in PV | 0 | No newly proved defender-loss reason |
| Material deficit only after extending 8 to 20 plies | 12 | None passes initial-board/common-safe-victim attribution |
| New isolated/doubled pawn | 2 | Both fail comparative explanation |

- **Checking tempo/capture:** e64PHVIv/16 has Bb5+ Nc6 Bxc6+ bxc6 Qxc6+, but the knight/bishop exchange creates the pawn target during the sequence, rather than demonstrating a check wins a previously safe victim. Bb5+ is also legal after best Qd4. Other checks trade queens/rooks, or have no next capture. A PV evasion alone does not prove every non-PV response loses. Do not ship `wins a tempo`.
- **Camp/seventh rank:** ehz1gRmt/141 allows Rc2, but the best Re4 allows the same Rc2. KiCreL8W/107's Rb1 is equally legal after Kf1. A true geographical description would not explain the error. No generic `enters your position` clause accepted. Outpost occupation without pawn-proof and same-reply differentiation is likewise withheld.
- **Defender loss:** require an opponent's legal target capture before the move, the moved piece as the only legal recapturer after that capture, loss of that recapture after the move, and the target attacked/taken in the played PV while the alternative prevents the same outcome. Most of the 31 geometric cases never lose the guarded target. 4Nuw3P4T/86 removes the g-pawn's h6 guard, but **h6 falls in both PVs**. Geometry plus later capture is not causality.
- **Beyond eight plies:** require the same original victim to survive safely through the corresponding best-PV horizon, and the first divergent played board to newly expose it while the before/best boards do not. The 12 extended deficits have no passing stationary-victim proof. Exchanges, promotion, later pawn pushes and mutually occurring captures dominate. `4Nuw3P4T/46` loses c7 in both PVs; `rqNPaT0r/43` loses the original queen in both. Increasing the window alone remains rejected.
- **Pawn structure:** KiCreL8W/54 gxh5 creates isolated/doubled h-pawns, and Bf3 later attacks the h5 pawn before it moves and is taken on h4. But its original g6 pawn also falls to hxg6 in the best line. Qgb5C4uK/66 fxe5 creates an isolated e5 pawn that is immediately exchanged by dxe5, creating White's passer; the best line also allows that white pawn to advance to a passer on e6. Neither supports `creates a weak pawn` as a causal short reason. KiCreL8W/37's later fxe3 isolation is a multi-move structure story, not a defect created by Bf1 itself. No backward-pawn rule was accepted: blocked advance or adjacent pawns being ahead alone cannot establish a permanent backward weakness.
- **Endgame king/rook rules:** two king exclusions are handled precisely by legal `stops` statements, without claiming opposition wins. A standalone opposition detector would need bare-king alignment, side-to-move and pawn/zugzwang context, plus the relevant consequence; mere king alignment is not enough. For rook cutoff, require an unobstructed rook-controlled whole rank/file separating the enemy king from its target, a safe rook and absence of the same barrier after the played move. For rook-behind-passer, require a same-file rook on the homeward side of a proven passer, clear ray, same pawn identity and a PV consequence absent after played. No new example justified those clauses. `ehz1gRmt/141` has obstructed rank-four geometry; `KiCreL8W/107` needs Kf1 Rb1+ Kg2 to blockade g3 and cannot be reduced to an immediate safe promotion-square guard.
- **Castling/development:** 7rGNXCJX/13 Rf1 forfeits kingside rights while O-O castles; Nxe4 is available in both lines. The loss of rights is literal but does not alone prove safety or why the timing is bad. The complete census records this plausible longer explanation without turning every best castling move into a new reason.

## Held-out check

Cheap widening was completed after the core rules were set: fixture entries **25 and 26**, game IDs **8hnEtpJx and qyCbgZmj**, **112 moves / 15 errors**, at depth 14. These positions are disjoint from the first 24 games. The sampler's complete relative-import feature/commentary closure was copied once to `tmp/r2-engine-source/` and hashed in `tmp/r2-engine-source-manifest.json`; running the preparation script again reuses that frozen source. Thus concurrent production edits cannot change this held-out result. The later SUANl0sI/33 preemptive-chase rule came from the training census after the held-out case was viewed; it has no held-out firings and is not independently validated here.

The held-out prose builder was captured from the current coach, which could already contain round-1 port work; its base prose is a separate frozen source snapshot, not a reconstruction of the original 24-game prose version. Effective round-1 output is obtained by applying the frozen round-1 detector to its remaining fallbacks. Do not pool raw pre-round-1 wording counts across the two snapshots.

```powershell
node research/coach-precision/prepare-heldout-r2.mjs
node scripts/coach/heldout-r2-sample.mjs --games 2 --depth 14 --quiet
node research/coach-precision/compare-r2.mjs --heldout --quiet
```

After the round-1 overlay: **6 actual gaps / 12 both-voice gaps**. Round 2 adds **one actual reason / two voice renderings**, leaving 5 / 10. **8hnEtpJx/25 Be3 allows d4, which attacks the bishop on e3**; the bishop retreats to f4. Best exd5 removes the attacking pawn. Full board/PV/voice audit is included at the end of `samples-r2.md` and frozen in `heldout-r2.json`.

Held-out observed FP rate, reported separately: **0/1 changed position, 0/2 renderings**. All other families have **zero held-out firings**, so their FP rates are **not estimable**, not 0%. No rule was tuned against held-out failures; none were found. Two games and one firing give very little evidence about broader reliability. Stockfish PVs depend on engine/cache history and remain examples, not proofs of uniqueness or optimality.

## Checks and artifacts

- **160 tests passed**: 121 round-2 tests, including the complete 110-case golden census, same-target negative cases, colour ownership, reply numbering, illegal/truncated chase evidence, preemptive-chase boundaries/ownership, pinned outpost-pawn support, check-postponement rejection and the held-out case; plus the 39 round-1 tests.
- Every main/held-out error PV was legally replayed by the comparator. Every changed rendering was manually reviewed; no production test run or application build was necessary because no production files were edited.
- Deliverables: `REPORT-r2.md`, `samples-r2.md`, `detectors-r2.js`, `detectors-r2.test.js`, `compare-r2.mjs`. Supporting evidence: `audit-r2.json`, `fixtures-r2.json`, `heldout-r2.json`, `measurement-r2.json`, `family-counts-r2.json`, frozen board helpers and reproducibility scripts.
- Main and held-out full machine comparisons/counts are under `tmp/`. Held-out engine evaluations use their own cache; the original 24-game rows/cache were not overwritten.
- No commit. All authored task files stayed inside `research/coach-precision/`, `scripts/coach/` and `tmp/`; no `web-src/coach/*` edits.
