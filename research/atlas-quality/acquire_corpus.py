"""Serial public Lichess PGN acquisition. Raw bytes never rewritten after saving.

Run with repository .venv313 Python. HTTP 429 immediately waits >=60 seconds
before any next request. Existing downloads are reused, not fetched again.
"""
import argparse
import hashlib
import io
import json
import shutil
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import chess.pgn

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / 'corpus'
OUT.mkdir(parents=True, exist_ok=True)
MANIFEST = OUT / 'manifest.json'
SEEDS = {
 '2EaSmZtz':('white','focused London system','repertoire'),
 'artuehhC':('white','focused London system; exercises','repertoire-and-exercises'),
 'D8QPC8Zr':('white','multi-defense gambit repertoire','repertoire'),
 'ACmyH8gC':('white',"King's Gambit accepted and declined",'repertoire-and-model-games'),
 'NGpnogsw':('black','Sicilian Dragon; partial defense repertoire','repertoire-and-model-games'),
 '8Uztu7Xx':('black','Caro-Kann multi-system theory','repertoire-and-model-games'),
 '8c8bmUfy':('black','Sicilian multiple variations','opening-guide'),
 'fTpa2qZW':('white','English repertoire','repertoire'),
 'CfSYkcMp':('white','three alternative anti-Caro-Kann repertoires','repertoire'),
 'yteYURRC':('black','Caro-Kann repertoire via examples','repertoire-and-model-games'),
 'vPqdbuqZ':('black','Hippopotamus system','repertoire-and-model-games'),
 '2XxhfIAJ':('both','broad personal repertoire; white and black chapters','repertoire'),
 'oBsew7N6':('both','multiple opening systems','opening-guide'),
 'u7UE6wUm':('white','Scotch Gambit','repertoire'),
 'tfgIsHyW':('white','Danish Gambit','repertoire'),
 'tU7Nq5nE':('white','Alien and Martian Gambits','repertoire'),
 '7Q7fYg9h':('black','Modern Scandinavian','repertoire'),
 'R0uFV8bD':('white','Lemur and Staunton Gambits','repertoire'),
 '0hjkNe91':('black','Hartlaub-Charlick Gambit','repertoire'),
 'Pn20fv0N':('white','Polish opening','repertoire'),
 'rZyGzD67':('white','anti-QGD Queen Attack','repertoire'),
 'ztgulNGx':('black','responses to Ruy Lopez and Italian','repertoire'),
 'AKbQXhWw':('white','broad personal d4/c4 repertoire','repertoire'),
 '2MMWpcNI':('both','beginner-to-advanced opening sampler','opening-guide'),
 'sEo8o4Rm':('black','defense to e4; scope to verify from PGN','opening-guide'),
 'GNlZ2WKx':('white','London model games and ideas','repertoire-and-model-games'),
 'KjivNw7F':('white','London ideas','opening-guide'),
 '1gqDv9cx':('black','Stafford accepted/declined; refutations and traps','repertoire-and-traps'),
 '8eyxyvBh':('white','Jerome Gambit with exercises','repertoire-and-exercises'),
 'dgUQNQ2B':('black','d4 Nf6; Nimzo/QGD and d4 sidelines','repertoire'),
 'whCVdUeM':('black','Stafford traps demonstrated by IM Eric Rosen','repertoire-and-traps'),
 'OnPMlzHT':('black','Petrov defense variation guide','repertoire'),
 'PDVt7Kbh':('black','Caro-Kann variation guide; comparative forum discovery','repertoire'),
 'jtlLwUvh':('black','Caro-Kann variation guide; comparative forum discovery','repertoire'),
 'A4EBp7Ds':('black','French defense variation guide; comparative forum discovery','repertoire'),
 'UzKIIAtz':('black','French defense variation guide; comparative forum discovery','repertoire'),
 'bbxmDYZV':('both','opening selection sampler by claimed audience level','opening-guide'),
 'nRiq9SZx':('black','Pirc/Czech system against e4 d4 and flank openings','repertoire-and-model-games'),
 'HHZpRszr':('both','broad beginner opening sampler','opening-guide'),
 'bmWAylqe':('both','d4 White repertoire plus Black defense choices','repertoire'),
 'nYAJ7Km3':('black','Pirc six attacking systems','repertoire'),
 'Ama1NsNR':('white','responses to Scandinavian branches; unfinished chapter','repertoire'),
 'FwXo3Qhq':('black','Pirc multiple systems based on Ramirez videos','repertoire-and-traps'),
 'LLNDy032':('white','French-language 1500 audience e4 multi-defense repertoire','repertoire'),
 'e01yoGqe':('both','punishing weak opening moves; tactical counterexamples','repertoire-and-traps'),
}

def now():
    return datetime.now(timezone.utc).isoformat()

def inspect(path, sid, meta, acquisition):
    raw=path.read_bytes()
    stream=io.StringIO(raw.decode('utf-8-sig'))
    headers=[]; errors=[]; chapters=[]; nodes=leaves=forks=evals=comments=0
    signatures=[]; mate_endings=0; root_comments=[]
    while (game:=chess.pgn.read_game(stream)) is not None:
        headers.append(dict(game.headers)); errors.extend(map(str,game.errors))
        chapter_nodes=chapter_leaves=0
        if game.comment: root_comments.append(game.comment)
        stack=[(game, ())]; paths=[]
        while stack:
            node, route=stack.pop()
            comments+=bool(node.comment); evals+=node.comment.count('[%eval')
            if node.move:
                nodes+=1; chapter_nodes+=1
                if not node.variations:
                    leaves+=1; chapter_leaves+=1
                    mate_endings+=node.board().is_checkmate()
                    paths.append(' '.join(route))
            forks+=len(node.variations)>1
            for child in node.variations:
                stack.append((child,route+(child.move.uci(),)))
        signatures.append((' '.join(game.board().fen().split()[:4]),sorted(paths)))
        chapters.append({'name':game.headers.get('ChapterName',game.headers.get('Event')),
                         'url':game.headers.get('ChapterURL'),'nodes':chapter_nodes,
                         'leaves':chapter_leaves,'custom_fen':game.headers.get('SetUp')=='1'})
    if not headers or not nodes:
        raise ValueError('Not a nonempty opening study PGN')
    color,scope,role=meta
    return {'study_id':sid,'id':sid,'title':headers[0].get('StudyName',headers[0].get('Event')),
      'study_url':f'https://lichess.org/study/{sid}',
      'export_url':f'https://lichess.org/api/study/{sid}.pgn',
      'file':f'{sid}.pgn','sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),
      'move_tree_sha256':hashlib.sha256(json.dumps(sorted(signatures),sort_keys=True).encode()).hexdigest(),
      'authors_export_attribution':sorted(set(h.get('Annotator','') for h in headers)),
      'color':color,'scope':scope,'content_role':role,
      'classification_basis':'Reviewer scope assignment from source discovery and exported chapter list; not a quality label.',
      'acquisition':acquisition,'chapters':len(headers),'chapter_details':chapters,
      'measurements':{'move_occurrences':nodes,'terminal_paths':leaves,'forks':forks,
                      'comments':comments,'eval_annotations':evals,'checkmate_endings':mate_endings},
      'parse_errors':errors,
      'quality_label':None,
      'quality_evidence':{'independent_engine_or_expert_assessment':'not performed by acquisition agent',
        'structural_checks':{'parsed_without_errors':not errors,'contains_legal_mate_endings':mate_endings},
        'limitations':'Legality, size, title, likes, gambit identity and mate traps do not establish good/bad repertoire quality. Eval comments are unverified source annotations, not independent engine results.'},
      'source_root_comments':root_comments}

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('ids',nargs='*')
    args=parser.parse_args()
    existing=json.loads(MANIFEST.read_text(encoding='utf8')) if MANIFEST.exists() else []
    entries={r['study_id']:r for r in existing}
    failures_path=OUT/'acquisition_failures.json'
    failures=json.loads(failures_path.read_text(encoding='utf8')) if failures_path.exists() else []
    for sid in args.ids or SEEDS:
        if sid in entries: continue
        meta=SEEDS.get(sid,('unknown','opening scope pending PGN review','opening-guide'))
        dest=OUT/f'{sid}.pgn'
        originals=[ROOT/'runs/literature-review/1A/raw'/f'{sid}.pgn',ROOT/'runs/literature-review/2B'/f'{sid}.pgn']
        try:
            source=next((p for p in originals if p.exists()),None)
            if source:
                shutil.copyfile(source,dest)
                acquisition={'method':'exact local byte copy','source_path':str(source.relative_to(ROOT)),
                  'copied_at_utc':now(),'original_file_write_utc':datetime.fromtimestamp(source.stat().st_mtime,timezone.utc).isoformat()}
            else:
                if dest.exists():
                    acquisition={'method':'reuse previously saved download','reused_at_utc':now()}
                else:
                    req=urllib.request.Request(f'https://lichess.org/api/study/{sid}.pgn',headers={'User-Agent':'PrepForge-research/1.0','Accept':'application/x-chess-pgn'})
                    try:
                        with urllib.request.urlopen(req,timeout=45) as resp:
                            raw=resp.read(); status=resp.status; response_headers=dict(resp.headers)
                        if not raw.lstrip().startswith(b'[Event '): raise ValueError('Response is not PGN')
                        dest.write_bytes(raw)
                        acquisition={'method':'serial unauthenticated HTTP GET','http_status':status,'fetched_at_utc':now(),'response_headers':response_headers}
                    except urllib.error.HTTPError as exc:
                        if exc.code==429:
                            print(f'{sid}: HTTP 429, immediate cooldown >=60s',flush=True)
                            time.sleep(max(60,int(exc.headers.get('Retry-After','60')) if exc.headers.get('Retry-After','60').isdigit() else 60))
                        raise
            entries[sid]=inspect(dest,sid,meta,acquisition)
            MANIFEST.write_text(json.dumps(list(entries.values()),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
            print(f'{len(entries)} saved: {sid} {entries[sid]["title"]} ({entries[sid]["chapters"]} chapters)',flush=True)
        except Exception as exc:
            failures.append({'study_id':sid,'at_utc':now(),'error':str(exc)})
            failures_path.write_text(json.dumps(failures,indent=2)+'\n',encoding='utf8')
            print(f'FAILED {sid}: {exc}',flush=True)
        time.sleep(1)

if __name__=='__main__': main()
