"""Research only. Kaggle GPU script: open-vocabulary chess ideas from GameKnot comments, then clusters.

1. Qwen3-4B names the chess ideas each comment says are in the position, zero-shot, with no
   candidate list or examples, and quotes the words that express each one; a phrase whose quote
   is not in the comment is dropped (phrases.jsonl).
2. Phrases are normalised and counted by comment; those in 3+ comments are embedded and
   clustered (average-linkage cosine) at several thresholds, tight ones first so that close but
   different ideas stay apart (CLUSTERS.json). The taxonomy is curated by hand from these.
"""
import json
import re
from collections import Counter, defaultdict

from common import OUT, letters, rows, run, two_gpus

LIMIT = 30000
DEADLINE = 5 * 3600
EMBED = "BAAI/bge-base-en-v1.5"
THRESHOLDS = (0.10, 0.15, 0.20, 0.30)
MIN_COMMENTS = 3

SYSTEM = (
    "You read a chess player's comment about the position after a move. List the chess ideas the "
    "comment itself states or clearly refers to as present or immediately threatened in that position: "
    "tactical, positional, strategic, endgame and evaluation ideas, plans and weaknesses. Do not add "
    "ideas the comment does not mention; many comments mention one idea or none. Leave out ideas that "
    "are only hypothetical or about earlier moves, opening names, engine lines, remarks about the "
    "players, and chat.\n"
    "For each idea write one line: a short general English phrase of one to four words naming the idea "
    "the way a chess coach would (the idea itself, not the particular squares, pieces or moves), then "
    "' | ', then the exact words of the comment that express it. No numbering or headings. If the "
    "comment names no chess idea, answer none."
)


def messages(r):
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Move: {r['mover']} played {r['move']}\nComment: {r['comment']}"}]


def normal(p):
    p = re.sub(r"^[\s\-*•\d.)]+", "", p.lower()).strip(" .;:,'\"")
    p = re.sub(r"^(a|an|the)\s+", "", p)
    return " ".join(p.split())


def parse(raw, comment):
    """Phrases whose quoted evidence is in the comment (ignoring spacing and punctuation)."""
    kept, dropped = set(), 0
    for line in raw.splitlines():
        if "|" not in line:
            continue
        phrase, quote = (x.strip() for x in line.split("|", 1))
        phrase = normal(phrase)
        if not phrase or len(phrase) > 60 or not letters(quote) or letters(quote) not in letters(comment):
            dropped += 1
            continue
        kept.add(phrase)
    return {"phrases": sorted(kept), "dropped": dropped}


def cluster():
    import numpy as np
    from sentence_transformers import SentenceTransformer
    from sklearn.cluster import AgglomerativeClustering
    data = [json.loads(line) for line in open(OUT / "phrases.jsonl", encoding="utf-8")]
    count, examples = Counter(), defaultdict(list)
    for r in data:
        for p in r["phrases"]:
            count[p] += 1
            if len(examples[p]) < 3:
                examples[p].append(r["comment"][:200])
    kept = [p for p, c in count.most_common() if c >= MIN_COMMENTS]
    print("comments", len(data), "phrases", len(count), "kept", len(kept), flush=True)
    emb = SentenceTransformer(EMBED, device="cuda").encode(kept, batch_size=256, normalize_embeddings=True)
    out = {"comments": len(data), "untagged": sum(not r["phrases"] for r in data), "phrases": len(count),
           "kept": len(kept), "minComments": MIN_COMMENTS, "embed": EMBED, "levels": {}}
    for t in THRESHOLDS:
        labels = AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average",
                                         distance_threshold=t).fit_predict(np.asarray(emb))
        groups = defaultdict(list)
        for p, c in zip(kept, labels):
            groups[int(c)].append(p)
        clusters = sorted(({"mentions": sum(count[p] for p in ps),
                            "phrases": [[p, count[p]] for p in sorted(ps, key=lambda p: -count[p])],
                            "examples": examples[max(ps, key=lambda p: count[p])]} for ps in groups.values()),
                          key=lambda c: -c["mentions"])
        out["levels"][str(t)] = clusters
        print("threshold", t, "clusters", len(clusters), flush=True)
    (OUT / "CLUSTERS.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "PHRASES.json").write_text(json.dumps(count.most_common(), ensure_ascii=False), encoding="utf-8")


def main():
    if not OUT.is_dir():
        raise RuntimeError("Kaggle only")
    if two_gpus(lambda: rows(LIMIT), "phrases.jsonl", messages, parse, 160, DEADLINE):
        run(["pip", "install", "-q", "sentence-transformers"])
        cluster()


if __name__ == "__main__":
    main()
