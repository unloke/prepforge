"""Second labelling of the 360 development cards with the user-taste rubric (RUBRIC.md here):
sol's batches (same cards and candidate order as cand/) and Hark's messages.

  py -B selector/taste/make.py   -> taste/batch-NN.jsonl, taste/hark/msg-NN.txt
"""
import json
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEL = HERE.parent


def hark_header():
    """The rubric as one chat message: Hark checks with its own tools and replies in a code block."""
    r = (HERE / "RUBRIC.md").read_text(encoding="utf-8")
    r = r.split("\nWrite `out/batch-NN.jsonl`")[0]
    r = r.replace("Check the board with python-chess (`import chess`; `pip install chess` if needed): replay the lines,\n"
                  "list attacks, count material. There is no engine beyond the given lines; do not install or run one.",
                  "Check the board with your board tools: replay the lines, list attacks, count material.")
    r = r.replace("Each line of a `batch-NN.jsonl` file is", "Each JSON line under Cards is")
    assert "python-chess" not in r and "batch-NN" not in r
    return ("Blind judging task (independent of any earlier labels or chats).\n\n" + r +
            "\nReply with ONLY one code block of JSON lines, one line per card, in order, nothing else:\n"
            '{"n": <n>, "candidates": [{"k": 0, "correct": true, "main": false}, ...], "best": <k or null>, '
            '"confidence": "...", "key": "..."}\n\nCards:\n')


def main():
    head = hark_header()
    (HERE / "hark/out").mkdir(parents=True, exist_ok=True)
    (HERE / "out").mkdir(exist_ok=True)
    for p in sorted((SEL / "cand").glob("batch-*.jsonl")):
        shutil.copyfile(p, HERE / p.name)
        nn = re.search(r"\d+", p.name).group()
        (HERE / f"hark/msg-{nn}.txt").write_bytes((head + p.read_text(encoding="utf-8")).encode())


if __name__ == "__main__":
    main()
