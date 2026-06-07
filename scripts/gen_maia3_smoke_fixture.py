"""Generate a tiny numeric reference fixture for the browser smoke test.

Phase 3b of docs/browser-engine-migration.md. The browser smoke test
(maia3-worker.js) must verify that onnxruntime-web loads each shipped artifact on
the WASM and WebGPU EPs and computes the SAME logits the Python CPU EP does. This
script captures concrete inputs (tokens / self_elos / oppo_elos for a couple of
positions, including one black-to-move to exercise the mirror frame) and the
reference outputs (logits_value in full, logits_move as top-k index/logit pairs,
the legal-masked policy top-k, and the 10%/30% kept-move SETS Build Generate
branches on), so the browser can reproduce the exact policy behavior — legal mask +
thresholds — without re-deriving the tokenizer or the index->move mapping.

The tokens are model-independent (derived from the FEN), so they're stored once as
shared `cases`. A SEPARATE CPU-EP reference is generated for EVERY artifact in the
manifest (fp16 AND fp32) under `references[label]`, so the browser compares each
artifact's onnxruntime-web output against that SAME artifact's CPU EP — not against
a different precision's reference (an fp32-vs-fp16 cross-check would mask real
fp32 divergence).

    py -3.11 scripts/gen_maia3_smoke_fixture.py

Writes web-src/engine/maia3-smoke-fixture.json (committed; small + deterministic).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from prepforge_chess.services.maia import Maia3Adapter, Maia3Config  # noqa: E402
from prepforge_chess.services.opening_generation import (  # noqa: E402
    BRANCH_THRESHOLD,
    MAINLINE_THRESHOLD,
)

OUT_DIR = Path(__file__).resolve().parents[1] / "web-src" / "public" / "maia3"
FIXTURE = Path(__file__).resolve().parents[1] / "web-src" / "engine" / "maia3-smoke-fixture.json"
TOPK = 10
# Golden positions whose Python `tokens` / `legal_indices` the JS tokenizer must
# reproduce byte-for-byte. Chosen to exercise every corner of the move vocabulary
# + mirror frame: a white-to-move and a black-to-move base (the index->move map
# differs by side), plus the three move types most likely to break index encoding
# or the black mirror — promotions (black-to-move, hits the white-frame promo
# vocab), castling (king two-square moves e1g1/e1c1 and their mirrors), and en
# passant (a capture to an empty square).
CASES = [
    {"name": "startpos-white", "fen": chess.STARTING_FEN, "self_elo": 1500, "oppo_elo": 1500},
    {
        "name": "after-1e4-black",
        "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        "self_elo": 1900,
        "oppo_elo": 1100,
    },
    {
        # Black to move with a pawn on e2: e1=Q/R/B/N must round-trip through the
        # white-frame promotion vocab (e7e8{q,r,b,n}) after the board mirror.
        "name": "promo-black-e1",
        "fen": "8/8/8/8/8/7k/4p3/7K b - - 0 1",
        "self_elo": 1500,
        "oppo_elo": 1500,
    },
    {
        # White to move, all four castles available: e1g1/e1c1 (and Black's mirror)
        # are encoded as plain king two-square moves in the vocab.
        "name": "castling-both-white",
        "fen": "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1",
        "self_elo": 1800,
        "oppo_elo": 1800,
    },
    {
        # White to move with an en-passant target (f6): e5xf6 captures to an empty
        # square, the one move chess.js can desync on if the ep square is dropped.
        "name": "enpassant-white-f6",
        "fen": "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
        "self_elo": 1600,
        "oppo_elo": 1600,
    },
    {
        # Black to move, both black castles available: e8g8/e8c8 must mirror to the
        # white-frame e1g1/e1c1 vocab entries. The black-to-move COUNTERPART of
        # castling-both-white — the mirror frame is exactly where castling can break.
        "name": "castling-both-black",
        "fen": "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1",
        "self_elo": 1800,
        "oppo_elo": 1800,
    },
    {
        # Black to move with an en-passant target (d3): e4xd3 captures to an empty
        # square AND goes through the black mirror — the path most likely to desync
        # if the ep square is dropped or the mirror frame is wrong.
        "name": "enpassant-black-d3",
        "fen": "rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 3",
        "self_elo": 1600,
        "oppo_elo": 1600,
    },
]


def _legal_masked_probs(logits_row, legal_indices):
    """Legal-masked softmax — exactly what Build Generate consumes.

    Softmax over only the legal logit indices is mathematically identical to
    softmaxing the full vector with the illegal entries set to -inf (the path in
    Maia3Adapter.move_assessment / score_moves), but lets us keep the fixture
    tokenizer-free: the browser need only know WHICH indices are legal, not how to
    derive them. Returns probs aligned to `legal_indices`.
    """
    import numpy as np

    legal_logits = logits_row[legal_indices].astype(np.float64)
    ex = np.exp(legal_logits - legal_logits.max())
    return ex / ex.sum()


def main() -> int:
    import numpy as np
    import onnxruntime as ort
    from maia3.dataset import get_legal_moves_mask

    manifest = json.loads((OUT_DIR / "maia3.manifest.json").read_text(encoding="utf-8"))

    # Refuse to write unless EVERY manifest artifact is present locally AND its
    # bytes match the manifest's size + sha256. The ONNX weights are git-ignored,
    # so a clean clone has none of them; a stray run would overwrite the committed
    # fixture with a version missing the fp16/fp32 references and silently gut the
    # browser smoke. Existence alone is not enough: we stamp each manifest SHA into
    # the fixture's `references[label].model_sha256`, so a correctly-named but
    # corrupt/stale local .onnx would make the fixture CLAIM it came from the
    # manifest artifact while the reference logits actually came from other bytes —
    # turning a real smoke mismatch into a misleading diagnosis. Verify up front so
    # we never produce a fixture that lies about its provenance.
    problems = []
    for label, art in manifest["artifacts"].items():
        path = OUT_DIR / art["file"]
        if not path.exists():
            problems.append("{0} ({1}): missing".format(label, art["file"]))
            continue
        size = path.stat().st_size
        if size != art["bytes"]:
            problems.append(
                "{0} ({1}): size {2} != manifest {3}".format(label, art["file"], size, art["bytes"])
            )
            continue  # don't bother hashing a wrong-sized file
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != art["sha256"]:
            problems.append(
                "{0} ({1}): sha256 {2} != manifest {3}".format(
                    label, art["file"], digest, art["sha256"]
                )
            )
    if problems:
        print(
            "ERROR: refusing to write fixture -- manifest artifacts missing or corrupt locally:\n  "
            + "\n  ".join(problems)
            + "\nThe ONNX weights are git-ignored; export/fetch the manifest-matching "
            + "artifacts into "
            + str(OUT_DIR)
            + " before regenerating.",
            file=sys.stderr,
        )
        return 1

    adapter = Maia3Adapter(Maia3Config(device="cpu"))
    engine = adapter._ensure_engine()

    # Shared, model-independent inputs (tokens + legal-move indices come from the
    # FEN + the move vocabulary, not the weights).
    cases_out = []
    feeds_by_case = []
    legal_by_case = []
    for case in CASES:
        board = chess.Board(case["fen"])
        engine.board = board
        engine._reset_history()
        tokens = engine._tokens_from_history(engine.history).unsqueeze(0).cpu().numpy().astype(np.float32)
        feeds = {
            "tokens": tokens,
            "self_elos": np.array([case["self_elo"]], dtype=np.int64),
            "oppo_elos": np.array([case["oppo_elo"]], dtype=np.int64),
        }
        feeds_by_case.append(feeds)
        # Legal-move policy indices in the model's side-to-move (mirrored) frame.
        # Stored so the browser can apply the SAME legal mask + 10%/30% thresholds
        # Build Generate uses, without re-deriving the index->move mapping.
        legal_mask = get_legal_moves_mask(board, engine.all_moves_dict).cpu().numpy().astype(bool)
        legal_indices = np.flatnonzero(legal_mask)
        legal_by_case.append(legal_indices)
        cases_out.append(
            {
                "name": case["name"],
                "fen": case["fen"],
                "self_elo": case["self_elo"],
                "oppo_elo": case["oppo_elo"],
                "token_shape": list(tokens.shape),
                "tokens": tokens.reshape(-1).round(6).tolist(),
                "legal_indices": [int(i) for i in legal_indices],
            }
        )

    # One CPU-EP reference per artifact in the manifest (fp16 AND fp32).
    references = {}
    for label, art in manifest["artifacts"].items():
        model_path = OUT_DIR / art["file"]  # guaranteed present (checked above)
        print(f"Reference [{label}]: {art['file']}")
        sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        outputs = []
        for case, feeds, legal_indices in zip(CASES, feeds_by_case, legal_by_case):
            logits_move, logits_value = sess.run(["logits_move", "logits_value"], feeds)
            lm = logits_move[0].astype(np.float64)
            top_idx = np.argsort(lm)[::-1][:TOPK]

            # Build Generate parity: legal-masked policy + the 10%/30% kept-move SETS
            # it branches on. fp16 has a known low-but-nonzero threshold-flip rate, so
            # comparing the kept SETS (not just top-1) is what catches a non-top-1 move
            # crossing a threshold under WASM/WebGPU vs the CPU reference.
            probs = _legal_masked_probs(lm, legal_indices)
            order = np.argsort(probs)[::-1][:TOPK]
            policy_top = [
                {"index": int(legal_indices[j]), "prob": round(float(probs[j]), 6)} for j in order
            ]
            kept_10 = sorted(int(legal_indices[j]) for j in np.flatnonzero(probs >= MAINLINE_THRESHOLD))
            kept_30 = sorted(int(legal_indices[j]) for j in np.flatnonzero(probs >= BRANCH_THRESHOLD))
            outputs.append(
                {
                    "logits_value": logits_value[0].astype(np.float64).round(6).tolist(),
                    "logits_move_top": [
                        {"index": int(i), "logit": round(float(lm[i]), 6)} for i in top_idx
                    ],
                    "policy_top": policy_top,
                    "kept_10": kept_10,
                    "kept_30": kept_30,
                }
            )
            print(
                f"  {label}/{case['name']}: argmax={int(top_idx[0])} "
                f"value={logits_value[0].round(4).tolist()} "
                f"kept@10={len(kept_10)} kept@30={len(kept_30)}"
            )
        references[label] = {
            "model_file": art["file"],
            "model_sha256": art["sha256"],
            "outputs": outputs,
        }

    fixture = {
        "_comment": "Generated by scripts/gen_maia3_smoke_fixture.py — per-artifact CPU-EP "
        "reference for the onnxruntime-web smoke test. Regenerate if any artifact changes.",
        "logits_move_dim": manifest["io"]["logits_move_dim"],
        "logits_value_dim": manifest["io"]["logits_value_dim"],
        "topk": TOPK,
        # Build Generate's branch thresholds (single source of truth: opening_generation).
        # The browser applies the SAME cuts to its legal-masked softmax and compares the
        # kept-move SETS, so it validates the exact policy behavior the build depends on.
        "thresholds": {"mainline": MAINLINE_THRESHOLD, "branch": BRANCH_THRESHOLD},
        "cases": cases_out,
        "references": references,
    }
    # Atomic write: render to a temp file and replace, so an interrupted or
    # erroring run can never leave a half-written fixture in place.
    tmp = FIXTURE.with_name(FIXTURE.name + ".tmp")
    tmp.write_text(json.dumps(fixture, indent=2), encoding="utf-8")
    tmp.replace(FIXTURE)
    print(f"Wrote {FIXTURE} ({FIXTURE.stat().st_size} bytes) with references: {list(references)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
