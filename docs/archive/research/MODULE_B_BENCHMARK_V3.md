# Module B pre-game conditional-outcome benchmark v3

Status: `FROZEN_SEMANTICS_SYNTHETICALLY_VALIDATED_NO_RESULT_AUTHORITY`

v3 prospectively corrects the treatment-timing defect in v2. Historical v1,
v2, candidate, Result, receipt, and burned-identity bytes remain immutable. No
historical candidate is rescored, rerun, retuned, or reinterpreted under v3.

## Responsibility and claim

Module A owns opponent reach. Module B estimates the intention-to-treat effect
of offering one frozen pre-game content package rather than a control package
after a study game has been scheduled, conditional only on the opponent's first
move being in the common arm-independent support:

`E[Y(candidate package) - Y(control package) | scheduled Black game played and White ply 1 is in common support]`.

The opponent's first move occurs before Black can act and the opponent must be
blind to assignment. Module A reports the probability of that first move and
may separately report deeper exact-7 reach. Neither diagnostic is a Module B
gate, ranking input, rejection reason, zero, or loss. An end-to-end diagnostic
may multiply independently validated Module A ply-1 reach by v3 conditional
uplift only after both modules pass independently.

## Lawful causal timing

The schedule ledger is frozen first. A seed is drawn only after that freeze;
the repository's deterministic block-balanced allocator assigns a package;
the full exact-12 package is exposed through ordinary Build/Train/Scout before
the game; and no content is revealed during play. Assignment is intention-to-
treat. Later Black choices, suffix departures, and noncompliance remain in the
assigned arm and are report-only.

v2's exact-7 post-reach reveal would be live assistance in a rated game. Moving
that assignment pre-game would put treated Black plies 2, 4, and 6 inside the
conditioning event and create post-treatment selection. Therefore exact-7 is
not a v3 outcome eligibility gate. It may remain content metadata or a Module A
diagnostic. If a future study needs an exact-7 decision endpoint, it must use a
separately versioned standardized blind assessment and may not claim terminal
game-outcome uplift.

## Common packages and opportunities

For every subject-cutoff, every arm supplies exactly 12 legal twelve-ply routes.
The 12 opportunity IDs and their White first-move UCI values are identical
across arms. Route suffixes may differ. Exact-12 is content/budget integrity,
not reach quality. A played game is Module B eligible when its actual first move
belongs to that common support. A first-move miss is excluded and reported once
as a Module A pre-intervention deviation. All later play remains ITT.

## Score, inference, and integrity

Black outcome is win = 1, draw = 0.5, loss = 0. The 30-day weight is frozen from
the pre-assignment scheduled-game timestamp relative to the cutoff, so treatment
cannot change its own weight. Unknown outcomes and scheduled games that do not
occur are unscored and reported; they are never manufactured losses. Because
play/nonplay and outcome ascertainment occur after randomization, any missing
scheduled game or eligible outcome makes the study inconclusive rather than
allowing a selected observed-only comparison to pass.

Within each subject-cutoff, compute the assigned candidate weighted mean minus
each assigned control weighted mean. Average cutoffs within subject, then use a
10,000-replicate 90% subject-cluster percentile bootstrap with seed 20260810.
Data sufficiency requires 24 paired cutoffs, six subjects, and 24 valid outcomes
per arm. A floor failure is
`INCONCLUSIVE_INSUFFICIENT_CONDITIONAL_OUTCOMES`.

Every non-statistical gate requires a repository-relative artifact and SHA-256
verified against actual bytes below an explicit evidence root. Required gates
cover package equality/legality, schedule freeze, randomization replay,
pre-game-only exposure, opponent blindness and arm-blind pairing, outcome
ascertainment, Result blinding, consent/lawful study operation, source
disjointness, materiality, and deterministic replay. A failed integrity gate is
`INVALID_PROSPECTIVE_STUDY_INTEGRITY`, not an algorithm failure.

## Authority

The machine protocol is
`research/module-b-outcome-benchmark-v3.protocol.json`. Only deterministic
synthetic validation exists. `newResultJoinAuthorization` is false. Before any
new Result authority, a real prospective schedule/package/randomization custody
bundle and fresh readonly pre-Result freeze review must exist. Fresh B,
replacement A, and product remain closed.
