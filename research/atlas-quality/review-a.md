# Manual clarity review A — corpus indices 0–12

Reviewed the saved raw PGNs listed in [corpus/manifest.json](corpus/manifest.json): 13 distinct studies, indices 0 through 12 inclusive. The chapter maps and sampled introductory, branch, warning, exercise and model-game comments underpin these judgments. This is not an exhaustive reading of every variation, a chess-correctness audit, or a blinded validation set. No engine assessment, study size or popularity determines these labels. Chapter links identify the passages in the saved snapshot; live studies may change.

The audience is a new reader trying to use the material at its declared level. **High** means the sampled material makes topic, perspective, choices and intended lesson readily understandable. **Medium** means useful local explanations coexist with concrete navigation, role or editorial ambiguities. **Low** means the sampled material leaves a newcomer without sufficient explanatory guidance, even if it may work as the author's personal reference. **Uncertain** is for insufficient accessible evidence. These are clarity judgments, not labels of good/bad chess or complete/incomplete coverage.

High likes can be external positive-unlabeled evidence of usefulness. Low likes are unknown, never a negative label. This review does not fit labels or thresholds to likes. Its reservations come from the passages below.

## 0 — London System Repertoire — high, with a localized placeholder

Source: [2EaSmZtz.pgn](corpus/2EaSmZtz.pgn). The progression from introduction and basics into named opponent setups gives the reader a usable map. The [Introduction](https://lichess.org/study/2EaSmZtz/mgoBqs97) explicitly calls this a personal repertoire, credits source studies and defines the colored drawings: green positional moves, red attacking moves, blue pawn breaks. The [Basics](https://lichess.org/study/2EaSmZtz/C8pUIq2K) explains the pawn pyramid and bishop responses rather than providing moves alone.

The Old Benoni chapter explicitly warns that simply playing the standard system moves is inadvisable and switches systems. That exception is valuable instruction: uniform setup is not presented as a universal policy. Conversely, [Stonewall London](https://lichess.org/study/2EaSmZtz/9j2qOYK9) is an empty placeholder. It is a specific broken expectation, not grounds to condemn the rest. An introductory FEN diagram with no moves is meaningful here and must not be equated with that empty placeholder.

## 1 — The London System (Lifetime Repertoire) — medium

Source: [artuehhC.pgn](corpus/artuehhC.pgn). A guided sequence of lines, variations, reviews and a quiz supports practice, but names such as “Variation #1 of line #1” are harder to navigate by opponent setup. Its clarity is stronger for a sequential learner than for someone returning after a particular game.

In [London line #1](https://lichess.org/study/artuehhC/BOsMGGU7), the gamebook chapter includes the non-mainline continuation `1.d4 d5 2.Bf4 Nf6 3.e3 c5 4.Nf3`, explaining that moving the knight there permits aggressive counterplay. This is wrong-answer feedback, without a mistake NAG; it is not evidence that the author recommends an inferior move. [London Review #1](https://lichess.org/study/artuehhC/0MQJrF35) starts from a custom position and asks for the best move. [Quick Quiz](https://lichess.org/study/artuehhC/Ym11IjEs) asks what to play. Preserving gamebook mode and prompt/feedback context matters more than treating every stored variation as preparation.

## 2 — A Gambit Repertoire for White — medium

Source: [D8QPC8Zr.pgn](corpus/D8QPC8Zr.pgn). Introduction, overview, named gambits and conclusion make the chosen style explicit. The Halasz material gives concrete attack plans, including queen transfers toward g3/h4 and pawn advances, rather than stopping at a sacrifice. Those plans make speculative openings understandable without proving their objective soundness.

In [The Tennison Gambit](https://lichess.org/study/D8QPC8Zr/WLMjNamp), the author favors Bc4 for development and pressure on f7, while a d3 alternative is attributed to another teacher and expressly rejected. That is an important recommendation/alternative distinction. The introduction also contains sweeping claims about suitability and rapid improvement that are not substantiated by the PGN. My reservation concerns the precision of the guidance, not the gambit choice or engine evaluation.

## 3 — King's Gambit | Full Repertoire — high

Source: [ACmyH8gC.pgn](corpus/ACmyH8gC.pgn). Accepted and declined sections, named defenses, optional aggressive material and a separately named example game communicate distinct roles. The accepted introduction explains the Qh4 threat and the Nf3 response. The [hyper-aggressive section](https://lichess.org/study/ACmyH8gC/bsKFmeDH) explicitly distinguishes its optional style from the previously presented h4 treatment. The [Single Muzio](https://lichess.org/study/ACmyH8gC/CcrvhcZJ) explains development compensation.

Crucially, [A Stunning Double Muzio Game at 2500 level!](https://lichess.org/study/ACmyH8gC/4sT7Yk1P) contains the historical mainline move `12...Nc6??` and identifies Ne7 as better. A mainline blunder is an analyzed game event, not necessarily a repertoire recommendation. The chapter on punishing `2...f6?` likewise teaches a response to a bad opponent move. Neither establishes poor study quality.

## 4 — The Sicilian — medium overall; clear Dragon lessons

Source: [NGpnogsw.pgn](corpus/NGpnogsw.pgn). The sequence from Open Sicilian to Dragon, Yugoslav Attack and named games provides a coherent local course. Its broad introduction discusses Open and Closed Sicilians, while the chapter map concentrates on the Dragon; the advertised scope is broader than the immediately discoverable instruction.

In [The Dragon: The Yugoslav Attack](https://lichess.org/study/NGpnogsw/k8kie88Q), `6...Ng4` appears as a non-mainline demonstration: the comment explains that both shown continuations lose material for Black. There is no mistake NAG on that node. In [Game 2: Koval vs Berman](https://lichess.org/study/NGpnogsw/B1nJfGyv), mainline `15.Bxf6` is criticized and h5 is suggested to open the h-file. The prose supplies both the move's role and its lesson. Penalizing the presence of either move would invert the teaching evidence.

## 5 — Greatest Caro Kann: Living Repertoire — high organization, editorial caveat

Source: [8Uztu7Xx.pgn](corpus/8Uztu7Xx.pgn). The [Course Map](https://lichess.org/study/8Uztu7Xx/0HhcLOT8) separates getting started, openings, middlegame plans and instructive games. The [Scaffolding Guide](https://lichess.org/study/8Uztu7Xx/hgAd8I6Y) calls itself a quick reference rather than a deep dive. Opening chapter introductions identify destination structures and plans; the 2.d3/KIA material explains the central response before White's kingside buildup. This is strong reader orientation, independently of its scale.

However, [Middlegame Guide — Plan #8](https://lichess.org/study/8Uztu7Xx/n6qPnXnz) retains an explicit engine-derived draft/edit-before-publication note. That is an editorial-readiness concern grounded in the text, not an objection to using engines. It also presents a White-side model game inside a Black repertoire, with both sides' turning points. A parser must preserve that game role rather than assume every own-side mistake is prescribed policy. Overall clarity is high in the sampled map and plans, with this visible unfinished passage requiring attention.

## 6 — ♦ All about the Sicilian Defense ♦ — medium

Source: [8c8bmUfy.pgn](corpus/8c8bmUfy.pgn). Named chapters make the major Sicilian families discoverable. This is a survey, so offering multiple systems is appropriate; absence of one selected repertoire policy is not itself a defect. Dragon explanations connect f3 with preventing Ng4, defending e4 and supporting the attacking setup.

Explanatory detail is uneven. The Accelerated Dragon's `6.Nxc6` is labeled a White mistake with little local explanation, while the sampled [Open Sicilian](https://lichess.org/study/8c8bmUfy/lleARfzO) chapter has no prose. The Najdorf chapter points elsewhere for further study. Contributor markers embedded in comments indicate a compiled discussion. These features make it less consistently self-contained than the chapter map suggests, without making the underlying variations bad.

## 7 — English Opening Repertoire — medium

Source: [fTpa2qZW.pgn](corpus/fTpa2qZW.pgn). Groups for Reversed Sicilian, Symmetrical, King's Indian structures, other systems, anti-English systems and model games help navigation. The Reversed Dragon/Alapin discussion distinguishes mainstream Nf3 from the author's e3 preference and explains Nge2–f4. A Symmetrical chapter explicitly recommends Nf3. These are useful preference and plan signals.

The [Williams–Locatelli model game](https://lichess.org/study/fTpa2qZW/RgjIkhU9) criticizes Black's mainline ...g5 as a mistaken reaction. Other compiled material changes perspective, and some model-game annotation is as sparse as a resignation statement. Group titles and local recommendations are helpful, but side/role transitions require more inference than in the strongest reviewed courses. Numerous evaluation directives are not substitutes for explanations.

## 8 — Crush the Caro-Kann! White Repertoire — high

Source: [CfSYkcMp.pgn](corpus/CfSYkcMp.pgn). The introduction separates three options—Open, Half-Open and IQP—and explicitly permits choosing one rather than memorizing everything. It explains IQP terminology and identifies an intended level. Branch introductions give plans, and the [IQP chapter](https://lichess.org/study/CfSYkcMp/4CBcNzDP) warns that this option needs more study/practice, with a stronger audience expectation than the general introduction. That is useful conditional scope, not necessarily contradiction.

In [Section 2: 3...Bg4](https://lichess.org/study/CfSYkcMp/89db8vUx), the non-mainline `6.e5?` is directly prohibited. Other branches expose opponent traps and explain transpositions to Alapin structures. Negative examples are labeled as such; their existence strengthens instruction. Some individual warnings are terse, but the overall choice architecture and guidance are clear.

## 9 — My Repertoire Against e4: The Caro Kann Defense — medium

Source: [yteYURRC.pgn](corpus/yteYURRC.pgn). Variation-based chapters contain useful positional explanations, including the ...c5 break and d-file plans. [Exchange Variation, Another type of Game](https://lichess.org/study/yteYURRC/3iUQhP0z) explicitly introduces the Ian Rogers game as additional middlegame instruction. The Two Knights chapter distinguishes a quicker, slightly weaker ...Bg4 option from the main ...Nf6 route. These are concrete role and tradeoff signals.

The onboarding asks the reader to consult a pinned study comment, which is absent from the PGN export. The [sources chapter](https://lichess.org/study/yteYURRC/P3xiZuc5) credits material but does not recover that missing context. The exported study is locally explanatory, yet the completeness of its intended onboarding remains uncertain. Missing discussion content must be recorded as unavailable, not silently treated as no explanation anywhere.

## 10 — Hippopotamus Defense — medium

Source: [vPqdbuqZ.pgn](corpus/vPqdbuqZ.pgn). The [main setup](https://lichess.org/study/vPqdbuqZ/CMX088YV) and [Standard Breaks](https://lichess.org/study/vPqdbuqZ/kLmkH0m3) use custom-FEN diagrams to teach a structure and pawn breaks. The latter distinguishes central reactions from active counterplay and advises focusing on one or two breaks. This compact plan instruction is useful even without an opening move sequence.

The connection between that introduction and all later games is less explicit. [Tal–Vasiukov](https://lichess.org/study/vPqdbuqZ/OWwRAiDx) is a Caro-Kann game with a substantial Tal anecdote; the sampled commentary does not clearly establish its Hippo lesson. [Pickard–Gardner](https://lichess.org/study/vPqdbuqZ/Q76PNJuE) discusses a White Hippo structure within the nominal Black guide. These can illustrate transferable ideas, but the reader must infer the bridge and perspective change. This reservation is about explanation, not whether an unconventional setup is sound.

## 11 — Complete Repertoire — low instructional clarity for a newcomer

Source: [2XxhfIAJ.pgn](corpus/2XxhfIAJ.pgn). Opening-family titles and W/B/W-B labels provide useful navigation. The problem is not its size: in sampled chapters, substantial move trees and citations receive little connective explanation. There is no introductory guide before Fried Liver. That chapter includes source-game references and a cross-reference to chapter 9; the sampled Danish/Center Game chapter has no prose. Ruy Lopez Archangel and London material frequently cite games rather than explain how the learner should use the alternatives.

For someone already familiar with the author's choices, this may be an effective personal reference; that suitability is uncertain. For the review's new-reader audience, concrete missing orientation and local rationale justify the low label. This is not a finding that its moves are bad, nor that sparse/obscure studies in general are bad.

## 12 — 🏆 Opening Systems YOU can USE in your games — high as a primer

Source: [oBsew7N6.pgn](corpus/oBsew7N6.pgn). Named systems and introductory definitions make this a primer for both colors rather than one complete policy. London explanations connect bishop placement to the pawn chain. Hippo and Lion passages connect structures and castling choices to plans; Gurgenidze material describes knight routes and the opponent's pawn counterplay.

The [Mystery System](https://lichess.org/study/oBsew7N6/6PvvLGs7) states when the system will not work, including early d4 and Smith–Morra structures, then illustrates structural problems. A resulting unpleasant position demonstrates a scope violation. Treating it as a repertoire blunder would erase the very warning that makes the lesson usable. The title's promise should be understood as selectable systems, not demonstrated exhaustive opening coverage.

## What the evidence supports for implementation

**Supported by these examples:** preserve chapter identity/order/title, side, custom starting FEN, gamebook mode, game headers, mainline status, local and starting comments, NAGs, drawings and contributor markers. Do not infer a recommendation from first-variation order, game mainline, a mistake symbol or the absence of a mistake symbol. Introductory diagrams, separators, placeholders, exercises and model games need different interpretations. The export omits some onboarding/discussion evidence.

**Exploratory heuristic:** Decision notes, Fork signposts, Endpoint notes and Starting notes can transparently measure documentation presence. They cannot establish clarity of meaning, consistency, correctness, teaching success or genuine recommendation roles. Mere letters after removing notation/directives qualify under the agreed simple core: a resignation comment or a draft note may count even when the human review finds it inadequate. This discrepancy should remain visible rather than be hidden by an English keyword classifier.

For PGN conversion, retain `ChapterName`, `ChapterURL`, `ChapterMode`, `FEN`/`SetUp`, `White`/`Black`/`Result`, node comments and variation-start comments with their attachment. Preserve NAGs as source judgments, not independent truth. Separate `[%cal]`/`[%csl]` drawings, `[%eval]` engine annotations and `[%anno]` attribution from explanatory prose; an arrow-only comment is not a local prose note. Preserve cross-chapter and external dependencies even when their destination is not locally available. Do not mistake a URL alone for rationale.

The principal negative clarity evidence here is missing guidance or ambiguous transitions relative to a declared audience and purpose. Neither low likes, low engine agreement, few nodes nor a demonstrated bad move supplies that negative evidence.
