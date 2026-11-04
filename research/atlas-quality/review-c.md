# Reviewer C — clarity of actual published content

Reviewed 2026-11-03. Assignment is **zero-based manifest indices 26–37**, twelve distinct studies. I read the saved PGNs: full chapter inventories, introductory text, selected early/late mainlines and substantive variation comments. This is direct content inspection, not an engine assessment or a count-based classifier. It is not an exhaustive factual or instructional audit of every variation. Evidence references below point to the exact chapters also preserved in `corpus/{id}.pgn`.

## Rubric and evidence rules

**High:** the inspected content makes its purpose and navigation clear, explains concrete decisions/plans, and distinguishes examples or alternatives sufficiently for its intended reader. **Medium:** useful instruction with concrete local ambiguity, unsupported simplification or inconsistent guidance. **Low:** an identifiable obstacle to learning from the PGN alone, evidenced in its actual content. **Uncertain:** insufficient inspected evidence or an audience/format dependency prevents a fair overall judgment. These are reviewer judgments of clarity in the inspected material, not chess strength, completeness or validated whole-study ratings.

High likes are a **positive-unlabeled external signal**: readers found or endorsed something useful. Low likes are **unknown**, never negative evidence. No popularity cutoff is fitted, and these labels were formed from the content, not likes. Popularity is affected by exposure, age and promotion. `corpus/stars.json` contains observed public Lichess `likes` integers, timestamp, source URL and raw embedded-metadata excerpts for all 38 studies; these are counts, not star ratings. No engine labels enter this review. An explicitly bad move can be an excellent teaching example.

## Individual findings

### 26 — PDVt7Kbh — Caro-Kann Defense Repertoire — High

The chapter sequence separates themes, sidelines, main lines and named master games. In [Theme #1](https://lichess.org/study/PDVt7Kbh/sRwKL0gj), ...b5 is linked to White's c4 weakness rather than merely praised. In [2.c4](https://lichess.org/study/PDVt7Kbh/ztj5zU5J), the author explains castling before central entanglement, then ...b6/...Bb7 before ...b5 because the a8 rook would otherwise be unprotected. The Advance discussion explicitly points back to Theme #3. This is strong explanatory and navigational evidence. Some historical/name speculation is explicitly marked speculation; it should not become a factual-quality endorsement.

### 27 — jtlLwUvh — Caro-Kann Defense — Medium

This is a clear beginner introduction, with named variations and a final quiz. [Advance](https://lichess.org/study/jtlLwUvh/UBjg1Y17) connects ...Bg4 to getting the light bishop outside the pawn chain and uses active prompts. But [Classical](https://lichess.org/study/jtlLwUvh/IhohNE72) describes Nc3/Nd2 as moves of the **g1** knight while its arrows identify b1. That concrete notation mismatch can confuse its novice audience. Calling one choice the best without comparison also supplies less decision support than the thematic guide. Its high public likes are positive evidence of reader reception, not a reason to ignore that local flaw or to classify the whole study negatively.

### 28 — A4EBp7Ds — French Defense Repertoire — High

Themes precede sidelines/main lines and named model games. [Theme #1](https://lichess.org/study/A4EBp7Ds/zk1whRCY) follows how the base of a pawn chain changes from b2 to d4. The [Exchange chapter](https://lichess.org/study/A4EBp7Ds/XObMEkZE) explains the repertoire's anti-symmetry aim and conditions the castling choice on whether White has played Bg5–h4. The [Wing Gambit chapter](https://lichess.org/study/A4EBp7Ds/fHrHzz7m) explains what each side buys with pawn concessions and attributes a recommendation. These are concrete decision explanations, not simply annotation volume. No claim here that every suggested move is best.

### 29 — UzKIIAtz — French Defense — Medium

Named variation chapters and practice questions make the introductory purpose clear. [Exchange](https://lichess.org/study/UzKIIAtz/WpSQpdzB) identifies why the c8 bishop becomes easier to develop and explicitly limits which moves to imitate. However, its closing statement calls the resulting position winning for Black and invokes a large game majority without a cohort or evidence. [Tarrasch](https://lichess.org/study/UzKIIAtz/ETSWoqoB) refers to a knight from g1 in the Nc3/Nd2 context and describes Black's rook as coming from a1. Those textual coordinate errors and unsupported absolutes weaken beginner clarity. This is not an engine verdict on the demonstrated moves.

### 30 — bbxmDYZV — What is your Ideal Opening? — Medium

[The 3 Keys](https://lichess.org/study/bbxmDYZV/PHGuEFZZ) provides a usable choice structure: level, available time and playing style. The chapter inventory follows those categories, and the [Ruy Lopez example](https://lichess.org/study/bbxmDYZV/dyU7jH8E) links to a dedicated follow-up study. It is an opening-selection guide, not a repertoire missing branches. The limitation is that level/style suitability is asserted rather than illustrated through competing positions or exceptions. Clear navigation, but weak support for the recommendation boundaries; not a low rating merely for being an overview.

### 31 — nRiq9SZx — Pirc/Czech System — Medium

The introduction names the d6/Nf6/c6 setup. The substantive e4 chapter explains trading the bishop because Black is cramped and Nf3 defends the center. The [London chapter](https://lichess.org/study/nRiq9SZx) marks ...g5 as a surprise sideline and identifies more solid alternatives. That distinction protects against treating every line as the main recommendation. However, jokes, alternating imagined voices and decorative chapter names make the recommendation harder to skim; a later note merely tells the reader to move the queen somewhere. The issue is inconsistent specificity, not humor or gambit identity by itself.

### 32 — HHZpRszr — Openings — Medium

White and Black sections and opening-family chapter labels are easy to navigate. The English chapter explains why Nc3 and g3 belong in the setup and offers newcomers permission to skip a difficult topic. But [Scandinavian](https://lichess.org/study/HHZpRszr/koSYJEFS) largely asks readers to follow arrows and ends with a favorable-position assertion without explaining a continuation plan. London prompts such as making a pawn pyramid help recognition but do not consistently explain decisions. This is a useful introductory sampler with uneven depth, not a failed complete repertoire.

### 33 — bmWAylqe — Repertoire for the D4 PLAYER — High, with diagram caveat

The [introduction](https://lichess.org/study/bmWAylqe/RTKXYP1R) explicitly maps White chapters 3–23 and Black chapters 24–50 and identifies its exceptional e4 system chapter. W:/B: prefixes make perspective visible. The [universal-system chapter](https://lichess.org/study/bmWAylqe/Ctmo8KhH) explains the setup and different pawn attacks according to the opponent's castling side. It uses repeated opposing king moves to display the setup: these are **diagram scaffolding**, not a serious opponent policy. An automatic engine-error score could misread that role. Ideally the instructional abstraction would be explicitly labelled; high clarity here rests on the scope map and plans, not complete coverage or engine soundness.

### 34 — nYAJ7Km3 — Pirc Defense Repertoire — Medium

Named White attacking systems supply a clear structure. [Austrian I](https://lichess.org/study/nYAJ7Km3/KEQUVYs9) links ...c6 to preparing ...d5; [150 Attack](https://lichess.org/study/nYAJ7Km3/1t2TPdJv) explains Qd2/Bh6 pressure on the fianchetto bishop. The Byrne chapter prompts the learner to prevent that trade. But the introduction overgeneralizes White's occupation of the center as overextension; prompts such as finding a fork are more explicit than explanations of when that tactic will actually be available. Good short drill structure, incomplete decision context. Shortness is not the negative evidence.

### 35 — FwXo3Qhq — Pirc Defense: Opening Repertoire for Black — High for companion notes; standalone completeness uncertain

Chapters are organized by White's attacking system and link to specific NM Robert Ramirez videos. In [Classical](https://lichess.org/study/FwXo3Qhq/aZUVLGwG), a variation describes the ...e5 break, queen support, rook placement and knight route to f4. [Fianchetto](https://lichess.org/study/FwXo3Qhq/3zDG52Sw) explains why exchanging a knight can improve the opposing bishop. [Tactics](https://lichess.org/study/FwXo3Qhq/WeK0cgPB) explicitly marks the transition from an opening trap into a game example. The external-video dependency limits standalone completeness, but actual local plan explanations support high clarity as companion notes. Its low likes do not count against it.

### 36 — LLNDy032 — répertoire 1500 élo avec les blancs — Low for self-contained teaching; personal-reference usefulness uncertain

The opening map and named defense chapters are understandable. But direct inspection of all nine chapter comment collections found the substantive guidance mostly in the introduction: defense names and an Italian playlist link. [Alapin](https://lichess.org/study/LLNDy032/jTpiWgf2) lists three serious options without explaining how to choose; the separate Petrov, Philidor, Pirc, gambit, McConnell, French and Caro-Kann chapters supply lines without prose decision explanations. The concrete drawback is missing rationale at the listed alternatives, not the author's language, study size or low likes. This can still be a useful personal move notebook; its usefulness for that purpose is uncertain, not negative.

### 37 — e01yoGqe — Punishing Bad Openings — High for its tactical-teaching purpose

The introduction explicitly promises punishments of weak choices. [Damiano](https://lichess.org/study/e01yoGqe/LztgG0lb) presents the apparently hanging Nxe5, asks the reader to find the follow-up and explains Qh5+ with the queen/rook fork if ...g6. [Greco](https://lichess.org/study/e01yoGqe/c86jKJXU) explains the queen-development cost and Nd5 pressure. [French Qh4](https://lichess.org/study/e01yoGqe/62rAQeih) explains blocked escape squares and gives forcing queen-chase moves. Opponent mistakes are the lesson's input, not evidence of a poor study. Some broad popularity claims remain unverified, but the tactical cause-and-effect explanation is concrete.

## Implications for clarity metrics — proposals, not validated predictors

1. **Separate material roles before assessing it.** Lesson examples, diagram setup, refutations, personal reference and playable repertoire have different jobs. The universal-system chapter and punishment study show why detecting mistakes is not a pedagogical negative.
2. **Reward understandable navigation and actionable local explanations.** A topic label identifies where to go; a reason linked to a move, conditional plan, worked question or explicit cross-reference identifies what to learn. Themes plus lines are particularly clear in the paired Caro-Kann/French guides.
3. **Do not equate comment count with explanation.** Praise, promotion, bare URLs, eval tags and arrows are distinct from causal instruction. Arrows and concise prompts still help a live board learner; do not simply discard them or penalize concise notes automatically.
4. **Reserve negative judgments for concrete shortcomings and intended audience.** Contradictory square references, unsupported universal claims and unexplained alternatives in an otherwise self-contained lesson are inspectable problems. A personal notebook lacking prose needs a role-aware unknown rather than an automatic bad label.
5. **Keep high likes as independent positive-unlabeled evidence.** Do not regress a score onto these counts or turn the low-like tail into negatives. A manual clarity rubric can flag local shortcomings in highly liked studies while still recognizing their accessible instruction. No cross-study ranking or numerical clarity formula has been validated by this twelve-study inspection.

Snapshot judgments: five High (one role-conditional), six Medium, one Low for self-contained teaching with personal-reference usefulness uncertain. These are transparent qualitative observations, not benchmark ground-truth whole-study good/bad classes.
