# Advanced ideas: board evidence before wording

The useful extension is a small collection of **move-sequence relations**, not a more elaborate vocabulary for evaluations. Detect a pawn move that opens a bishop's diagonal, a pawn advance that simultaneously blocks a pawn and attacks a bishop, or a queen excursion whose pawn gain is recovered. Generate the sentence from the pieces, squares and moves that establish that relation.

My proposed outputs cover **1, 2, 3, 4, 5, 6, 8 and 10**, with narrower claims than some annotations. **7 and 9 stay bare.** These are manually supported outputs for these ten cards, not measured precision claims for the proposed detectors.

I replayed all twenty supplied variations with python-chess, checked captures and piece identities, and examined the relevant alternative moves on the board. Every supplied variation is legal. Ply numbers below start at 1 separately in each line, including the candidate move. Thus card 3's best-line ply 1 is 18...g5. I retain the supplied grades; board replay does not independently establish an engine evaluation.

## 1. What can be detected and said

### Common evidence contract

Replay both complete PVs, keeping piece identities through moves and captures. Do not truncate the reason scan at ten plies: card 4 promotes at ply 12. Store each candidate as a small structured record: motif, beneficiary, move/piece identities, squares, witness plies, comparison with the other first move, and any unverified claim.

Distinguish three kinds of evidence:

* **Exact board fact:** a move attacks a bishop; a capture exchanges a bishop for a knight; a pawn blocks another pawn. These require legal move generation and occupancy/attack tests.
* **Line-supported consequence:** the supplied continuation contains two queen retreats, a pawn storm or a promotion. It supports “allows” or “misses the plan …”, not “forces”, “cannot stop” or “has no defence”.
* **Universal claim:** promotion cannot be stopped, a piece is trapped against every defence, a pawn cannot be taken profitably. This needs a tactical certificate or additional search. A single PV is not such a certificate.

For generalisation, use the following initial gates. The numbers are proposed starting thresholds, to be calibrated offline, not chess laws:

1. The initiating event occurs within the first four plies. Follow its consequences through the supplied PV. A plan can finish later; an unrelated event near the leaf cannot become the reason.
2. Every quoted move is legal. Track the actual piece/pawn, not merely a square occupied at two different times.
3. The best move must remove a prerequisite, supply a concrete answer, or produce the positive plan absent from the played line. “The event appears only in one PV” alone is insufficient.
4. For a lasting restriction/structure claim, the relevant pawn or blocker remains through the available continuation, including at least two further plies. Treat an event at the PV boundary as unresolved unless its claimed property is already exact and local.
5. For material claims, include recaptures, promotion and checks beyond the named event. Never use an attack count as proof of material gain. A terminal capture with unresolved compensation does not pass.
6. Render one connected reason. If only its incidental clause is proved, discard the candidate rather than keeping that clause as a substitute reason.

An event can occur in both PVs with a different consequence. Compare the prerequisite and result, not just the SAN token. Card 8 is an important example.

### Card 1 — development with tempo and an answer to the knight route

**Board evidence.** In the played line, ...f5 at ply 2 attacks Qe4; Qe2 follows at ply 3. The b8-knight develops to c6 at ply 4, then d4 at ply 6, attacking Qe2; Qd1 follows at ply 7. Two noncapturing, nonchecking queen retreats answer attacks by cheaper pieces. The queen finishes on its original home square.

Na5 does not make ...Nc6 illegal, and ...Nc6 actually appears later in the best PV, after the a5-knight has been exchanged. The accurate local distinction is that **while the knight remains on a5, it can exchange the b8-knight on c6**. Both `Na5 Nc6 Nxc6 bxc6` and `Na5 f5 Qe2 Nc6 Nxc6 bxc6` are legal, material-balanced exchanges. Na5 also attacks b7, but that is not needed in the sentence.

**Detector.** Track a queen through two attack-and-retreat events within eight plies: the cheaper attacker newly attacks its square; on the next move by that side the queen moves without capture or check; the final queen rank is its first rank. Require the attacking knight's route to be identifiable. At the best first-move position, test whether a friendly minor legally captures that knight on its intermediate development square after the proposed development. Examine legal recaptures; do not call an exchange a free piece. Here the route is b8–c6–d4 and Na5 supplies Nxc6. Do not compare queen mobility with the best PV's endpoint: that queen has been exchanged.

**Sentence:** “Bd3 allows ...f5 and ...Nc6–d4 to chase your queen home; Na5 can exchange that knight on c6.”

The chase is a PV witness; the alternative capture is an exact local relation. Neither proves that White must choose those queen retreats or that every black development is prevented.

### Card 2 — use the tempo to attack the knight before the passer advances

**Board evidence.** The d4-pawn is already passed at the root. Kh2 permits ...d3 at ply 2; Kg1 at ply 3 reverses the king move. White reaches Kf1 at ply 7, versus ply 3 in the best line. However, both supplied leaves have Kf1, and neither contains promotion or a demonstrated failed interception. A king-distance comparison at the leaves would miss the tempo history, while the square-of-the-pawn rule would be inappropriate with rooks, bishops and knights present.

There is a stronger local explanation than “the king is too far away”: **Nd2 attacks the undefended Ne4.** After `Nd2 d3 Nxe4`, Black has no immediate legal recapture of the knight on e4. In the supplied best line Black instead plays ...f5, which defends e4. Nd2 also puts a knight on d2, blocking the passer if it reaches d3.

Kh2 does remove the king's defence of f2. After ...d3 the a7-bishop's diagonal to f2 opens, but **Be1 still defends f2**. Do not describe that pawn as undefended.

**Detector.** Find the opponent's passed-pawn advance at played ply 2. Test the same advance after the best first move. Require that the best move newly attacks an enemy piece that is then legally capturable without an immediate recapture; render the actual capture rather than claiming a forced material win. Check that the played first move supplies no such capture. Here the answer is Nd2, ...d3, Nxe4. A same-piece round trip at played plies 1 and 3 is supporting evidence, not a general “wasted move” detector.

**Sentence:** “Kh2 gives Black time for ...d3; after Nd2, that push would instead allow Nxe4.”

This states a concrete distinction without pretending the supplied data prove a lost pawn race.

### Card 3 — retain the cooperating pawns for a concrete kingside plan

**Board evidence.** Best plies 1 and 3 are ...g5 and ...f4. The f4-pawn is supported by e5 and g5. White plays f3 at ply 4; ...g4 at ply 9 challenges that pawn, and fxg4 follows at ply 10. In contrast, ...fxe4 Nxe4 removes Black's f-pawn at played plies 1–2 and frees e4 for a white knight. The plan's cooperating f-pawn has actually disappeared; this is more specific than an endpoint “space” difference.

The annotation's branch `...g5 exf5 ...e4` is legal, and e4 attacks Bd3 and Nf3. But White has Bxe4 and Nxe4 captures available. Merely seeing the fork is not a proof that exf5 is refuted. Likewise, the supplied PV does not prove that ...f4 or the entire attack is unstoppable.

**Detector.** On the best line, require two adjacent pawns on files f–h, with the enemy king on that wing, to advance within the first four plies. At least one advanced pawn must have pawn support. Within the next six plies, require a further advance creating an actual pawn contact with a king-wing pawn within Chebyshev distance 2 of the enemy king. Here ...g4 attacks f3, two squares from Kg1. Require the played first-move exchange to remove one of the cooperating pawns before the corresponding plan can occur. Keep the target named in the witness; do not invent an open file or a mating attack.

**Sentence:** “fxe4 gives up the kingside pawn storm: ...g5 keeps the f-pawn for ...f4, followed by ...g4 against f3.”

This describes a missed plan, not a forced win. It does not require a score decomposition. If the later pawn contact is absent from the available PV, the initial pushes alone should not earn this sentence.

### Card 4 — promotion, with the capture tail checked

**Board evidence.** Re8 takes the rook off h8. In the played line White plays h7 at ply 2, Rg8 at ply 6 and h8=R at ply 12. The promoted rook can be captured: `...Rxh8 Rxh8` is legal. But that exchanges Black's original rook for the promoted rook and leaves White's original rook against the f-pawn. The promotion is therefore not a fictitious material gain caused by stopping before a recapture. The best PV retains Rh8 initially, activates the king with Kf4 and contains no promotion.

**Detector.** Follow an existing passed pawn to promotion in the played PV. Require the played first move to abandon its promotion square/file or its interception duty; identify the specific changed piece relation, here Rh8–e8. Examine the immediate capture/recapture tail, including checking captures, until the claimed material survives or the verification budget is exhausted. Compare the same pawn and defensive resource in the best line. A nonpromoting best PV is supporting contrast, not proof of perpetual prevention. If the promotion occurs at the final ply and its capture tail cannot be resolved locally, reserve a targeted engine verification or abstain.

**Sentence:** “Re8 leaves the h-file, allowing White to play h7, Rg8 and eventually h8=R.”

“Allows promotion” has a supplied witness. “Promotion is forced” needs more evidence. Do not invent a rook return to h8: the supplied line goes Re8–d8–d4–h4, and a return is not shown.

### Card 5 — a pawn wedge, rather than a speculative king-safety comparison

**Board evidence.** In the played line, `Nf6 bxc6 bxc6 c5` puts White's c-pawn on c5 at ply 4. It blocks Black's c6-pawn and attacks Bb6; ...Bc7 follows at ply 5. The c5-pawn is supported by both b4 and d4. The blockage persists through the line. Best-move ...dxc4 captures precisely the pawn that would make this wedge. The subsequent b-pawn exchanges occur in both variations, so “allows bxc6” does not distinguish them.

It is **c6** that is directly blocked by the new c5-pawn. The d5-pawn was already blocked by d4 at the root. The best leaf has White's queen on a4 and rook on c1 facing Black's c6-pawn and king area; “the exposed king cannot be attacked” is much stronger than these positions justify.

**Detector.** Within four plies of the played line, an enemy pawn reaches relative rank 5 or beyond, becomes a direct same-file blocker of a friendly pawn and attacks a friendly minor piece. Require at least one pawn defender of the wedge and the attacked minor to retreat on its next move. The blocker and blocked pawn must persist for at least two more plies and to the supplied endpoint. Require the best first move to capture the wedge's original pawn, not merely produce a different-looking structure. No label “backward pawn” is necessary.

**Sentence:** “Nf6 allows c5 to block the c6-pawn and drive the bishop off b6; dxc4 removes that pawn first.”

This captures a concrete structural part of the annotation. It does not claim to explain the entire evaluation difference or resolve the king-safety trade-off.

### Card 6 — a bishop-for-knight exchange that preserves Black's bishop pair

**Board evidence.** Played plies 2–3 are ...Nxh2+ Rxh2. White loses Bh2; Black loses Ng4. Black retains both bishops, and White retains only one. In the best line Bg3 saves the attacked bishop initially; later Bxh4 Nxh4 exchanges a bishop for a bishop, leaving neither side a bishop pair. Thus raw 3-for-3 material accounting misses the distinction.

**Detector.** Within the first four plies, an enemy knight captures the mover's bishop and is recaptured, with no extra material gain asserted. Count bishops after the exchange and through the available PV. Require the opponent to retain both bishops while the mover has fewer than two, and the best first move to move/save that bishop. Verify that the best line does not preserve the same opponent bishop pair through its exchanges. Do not assign a universal bishop-minus-knight value.

**Sentence:** “Kf1 lets ...Nxh2+ exchange a knight for your bishop, leaving Black with the bishop pair.”

The knight already attacks h2 at the root; Kf1 does not create that attack, though it makes the capture check. “Lets” means leaving the exchange available instead of saving the bishop. This is not a free bishop and not a general assertion that every bishop is better than every knight.

### Card 7 — bare

**Board evidence.** The best PV has only six plies, the played PV twelve. In the played continuation ...Bh4–g5–e3 trades a bishop for Ne3; White's bishop then reaches f2 and the rook reaches e2. Endpoint activity totals would partly measure different material and different amounts of play. The supplied best line also contains White's queen activity and check: Qa2+, Qd2, Qf2.

The proposed deeper line `...h3 f6 Bb6 Qf2` is an alternative hypothesis, not a PV or score supplied here. Even if its moves are legal, that does not establish its evaluation. Neither validate nor reverse the blunder grade from that annotation alone.

**Decision:** no explanation sentence. Flag for offline deeper reanalysis. “Makes White's pieces more active” is too unspecific, and the evidence does not establish it as the reason.

### Card 8 — the exchange installs a pawn with tempo, then a supporting chain

**Board evidence.** ...Nc4 occurs in **both** lines: played ply 2, best ply 6. It cannot by itself explain the difference. In the played line Bxc4 dxc4 at plies 3–4 installs a black pawn on c4, attacking Qb3. Qa4+ is answered by ...b5 at ply 6; the b5-pawn now supports c4. This chain survives to the endpoint next to White's queenside king. In the best line ...dxe4 Nxe4 Nxe4 Bxe4 has already removed the d-pawn, so the same d-pawn recapture onto c4 is impossible.

**Detector.** Within four plies, a minor occupies an advanced square, is captured, and a pawn recaptures onto that square. Require the recapturing pawn to attack the mover's queen, followed within two further plies by a neighbouring pawn move that supports it. Require the chain to persist through at least two further plies and the endpoint. Restrict this template to a chain on the king's wing: files a–d for a king on a–c, files e–h for a king on f–h. In the other line require a concrete lost prerequisite, here the d-pawn is exchanged before ...Nc4. Do not require the knight move itself to be absent.

**Sentence:** “Rc1 allows ...Nc4 Bxc4 dxc4, attacking your queen and building a b5–c4 pawn chain near your king.”

The chain is an observed continuation, not proof that Black's queenside pawns will inevitably roll forward. Do not call c4 unchallengeable.

### Card 9 — true local facts, but insufficient explanation: bare

**Board evidence.** After ...h4, gxh4 is legal and leaves White with isolated doubled pawns on h2 and h4. That conditional structural fact is exact. But White need not capture, and the supplied best PV uses Rh6 instead.

Crucially, **Rh6 Bd2 Rh7 occurs after both ...h4 and ...Kg4**. Bd2 attacks Rh6 along e3–f4–g5–h6 and uncovers Rc2's attack on Bc7 along the c-file in both cases. This is a double attack by two pieces, not a bishop directly attacking both targets. A detector saying that ...h4 uniquely enables it would be wrong. Likewise Rc1+ is legal after the common Rh7 position in both lines. The continuation differs, but merely listing those moves does not explain why h4 makes them more effective.

After the best line's ...Rc1+ Kg2, ...Rc3 attacks d3 along the third rank, and ...Rxd3 follows. The played line also contains ...Rc3 and ...Rxd3, while White additionally wins d4. Those shared rook moves do not isolate the tactical benefit of the h-pawn push.

There is one exact additional contrast: White's h4 at played ply 6 attacks Bg5 and is protected by g3. Black's best-move ...h4 occupies that square, so the identical h2–h4 push is unavailable. But the best PV never puts the bishop on g5, and gxh4 remains a different way to create a pawn attack on g5, at a structural cost. “Prevents the bishop chase” would therefore also need narrower wording or branch evidence; it does not yet establish the main reason.

**Decision:** no explanation sentence. A useful future candidate is “h4 creates a pawn contact whose capture damages White's structure and whose refusal permits a concrete tactical concession.” The second half needs branch verification. The doubled-pawn observation alone is a side remark, and the double attack alone fails the contrast test. Do not print either as the reason for Kg4.

### Card 10 — an unprofitable queen excursion with a measurable restriction

**Board evidence.** Played plies 1–4 are Qc7 Na6 Qxb7 Nb4. ...Na6 attacks Qc7. At the position after ...Nb4, **Qc7 is the queen's only legal destination on which it cannot immediately be legally captured**. There are fourteen legal queen moves, thirteen admitting an immediate capture. For example Qxa8 Rxa8, Qxc6 Nxc6, Qa6 Nxa6, Qb5 cxb5 and Qxb4 Bxb4. This remains true after Nce2 a5. It is restriction, not a trapped queen: c7 is available.

The queen returns Qc7 at ply 7, ...Rf7 attacks it at ply 8, and Qe5 at ply 9 returns it to its root square. ...Nxc2 at ply 10 recovers a pawn for b7; Qxd3 at ply 12 wins another pawn, which must not be mistaken for the immediate compensation alone. The best PV plays Rac1 before any ...Nxc2, supplying an actual defence of c2. Do not invent protection by the rook on a1 at the root.

**Detector.** Within the first four played plies, require a queen sortie to meet a developing minor's attack, capture a pawn and then have at most two destinations free from immediate legal capture, down by at least three from the root. Count only legal queen moves and, for each, enumerate legal enemy captures of the destination. This deliberately measures immediate capture exposure, not strategic safety or SEE. Require the restriction to survive until the queen's next move. Require an observed return/second harassment and an opponent pawn recovery by the same developing minor within the supplied PV, with the captured pawn identities distinct. The best first move must avoid the sortie and retain a concrete resource against that recovery in its continuation. Here Rac1 supplies the later defence of c2; the best queen is exchanged, so do not score its endpoint mobility as zero.

At the root, the same conservative mobility count is five; after played ply 4 it is one. The captured c2-pawn is not immediately recoverable by White at ply 10. This validates the short claim about regaining a pawn, not “c2 is impossible to save against all alternatives”.

**Sentence:** “After Qxb7, ...Nb4 leaves only c7 free from immediate capture, and ...Nxc2 regains the pawn.”

## 2. Can classical evaluation terms explain trade-offs?

They can generate or rank hypotheses; **the largest term difference is not automatically the reason for the move**. Stockfish 11 has explicit mobility, king, threats, passed-pawn and other evaluation components, with phase-dependent scoring and scaling ([source](https://github.com/official-stockfish/Stockfish/blob/sf_11/src/evaluate.cpp)). A small evaluator inspired by those features is feasible. It would explain its own static estimates, however, not decompose the searched scores supplied by a different engine.

Formally, for a surrogate evaluator `E(P) = sum_j w_j f_j(P)`, one can compute `Delta_j = w_j [f_j(best_position) - f_j(played_position)]`. Those quantities sum to the surrogate's static difference, subject to any explicit nonlinear/scaling terms. They do not sum to the supplied engine score gap. Features interact: a king's apparent exposure matters differently when queens are exchanged, and mobility can be compensation for material rather than the cause of losing it.

The endpoints here are especially poor attribution points. Card 3's played line has exchanged a bishop for a rook; its best line has not. Card 5 has different bishop populations and ends immediately after Rxe7. Card 9's best line has removed all bishops; its played line retains both. Card 7 even compares six plies with twelve. A dominant endpoint term could simply describe the exchange chosen along one continuation.

If using such features, compute them at the root, immediately after each first move, and at equal-ply positions with the same side to move. For persistence, inspect three consecutive positions with that same side to move, two plies apart, beginning at the event's first valid comparison point. If either PV is too short, mark persistence unknown. Exclude tactical/check nodes from a “quiet positional comparison”; if too few quiet matched positions remain, abstain. Keep material and phase differences as explicit confounders rather than silently absorbing them into mobility. These are filters, not a causal identification method.

For these trade-off cards:

* **3:** retain the exact cooperating-pawn plan. Do not render “king safety −X” or “Black has more space”. The pawn identities, f4 support and g4–f3 contact explain what to follow.
* **5:** render the c5 wedge and bishop displacement. Do not claim a safely exposed king or name a dominant static term that was never measured.
* **9:** stay bare. A higher pawn-structure penalty after the optional gxh4 branch would not establish that accepting the capture is best, or explain the more important tactical alternatives.

Thus there is a non-LLM route for **parts** of these trade-offs: detect the local mechanism that produces the feature. Naming the aggregate feature alone is likely noise for this reader.

## 3. What offline mining should add

Mine and validate relations, then ship a small candidate selector and fixed templates. More phrases alone will not close the gap.

1. **Build motif-labelled examples and hard negatives.** Store the exact witness and the comparison move, not only a position plus an English label. Include rejected examples: a queen trade falsely scored as zero mobility; ...Nc4 in both lines with different recaptures; the shared Bd2 double attack on card 9; a capturable pawn fork; a promoted piece immediately exchanged; a passed pawn already present at the root.
2. **Generate branches offline.** For each candidate, analyse both root choices more deeply and test the specific challenge: take the advancing pawn, decline the exchange, save c2, avoid the queen retreat, or change the recapture. Use fixed node budgets and record incomplete results. Branch agreement supports a stable motif; branch disagreement can narrow the wording to an existential continuation or reject it. Do not turn a percentage of sampled branches into a proof of “forced”.
3. **Learn relevance separately from factual correctness.** Ask strong players two questions: “Is this claim correct?” and “Is this the useful main reason?” A sentence can pass the first and fail the second, as on card 9. Use blinded sentence-vs-bare judgments, not only sentence-vs-sentence rankings that force a winner.
4. **Calibrate the thresholds above on held-out games.** Features can include earliest witness ply, prerequisite changed by the first move, local tactical verification, shared events in the other line, persistence, missing tail, material/phase mismatch, queen-mobility change and motif-specific branch agreement. A sparse logistic model or small shallow tree ensemble can choose among candidates and abstain. It cannot certify an unsupported tactical statement.
5. **Split by game and related position family.** Keep near-duplicate openings, transpositions and generated branches together. These ten cards are development examples, not a test set. Report correctness, main-reason relevance and coverage separately, with confidence intervals and a reason for each abstention. Select the shipping threshold for a predeclared high precision target, for example 98% correct-and-relevant, only when held-out evidence supports it. Do not claim that target has been achieved here.
6. **Ship semantic templates with typed slots.** A wedge template takes pawn origin, blocked pawn, attacked piece and comparison capture. A queen-excursion template takes the attacker, restriction square and pawn recovery. A validator checks every slot against the board witness before rendering. Never retrieve free-form prose from a superficially similar position and substitute square names.

No extra engine searches are needed for basic replay, attack relations, piece counts or the conservative queen-destination count. Enumerating queen moves and their legal capture replies is bounded board computation, not a new evaluation search. Benchmark it in the actual browser before optimising. A selector with tens of features is small; its quality comes from labels and counterexamples, not its parameter count.

For an unresolved tactical tail, allow at most one targeted verification request for the selected candidate, only when no verified candidate already suffices. A reasonable initial policy is a 20,000-node ceiling, subject to a separately measured browser time limit; exhausting either means abstention, not acceptance. That search budget is a proposal, not a claim of sufficient depth. Reuse results already obtained during normal analysis. Perform most stability experiments offline, rather than running MultiPV for every explanation.

## 4. Output and abstention policy

| Card | Proposed reason | Boundary of the claim |
|---|---|---|
| 1 | “Bd3 allows ...f5 and ...Nc6–d4 to chase your queen home; Na5 can exchange that knight on c6.” | Observed chase and local exchange; not forced queen retreat or absolute prevention of Nc6. |
| 2 | “Kh2 gives Black time for ...d3; after Nd2, that push would instead allow Nxe4.” | Concrete forcing-move contrast; no proved failed king interception. |
| 3 | “fxe4 gives up the kingside pawn storm: ...g5 keeps the f-pawn for ...f4, followed by ...g4 against f3.” | Witnessed plan; not an unstoppable attack. |
| 4 | “Re8 leaves the h-file, allowing White to play h7, Rg8 and eventually h8=R.” | Promotion witness with capture tail; not a proof against every defence. |
| 5 | “Nf6 allows c5 to block the c6-pawn and drive the bishop off b6; dxc4 removes that pawn first.” | Structural mechanism; no speculative king-safety verdict. |
| 6 | “Kf1 lets ...Nxh2+ exchange a knight for your bishop, leaving Black with the bishop pair.” | Exchange and surviving bishop pair; not a free bishop. |
| 7 | **Bare.** | Horizon concern and no sufficiently specific contrast. |
| 8 | “Rc1 allows ...Nc4 Bxc4 dxc4, attacking your queen and building a b5–c4 pawn chain near your king.” | Pawn replacement and chain; Nc4 alone is shared. |
| 9 | **Bare.** | Structural branch is optional; named tactical ideas also exist after Kg4. |
| 10 | “After Qxb7, ...Nb4 leaves only c7 free from immediate capture, and ...Nxc2 regains the pawn.” | Immediate capture exposure and observed recovery; not a forced queen trap. |

At runtime, grade text and a reason are separate decisions. A supplied blunder grade does not license an explanation. First require a valid witness, the changed prerequisite and wording no stronger than the evidence; then require the selector's calibrated correct-and-relevant threshold. Prefer a short direct mechanism over a longer candidate with an unresolved clause. When none passes, return an empty reason. Do not replace it with an evaluation change, generic activity, a best-move restatement or a true but incidental weakness.

The eight sentences above are proposals supported by manual board analysis. Their general detectors still need the offline precision/relevance validation described here. Coverage must be allowed to fall if that validation rejects a motif; matching these ten examples is not a reason to relax the gates.
