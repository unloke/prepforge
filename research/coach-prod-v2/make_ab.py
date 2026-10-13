"""Blind A/B of the production coach before/after this change, for coach-ab-review.

  py research/coach-prod-v2/make_ab.py
  node research/coach-ab-review/serve.mjs research/coach-prod-v2/ab --port 5205

Pairs: every position whose prose changed, minus the 40 the user already reviewed in
coach-v7, up to 30. Order and A/B side come from os.urandom; the key is sealed in
ab/run-output/BLIND-KEY.json.
"""
import hashlib
import json
import os
import pathlib
import random

HERE = pathlib.Path(__file__).parent
SEEN = set(json.loads((HERE / '../sft/experiment/coach-v7-20261012/sample.json').read_text(encoding='utf-8')))


def rows(name):
    return {r['id']: r for r in map(json.loads, (HERE / name).read_text(encoding='utf-8').splitlines())}


old, new = rows('before.jsonl'), rows('after.jsonl')
changed = [i for i in old if old[i]['prose'] != new[i]['prose'] and i not in SEEN]
seed = int.from_bytes(os.urandom(16), 'big')
rng = random.Random(seed)
statics = [i for i in changed if 'mate' not in new[i]['prose']]
picked = statics + rng.sample([i for i in changed if i not in statics], 30 - len(statics))
rng.shuffle(picked)


def answer(text):
    return {'response': text, 'finish': {'finished': True}, 'content_sha256': hashlib.sha256(text.encode()).hexdigest()}


out, key = [], {}
for n, i in enumerate(picked, 1):
    r, pid = new[i], f'pair-{n:03d}'
    a, b = ('before', 'after') if rng.random() < 0.5 else ('after', 'before')
    text = {'before': old[i]['prose'], 'after': new[i]['prose']}
    out.append({
        'pair_id': pid,
        'prompt': f"{r['san']} ({r['code']}), {r['mover']}, move {r['moveNumber']}.",
        'facts': {'fen_before': r['fen'], 'fen_after': r['fenAfter'], 'side': r['mover'], 'move_number': r['moveNumber'],
                  'played_uci': r['uci'], 'played_san': r['san'], 'best_uci': r['bestUci'], 'best_san': r['bestSan'],
                  'is_best': r['isBest'], 'grade': r['code']},
        'A': answer(text[a]), 'B': answer(text[b]),
    })
    key[pid] = {'id': i, 'A': a, 'B': b}

dst = HERE / 'ab/run-output'
dst.mkdir(parents=True, exist_ok=True)
(dst / 'BLINDED.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in out), encoding='utf-8')
(dst / 'BLIND-KEY.json').write_text(json.dumps({'seed_hex': f'{seed:032x}', 'pairs': key}, indent=2) + '\n', encoding='utf-8')
print(len(changed), 'changed unseen;', len(out), 'pairs;', len(statics), 'static-cost')
