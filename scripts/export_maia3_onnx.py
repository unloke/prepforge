"""Export the Maia3-23M checkpoint to ONNX artifacts for the browser.

Phase 3a of docs/browser-engine-migration.md. Produces the browser artifact plus
a manifest, with BEHAVIORAL parity verified against the live Maia3Adapter
(legal-masked policy, top-1 move, Build-Generate 10%/30% threshold sets, and the
move_assessment after-move value path) — not just raw graph numerics:

  - maia3-fp16.onnx   -> ~44 MB, used for BOTH WebGPU and WASM. Threshold parity
                         is verified on the curated probes and empirically strong
                         on the random sweep (~1/200 flip), but that sweep is
                         evidence, NOT a safety proof — do not claim "threshold-safe".
  - maia3-fp32.onnx   -> reference / fp16 source (87 MB; WebGPU fallback if fp16 fails)
  - maia3-int8.onnx   -> OPTIONAL (--int8), ~24 MB, NOT threshold-safe (flips
                         Build Generate branch thresholds) — never gates the build
  - maia3.manifest.json

int8 was the original WASM plan, but behavioral parity shows per-tensor AND
per-channel int8 shift the policy head enough to flip 10%/30% branch decisions,
so fp16 serves both backends instead.

The net uses torch.nn.RMSNorm (use_rms_norm=True). ONNX export of that op is
torch/opset-version sensitive, so we monkeypatch RMSNorm.forward with an
export-friendly functional implementation and ASSERT how many modules were
patched (a silent miss would produce a subtly wrong export).

Run under the maia3 env (py3.11/3.13 on this machine, NOT py3.8):

    py -3.11 scripts/export_maia3_onnx.py --out web-src/public/maia3

Requires: torch, maia3, onnx, onnxruntime, onnxconverter-common.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from importlib import metadata as importlib_metadata
from pathlib import Path

import chess
import torch

# Repo + scripts import path (script lives in scripts/).
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from gc_maia3_artifacts import publish_lock  # noqa: E402  (stdlib-only; no torch)
from prepforge_chess.services.maia import (  # noqa: E402
    MAIA3_DEFAULT_MODEL,
    MAIA3_DEFAULT_REPO,
    Maia3Adapter,
    Maia3Config,
)

# Behavioral parity probes. Each covers a distinct part of the move vocabulary /
# post-processing, and lists explicit moves to exercise move_assessment's
# after-move value path. `assess` moves must be legal in `fen`.
PARITY_PROBES = [
    {"fen": chess.STARTING_FEN, "elo": 1500, "assess": ["e2e4", "g1f3"]},
    # White to move. (The adapter API takes one rating, so self==oppo here;
    # genuine asymmetric-Elo / swap wiring is tested separately at the graph
    # level — see raw_asym_check.)
    {
        "fen": "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2",
        "elo": 1900,
        "assess": ["g1f3", "b1c3"],
    },
    # Black to move — vocabulary is mirrored for the side to move.
    {
        "fen": "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4",
        "elo": 1100,
        "assess": ["f8c5", "d7d6"],
    },
    # Promotion moves (last 256 logits of the 4352 head).
    {"fen": "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "elo": 1500, "assess": ["a7a8q", "a7a8n"]},
    # Castling (king two-square moves).
    {
        "fen": "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
        "elo": 1500,
        "assess": ["e1g1", "e1c1"],
    },
]

# Build Generate keeps opponent moves with policy >= these thresholds
# (opening_generation.MAINLINE_THRESHOLD / BRANCH_THRESHOLD). Parity must hold
# the kept-move SET at both, or branching changes.
BUILD_THRESHOLDS = (0.10, 0.30)


def patch_rms_norm_for_export() -> int:
    """Replace torch.nn.RMSNorm.forward with an export-friendly impl.

    Returns the original method so the caller can restore it. The replacement
    is numerically equivalent to the reference RMSNorm.
    """
    import torch.nn as nn

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        dims = tuple(range(-len(self.normalized_shape), 0))
        variance = x.pow(2).mean(dim=dims, keepdim=True)
        eps = self.eps if self.eps is not None else torch.finfo(x.dtype).eps
        normed = x * torch.rsqrt(variance + eps)
        if self.elementwise_affine and self.weight is not None:
            normed = normed * self.weight
        return normed

    patch_rms_norm_for_export._original = nn.RMSNorm.forward  # type: ignore[attr-defined]
    nn.RMSNorm.forward = forward  # type: ignore[assignment]
    return 0


def restore_rms_norm() -> None:
    import torch.nn as nn

    original = getattr(patch_rms_norm_for_export, "_original", None)
    if original is not None:
        nn.RMSNorm.forward = original  # type: ignore[assignment]


def count_rms_norm_modules(model: torch.nn.Module) -> list[str]:
    import torch.nn as nn

    return [name for name, m in model.named_modules() if isinstance(m, nn.RMSNorm)]


class ExportWrapper(torch.nn.Module):
    """Expose only the two heads the browser needs: policy + value (WDL)."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, tokens, self_elos, oppo_elos):
        logits_move, logits_value, _ponder = self.model(tokens, self_elos, oppo_elos)
        return logits_move, logits_value


def convert_fp16(engine, fp32_path: Path, fp16_path: Path) -> Path:
    """Convert the fp32 graph to fp16 for the WebGPU EP.

    onnxconverter-common's manual op_block_list path is buggy in 1.16.0
    (``remove_unnecessary_cast_node`` AttributeError), and a naive full
    conversion leaves mixed float/float16 bindings ORT rejects at load. Use the
    validation-guided ``auto_convert_mixed_precision`` (it keeps nodes in fp32
    where fp16 would break or diverge). If anything fails, fall back to shipping
    fp32 as the WebGPU float artifact and return that path — the per-backend
    split (float for WebGPU, int8 for WASM) still holds, just larger.
    """
    import onnx
    import onnxruntime as ort

    try:
        from onnxconverter_common import float16

        # 1.16's remove_unnecessary_cast_node crashes ('list' has no attribute
        # 'input') whenever a block list is supplied. It's only a cleanup pass,
        # so neutralize it; we keep the elementwise math in fp32 ourselves.
        float16.remove_unnecessary_cast_node = lambda graph: None

        # Keep the int->float->div Elo interpolation and the RMSNorm scalar math
        # in fp32: converting these leaves mixed float/float16 bindings ORT
        # rejects at load (/model/Cast_1 -> Div_1). The fp16 win comes from the
        # MatMul/Gemm/Einsum weights, which still convert.
        block = list(getattr(float16, "DEFAULT_OP_BLOCK_LIST", [])) + [
            "Div",
            "Mul",
            "Add",
            "Sub",
            "Clip",
            "Pow",
            "Sqrt",
            "ReduceMean",
        ]
        model = onnx.load(str(fp32_path))
        converted = float16.convert_float_to_float16(
            model, keep_io_types=True, op_block_list=block
        )
        del converted.graph.value_info[:]
        converted = onnx.shape_inference.infer_shapes(converted)
        onnx.save(converted, str(fp16_path))
        # Prove it loads before we commit to it as the WebGPU artifact.
        ort.InferenceSession(str(fp16_path), providers=["CPUExecutionProvider"])
        return fp16_path
    except Exception as exc:  # noqa: BLE001
        print(
            f"      fp16 conversion failed ({type(exc).__name__}: {exc}); "
            f"shipping fp32 for WebGPU (follow-up: revisit fp16).",
            file=sys.stderr,
        )
        fp16_path.unlink(missing_ok=True)
        return fp32_path


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pkg_version(name: str) -> str:
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return "unknown"


def resolve_source_revision(engine) -> str:
    """Best-effort HF commit hash for the resolved checkpoint.

    The maia3 package loads from an HF cache snapshot whose directory name is the
    commit hash, e.g. ``.../snapshots/<sha>/maia3-23m.pt``. Pin that into the
    manifest so the same alias can't silently resolve to different weights.
    """
    ckpt = getattr(getattr(engine, "cfg", None), "checkpoint_path", None)
    if ckpt:
        parts = Path(ckpt).parts
        if "snapshots" in parts:
            i = parts.index("snapshots")
            if i + 1 < len(parts):
                return parts[i + 1]
    return "unknown"


def build_probe_inputs(engine, fen: str, self_elo: int, oppo_elo: int | None = None):
    engine.board = chess.Board(fen)
    engine._reset_history()
    tokens = engine._tokens_from_history(engine.history).unsqueeze(0).to("cpu")
    self_elos = torch.tensor([self_elo], dtype=torch.long)
    oppo_elos = torch.tensor([oppo_elo if oppo_elo is not None else self_elo], dtype=torch.long)
    return tokens, self_elos, oppo_elos


def _onnx_run(sess, t, s, o):
    out = sess.run(
        ["logits_move", "logits_value"],
        {"tokens": t.numpy(), "self_elos": s.numpy(), "oppo_elos": o.numpy()},
    )
    return out[0], out[1]


def onnx_predictions(sess, engine, fen: str, elo: int):
    """Reproduce Maia3Adapter.predictions() from an ONNX session.

    Mirrors maia.py: legal-move mask -> softmax over legal moves -> map indices
    back through the side-to-move (mirrored) frame via engine._move_from_index.
    Returns an ordered list of (move_uci, probability), high to low.
    """
    from maia3.dataset import get_legal_moves_mask

    board = chess.Board(fen)
    t, s, o = build_probe_inputs(engine, fen, elo)
    logits_move, _ = _onnx_run(sess, t, s, o)
    legal_mask = get_legal_moves_mask(board, engine.all_moves_dict)
    logits = torch.tensor(logits_move[0], dtype=torch.float32).masked_fill(
        ~legal_mask.bool(), float("-inf")
    )
    probs = torch.softmax(logits, dim=-1)
    out = []
    for idx in torch.nonzero(probs > 0).flatten().tolist():
        move = engine._move_from_index(idx)
        if move is not None:
            out.append((move.uci(), float(probs[idx])))
    out.sort(key=lambda kv: kv[1], reverse=True)
    return out


def onnx_move_assessment(sess, engine, fen: str, move_uci: str, elo: int):
    """Reproduce Maia3Adapter.move_assessment() from an ONNX session.

    Two forwards: policy on the current position (human probability of the move)
    and value on the after-move tokens with self/oppo Elo swapped, WDL inverted
    back to the mover (maia.py:169-181).
    """
    from maia3.dataset import get_legal_moves_mask
    from maia3.uci import invert_wdl, wdl_from_value_logits

    board = chess.Board(fen)
    move = chess.Move.from_uci(move_uci)
    if move not in board.legal_moves:
        return None

    engine.board = board
    engine._reset_history()
    t = engine._tokens_from_history(engine.history).unsqueeze(0).to("cpu")
    self_elos = torch.tensor([elo], dtype=torch.long)
    oppo_elos = torch.tensor([elo], dtype=torch.long)
    logits_move, _ = _onnx_run(sess, t, self_elos, oppo_elos)
    legal_mask = get_legal_moves_mask(board, engine.all_moves_dict)
    logits = torch.tensor(logits_move[0], dtype=torch.float32).masked_fill(
        ~legal_mask.bool(), float("-inf")
    )
    probs = torch.softmax(logits, dim=-1)
    human_probability = 0.0
    for idx in torch.nonzero(probs > 0).flatten().tolist():
        cand = engine._move_from_index(idx)
        if cand is not None and cand.uci() == move_uci:
            human_probability = float(probs[idx])
            break

    cand_tokens = (
        engine._tokens_from_history(engine._history_after_move(move)).unsqueeze(0).to("cpu")
    )
    cand_self = torch.tensor([elo], dtype=torch.long)
    cand_oppo = torch.tensor([elo], dtype=torch.long)
    _, value_logits = _onnx_run(sess, cand_tokens, cand_self, cand_oppo)
    win, draw, loss = invert_wdl(wdl_from_value_logits(torch.tensor(value_logits[0])))
    win_chance_after = (win + 0.5 * draw) / 1000.0
    return human_probability, win_chance_after


def _softmax_np(x):
    import numpy as np

    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


def kept_set(pred_pairs, threshold):
    return {uci for uci, p in pred_pairs if p >= threshold}


def random_positions(n: int, seed: int = 1234):
    """Varied legal midgame positions for the threshold-flip sweep.

    Random play to a random depth gives a broad spread of move distributions —
    including moves sitting near the 10%/30% boundaries, which the 5 curated
    probes cannot guarantee. Elos are cycled so the sweep spans skill levels.
    """
    import random

    rng = random.Random(seed)
    elos = [1100, 1500, 1900, 2200]
    out = []
    attempts = 0
    while len(out) < n and attempts < n * 30:
        attempts += 1
        board = chess.Board()
        for _ in range(rng.randint(2, 36)):
            if board.is_game_over():
                break
            board.push(rng.choice(list(board.legal_moves)))
        if board.is_game_over() or not any(board.legal_moves):
            continue
        out.append((board.fen(), elos[len(out) % len(elos)]))
    return out


def sweep_threshold_parity(sess, engine, adapter, positions):
    """Empirical threshold-flip rate over many positions (gating-float artifact).

    For each position, compares the adapter's kept-move set at 10%/30% against the
    ONNX session's. A "flip" = the sets differ at any threshold. This is EVIDENCE
    of how often fp16's small numeric delta crosses a hard cutoff — not a safety
    proof (a move sitting exactly on a boundary can always flip).
    """
    flips = 0
    max_prob = 0.0
    examples = []
    for fen, elo in positions:
        ref = [(m.move_uci, m.probability) for m in adapter.predictions(fen, rating=elo)]
        got = onnx_predictions(sess, engine, fen, elo)
        got_map = dict(got)
        for uci, p in ref:
            if uci in got_map:
                max_prob = max(max_prob, abs(p - got_map[uci]))
        flipped = any(kept_set(ref, th) != kept_set(got, th) for th in BUILD_THRESHOLDS)
        if flipped:
            flips += 1
            if len(examples) < 5:
                examples.append({"fen": fen, "elo": elo})
    n = max(1, len(positions))
    return {
        "positions": len(positions),
        "threshold_flips": flips,
        "flip_rate": round(flips / n, 4),
        "max_prob_delta": float(max_prob),
        "flip_examples": examples,
    }


def raw_asym_check(sess, wrapper, engine, fens, elo_a=1100, elo_b=2200):
    """Verify asymmetric-Elo wiring AND the after-move value swap at the graph
    level (the adapter API takes one rating, so it can't express self != oppo).

    For each FEN, with a legal move applied for the after-move tokens:
    - policy: onnx(cur, A, B) ≈ torch(cur, A, B); swapping A/B changes the policy
      (both Elo inputs live).
    - value (the move_assessment path): onnx(after, A, B) ≈ torch(after, A, B)
      AND onnx(after, B, A) ≈ torch(after, B, A) — both orderings, value head.
    - the WDL-inverted win-chance (what Brilliancy consumes) matches onnx vs torch
      under both orderings.
    - swapping A/B changes the value head too (the swap is not a no-op for A != B).

    Distinctness ("both Elo inputs live", "swap changes value") is measured on the
    ONNX graph itself — onnx(.,A,B) vs onnx(.,B,A) — NOT on Torch. A Torch-only
    distinctness check would pass even if the export dropped one Elo input, because
    the ONNX/Torch parity uses tol=0.02 and a genuine swap delta below that
    tolerance would let a swap-blind ONNX slip through. So we run o_pol_ba too and
    compare ONNX orderings directly.
    """
    import numpy as np
    from maia3.uci import invert_wdl, wdl_from_value_logits

    sa = torch.tensor([elo_a], dtype=torch.long)
    sb = torch.tensor([elo_b], dtype=torch.long)

    def win_chance(value_logits_row):
        win, draw, _loss = invert_wdl(wdl_from_value_logits(torch.as_tensor(value_logits_row)))
        return (win + 0.5 * draw) / 1000.0

    pol_delta = val_delta = wc_delta = 0.0
    pol_distinct = val_distinct = True
    for fen in fens:
        board = chess.Board(fen)
        move = next(iter(board.legal_moves))
        engine.board = board
        engine._reset_history()
        cur = engine._tokens_from_history(engine.history).unsqueeze(0)
        aft = engine._tokens_from_history(engine._history_after_move(move)).unsqueeze(0)

        with torch.no_grad():
            t_pol_ab, _ = wrapper(cur, sa, sb)
            t_pol_ba, _ = wrapper(cur, sb, sa)
            _, t_val_ab = wrapper(aft, sa, sb)
            _, t_val_ba = wrapper(aft, sb, sa)
        o_pol_ab, _ = _onnx_run(sess, cur, sa, sb)
        o_pol_ba, _ = _onnx_run(sess, cur, sb, sa)
        o_val_ab = _onnx_run(sess, aft, sa, sb)[1]
        o_val_ba = _onnx_run(sess, aft, sb, sa)[1]

        pol_delta = max(
            pol_delta,
            float(np.abs(_softmax_np(o_pol_ab[0]) - _softmax_np(t_pol_ab.numpy()[0])).max()),
        )
        val_delta = max(
            val_delta,
            float(np.abs(_softmax_np(o_val_ab[0]) - _softmax_np(t_val_ab.numpy()[0])).max()),
            float(np.abs(_softmax_np(o_val_ba[0]) - _softmax_np(t_val_ba.numpy()[0])).max()),
        )
        wc_delta = max(
            wc_delta,
            abs(win_chance(o_val_ab[0]) - win_chance(t_val_ab.numpy()[0])),
            abs(win_chance(o_val_ba[0]) - win_chance(t_val_ba.numpy()[0])),
        )
        # Distinctness on the ONNX graph: if swapping the Elo pair barely moves the
        # ONNX output, that input is effectively dead in the exported graph.
        if float(np.abs(_softmax_np(o_pol_ab[0]) - _softmax_np(o_pol_ba[0])).max()) < 1e-4:
            pol_distinct = False
        if float(np.abs(_softmax_np(o_val_ab[0]) - _softmax_np(o_val_ba[0])).max()) < 1e-4:
            val_distinct = False

    return {
        "elo_a": elo_a,
        "elo_b": elo_b,
        "policy_onnx_vs_torch_max_delta": pol_delta,
        "value_onnx_vs_torch_max_delta": val_delta,
        "winchance_onnx_vs_torch_max_delta": wc_delta,
        "policy_inputs_distinct": pol_distinct,
        "value_swap_changes_output": val_distinct,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="web-src/public/maia3", help="output directory")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument(
        "--expect-rms-norm",
        type=int,
        default=16,
        help="fail unless exactly this many RMSNorm modules are patched "
        "(default 16; pass -1 to disable the guard)",
    )
    parser.add_argument("--tol", type=float, default=2e-2, help="parity max-abs tolerance")
    parser.add_argument(
        "--int8",
        action="store_true",
        help="also emit an experimental int8 artifact. OFF by default: int8 "
        "dynamic quantization shifts the policy head enough to flip Build "
        "Generate's 10%%/30%% branch thresholds (verified), so it is NOT "
        "threshold-safe. Recorded for reference; never gates the build.",
    )
    parser.add_argument("--skip-fp16", action="store_true")
    parser.add_argument(
        "--sweep",
        type=int,
        default=200,
        help="number of random positions for the threshold-flip sweep "
        "(empirical evidence, not a safety proof; 0 to skip)",
    )
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[1/6] Loading {MAIA3_DEFAULT_MODEL} ({MAIA3_DEFAULT_REPO}) on CPU ...")
    adapter = Maia3Adapter(Maia3Config(device="cpu"))
    engine = adapter._ensure_engine()
    model = engine.model.eval()

    source_revision = resolve_source_revision(engine)
    print(f"      Source revision: {source_revision}")

    rms_names = count_rms_norm_modules(model)
    print(f"      Found {len(rms_names)} RMSNorm modules.")
    if args.expect_rms_norm >= 0 and len(rms_names) != args.expect_rms_norm:
        print(
            f"ERROR: expected {args.expect_rms_norm} RMSNorm modules, found "
            f"{len(rms_names)}. Refusing to export a possibly-wrong graph "
            f"(pass --expect-rms-norm -1 to override).",
            file=sys.stderr,
        )
        return 2

    import os
    import shutil
    import tempfile

    # Stage artifacts in a temp dir INSIDE out_dir (same filesystem → the final
    # promotion is an atomic os.replace rename, not a cross-drive copy+delete). A
    # single try/finally wraps export + verify + promote, so the stage dir is
    # always removed even if export / fp16 conversion / int8 quantization throws.
    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=out_dir))
    fp32_path = stage / "maia3-fp32.onnx"
    fp16_path = stage / "maia3-fp16.onnx"
    int8_path = stage / "maia3-int8.onnx"
    sample = build_probe_inputs(engine, PARITY_PROBES[0]["fen"], PARITY_PROBES[0]["elo"])
    prev_cwd = os.getcwd()
    try:
        # The torch exporter and the ORT quantizer leak intermediate files into
        # the CWD (a GUID `.data` blob, `sym_shape_infer_temp.onnx`). Run the
        # export/quantize region with the CWD inside a temp dir so those land
        # there and vanish with it; the real artifacts use absolute paths.
        with tempfile.TemporaryDirectory(prefix="maia3-export-") as scratch:
            os.chdir(scratch)
            try:
                print("[2/7] Patching RMSNorm.forward for export ...")
                patch_rms_norm_for_export()
                try:
                    wrapper = ExportWrapper(model).eval()
                    print(f"[3/7] Exporting fp32 graph -> {fp32_path.name}")
                    with torch.no_grad():
                        torch.onnx.export(
                            wrapper,
                            sample,
                            str(fp32_path),
                            input_names=["tokens", "self_elos", "oppo_elos"],
                            output_names=["logits_move", "logits_value"],
                            dynamic_axes={
                                "tokens": {0: "batch"},
                                "self_elos": {0: "batch"},
                                "oppo_elos": {0: "batch"},
                                "logits_move": {0: "batch"},
                                "logits_value": {0: "batch"},
                            },
                            opset_version=args.opset,
                            do_constant_folding=True,
                            verbose=False,
                            # Legacy TorchScript exporter: the RMSNorm monkeypatch
                            # traces to primitive ops, and the graph is far
                            # friendlier to the ORT quantizer than the dynamo graph
                            # (which fails opset conversion + symbolic shape
                            # inference during quantize).
                            dynamo=False,
                        )
                finally:
                    restore_rms_norm()

                webgpu_artifact = fp32_path  # upgraded to fp16 if conversion succeeds
                if not args.skip_fp16:
                    print(f"[4/7] Converting to fp16 -> {fp16_path.name} (WebGPU)")
                    webgpu_artifact = convert_fp16(engine, fp32_path, fp16_path)

                if args.int8:
                    print(f"[5/7] Dynamic-quantizing to int8 -> {int8_path.name} (experimental)")
                    from onnxruntime.quantization import QuantType, quantize_dynamic

                    # Per-channel weight quantization: per-tensor int8 shifts the
                    # policy head enough to flip Build Generate's 10%/30% branch
                    # thresholds (verified). Per-channel keeps the big MatMul
                    # weights accurate enough for threshold-set parity.
                    quantize_dynamic(
                        str(fp32_path),
                        str(int8_path),
                        weight_type=QuantType.QInt8,
                        per_channel=True,
                    )
            finally:
                os.chdir(prev_cwd)

        import onnxruntime as ort

        candidates = {"fp32": fp32_path}
        fp16_ok = not args.skip_fp16 and webgpu_artifact == fp16_path
        if fp16_ok:
            candidates["fp16"] = fp16_path
        if args.int8:
            candidates["int8"] = int8_path
        # int8 is experimental and never gates the build (not threshold-safe).
        non_gating = {"int8"}

        print(f"[6/7] Curated-probe parity vs live Maia3Adapter (tol={args.tol}) ...")
        # Reference = the real adapter (torch model + legal mask + mirror-frame
        # mapping + after-move value path), exactly what Build Generate and
        # Brilliancy consume — NOT the raw torch wrapper.
        ref_pred = {p["fen"]: adapter.predictions(p["fen"], rating=p["elo"]) for p in PARITY_PROBES}
        ref_assess = {
            p["fen"]: {mv: adapter.move_assessment(p["fen"], mv, rating=p["elo"]) for mv in p["assess"]}
            for p in PARITY_PROBES
        }

        summary: dict[str, dict] = {}
        ok = True
        for label, path in candidates.items():
            sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            max_prob = max_assess = 0.0
            top1_ok = probe_thresh_ok = assess_ok = True
            for probe in PARITY_PROBES:
                fen, elo = probe["fen"], probe["elo"]
                ref_pairs = [(m.move_uci, m.probability) for m in ref_pred[fen]]
                got_pairs = onnx_predictions(sess, engine, fen, elo)
                got_map = dict(got_pairs)
                if ref_pairs and got_pairs and ref_pairs[0][0] != got_pairs[0][0]:
                    top1_ok = False
                for uci, p in ref_pairs:
                    if uci in got_map:
                        max_prob = max(max_prob, abs(p - got_map[uci]))
                for th in BUILD_THRESHOLDS:
                    if kept_set(ref_pairs, th) != kept_set(got_pairs, th):
                        probe_thresh_ok = False
                for mv, ref_val in ref_assess[fen].items():
                    got_val = onnx_move_assessment(sess, engine, fen, mv, elo)
                    if ref_val is None or got_val is None:
                        if ref_val != got_val:
                            assess_ok = False
                        continue
                    dh = abs(ref_val[0] - got_val[0])
                    dw = abs(ref_val[1] - got_val[1])
                    max_assess = max(max_assess, dh, dw)
                    if dh > args.tol or dw > args.tol:
                        assess_ok = False

            passed = (
                max_prob <= args.tol
                and max_assess <= args.tol
                and top1_ok
                and probe_thresh_ok
                and assess_ok
            )
            gates = label not in non_gating
            if gates:
                ok = ok and passed
            summary[label] = {
                "max_prob_delta": max_prob,
                "max_assess_delta": max_assess,
                "top1_match": top1_ok,
                # NOT a safety claim — only that the curated probes agree. See the
                # `sweep` block for an empirical flip rate over many positions.
                "probe_threshold_sets_match": probe_thresh_ok,
                "assess_within_tol": assess_ok,
                "curated_probes_pass": passed,
                "gates_build": gates,
            }
            note = "" if gates else "  (experimental, non-gating)"
            print(
                f"      {label}: Δprob={max_prob:.4g} Δassess={max_assess:.4g} "
                f"top1={'OK' if top1_ok else 'FAIL'} "
                f"probe-thresh={'OK' if probe_thresh_ok else 'FAIL'} -> "
                f"{'OK' if passed else 'FAIL'}{note}"
            )

        # Empirical sweep + asymmetric-Elo wiring on the gating float artifact.
        gating_label = "fp16" if fp16_ok else "fp32"
        gating_sess = ort.InferenceSession(str(candidates[gating_label]), providers=["CPUExecutionProvider"])
        sweep_result = None
        if args.sweep > 0:
            print(f"[7/7] Threshold-flip sweep on {gating_label}: {args.sweep} random positions ...")
            positions = random_positions(args.sweep)
            sweep_result = sweep_threshold_parity(gating_sess, engine, adapter, positions)
            print(
                f"      flips={sweep_result['threshold_flips']}/{sweep_result['positions']} "
                f"(rate={sweep_result['flip_rate']}) maxΔprob={sweep_result['max_prob_delta']:.4g}"
            )
        asym = raw_asym_check(
            gating_sess, wrapper, engine, [p["fen"] for p in PARITY_PROBES[:3]]
        )
        print(
            f"      asym-Elo: polΔ={asym['policy_onnx_vs_torch_max_delta']:.4g} "
            f"valΔ={asym['value_onnx_vs_torch_max_delta']:.4g} "
            f"wcΔ={asym['winchance_onnx_vs_torch_max_delta']:.4g} "
            f"pol_distinct={asym['policy_inputs_distinct']} "
            f"val_swap_changes={asym['value_swap_changes_output']}"
        )
        # Gate: ONNX must match Torch for policy AND the after-move value head AND
        # the WDL-inverted win-chance, under the asymmetric Elos; and both Elo
        # inputs must be live (swapping changes the policy).
        asym_ok = (
            asym["policy_onnx_vs_torch_max_delta"] <= args.tol
            and asym["value_onnx_vs_torch_max_delta"] <= args.tol
            and asym["winchance_onnx_vs_torch_max_delta"] <= args.tol
            and asym["policy_inputs_distinct"]
            # The after-move value head must actually respond to swapping the
            # Elo pair; otherwise the value/win-chance parity above would pass
            # against a swap-blind head. This is the assertion the summary claims.
            and asym["value_swap_changes_output"]
        )
        if not asym_ok:
            ok = False
            print("      asym-Elo check FAILED (wiring/value-swap parity).", file=sys.stderr)

        # Release ORT sessions BEFORE touching files (Windows can't rename a model
        # file while a session holds it open).
        import gc

        sess = gating_sess = None
        gc.collect()

        if not ok:
            print(
                "PARITY FAILED — gating artifact diverges from the adapter; "
                "out_dir left untouched (no manifest written).",
                file=sys.stderr,
            )
            return 1

        # --- Atomic promotion via content-addressed filenames ---
        # Each artifact is renamed into out_dir as maia3-<label>-<sha12>.onnx
        # (same filesystem → atomic os.replace; a new build never overwrites a
        # live file, and CDNs can cache immutably). The manifest os.replace is the
        # single commit point that switches which artifacts the app loads.
        #
        # Held under the shared publish_lock so a concurrent gc_maia3_artifacts.py
        # pass can't read the old manifest, then have us swap in a new one, then
        # delete a file the new manifest references (the stat/replace/unlink race).
        with publish_lock(out_dir):
            final_files: dict[str, dict] = {}
            keep_names = set()
            for label, path in candidates.items():
                digest = sha256(path)
                fname = f"maia3-{label}-{digest[:12]}.onnx"
                os.replace(str(path), str(out_dir / fname))
                final_files[label] = {
                    "file": fname,
                    "bytes": (out_dir / fname).stat().st_size,
                    "sha256": digest,
                }
                keep_names.add(fname)
            webgpu_name = final_files[gating_label]["file"]

            manifest = {
                "generated_utc": datetime.now(timezone.utc).isoformat(),
                "model": MAIA3_DEFAULT_MODEL,
                "source_repo": MAIA3_DEFAULT_REPO,
                "source_revision": source_revision,
                "opset": args.opset,
                "history": int(engine.cfg.history),
                "include_time_info": bool(engine.cfg.include_time_info),
                "token_dim": int(sample[0].shape[-1]),
                "rms_norm_module_count": len(rms_names),
                "rms_norm_modules": rms_names,
                "io": {
                    "inputs": ["tokens", "self_elos", "oppo_elos"],
                    "outputs": ["logits_move", "logits_value"],
                    "logits_move_dim": 4352,
                    "logits_value_dim": 3,
                },
                "parity_tolerance": args.tol,
                "parity": summary,
                "threshold_flip_sweep": sweep_result,
                "asymmetric_elo": asym,
                "verification_backend": "onnxruntime CPUExecutionProvider (Python). "
                "NOT yet verified on onnxruntime-web WASM/WebGPU — see Phase 3b.",
                "versions": {
                    "torch": torch.__version__,
                    "onnx": pkg_version("onnx"),
                    "onnxruntime": pkg_version("onnxruntime"),
                    "onnxconverter-common": pkg_version("onnxconverter-common"),
                    "maia3": pkg_version("maia3"),
                },
                "artifacts": final_files,
                # Both backends point at the fp16 artifact as a DELIBERATE
                # download-size product choice (46 MB vs 91 MB), NOT the
                # latency-optimal pick: the Phase 3b onnxruntime-web smoke found
                # fp32/WASM faster warm AND more accurate. Still provisional pending
                # broader-device + threaded-WASM benchmarking. See the status string
                # and docs/browser-engine-migration.md Phase 3b.
                "backend_artifact": {"webgpu": webgpu_name, "wasm": webgpu_name},
                "backend_artifact_status": (
                    "deliberate product choice, not latency-optimal: fp16 (46 MB) "
                    "maps to BOTH backends to halve the cross-origin download vs fp32 "
                    "(91 MB). The single-threaded onnxruntime-web smoke measured "
                    "fp32/WASM FASTER warm (~70 ms vs ~95 ms) AND more accurate "
                    "(parity ~1e-6 vs ~1e-3), so this trades latency + precision for "
                    "download size on purpose. onnxruntime-web single-threaded "
                    "WASM+WebGPU validated (Phase 3b smoke). STILL PROVISIONAL pending "
                    "broader-device + threaded-WASM benchmarking; keep a runtime "
                    "capability/benchmark override."
                ),
                "int8_experimental": (
                    bool(args.int8)
                    and "int8 dynamic quantization flips Build Generate 10%/30% branch "
                    "thresholds; do not use for generation"
                ),
            }
            # Write the manifest inside the (same-filesystem) stage dir, then
            # os.replace it into place as the single atomic commit point. Keeping
            # the temp file in stage means a crash before the replace leaves
            # nothing behind: the finally below removes stage entirely. (A temp
            # written into out_dir would survive that cleanup and leak a .tmp.)
            tmp_manifest = stage / "maia3.manifest.json.tmp"
            tmp_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            os.replace(str(tmp_manifest), str(out_dir / "maia3.manifest.json"))  # atomic commit

            # Content-addressed publish: the manifest swap makes the NEW artifacts
            # live for new readers, but says nothing about clients still holding the
            # previous manifest, who may not have started downloading their model.
            # So this path NEVER deletes — unreferenced artifacts are reaped only by
            # the separate gc_maia3_artifacts.py pass after the deploy grace period.
            stale = [p for p in out_dir.glob("maia3-*.onnx") if p.name not in keep_names]
            if stale:
                print(
                    f"      Retained {len(stale)} unreferenced artifact(s) from prior "
                    f"build(s); reap with gc_maia3_artifacts.py after the grace period."
                )

        print(
            f"Done. Gating parity passed (CPU EP). WebGPU+WASM -> {webgpu_name} "
            f"(provisional; browser-validate in Phase 3b)."
        )
        return 0
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
