"""Research only. Kaggle GPU script: tag GameKnot comments with the curated concept taxonomy.

The taxonomy (taxonomy.json, curated by hand from the phrases kernel's clusters) has categories
of fine concepts. Each comment gets the fine concepts it says are present or immediately
threatened in the position after the move, each backed by a quote from the comment; a concept
whose quote is not in the comment is dropped. Rows carry the fine tags and their categories.
"""

from common import OUT, letters, rows, two_gpus

LIMIT = 0  # 0 = all
DEADLINE = 10 * 3600
TAXONOMY = {}  # package.py fills in taxonomy.json: {category: {concept: definition}}
CATEGORY = {c: cat for cat, cs in TAXONOMY.items() for c in cs}

SYSTEM = (
    "You label chess comments. Given a move and the player's comment about the position after it, "
    "list which of these concepts the comment itself says are present or immediately threatened in "
    "that position. Leave out concepts that are only hypothetical or about earlier moves, and do not "
    "add concepts the comment does not mention; many comments mention none.\n"
    + "\n".join(f"{cat}:\n" + "\n".join(f"- {c}: {d}" for c, d in cs.items()) for cat, cs in TAXONOMY.items())
    + "\nFor each concept write one line: its name exactly as listed, then ' | ', then the exact words "
    "of the comment that express it. If none apply, answer none."
)


def messages(r):
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Move: {r['mover']} played {r['move']}\nComment: {r['comment']}"}]


def parse(raw, comment):
    tags, dropped = set(), 0
    for line in raw.splitlines():
        if "|" not in line:
            continue
        name, quote = (x.strip(" -*.") for x in line.split("|", 1))
        name = name.lower()
        if name in CATEGORY and quote.lower() != "none" and letters(quote) and letters(quote) in letters(comment):
            tags.add(name)
        else:
            dropped += 1
    return {"tags": sorted(tags), "cats": sorted({CATEGORY[t] for t in tags}), "dropped": dropped}


def main():
    if not OUT.is_dir():
        raise RuntimeError("Kaggle only")
    two_gpus(lambda: rows(LIMIT), "labels.jsonl", messages, parse, 160, DEADLINE)


if __name__ == "__main__":
    main()
