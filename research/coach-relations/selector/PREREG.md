# Reason selector: pre-registration (2026-10-15, before any confirmation label is read)

Frozen before the test: the weak-type list v2 (`v2.py`, `V2.md`), the confirmation set
(`confirm/`, 250 cards from games no earlier label touches, one per game, in the pool's mix of
147 one-candidate and 103 multi-candidate cards, seed 20261016), and the test script
(`confirm.py`). The test runs once.

Labels: sol (`confirm/out`) and a second judge from another model family (`confirm/out2`); where
they disagree on a candidate, the user decides (`confirm/adjudicated.jsonl`).

Precondition, measured on the development set: the user's spot-check of 60 cards (40 random: 30
multi, 10 single; 20 where the judges disagree) gives speak/stay-bare kappa >= 0.6 against sol
on the 40 random cards and multi-candidate best agreement >= 70%. If it fails, the conclusion uses
only the cards where both judges agree plus the user's verdicts.

H1, ship v2 (all must hold; R1 = the v1 hand rule):
- v2 hit - R0 hit >= +10pp, paired bootstrap (10,000) 95% CI lower bound > 0;
- v2 - R1 hit: CI lower bound > -3pp; v2 coverage >= R1 coverage - 2pp;
- v2 speaks when the card should stay bare on <= 12% of cards.

H2, a learned model replaces the rule (only if one is proposed again): coverage within +-3pp of the
rule, hit >= +5pp with CI lower bound > 0, recall down by at most 5pp, utility (right +1, wrong -2,
bare 0) not below the rule's.

Choosing among candidates is closed: wrong picks are 3-5% of cards.

## Closed before the test (2026-10-15, no confirmation label read)

The user's spot-check (20 of the 60 cards, spot/) shows a different cost model: the user stays bare
on 3 of 20 cards (sol 22%, Hark 30% of the 360) and prefers a correct but incomplete reason to none.
The user's call: show it, and fix the reasons. The "wrong costs 2" utility behind H1 does not hold
for this reader, so H1/H2 are not run and confirm/ stays sealed. A user-taste rubric for the judges
(taste/) matched the user on 6 of 10 held-out cards, no better than the plain rubric (7/10), and is
not used. Work moves to the candidates themselves: duplicates (fixed in explain.said), forks that
are plain exchanges, material and king safety told together.
