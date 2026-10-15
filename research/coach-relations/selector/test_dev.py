"""Focused counter checks; no engine or corpus writes."""
import unittest
from unittest.mock import patch

import chess
import dev


class DevelopmentCounts(unittest.TestCase):
    def test_round_trip_is_same_man_and_within_four_plies(self):
        _, cs, es = dev.counts(chess.STARTING_FEN, ["g1f3", "g8f6", "f3g1", "f6g8"])
        self.assertEqual([e["kind"] for e in es], ["round_trip", "round_trip"])
        self.assertEqual(cs["white"]["undeveloped"], 4)
        _, _, es = dev.counts(chess.STARTING_FEN, ["g1f3", "g8f6", "e2e4", "e7e5", "f1c4", "b8c6", "f3g1"])
        self.assertNotIn("round_trip", [e["kind"] for e in es])

    def test_cheaper_attack_retreat_can_overlap_round_trip(self):
        _, cs, es = dev.counts(chess.STARTING_FEN, ["g1f3", "e7e5", "f3e5", "d7d6", "e5f3"])
        self.assertEqual([e["kind"] for e in es], ["round_trip", "retreat"])
        self.assertEqual(cs["white"]["wasted"], 2)

    def test_queen_window_is_game_plies_not_line_plies(self):
        prefix = ["e2e4", "e7e5", "d1h5", "b8c6"]
        _, _, es = dev.counts(chess.STARTING_FEN, ["h5f3", "g8f6"], prefix)
        self.assertEqual(sum(e["kind"] == "extra_queen" and e["in_line"] for e in es), 1)
        fen = "rnbqkbnr/pppp1ppp/8/4p3/4P2Q/8/PPPP1PPP/RNB1KBNR w KQkq - 0 7"
        _, _, es = dev.counts(fen, ["h4h5", "g8f6", "h5f3"])
        self.assertNotIn("extra_queen", [e["kind"] for e in es])

    def test_castled_king_is_not_lost_castling(self):
        fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
        _, cs, _ = dev.counts(fen, ["e1f1", "e8g8"])
        self.assertEqual(cs["white"]["lost_castling"], 1)
        self.assertEqual(cs["black"]["lost_castling"], 0)

    def test_history_boundary_catches_return_and_preserves_castling(self):
        seq = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1", "f8c5", "f1e1", "d7d6", "e1f1"]
        _, cs, es = dev.counts(chess.STARTING_FEN, seq[10:], seq[:10])
        self.assertEqual(cs["white"]["lost_castling"], 0)
        self.assertTrue(any(e["kind"] == "round_trip" and e["in_line"] for e in es))

    def test_illegal_pv_fails_instead_of_silently_truncating(self):
        with self.assertRaises(ValueError):
            dev.counts(chess.STARTING_FEN, ["e2e5"])

    def test_castling_event_distinguishes_castling_from_losing_rights(self):
        r = {"fen": "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
             "played_pv": ["e1f1"], "best_pv": ["e1g1"]}
        ends, cs = {}, {}
        for k in ("played", "best"):
            ends[k], cs[k], _ = dev.counts(r["fen"], r[k + "_pv"])
        self.assertEqual(dev.events(r, ends, cs), [{"line": "played", "kind": "lost_castling", "side": "white"}])

    def test_zone_entry_must_contrast_with_other_line(self):
        r = {"fen": "4k3/8/8/8/8/8/8/K2R4 w - - 0 1", "best_pv": ["d1d6"]}
        for played, expected in (("d1d2", 1), ("d1d7", 0)):
            r["played_pv"] = [played]
            ends, cs = {}, {}
            for k in ("played", "best"):
                ends[k], cs[k], _ = dev.counts(r["fen"], r[k + "_pv"])
            self.assertEqual(sum(e["kind"] == "king_zone_entry" for e in dev.events(r, ends, cs)), expected)

    def test_missing_cache_cannot_search(self):
        with patch.object(dev.tactics, "analyse"), patch.object(dev.tactics, "CACHE", dev.HERE / "selector/nonexistent-cache"), \
                patch.object(dev.tactics.chess.engine.SimpleEngine, "popen_uci", side_effect=AssertionError("engine started")):
            _, misses = dev.cached_only(dev.HERE / "selector/nonexistent-reads")
            with self.assertRaises(LookupError):
                dev.tactics.analyse(chess.Board())
            self.assertEqual(len(misses), 1)


if __name__ == "__main__":
    unittest.main()
