# Atlas documentation research

Repertoire quality depends on clear organization, explanations and learning routes. Stored mistakes can be demonstrations or wrong-answer feedback. High likes are plausible positive-unlabeled evidence; **low/missing likes are unknown**, never a negative label. Direct content reviews supply the manual judgments; neither engines nor annotation totals determine them.

Start with the **[38-study catalog](catalog.md)**: source/title, corpus role, saved likes, manual clarity, Documentation score and exact review links. [Review A](review-a.md), [B](review-b.md) and [C](review-c.md) identify concrete chapters/comments. [Manual classifications](manual-review-labels.json) retain role, explicitly stated confidence and evidence headings. Null confidence means not explicitly specified. These are subjective, role-dependent readings of inspected material, not exhaustive certification.

The four production signals measure **documentation presence**. They are not a validated overall quality predictor. No weights were fitted to likes or manual labels. The quality-ranking goal remains unmet.

## Final results

The actual atlasClarity core evaluated **38 distinct saved studies**, **105 merged root scopes**, **86,108 nodes**, with zero PGN parse errors or scorer failures. Core SHA-256: `8de9b88e47ee41955e90629b422b13cbf70598d127488fae23753d3c01068ff9`. The final offline evaluation took **6.287 seconds**, including research forest aggregation; this is not browser latency. [Exact results](clarity-results.json) preserve numerators, denominators, root outputs and hashes.

| Manual instructional clarity | Studies | Mean Documentation /100 |
| --- | ---: | ---: |
| High | 14 | 46.39 |
| Medium | 20 | 55.56 |
| Low | 4 | 26.86 |

High-versus-low AUC is **0.732**; ordinal Spearman correlation across all 38 is **0.045**. Medium-rated content scores above high-rated content on average. Four low-rated studies yield only 56 high/low pairs, not 56 independent observations. These selected, subjective cohorts do **not** establish a general quality ranking. The corpus informed design: there is no untouched holdout or calibrated quality probability. Extra decimal places reflect arithmetic, not confidence.

Concrete false positive: **2MMWpcNI scores 92.36**, despite review B identifying confused opening/color explanations and unsupported rating tiers in its beginner sampler. **PDVt7Kbh scores 40.63**, despite review C finding thematic explanations and clear warnings about purpose. Presence cannot distinguish misleading/promotional prose from good teaching. Companion notes FwXo3Qhq score 6.91 despite high clarity within their limited role. Long courses can have many unannotated endpoints and score below short samplers; do not turn this into an author-quality verdict.

## Four documentation signals

| Facet | Numerator / denominator |
| --- | --- |
| Decision notes | Own positions with local or selected-child prose / inspected own decision positions |
| Fork signposts | Forks with prose/descriptive tags on every enabled child / inspected forks |
| Endpoint notes | Enabled leaves with local prose / enabled leaves |
| Starting notes | Roots with local prose or repertoire notes / inspected roots |

Score is the equal mean of applicable percentages; empty scopes return null. The core strips engine directives, URLs, move notation and numeric annotations before detecting letters. This measures note presence, **not meaning, accuracy, audience suitability or author intent**. First mainline/child supplies context when prepared markers are absent; it does not identify an author recommendation. PGN headings are not injected as notes.

Conversion merges equal canonical-FEN roots and same-parent UCI branches across chapters, unions comments, preserves variation-start comments and NAG integers, and retains first-source mainline order. Explanations may thereby combine across chapters; raw PGNs and manual reviews remain authoritative for actual navigation/context. NAGs and headings do not become descriptive tags.

The core supports one root. Results retain exact core output per merged root/side. The **research study rollup** unions canonical positions across scopes/sides, requiring every repeated context to pass, and applies the same four-facet mean. Local parent/child calls use the actual core for decision/fork judgments; only real leaves/roots contribute endpoint/starting judgments. This is explicitly forest aggregation, not a production multi-root call. Both-side studies remain one study in comparisons.

## Validation and limits

The verifier checks all source hashes, manifest/scorer/producer/evaluator/review hashes, facet arithmetic, catalog coverage and evidence headings. Evaluation asserts zero parse errors and unchanged core hash during the run. Two converter tests check duplicate-chapter invariance, stable mainline, preserved start/after comments and NAGs, and no title-to-note leakage.

Merged duplicates cannot add weight. **Generic prose on every node can inflate the proxy; deleting poorly documented branches can raise ratios while removing useful material.** Semantic gaming resistance and deletion monotonicity are not established. Retain denominators and inspect passages. Future validation should use new independently reviewed, role-matched studies, with predefined generic-prose, misleading-explanation, omitted-branch and useful-wrong-answer controls. Those tests are proposals, not completed validation.

## Reproduce offline

From repository root, with the existing python-chess environment and Node dependencies:

```powershell
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/clarity-inputs.py
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/clarity-inputs.test.py
node research/atlas-quality/clarity-evaluate.mjs
node research/atlas-quality/clarity-verify.mjs
```

The producer writes the approximately 29 MB tree to ignored `tmp/atlas-clarity-inputs.json`; **do not commit it**. Retain original PGNs, manifest, reception metadata, reviews, compact results and scripts. Evaluation makes no network or engine calls.

The engine path-score experiment failed broad ranking and targeted the wrong construct. Only its concise [rejection record](rejected-engine-findings.md) and frozen [aggregate](evaluate-summary.json) remain; obsolete runners and redundant query caches were removed. Historical aggregate validity flags refer to that old run, not the current scorer.
