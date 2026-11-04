"""Small conversion invariants, using in-memory PGN rather than derived corpus trees."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("inputs", Path(__file__).with_name("clarity-inputs.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
STUDY = {"id": "fixture", "title": "Not an explanation", "color": "white", "content_role": "test"}


class ConversionTests(unittest.TestCase):
    def test_merge_preserves_mainline_notes_and_nags_without_headers(self):
        first = b'[Event "Title"]\n\n1. e4 $1 {Central space} ( {Alternative route} 1. d4 $2 {Other plan} ) *\n'
        second = b'[Event "Another title"]\n\n1. e4 {Second chapter note} e5 *\n'
        converted = module.convert(STUDY, first + b'\n' + second)
        self.assertEqual(converted["parseErrors"], [])
        self.assertEqual(len(converted["mergedRootScopes"]), 1)
        nodes = converted["mergedRootScopes"][0]["nodes"]
        root, e4, _, d4 = nodes
        self.assertEqual(root["comment"], "")
        self.assertTrue(e4["is_mainline"])
        self.assertFalse(d4["is_mainline"])
        self.assertEqual(e4["nags"], [1])
        self.assertEqual(d4["nags"], [2])
        self.assertIn("Alternative route", d4["starting_comment"])
        self.assertIn("Second chapter note", e4["comment"])
        self.assertTrue(all(n["tags"] == [] for n in nodes))

    def test_duplicate_chapter_does_not_inflate_tree_or_comments(self):
        raw = b'[Event "Title"]\n\n{Starting plan} 1. e4 {Central space} e5 *\n'
        one = module.convert(STUDY, raw)["mergedRootScopes"][0]["nodes"]
        two = module.convert(STUDY, raw + b'\n' + raw)["mergedRootScopes"][0]["nodes"]
        for node in one + two:
            node.pop("source_chapters")
        self.assertEqual(one, two)


if __name__ == "__main__":
    unittest.main()
