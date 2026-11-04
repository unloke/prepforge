"""Reproducible chapter samples for manual move-content review; no note scoring."""
import io
import json
from pathlib import Path

import chess.pgn

BASE = Path(__file__).resolve().parent


def inspect(item):
    stream = io.StringIO((BASE / 'corpus' / item['file']).read_text(encoding='utf-8-sig'))
    chapters = []
    while (game := chess.pgn.read_game(stream)) is not None:
        if game.errors:
            raise ValueError(game.errors)
        stack, forks, nodes, endings = [(game, 0)], 0, 0, []
        while stack:
            node, depth = stack.pop()
            nodes += 1
            forks += len(node.variations) > 1
            if not node.variations:
                endings.append(depth)
            stack.extend((child, depth + 1) for child in node.variations)
        board = game.board()
        path, first_fork = [], None
        current = game
        while current.variations:
            if len(current.variations) > 1 and first_fork is None:
                first_fork = {'after': ' '.join(path),
                              'options': [board.san(c.move) for c in current.variations]}
            child = current.variations[0]
            path.append(board.san(child.move))
            board.push(child.move)
            current = child
        chapters.append({'chapter': len(chapters) + 1, 'title': game.headers.get('ChapterName', game.headers.get('Event', '')),
                         'start': game.board().fen(), 'moves': nodes - 1, 'forks': forks,
                         'leaves': len(endings), 'max_plies': max(endings),
                         'mainline': ' '.join(path[:24]), 'mainline_plies': len(path),
                         'first_mainline_fork': first_fork,
                         'endpoint': board.fen(), 'checkmate': board.is_checkmate()})
    nonempty = [c for c in chapters if c['moves']]
    selected = {c['chapter'] for c in nonempty[:1]}
    if nonempty:
        selected.add(max(nonempty, key=lambda c: (c['forks'], c['moves']))['chapter'])
        selected.add(min(nonempty, key=lambda c: (c['moves'], c['chapter']))['chapter'])
    return {'id': item['id'], 'title': item['title'], 'role': item['content_role'],
            'chapters': len(chapters), 'nonempty': len(nonempty),
            'sample_rule': 'first nonempty, most branching, shortest nonempty chapter; overlaps collapsed',
            'samples': [c for c in chapters if c['chapter'] in selected]}


if __name__ == '__main__':
    rows = [inspect(item) for item in json.loads((BASE / 'corpus/manifest.json').read_text(encoding='utf8'))]
    (BASE / 'content-review-samples.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    for r in rows:
        print(r['id'], r['role'], f"{r['nonempty']}/{r['chapters']} chapters")
        for c in r['samples']:
            print(f"  #{c['chapter']} {c['title']} | {c['moves']} moves/{c['forks']} forks | {c['mainline']}")
            print('   ', c['first_mainline_fork'])
