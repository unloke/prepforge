"""Hand-counted legal chess fixtures; opt-in research tests, no application imports."""
import io
import unittest

import chess
import chess.pgn

from move_graph_audit import audit, chapters_from_games, invariance, key


def games(text):
    stream, result = io.StringIO(text), []
    while (game := chess.pgn.read_game(stream)) is not None:
        assert not game.errors
        result.append(game)
    return result


class MoveGraphAuditTests(unittest.TestCase):
    def test_hand_counted_line_and_exact_example(self):
        result = audit(chapters_from_games(games("1. e4 e5 *")), "white")
        graph = result["graph"]
        self.assertEqual((graph["active_unique_positions"], graph["unique_edges"]), (3, 2))
        side = graph["by_side"]["white"]
        self.assertEqual(side["own_turn_distinct_choice_histogram"], {0: 1, 1: 1})
        self.assertEqual(side["own_decision_positions_with_stored_choices"], 1)
        self.assertEqual(side["nonterminal_own_to_move_leaves"], 1)
        example = side["examples"][0]
        self.assertEqual(example["san_path"], ["e4", "e5"])
        board = chess.Board(example["start_fen"])
        for san in example["san_path"]:
            board.push_san(san)
        self.assertEqual(key(board), example["end_position"])

    def test_diagrams_have_no_routes_or_decisions(self):
        source = games('[Event "Diagram"]\n\n{Only explanatory prose} *')
        result = audit(chapters_from_games(source), "both")
        self.assertEqual(result["graph"]["unique_positions_including_diagrams"], 1)
        self.assertEqual(result["graph"]["active_unique_positions"], 0)
        self.assertEqual(result["graph"]["graph_terminal_positions"], 0)
        self.assertEqual(result["graph"]["active_chapter_root_keys"], [])
        for side in result["graph"]["by_side"].values():
            self.assertEqual(side["own_decision_positions_with_stored_choices"], 0)
            self.assertEqual(side["nonterminal_own_to_move_leaves"], 0)
        self.assertTrue(all(invariance(source, "both", result).values()))

    def test_transposition_unions_continuations_and_removes_false_leaf(self):
        # Two four-ply move orders reach the same board; only one chapter
        # continues Bg2. Hand count: 9 positions, 9 edges, one merged endpoint.
        source = games('[Event "A"]\n\n1. Nf3 Nf6 2. g3 g6 3. Bg2 *\n\n'
                       '[Event "B"]\n\n1. g3 g6 2. Nf3 Nf6 *')
        result = audit(chapters_from_games(source), "both")
        graph = result["graph"]
        self.assertEqual((graph["active_unique_positions"], graph["unique_edges"]), (9, 9))
        self.assertEqual(graph["positions_with_multiple_distinct_incoming_parents"], 1)
        self.assertEqual(graph["graph_terminal_positions"], 1)
        self.assertEqual(graph["by_side"]["white"]["nonterminal_own_to_move_leaves"], 0)
        self.assertEqual(graph["by_side"]["white"]["own_turn_distinct_choice_histogram"], {1: 3, 2: 1})
        self.assertEqual(graph["by_side"]["black"]["own_turn_distinct_choice_histogram"], {0: 1, 1: 4})
        self.assertTrue(all(invariance(source, "both", result).values()))

    def test_duplicate_chapters_change_occurrences_only(self):
        chapters = chapters_from_games(games("1. e4 e5 *"))
        single, duplicate = audit(chapters, "white"), audit(chapters * 2, "white")
        self.assertEqual(single["graph"], duplicate["graph"])
        self.assertEqual(duplicate["occurrences"]["position_occurrences_including_roots"], 6)
        self.assertEqual(duplicate["occurrences"]["merged_position_occurrence_savings"], 3)
        self.assertEqual(duplicate["occurrences"]["move_edge_occurrences"], 4)
        self.assertEqual(duplicate["occurrences"]["merged_edge_occurrence_savings"], 2)

    def test_identity_retains_legality_but_ignores_counters(self):
        a = chess.Board("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1")
        b = chess.Board("4k3/8/8/3pP3/8/8/8/4K3 w - - 70 40")
        self.assertNotEqual(key(a), key(b))  # legal EP changes the graph
        a = chess.Board("4k3/8/8/3p4/8/8/8/4K3 w - d6 0 1")
        b = chess.Board("4k3/8/8/3p4/8/8/8/4K3 w - - 70 40")
        self.assertEqual(key(a), key(b))  # irrelevant EP and clocks do not
        a = chess.Board("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        b = chess.Board("r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1")
        self.assertNotEqual(key(a), key(b))

    def test_game_ending_mate_is_not_unanswered(self):
        result = audit(chapters_from_games(games("1. f3 e5 2. g4 Qh4# *")), "white")
        self.assertEqual(result["graph"]["graph_terminal_positions"], 1)
        self.assertEqual(result["graph"]["by_side"]["white"]["nonterminal_own_to_move_leaves"], 0)

    def test_disconnected_custom_start_and_relative_depth(self):
        source = games('[Event "A"]\n\n1. e4 e5 *\n\n'
                       '[Event "B"]\n[SetUp "1"]\n'
                       '[FEN "4k3/8/8/8/8/8/8/4K3 w - - 80 99"]\n\n99. Kf2 *')
        result = audit(chapters_from_games(source), "white")
        graph = result["graph"]
        self.assertEqual(graph["active_unique_positions"], 5)
        self.assertEqual(len(graph["custom_start_keys"]), 1)
        self.assertEqual(len(graph["weak_root_connectivity_groups"]), 2)
        self.assertEqual(graph["active_positions_unreachable_from_standard"], 2)
        self.assertEqual(result["occurrences"]["chapter_terminal_relative_ply"]["histogram"], {1: 1, 2: 1})


if __name__ == "__main__":
    unittest.main()
