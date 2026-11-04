"""Small monotone fits; leave entire frozen opening families out for validation."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import lsq_linear

BASE = Path(__file__).resolve().parent
LABEL_HASH = '187b56f83b62f52062a29a8a280e33db33089bf710145e62cdcdb965d0a4907a'
FEATURES = {
    'replies': ['supportedBreadth', 'adequacy'],
    'reach': ['supportedBreadth', 'routeBreadth', 'adequacy'],
    'depth': ['completion', 'handover'],
    'moveOrders': ['coherence', 'repeatedAgreement', 'pawnReuse'],
    'ease': ['quiet', 'planReuse', 'coherence'],
    'overall': ['supportedBreadth', 'adequacy'],
}


def fit(x, y, zero=False):
    # Fixed small regularization, no search over held-out families. Positive
    # slopes keep more observed preparation from reducing preparation facets.
    penalty = np.eye(x.shape[1]) * np.sqrt(0.05)
    penalty[0, 0] = 0
    lower, upper = np.r_[-1., np.zeros(x.shape[1]-1)], np.ones(x.shape[1])*2
    if zero: lower[0], upper[0] = -1e-15, 1e-15
    return lsq_linear(np.vstack([x, penalty]), np.r_[y, np.zeros(x.shape[1])], bounds=(lower, upper)).x


def metrics(y, p):
    available = np.isfinite(p)
    y, p = y[available], p[available]
    pairs = [(i, j) for i in range(len(y)) for j in range(i) if abs(y[i]-y[j]) >= 0.1-1e-8]
    return {'n': len(y), 'mae': float(np.mean(abs(y-p))*100),
            'ranking': float(np.mean([np.sign(y[i]-y[j]) == np.sign(p[i]-p[j]) for i,j in pairs]))}


def main():
    raw = (BASE/'facet-judgments.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == LABEL_HASH, 'Frozen judgments changed'
    judgments = json.loads(raw)['reviews']
    extracted = json.loads((BASE/'facet-features.json').read_text(encoding='utf8'))
    assert extracted['judgments_sha256'] == LABEL_HASH
    features = {(r['id'],r['color']): r for r in extracted['rows']}
    baseline = json.loads((BASE/'facet-baseline.json').read_text(encoding='utf8'))
    old = {(s['study_id'],r['color']): r for s in baseline['studies'] for r in s['reports']}
    groups = np.array([r['family'] for r in judgments])
    report, models = {}, {}
    for index, (facet, names) in enumerate(FEATURES.items()):
        x = np.array([[1]+[features[r['id'],r['color']]['features'][n] for n in names] for r in judgments])
        y = np.array([r['overall'] if facet=='overall' else r['scores'][index] for r in judgments])/100
        zero = facet not in ['moveOrders','ease']
        coef = fit(x, y, zero)
        predictions = np.clip(x @ coef,0,1)
        oof = np.zeros(len(y))
        fold_models = {}
        for group in sorted(set(groups)):
            test = groups==group
            c = fit(x[~test],y[~test],zero)
            oof[test] = np.clip(x[test] @ c,0,1)
            fold_models[group] = c.tolist()
        b = []
        for r in judgments:
            row = old[r['id'],r['color']]
            value = row['score'] if facet=='overall' else next(f['value'] for f in row['facets'] if f['key']==facet)
            b.append(np.nan if value is None else value/100)
        b = np.array(b)
        report[facet] = {'features':names, 'baseline':metrics(y,b), 'training':metrics(y,predictions),
            'family_holdout':metrics(y,oof), 'family_holdout_same_available':metrics(y[np.isfinite(b)],oof[np.isfinite(b)]),
            'fold_coefficients':fold_models,
            'rows':[{'id':r['id'],'color':r['color'],'family':r['family'], 'judgment':float(t*100),
                     'baseline':None if not np.isfinite(bb) else float(bb*100),
                     'fitted':float(p*100),'held_out':float(o*100)}
                    for r,t,bb,p,o in zip(judgments,y,b,predictions,oof)]}
        models[facet] = dict(zip(['intercept']+names,(coef*100).tolist()))
        print(f"{facet:12} baseline {report[facet]['baseline']['mae']:.1f} ({report[facet]['baseline']['n']}) -> family holdout {report[facet]['family_holdout']['mae']:.1f}; rank {report[facet]['family_holdout']['ranking']:.3f}; {models[facet]}")
    output = {'judgments_sha256':LABEL_HASH,'method':'Nonnegative slopes, fixed ridge 0.05, leave-one-opening-family-out. Single rater, previously exposed to outputs; exploratory model selection is not nested validation. Mixed-family overlap remains.',
              'models':models,'metrics':report}
    (BASE/'facet-fit-results.json').write_bytes((json.dumps(output,indent=2)+'\n').encode())
    lines = ['# Facet validation', '',
             'Targets were committed at c3554909 before candidate extraction/fitting. Frozen label SHA256: `' + LABEL_HASH + '`.', '',
             'Single Codex rater, previously exposed to scores. Sampled move inspection, about ±10-point target uncertainty. Leave-one-family-out evaluation covers nine groups; model/feature choices used these results, so this is exploratory development validation, not an untouched test set. Mixed studies overlap named opening families.', '',
             '| Metric | Previous MAE | Family-held-out MAE (same available rows) | Previous ranking | Held-out ranking (same rows) |',
             '| --- | ---: | ---: | ---: | ---: |']
    for facet, result in report.items():
        b, o = result['baseline'], result['family_holdout_same_available']
        lines.append(f"| {facet} | {b['mae']:.1f} | {o['mae']:.1f} | {b['ranking']:.1%} | {o['ranking']:.1%} |")
    lines += ['', 'MAE uses a 100-point scale. Ranking compares pairs whose judgments differ by at least 10 points, counts ties as incorrect, and is descriptive. Previous Consistency had 42 measured rows; all other comparisons have 45. The new Consistency model supplies 45 estimates; its all-row results are in the JSON report.', '',
              '## Largest remaining held-out errors', '']
    for facet, result in report.items():
        worst = sorted(result['rows'],key=lambda r:-abs(r['held_out']-r['judgment']))[:3]
        lines.append('- ' + facet + ': ' + '; '.join(f"{r['id']}/{r['color']} target {r['judgment']:.0f}, held-out {r['held_out']:.0f}" for r in worst) + '.')
    lines += ['', '## Every reviewed side', '',
              'Cells are **judgment / shipped fit / family-held-out prediction**. The shipped fit uses all development labels. Consult facet-judgments.json for five separate move-content rationales for every row.', '',
              '| Study / side | Replies | Reach | Depth | Consistency | Ease | Preparation |',
              '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for i, review in enumerate(judgments):
        cells = []
        for result in report.values():
            row = result['rows'][i]
            cells.append(f"{row['judgment']:.0f} / {row['fitted']:.0f} / {row['held_out']:.0f}")
        lines.append(f"| [{review['id']}](https://lichess.org/study/{review['id']}) / {review['color']} | " + ' | '.join(cells) + ' |')
    (BASE/'facet-validation.md').write_bytes(('\n'.join(lines)+'\n').encode())
    if '--write-model' in sys.argv:
        rounded = {key:{n:round(c,6) for n,c in values.items()} for key,values in models.items()}
        source = ('// Generated by research/atlas-quality/fit-facets.py --write-model.\n'
                  f'// Frozen qualitative judgments SHA256: {LABEL_HASH}\n'
                  '// Scores approximate one reviewer; they are not chess evaluations.\n'
                  'export const ATLAS_CALIBRATION = ' + json.dumps(rounded,indent=2) + ';\n\n'
                  'export function calibratedAtlasValue(key, features) {\n'
                  '  const { intercept, ...weights } = ATLAS_CALIBRATION[key];\n'
                  '  const value = Object.entries(weights).reduce((sum, [name, weight]) =>\n'
                  '    sum + features[name] * weight, intercept);\n'
                  '  return Math.max(0, Math.min(100, value));\n}\n')
        (BASE.parents[1]/'web-src/atlas-calibration.js').write_bytes(source.encode())


if __name__=='__main__': main()
