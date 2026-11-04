# Rejected engine-quality experiment

The target was rejected: a stored mistake can illustrate a trap, quiz answer or refutation. Engine regret does not establish poor teaching or unclear organization. No engine-derived labels are used in the final manual classifications or documentation evaluation.

The frozen [aggregate](evaluate-summary.json) records 38 real studies, 45 study-side units and 1,070 sampled decisions. Stockfish 18 searched 100,000 nodes per unrestricted/restricted parent search; severe candidates were confirmed at 1,000,000 nodes. Twelve severe decisions were confirmed. Labels described sampled choices only: 23 sampled-clean units, 8 containing severe errors, 14 mixed/insufficient.

The rejected joint path formula failed broad ranking: study-split holdout AUC **0.357**; sampled-clean mean lower-bound score **12.82**, severe-error mean **19.67**. Local one-decision diagnostics separated the engine labels (holdout means **92.21 vs 17.90**, AUC **1.00**), but the same engine family supplied labels and scores. This measures engine-regret sensitivity on inspected positions, not instructional quality or full-repertoire generalization.

Scored chapters and audited decisions did not cover identical scope. Opponent probabilities came from within-study branch occurrences, not Maia or empirical game encounters. Study separation also left 48/424 holdout decision positions seen in development. Generated repairs/blunders/deletions were controls, not additional real studies. No engine v2 benchmark was completed.

Historical scorer SHA-256: `3555aa058c85d6b50b345b027050de3652c35f6b279ebd78c0056dae4a039dbb`. Fields such as `coreHashStillCurrent` in the frozen aggregate refer to that historical run, **not the current documentation scorer**. Obsolete runners and redundant query caches were removed; this aggregate is retained as a concise rejection record, not a reproducible current engine implementation.
