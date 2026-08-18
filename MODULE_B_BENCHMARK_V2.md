# Module B conditional-outcome benchmark v2

Status: `FROZEN_SEMANTICS_SYNTHETICALLY_VALIDATED_NO_RESULT_AUTHORITY`

This version corrects the responsibility boundary prospectively. It does not
rescore, rerun, retune, or reinterpret any burned v1 candidate. Historical v1
protocols, reports, receipts, and Result-exposure facts remain immutable.

## Responsibility boundary and estimand

Module A owns whether the opponent is likely to reach a preparation
opportunity and reports reach probabilities. Module B begins only after a
common legal opportunity has been reached and estimates:

`E[Black outcome(candidate offer) - Black outcome(control offer) | common opportunity reached]`.

If both modules later pass independently, `Module A reach probability × Module
B conditional uplift` may be reported as an approximate end-to-end diagnostic.
Reach is never a Module B admission gate or ranking input.

## Common opportunities and exact-12 content

Each subject-cutoff has 12 outcome-blind opportunity anchors supplied by
Module A or a separately frozen anchor selector. An anchor is an exact legal
seven-ply UCI prefix: White has just moved and Black has not yet taken the
action that Module B content can influence. Every arm must provide an exact-12
route extending every one of the same 12 anchors. Exact-12 is the content and
budget receipt; it is not a future-reach metric.

Opponent deviation before the anchor is excluded from Module B scoring and
reported once as a Module A reach diagnostic. It is never a miss, zero, loss,
or arm-specific failure.

## Identification

When a common anchor is reached, blocked random assignment occurs before any
arm content is revealed. The assigned candidate or control content is offered,
and the row remains in its assigned arm even if the subject does not follow it.
Compliance is recorded as a report-only boolean by assigned arm; it never
reassigns or removes the row. The primary analysis is therefore intention-to-treat. Assignment is blocked
by subject-cutoff and opportunity stratum; all arms use the same eligible
population.

Historical observational v1 outcomes cannot implement this estimand. v1
computed each arm's outcome mean on that arm's own triggered games. Shared-game
outcomes are identical, while non-shared games differ in opening composition;
the resulting nonzero delta is not a content treatment effect. Offline
prediction, agreement, propensity, or arm-conditional summaries may be
retained only as explicitly non-causal diagnostics. They cannot authorize
admission, Fresh, replacement A, or product.

## Score, inference, and decisions

Black outcome remains win = 1, draw = 0.5, loss = 0 with the frozen 30-day
half-life weight. For each subject-cutoff randomization block, compute the
candidate assigned-arm weighted mean minus the control assigned-arm weighted
mean. Average block deltas within subject, then use the frozen 10,000-replicate
90% subject-cluster percentile bootstrap with seed 20260810.

Data sufficiency requires at least 24 paired subject-cutoffs, six subjects, and
24 valid outcomes in every arm. Failure of any sufficiency check is
`INCONCLUSIVE_INSUFFICIENT_CONDITIONAL_OUTCOMES`, not algorithm failure. With
sufficient data, admission requires a positive lower confidence bound against
every required control plus the frozen blinding, randomization, common-
opportunity, disjointness, materiality, and deterministic-replay gates.
Every non-statistical gate requires an artifact path and SHA-256 receipt. The
evaluator resolves that path below an explicit evidence root and verifies the
hash against the actual bytes; a bare boolean, missing receipt, path escape, or
hash mismatch cannot authorize a scientific decision. A
positive scientific decision also cannot become admission while the protocol
has `newResultJoinAuthorization:false`.

Coverage is `common opportunities reached / prospectively scheduled games`.
It is a single Module A-owned descriptive diagnostic, not an arm-specific gate.

## Authority boundary

The machine protocol is
`research/module-b-outcome-benchmark-v2.protocol.json`. The current repository
contains only deterministic synthetic validation. No new Result join is
authorized until a prospective randomized opportunity ledger, custody plan,
and fresh pre-Result hostile freeze review exist. Fresh B and replacement A
remain closed.
