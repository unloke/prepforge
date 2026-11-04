"""Move-only review packets. Deliberately never imports a scorer or its outputs."""
import io
import json
from collections import defaultdict
from pathlib import Path

import chess
import chess.pgn
from convert_preparation import convert, key

BASE = Path(__file__).resolve().parent


def packet(item):
    stream, games = io.StringIO((BASE / 'corpus' / item['file']).read_text(encoding='utf-8-sig')), []
    while (game := chess.pgn.read_game(stream)) is not None:
        if game.errors:
            raise ValueError(game.errors)
        games.append(game)
    nodes, scope = convert(games)
    by_id = {n['id']: n for n in nodes}
    children, occurrences = defaultdict(list), defaultdict(list)
    for n in nodes:
        children[n['parent_id']].append(n)
        occurrences[' '.join(n['fen'].split()[:4])].append(n)

    def path(n):
        moves = []
        while n['parent_id'] is not None:
            moves.append(n['uci'])
            n = by_id[n['parent_id']]
        board, sans = chess.Board(), []
        for uci in reversed(moves):
            move = chess.Move.from_uci(uci)
            sans.append(board.san(move))
            board.push(move)
        return ' '.join(sans)

    chapter_paths = []
    included_starts = {key(chess.Board())}
    included_starts.update(' '.join(n['fen'].split()[:4]) for n in nodes)
    for index, game in enumerate(games, 1):
        board, sans, forks = game.board(), [], []
        current = game
        while current.variations:
            if len(current.variations) > 1:
                forks.append({'after': ' '.join(sans[-10:]),
                              'moves': [board.san(c.move) for c in current.variations]})
            child = current.variations[0]
            sans.append(board.san(child.move))
            board.push(child.move)
            current = child
        if sans:
            chapter_paths.append({'chapter': index, 'included_start': key(game.board()) in included_starts,
                                  'mainline': ' '.join(sans[:24]), 'plies': len(sans),
                                  'end_fen': board.fen(), 'forks': forks[:3]})
    side_packets = []
    for color in ['white', 'black'] if item['color'] == 'both' else [item['color']]:
        own = 'w' if color == 'white' else 'b'
        repeated, frontiers = [], []
        for fen, group in occurrences.items():
            if fen.split()[1] != own:
                continue
            choices = {}
            for n in group:
                kids = children[n['id']]
                preferred = [k for k in kids if k['is_mainline']]
                if preferred:
                    signature = tuple(sorted({k['uci'] for k in preferred}))
                    choices.setdefault(signature, {'path': path(n),
                        'replies': [chess.Board(n['fen']).san(chess.Move.from_uci(m)) for m in signature]})
            if len(choices) > 1:
                repeated.append({'fen': fen, 'arrivals': list(choices.values())[:3]})
            if not any(children[n['id']] for n in group) and not chess.Board(fen + ' 0 1').is_game_over():
                n = min(group, key=lambda n: n['ply'])
                frontiers.append({'path': path(n), 'fen': fen, 'ply': n['ply']})
        repeated.sort(key=lambda r: min(len(a['path'].split()) for a in r['arrivals']))
        frontiers.sort(key=lambda r: (r['ply'], r['path']))
        side_packets.append({'color': color, 'repeated_choices': repeated[:6], 'frontiers': frontiers[:4]})
    return {'id': item['id'], 'scope': scope, 'chapters': chapter_paths, 'sides': side_packets}


if __name__ == '__main__':
    packets = [packet(item) for item in json.loads((BASE / 'corpus/manifest.json').read_text(encoding='utf8'))]
    (BASE / 'facet-review-packets.json').write_text(json.dumps(packets, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(f'{len(packets)} move-only packets; no computed scores or likes read')
