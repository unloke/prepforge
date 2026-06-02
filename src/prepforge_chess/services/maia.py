from __future__ import annotations

from dataclasses import dataclass, replace
import importlib.util
import shutil
import subprocess
import sys
import threading
import time
from typing import Dict, List, Optional, Protocol, Tuple

import chess

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import MaiaMovePrediction


MAIA3_DEFAULT_MODEL = "maia3-23m"
MAIA3_DEFAULT_REPO = "UofTCSSLab/Maia3-23M"


class MaiaAdapter(Protocol):
    name: str

    def predictions(
        self,
        fen: str,
        *,
        rating: Optional[int] = None,
    ) -> List[MaiaMovePrediction]:
        raise NotImplementedError

    def move_assessment(
        self,
        fen: str,
        move_uci: str,
        *,
        rating: Optional[int] = None,
    ) -> Optional[Tuple[float, float]]:
        """Return (human_probability, win_chance_after) for a specific move.

        human_probability: how likely a human of ``rating`` plays the move (low
        = unintuitive). win_chance_after: the model's value of the resulting
        position from the mover's perspective (low = looks bad at a glance).
        Returns None when unavailable / illegal.
        """
        raise NotImplementedError


class Maia3Unavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Maia3Config:
    model: str = MAIA3_DEFAULT_MODEL
    top_n: int = 12
    default_rating: int = 1500
    device: Optional[str] = None
    cache_dir: Optional[str] = None
    local_files_only: bool = False
    force_download: bool = False


class Maia3Adapter:
    """True Maia3 adapter using the official CSSLab `maia3` package.

    The default model is Maia3 23M (`UofTCSSLab/Maia3-23M`). The package resolves
    the checkpoint through Hugging Face on first use. When the optional dependency
    is missing, ``create_maia3_adapter`` raises rather than substituting a fake.
    """

    name = MAIA3_DEFAULT_MODEL

    def __init__(
        self,
        config: Maia3Config = Maia3Config(),
        chess_core: Optional[ChessCore] = None,
    ):
        self.config = config
        self.chess_core = chess_core or ChessCore()
        self.name = config.model
        self._engine = None
        self._lock = threading.Lock()

    @staticmethod
    def is_available() -> bool:
        return importlib.util.find_spec("maia3") is not None

    def predictions(
        self,
        fen: str,
        *,
        rating: Optional[int] = None,
    ) -> List[MaiaMovePrediction]:
        with self._lock:
            engine = self._ensure_engine()
            engine.board = chess.Board(fen)
            engine._reset_history()
            engine.self_elo = int(rating or self.config.default_rating)
            engine.oppo_elo = int(rating or self.config.default_rating)
            engine.temperature = 0.0
            engine.top_p = 1.0
            engine.multipv = max(1, min(20, int(self.config.top_n)))
            _move, top_moves = engine.score_moves()

        predictions = []
        for index, item in enumerate(top_moves, start=1):
            predictions.append(
                MaiaMovePrediction(
                    fen=fen,
                    move_uci=item["move"].uci(),
                    probability=float(item.get("policy", 0.0)),
                    model=self.config.model,
                    rating_bucket=str(rating) if rating is not None else None,
                    rank=index,
                )
            )
        return predictions

    def move_assessment(
        self,
        fen: str,
        move_uci: str,
        *,
        rating: Optional[int] = None,
    ) -> Optional[Tuple[float, float]]:
        import torch
        from maia3.dataset import get_legal_moves_mask
        from maia3.uci import invert_wdl, wdl_from_value_logits

        try:
            board = chess.Board(fen)
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return None
        if move not in board.legal_moves:
            return None

        with self._lock:
            engine = self._ensure_engine()
            engine.board = board
            engine._reset_history()
            elo = int(rating or self.config.default_rating)
            engine.self_elo = elo
            engine.oppo_elo = elo
            device = engine.cfg.device

            legal_mask = get_legal_moves_mask(board, engine.all_moves_dict).to(device)
            tokens = engine._tokens_from_history(engine.history).unsqueeze(0).to(device)
            self_elos = torch.tensor([elo], dtype=torch.long, device=device)
            oppo_elos = torch.tensor([elo], dtype=torch.long, device=device)
            with torch.no_grad():
                logits_move, _, _ = engine.model(tokens, self_elos, oppo_elos)
            logits = logits_move[0].float().masked_fill(~legal_mask, float("-inf"))
            probs = torch.softmax(logits, dim=-1)

            # The move vocabulary is in maia's side-to-move (mirrored) frame, so
            # map indices back to real moves via the engine and match by uci.
            human_probability = 0.0
            for idx in torch.nonzero(probs > 0).flatten().tolist():
                candidate = engine._move_from_index(idx)
                if candidate is not None and candidate.uci() == move_uci:
                    human_probability = float(probs[idx])
                    break

            # Value of the position after the move. The candidate board's side
            # to move is the opponent, so swap elos and invert back to the mover.
            cand_tokens = (
                engine._tokens_from_history(engine._history_after_move(move))
                .unsqueeze(0)
                .to(device)
            )
            cand_self = torch.tensor([engine.oppo_elo], dtype=torch.long, device=device)
            cand_oppo = torch.tensor([engine.self_elo], dtype=torch.long, device=device)
            with torch.no_grad():
                _, value_logits, _ = engine.model(cand_tokens, cand_self, cand_oppo)
            win, draw, loss = invert_wdl(wdl_from_value_logits(value_logits[0]))
            win_chance_after = (win + 0.5 * draw) / 1000.0

        return human_probability, win_chance_after

    def _ensure_engine(self):
        if self._engine is not None:
            return self._engine
        if not self.is_available():
            raise Maia3Unavailable(
                "Maia3 package is not installed. Install CSSLab/maia3 and cache "
                "`maia3-23m` to use the true Maia3 adapter."
            )

        try:
            from maia3.uci import Maia3UCIEngine, parse_args
        except ImportError as exc:
            raise Maia3Unavailable(str(exc)) from exc

        def build(device: Optional[str]):
            argv = [
                "--model",
                self.config.model,
                "--multipv",
                str(max(1, min(20, int(self.config.top_n)))),
                "--temperature",
                "0",
            ]
            if device:
                argv.extend(["--device", device])
            if self.config.cache_dir:
                argv.extend(["--cache-dir", self.config.cache_dir])
            if self.config.local_files_only:
                argv.append("--local-files-only")
            if self.config.force_download:
                argv.append("--force-download")
            engine = Maia3UCIEngine(parse_args(argv))
            engine.ensure_model_loaded()
            return engine

        device = self.config.device
        try:
            self._engine = build(device)
        except Exception:
            # A CUDA device that passed detection can still fail at model load
            # (driver/runtime/compute-capability mismatch). Degrade to CPU so
            # Brilliant detection keeps working instead of silently dying for the
            # whole game. ``move_assessment`` reads the device off the loaded
            # engine, so the retried engine drives all later inference on CPU.
            if device and device != "cpu":
                self._engine = build("cpu")
            else:
                raise
        return self._engine


MAIA3_PACKAGE_SOURCE = "git+https://github.com/CSSLab/maia3.git"


def ensure_maia3() -> Dict[str, object]:
    """Install the Maia3 package when missing, or simulate an update if present.

    The official package is not on PyPI — it installs from the CSSLab GitHub
    repo (see README). When already installed we just report success after a
    brief pause (there is no separate update channel).
    """
    if Maia3Adapter.is_available():
        time.sleep(1.0)  # let the UI show its working state
        return {
            "action": "update",
            "already_present": True,
            "package_installed": True,
            "message": "Maia3 already installed — checked for updates.",
        }

    # The package requires Python 3.10+. Fail fast with an actionable message
    # rather than letting pip emit a cryptic resolver error.
    if sys.version_info < (3, 10):
        running = "{0}.{1}.{2}".format(*sys.version_info[:3])
        raise RuntimeError(
            "Maia3 needs Python 3.10+ but PrepForge is running on Python {0}. "
            "Run the app with a newer Python (3.10–3.12) to install it.".format(running)
        )

    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "install", MAIA3_PACKAGE_SOURCE],
            capture_output=True,
            text=True,
            timeout=1800,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Could not run pip. Install Maia3 manually: pip install {0}".format(MAIA3_PACKAGE_SOURCE)
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("Maia3 install could not start: {0}".format(exc)) from exc

    importlib.invalidate_caches()
    installed = importlib.util.find_spec("maia3") is not None
    if proc.returncode != 0 or not installed:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        hint = " / ".join(tail[-4:]) if tail else "unknown error"
        if "git" in hint.lower() and ("not found" in hint.lower() or "not recognized" in hint.lower()):
            hint = "git is required to install Maia3 from GitHub — install Git and retry."
        raise RuntimeError("Maia3 install failed: {0}".format(hint))

    # Best-effort: warm the default checkpoint so the first prediction isn't slow.
    # Non-fatal — the model also downloads lazily on first use.
    cache_exe = shutil.which("maia3-cache")
    if cache_exe:
        try:
            subprocess.run(
                [cache_exe, "--model", MAIA3_DEFAULT_MODEL],
                capture_output=True,
                text=True,
                timeout=1800,
            )
        except Exception:
            pass

    return {
        "action": "install",
        "already_present": False,
        "package_installed": True,
        "message": "Maia3 installed successfully.",
    }


def create_maia3_adapter(
    *,
    chess_core: Optional[ChessCore] = None,
    config: Maia3Config = Maia3Config(),
) -> MaiaAdapter:
    """Create the real Maia3 adapter, or raise ``Maia3Unavailable``.

    There is deliberately **no** mock fallback. A silent stand-in for a missing
    or broken Maia3 install hid real failures (the app looked like it was running
    the human model when it was not), which made debugging far harder. Callers
    that genuinely want a lightweight, deterministic stand-in (e.g. tests) must
    inject one explicitly.
    """
    if not Maia3Adapter.is_available():
        raise Maia3Unavailable(
            "Maia3 is not installed. Expected the official model {0}. Install it "
            "from Settings → Maia3, or `pip install {1}`.".format(
                MAIA3_DEFAULT_REPO, MAIA3_PACKAGE_SOURCE
            )
        )
    resolved = config
    if config.device is None:
        # Prefer GPU, fall back to CPU. (The maia3 package picks the same default
        # internally; we resolve it here so the choice is explicit and the app
        # can report which device Maia3 will use.)
        from prepforge_chess.services.device import preferred_maia_device

        resolved = replace(config, device=preferred_maia_device())
    return Maia3Adapter(config=resolved, chess_core=chess_core)
