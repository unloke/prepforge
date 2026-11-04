"""Verify and document the acquired corpus, without fetching or altering PGNs."""
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

BASE=Path(__file__).resolve().parent/'corpus'
path=BASE/'manifest.json'
rows=json.loads(path.read_text(encoding='utf8'))
for row in rows:
    raw=(BASE/row['file']).read_bytes()
    assert hashlib.sha256(raw).hexdigest()==row['sha256']
    assert len(raw)==row['bytes']
    row['local_pgn_path']='research/atlas-quality/corpus/'+row['file']
    row['color_provenance']={'method':'reviewer reading of study/chapter scope; not engine-inferred',
        'source_url':row['study_url'],'uncertainty':'Both denotes a mixed-color guide; filter chapters before choosing a repertoire side.' if row['color']=='both' else 'Study attribution and chapter perspective; not independently confirmed with author.'}
    if row['id']=='sEo8o4Rm': row['scope']='Nimzowitsch 1.e4 Nc6 defense; ideas, variations and model games'
    if row['id'] in ['1gqDv9cx','whCVdUeM']:
        row['quality_evidence']['independent_opening_warning']={
            'author':'IM Eric Rosen','title':'The Trappiest Opening in Chess? | Win Quickly with the Stafford Gambit',
            'url':'https://lichess.org/video/nH_fiqlLp2U',
            'fact':'Rosen describes White as objectively better with precise play, while explaining practical traps.',
            'scope_limit':'External expert statement about the opening, not a move-by-move verdict on this export or its teaching quality.'}
    if row['id'] in ['PDVt7Kbh','jtlLwUvh','A4EBp7Ds','UzKIIAtz']:
        row['quality_evidence']['external_comparison']={
            'author':'ProvisionalRating; other forum participants disagree',
            'url':'https://lichess.org/forum/general-chess-discussion/how-much-do-leninperez-studies-matter',
            'fact':'Forum post #3 contrasts these Caro-Kann/French studies and claims one pair is less detailed.',
            'evidence_strength':'unverified community opinion; discovery lead only, not quality ground truth'}

bybytes=defaultdict(list); bytree=defaultdict(list)
for r in rows:
    bybytes[r['sha256']].append(r['id']); bytree[r['move_tree_sha256']].append(r['id'])
dupbytes=[v for v in bybytes.values() if len(v)>1]
duptrees=[v for v in bytree.values() if len(v)>1]
assert not dupbytes and not duptrees, (dupbytes,duptrees)
path.write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
summary={'studies':len(rows),'bytes':sum(r['bytes'] for r in rows),'chapters':sum(r['chapters'] for r in rows),
    'colors':dict(Counter(r['color'] for r in rows)),
    'roles':dict(Counter(r['content_role'] for r in rows)),
    'duplicate_bytes':dupbytes,'duplicate_move_trees':duptrees,
    'parse_errors':{r['id']:r['parse_errors'] for r in rows if r['parse_errors']},
    'raw_comments_preserved':True,'synthetic_variants':0}
(BASE/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf8')
table='\n'.join('| '+ ' | '.join([r['id'],r['title'].replace('|','/'),r['color'],r['content_role'],str(r['chapters']),str(r['measurements']['move_occurrences']),str(r['measurements']['terminal_paths'])])+' |' for r in rows)
doc=f'''# Public Lichess opening-study corpus

{len(rows)} distinct real study exports; {summary['chapters']} chapters; {summary['bytes']:,} bytes.
No synthetic ablations count as studies. Every raw `.pgn` preserves original bytes, including comments.
Eight samples were copied byte-for-byte from prior review acquisitions; others were serial HTTP GETs.
`manifest.json` contains exact source URLs, author attributions, hashes, acquisition provenance,
scope/color/role, chapter lists, legal parse checks, and evidence limitations. `summary.json` gives totals.

## Integrity and use

All hashes and byte lengths were rechecked. No identical byte hashes or identical normalized
chapter-root-and-terminal-move-tree hashes occur. This does not prove genealogical independence:
authors may adapt each other's lines or share opening theory. Each study counts once, irrespective
of chapter count. This is a public English-heavy convenience sample, not a random population sample.
Model-game guides, exercises and opening samplers are explicitly distinguished from repertoires.
For mixed-color samples select the relevant chapters before assessment; do not score both colors as
one player's policy. First-variation order alone is not verified author intent.

Acquisition made one request at a time. HTTP failures are recorded in `acquisition_failures.json`.
The downloader immediately waits at least 60 seconds on HTTP 429 before any next request.
No retry or failed-response body is counted as a PGN. The raw PGNs were not comment-stripped.
Reproduce with `.venv313\\Scripts\\python.exe research\\atlas-quality\\acquire_corpus.py`
and finalize with `.venv313\\Scripts\\python.exe research\\atlas-quality\\acquire_finalize.py`.
The environment has python-chess 1.11.2. Rerunning skips manifest entries already acquired.

## Quality evidence without circular labels

No study is labelled good/bad from its title, length, popularity, author's rating or gambit identity.
`quality_label` stays null because whole-study expert quality has not been adjudicated.
Sampled move-quality labels and evidence are saved in `../evaluate-evidence.json`.
Legal moves and stored mating traps are
observable properties, not proof of soundness, completeness or learning effectiveness.
Source eval annotations are preserved but not independently verified by this acquisition agent.
The offline engine audit supplies diagnostic move-quality evidence.

An independent expert warning is available for the Stafford family: IM Eric Rosen describes
White's advantage with precise defense while teaching practical traps in
[his video description](https://lichess.org/video/nH_fiqlLp2U). This distinguishes objective
opening soundness from instructional quality; his trap study can teach its stated purpose well.
The Jerome study's own warning is an author claim, not independent validation.

The [comparison forum](https://lichess.org/forum/general-chess-discussion/how-much-do-leninperez-studies-matter)
supplied matched Caro-Kann and French pairs. Its claims of differing detail are disputed community
opinion, not accepted good/bad ground truth. This motivates inspecting actual moves and coverage
rather than inheriting popularity or author-status judgments.

## Inventory

| Study ID | Exported title | Side | Content role | Chapters | Move occurrences | Terminal paths |
|---|---|---|---|---:|---:|---:|
{table}
'''
(BASE/'README.md').write_text(doc,encoding='utf8')
print(json.dumps(summary,indent=2))
