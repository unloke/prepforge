from __future__ import annotations

import hashlib
import html
import json
import math
import mimetypes
import os
import re
import secrets
import threading
import uuid
from http.cookies import SimpleCookie
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color, MoveSource, TrainingMode
from prepforge_chess.services.analysis import (
    AnalysisCancelled,
    AnalysisConfig,
    AnalysisProgress,
    AnalysisService,
    CancellationToken,
)
from prepforge_chess.services.analysis_report import AnalysisReportBuilder
from prepforge_chess.services.brilliant import BrilliantAnalyzer, BrilliantConfig
from prepforge_chess.services.replay_maia import ReplayMaia
from prepforge_chess.services.app_settings import (
    AppSettingsService,
    STOCKFISH_DEPTH_DEFAULT,
    STOCKFISH_DEPTH_MAX,
    STOCKFISH_DEPTH_MIN,
    stockfish_status,
)
import chess
import chess.engine as _chess_engine
from prepforge_chess.services.device import has_cuda_gpu, preferred_maia_device
from prepforge_chess.services.engine import EngineAnalysisConfig, MockEngine, StockfishEngine
from prepforge_chess.services.lichess_fetch import (
    LichessFetchError,
    compare_recent_games,
    fetch_latest_games_meta,
    fetch_recent_pgns,
)
from prepforge_chess.services.lichess_oauth import (
    LichessOAuthError,
    build_authorize_url,
    code_challenge_for,
    exchange_code,
    fetch_username,
    generate_code_verifier,
    generate_state,
)
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.opening_generation import GenerateConfig
from prepforge_chess.services.maia import (
    MAIA3_DEFAULT_MODEL,
    MAIA3_DEFAULT_REPO,
    Maia3Adapter,
    create_maia3_adapter,
    ensure_maia3,
)
from prepforge_chess.services.pgn_import import PgnImportOptions, PgnImportService
from prepforge_chess.services.replay_engine import ReplayEngine, ReplayEngineError
from prepforge_chess.services.progress import compute_health, mastery_map
from prepforge_chess.services.repertoire_export import RepertoireExportService
from prepforge_chess.services.stockfish_download import (
    find_stockfish_executable,
    install_stockfish,
)
from prepforge_chess.services.training import TrainingService
from sqlalchemy import text

from prepforge_chess.storage.database import initialize_database
from prepforge_chess.storage.repositories import PrepForgeRepository


STATIC_DIR = Path(__file__).with_name("static")
DEFAULT_DB_PATH = Path("data") / "prepforge.sqlite3"
ENGINE_SESSION_MAX_MULTIPV = 5

# Runtime knob for the browser engine's ONNX weight base URL. The weights are
# CDN/object-store hosted and never shipped in the deploy image (see
# vite.config.js / docs/browser-engine-migration.md), so the browser resolves
# their base URL at RUNTIME. When this env var is set, the server renders it into
# a <script>window.__MAIA3_ASSET_BASE=...</script> in the served HTML documents,
# letting a committed-static deploy point the bundle at a CDN with NO rebuild --
# the production seam for resolveModelBase() in web-src/engine/maia3-smoke.js.
# Unset/empty -> the bundle falls back to the in-image /static/maia3/ (local dev,
# where a developer's git-ignored weights live).
# Per-browser session cookie that maps to a user_profiles row (multi-tenancy). We store
# only the SHA-256 of the token server-side, so a leaked DB never yields a usable cookie.
SESSION_COOKIE_NAME = "pf_session"


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


MAIA3_ASSET_BASE_ENV = "PREPFORGE_MAIA3_ASSET_BASE"


def _maia3_asset_base() -> str:
    return os.environ.get(MAIA3_ASSET_BASE_ENV, "").strip()


def _inject_asset_base(html_bytes: bytes) -> bytes:
    """Inject ``window.__MAIA3_ASSET_BASE`` (from the env) into an HTML document.

    No-op when the env var is unset, so local dev keeps the in-image
    /static/maia3/ fallback. The tag is placed right after ``<head>`` so it runs
    before the module scripts that read the global. The value is JSON-encoded and
    its ``</`` sequences are escaped to prevent a ``</script>`` breakout.
    """
    base = _maia3_asset_base()
    if not base:
        return html_bytes
    literal = json.dumps(base).replace("</", "<\\/")
    tag = "<script>window.__MAIA3_ASSET_BASE={0};</script>".format(literal).encode("utf-8")
    marker = b"<head>"
    idx = html_bytes.find(marker)
    if idx == -1:
        # No <head> (shouldn't happen for our docs) -- prepend so the global still
        # lands before any module script that reads it.
        return tag + html_bytes
    insert_at = idx + len(marker)
    return html_bytes[:insert_at] + tag + html_bytes[insert_at:]


# The developer's git-ignored ONNX weights live here (next to the manifest). A
# production build STRIPS the weights from static/maia3/ (they're CDN-hosted; see
# vite.config.js), so a locally-built tree has only the manifest. This is the source
# copy we fall back to so local runs serve the weights with no manual copying and no
# PREPFORGE_MAIA3_ASSET_BASE. In a pip-installed deploy there is no web-src/, so the
# directory simply doesn't exist and the fallback is a no-op (production uses the CDN).
DEV_MAIA3_DIR = Path(__file__).resolve().parents[3] / "web-src" / "public" / "maia3"


def _dev_maia3_fallback(rel_path: str) -> Optional[Path]:
    """Resolve a ``maia3/<file>`` request against the dev source weights dir, or None.

    Only maia3/* paths are eligible, the dir must exist, and the resolved file must
    stay inside it (traversal guard) and be a real file."""
    prefix = "maia3/"
    if not rel_path.startswith(prefix):
        return None
    if not DEV_MAIA3_DIR.is_dir():
        return None
    base = DEV_MAIA3_DIR.resolve()
    target = (base / rel_path[len(prefix):]).resolve()
    if target != base and base not in target.parents:
        return None
    return target if target.is_file() else None


# Explicit MIME types for the assets the browser-engine work will serve from
# STATIC_DIR (wasm/onnx/workers). mimetypes alone is unreliable for these on
# Windows, and a wrong type (e.g. text/plain for .wasm) breaks instantiation.
_STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}


def _static_mime(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _STATIC_MIME:
        return _STATIC_MIME[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


# Content-stable engine/model artifacts can be cached forever.
_IMMUTABLE_EXT = {".wasm", ".onnx", ".nnue"}
# Vite content-hashed bundle names, e.g. "index-D4f8aB12.js". Only these (not
# every file under assets/, which may hold icons/metadata) are safe to mark
# immutable -- the hash changes whenever the content does.
_HASHED_NAME = re.compile(r"-[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$")


def _cache_control(path: Path) -> str:
    if path.suffix.lower() in _IMMUTABLE_EXT or _HASHED_NAME.search(path.name):
        return "public, max-age=31536000, immutable"
    # App shell + unhashed/dev assets (index.html, app.js, styles.css, icons):
    # always revalidate so deploys/edits are picked up immediately.
    return "no-cache"


def _normalize_color(value: Optional[str]) -> Optional[str]:
    """Return 'white'/'black' if value names a side, else None."""
    if not value:
        return None
    lowered = str(value).strip().lower()
    return lowered if lowered in {"white", "black"} else None


def _engine_eval_to_json(ev) -> Optional[Dict[str, Any]]:
    """Serialize an EngineEvaluation (White-POV) for the build-load payload, or None.

    The browser Build Generate planner only needs null-vs-present to merge fill-only-
    when-null, but the full fields keep the payload self-describing for apply-plan.
    """
    if ev is None:
        return None
    return {
        "engine": ev.engine,
        "depth": ev.depth,
        "score_cp": ev.score_cp,
        "mate_in": ev.mate_in,
        "best_move_uci": ev.best_move_uci,
        "pv": list(ev.pv),
        "wdl": dict(ev.wdl) if ev.wdl else None,
    }


# Hard cap on a POST body. `_read_json` reads the whole body by Content-Length,
# so without this a single request could declare a huge length and force the
# server to allocate it — a trivial DoS on the public, untrusted endpoints
# (apply-plan especially). 2 MB sits well above every legitimate payload here
# (a rich repertoire import or a long game's positions are well under that).
MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024


DEMO_PGN = """
[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""


class BuildCancelled(RuntimeError):
    """Raised inside the build-generate progress callback to stop a running job."""


class ServerEngineDisabled(RuntimeError):
    """Raised when a server-side engine-compute endpoint is hit while disabled.

    Hard product rule: in the public/default flow the server must never run a
    chess engine — Stockfish/Maia compute happens in the browser. These APIs
    remain in the codebase for a future server/admin mode, gated behind
    ``PREPFORGE_SERVER_ENGINE_ENABLED`` (default off). Mapped to HTTP 403.
    """


class _InertEngine:
    """Metadata-only engine placeholder for CRUD/workspace builder usage.

    Ordinary repertoire editing (create/add-move/annotate/read) needs an
    ``OpeningBuilderService`` but no real engine compute. Loading Stockfish for
    those paths would pull a server-side engine dependency the public build must
    never touch, so we hand the builder this inert stand-in: it carries a name
    for repertoire metadata and refuses to analyse. Real generation goes through
    ``_create_compute_builder`` (gated behind ``_require_server_engine``).
    """

    name = "browser"

    def analyze_position(self, *args, **kwargs):
        raise ServerEngineDisabled(
            "Server-side engine compute is disabled. This builder was created "
            "for metadata/CRUD only; engine analysis runs in the browser."
        )

    def close(self) -> None:  # parity with real engines for _close_engine
        pass


class _InertMaia:
    """Metadata-only human-model placeholder, mirroring :class:`_InertEngine`.

    ``OpeningBuilderService`` requires a Maia adapter, but CRUD/workspace paths
    only read its ``name``. Building the real Maia3 adapter here would raise on
    deployments without the model installed (the public build) and pull a
    server-side dependency, so we inject this inert stand-in instead.
    """

    name = "browser"

    def predictions(self, *args, **kwargs):
        raise ServerEngineDisabled(
            "Server-side Maia compute is disabled. This builder was created for "
            "metadata/CRUD only; human-model prediction runs in the browser."
        )

    def move_assessment(self, *args, **kwargs):
        raise ServerEngineDisabled(
            "Server-side Maia compute is disabled. This builder was created for "
            "metadata/CRUD only; human-model prediction runs in the browser."
        )


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class AnalysisJob:
    id: str
    game_id: Optional[str] = None
    status: str = "queued"
    current_ply: int = 0
    total_plies: int = 0
    message: str = "queued"
    san: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    cancel_token: CancellationToken = field(default_factory=CancellationToken)

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            percent = 1.0 if self.total_plies <= 0 and self.status == "completed" else (
                0.0 if self.total_plies <= 0 else min(1.0, max(0.0, self.current_ply / self.total_plies))
            )
            return {
                "job_id": self.id,
                "kind": "analyze",
                "tab": "analyze",
                "game_id": self.game_id,
                "status": self.status,
                "current": self.current_ply,
                "total": self.total_plies,
                "current_ply": self.current_ply,
                "total_plies": self.total_plies,
                "percent": percent,
                "message": self.message,
                "san": self.san,
                "result": self.result,
                "error": self.error,
            }


@dataclass
class BuildJob:
    id: str
    repertoire_id: str
    node_id: str
    ply_depth: int
    detail_mode: str
    maia_rating: int
    own_color: Optional[str] = None
    status: str = "queued"
    added_nodes: int = 0
    estimated_total: int = 1
    message: str = "queued"
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    cancel_requested: bool = False

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            percent = 0.0
            if self.status == "completed":
                percent = 1.0
            elif self.estimated_total > 0:
                percent = min(0.99, self.added_nodes / float(self.estimated_total))
            return {
                "job_id": self.id,
                "kind": "build_generate",
                "tab": "build",
                "repertoire_id": self.repertoire_id,
                "node_id": self.node_id,
                "ply_depth": self.ply_depth,
                "detail_mode": self.detail_mode,
                "maia_rating": self.maia_rating,
                "status": self.status,
                "current": self.added_nodes,
                "total": self.estimated_total,
                "added_nodes": self.added_nodes,
                "estimated_total": self.estimated_total,
                "percent": percent,
                "message": self.message,
                "result": self.result,
                "error": self.error,
            }


class EngineSession:
    """Live engine analysis session that streams progressive PV updates.

    Owns one chess.engine subprocess for the duration of the session. The
    session iterates the engine's analysis stream in a worker thread and keeps
    the latest info-per-pv-rank so the client can poll a snapshot.
    """

    def __init__(
        self,
        session_id: str,
        engine_name: str,
        executable_path: str,
        *,
        options: Optional[Dict[str, Any]] = None,
    ):
        self.id = session_id
        self.engine_name = engine_name
        self.executable_path = executable_path
        self.options = dict(options or {})
        self._engine: Optional[_chess_engine.SimpleEngine] = None
        self._analysis = None
        self._worker: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._generation = 0
        self._state = {
            "fen": None,
            "side_to_move": "white",
            "multipv": 1,
            "max_depth": 24,
            "current_depth": 0,
            "pvs": [],
            "running": False,
            "error": None,
        }

    def open(self) -> None:
        self._engine = _chess_engine.SimpleEngine.popen_uci(self.executable_path)
        if self.options:
            try:
                self._engine.configure(self.options)
            except Exception:
                pass

    def update(self, *, fen: str, multipv: int, max_depth: int) -> None:
        with self._lock:
            self._generation += 1
            generation = self._generation
            self._stop_current_analysis_locked()
            try:
                board = chess.Board(fen)
            except ValueError as exc:
                self._state["error"] = str(exc)
                return
            self._state.update(
                {
                    "fen": fen,
                    "side_to_move": "white" if board.turn == chess.WHITE else "black",
                    "multipv": max(1, min(ENGINE_SESSION_MAX_MULTIPV, int(multipv))),
                    "max_depth": max(1, min(40, int(max_depth))),
                    "current_depth": 0,
                    "pvs": [],
                    "running": True,
                    "error": None,
                }
            )
            limit = _chess_engine.Limit(depth=self._state["max_depth"])
            self._analysis = self._engine.analysis(
                board,
                limit,
                multipv=self._state["multipv"],
                game=object(),
            )
            root_board = board.copy()
            self._worker = threading.Thread(
                target=self._consume_loop,
                args=(self._analysis, generation, root_board),
                name="prepforge-engine-{0}".format(self.id[:8]),
                daemon=True,
            )
            self._worker.start()

    def pause(self) -> None:
        with self._lock:
            self._stop_current_analysis_locked()
            self._state["running"] = False

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "session_id": self.id,
                "engine": self.engine_name,
                "fen": self._state["fen"],
                "side_to_move": self._state["side_to_move"],
                "multipv": self._state["multipv"],
                "max_depth": self._state["max_depth"],
                "current_depth": self._state["current_depth"],
                "pvs": list(self._state["pvs"]),
                "running": self._state["running"],
                "error": self._state["error"],
            }

    def close(self) -> None:
        with self._lock:
            self._generation += 1
            self._stop_current_analysis_locked()
            self._state["running"] = False
        engine = self._engine
        self._engine = None
        if engine is not None:
            try:
                engine.quit()
            except Exception:
                try:
                    engine.close()
                except Exception:
                    pass

    def _stop_current_analysis_locked(self) -> None:
        if self._analysis is not None:
            try:
                self._analysis.stop()
            except Exception:
                pass
        self._analysis = None
        self._worker = None

    def _consume_loop(
        self, analysis, generation: int, root_board: chess.Board
    ) -> None:
        # `analysis` is a SimpleAnalysisResult. Iterating yields one info dict
        # per engine update; we keep the latest per-pv-rank entry and the
        # newest reported depth, and convert the principal variation to SAN
        # so the client can show natural-language move lists.
        try:
            for info in analysis:
                if not isinstance(info, dict):
                    continue
                depth = info.get("depth")
                multipv_index = info.get("multipv", 1)
                score = info.get("score")
                pv_moves = info.get("pv") or []
                pv_uci = [move.uci() for move in pv_moves]
                pv_san = self._pv_san(root_board, pv_moves)
                score_cp = None
                mate_in = None
                if score is not None:
                    # Always report from White's perspective so a Black
                    # advantage reads negative, matching the rest of the app.
                    pov = score.white()
                    mate_in = pov.mate()
                    score_cp = pov.score(mate_score=100000)
                with self._lock:
                    if generation != self._generation or not self._state["running"]:
                        break
                    if depth is not None and depth > self._state["current_depth"]:
                        self._state["current_depth"] = depth
                    pvs = self._state["pvs"]
                    # Ensure list has slot for this multipv index.
                    while len(pvs) < multipv_index:
                        pvs.append(
                            {
                                "rank": len(pvs) + 1,
                                "depth": depth or 0,
                                "score_cp": None,
                                "mate_in": None,
                                "pv_uci": [],
                                "pv_san": [],
                            }
                        )
                    pvs[multipv_index - 1] = {
                        "rank": multipv_index,
                        "depth": depth or 0,
                        "score_cp": score_cp,
                        "mate_in": mate_in,
                        "pv_uci": pv_uci,
                        "pv_san": pv_san,
                    }
                if depth is not None and depth >= self._state["max_depth"]:
                    with self._lock:
                        if generation == self._generation:
                            self._state["running"] = False
                    break
        except Exception as exc:
            with self._lock:
                if generation == self._generation:
                    self._state["error"] = str(exc)
                    self._state["running"] = False
        finally:
            with self._lock:
                if generation == self._generation:
                    self._state["running"] = False

    def _pv_san(self, root: chess.Board, pv_moves) -> List[str]:
        if not pv_moves:
            return []
        board = root.copy()
        san_moves: List[str] = []
        for move in pv_moves:
            try:
                san_moves.append(board.san(move))
                board.push(move)
            except (ValueError, AssertionError):
                break
        return san_moves


class PrepForgeWebApp:
    def __init__(
        self,
        db_path: Path = DEFAULT_DB_PATH,
        *,
        prefer_real_engines: bool = True,
        server_engine_enabled: Optional[bool] = None,
        maia_factory: Optional[Callable[[], Any]] = None,
    ):
        self.db_path = Path(db_path)
        self.engine = initialize_database(self.db_path)
        self.repository = PrepForgeRepository(self.engine)
        self.chess_core = ChessCore()
        self.settings = AppSettingsService(self.engine)
        self.prefer_real_engines = prefer_real_engines
        # Hard product rule: no server-side engine compute in the public flow.
        # All Stockfish/Maia work runs in the browser. The server engine APIs
        # stay for a future server/admin mode, off unless explicitly enabled
        # (env PREPFORGE_SERVER_ENGINE_ENABLED, or the constructor override).
        self.server_engine_enabled = (
            _env_flag("PREPFORGE_SERVER_ENGINE_ENABLED", False)
            if server_engine_enabled is None
            else bool(server_engine_enabled)
        )
        # Compute paths build a Maia adapter through this factory. Production
        # defaults to the real Maia3 (which fails loudly when the model is not
        # installed — no silent mock fallback, see ``create_maia3_adapter``).
        # Tests that exercise the gated generate paths inject a deterministic
        # stub here so they run without the model, mirroring how
        # ``prefer_real_engines=False`` swaps Stockfish for ``MockEngine``.
        self._maia_factory: Callable[[], Any] = maia_factory or (
            lambda: create_maia3_adapter(chess_core=self.chess_core)
        )
        self.analysis_jobs: Dict[str, AnalysisJob] = {}
        self.analysis_jobs_lock = threading.Lock()
        self.build_jobs: Dict[str, BuildJob] = {}
        self.build_jobs_lock = threading.Lock()
        # Heavy-engine jobs run one at a time so a user's machine isn't
        # overwhelmed. The floating engine widget owns a separate live session
        # and must not reserve this global Analyze/Build slot.
        self.heavy_job_lock = threading.Lock()
        self.heavy_job_kind: Optional[str] = None
        self.heavy_job_id: Optional[str] = None
        self.engine_session: Optional["EngineSession"] = None
        self.engine_session_lock = threading.Lock()
        # Maia3 model is expensive to load; share one instance for Brilliant.
        self._brilliant_maia_adapter = None
        self._brilliant_maia_lock = threading.Lock()

    def _require_server_engine(self) -> None:
        if not self.server_engine_enabled:
            raise ServerEngineDisabled(
                "Server-side engine compute is disabled. Chess analysis runs in "
                "your browser. (Operators may set PREPFORGE_SERVER_ENGINE_ENABLED=1 "
                "to enable the server/admin engine APIs.)"
            )

    def settings_payload(self) -> Dict[str, Any]:
        path = find_stockfish_executable()
        status = stockfish_status(path)
        gpu = has_cuda_gpu()
        return {
            "gpu": {"cuda_available": gpu},
            "stockfish": {
                "path": status.path,
                "version": status.version,
                "error": status.error,
                "installed": bool(status.path),
            },
            "maia3": {
                "model": MAIA3_DEFAULT_MODEL,
                "repo": MAIA3_DEFAULT_REPO,
                "package_installed": Maia3Adapter.is_available(),
                "device": preferred_maia_device() if Maia3Adapter.is_available() else None,
                # Brilliant detection (human policy + value glance) runs on Maia3.
                "brilliant_ready": Maia3Adapter.is_available(),
            },
            "server_engine_enabled": self.server_engine_enabled,
            "stockfish_depth": self.settings.get_stockfish_depth(),
            "stockfish_depth_range": {
                "min": STOCKFISH_DEPTH_MIN,
                "max": STOCKFISH_DEPTH_MAX,
                "default": STOCKFISH_DEPTH_DEFAULT,
            },
        }

    def update_settings_payload(self, *, stockfish_depth: Optional[int] = None) -> Dict[str, Any]:
        if stockfish_depth is not None:
            self.settings.set_stockfish_depth(int(stockfish_depth))
        return self.settings_payload()

    def install_stockfish_payload(self) -> Dict[str, Any]:
        self._require_server_engine()
        result = install_stockfish()
        status = stockfish_status(result.executable_path)
        return {
            "path": result.executable_path,
            "version": status.version,
            "already_present": result.already_present,
            "asset": result.asset.asset_name if result.asset else None,
        }

    def install_maia3_payload(self) -> Dict[str, Any]:
        self._require_server_engine()
        return ensure_maia3()

    def _engine_config(self, *, multipv: int = 1) -> EngineAnalysisConfig:
        return EngineAnalysisConfig(depth=self.settings.get_stockfish_depth(), multipv=multipv)

    def _create_primary_engine(self):
        if self.prefer_real_engines:
            path = find_stockfish_executable()
            if path:
                return StockfishEngine(path)
        return MockEngine()

    def _brilliant_maia(self):
        """Shared Maia3 adapter powering Brilliant detection (human policy +
        value glance). Loaded once and reused. None if Maia3 isn't installed."""
        if not Maia3Adapter.is_available():
            return None
        with self._brilliant_maia_lock:
            if self._brilliant_maia_adapter is None:
                self._brilliant_maia_adapter = create_maia3_adapter(
                    chess_core=self.chess_core
                )
            return self._brilliant_maia_adapter

    def _analysis_worker_count(self, total_plies: int) -> int:
        if not self.prefer_real_engines or not find_stockfish_executable():
            return 1
        cpu_count = os.cpu_count() or 2
        hard_cap = min(8, max(1, cpu_count))
        if total_plies < 4:
            return 1
        depth = self.settings.get_stockfish_depth()
        high_depth = depth >= 18

        def capped(count: int) -> int:
            return max(1, min(count, hard_cap, max(1, total_plies)))

        if total_plies < 12:
            return capped(4 if high_depth else 2)
        if total_plies < 30:
            return capped(4 if high_depth else 2)
        if total_plies < 70:
            return capped(6 if high_depth else 4)
        return capped(8)

    def _create_builder(self, *, engine=None, maia=None) -> OpeningBuilderService:
        """Builder for CRUD/workspace operations (create/edit/read/export).

        These paths never compute, so by default we inject inert metadata-only
        adapters rather than a real Stockfish/Maia. That keeps ordinary
        repertoire editing free of server-side engine dependencies and stops it
        from raising on deployments where Maia3 isn't installed (the public
        build). Compute paths must use ``_create_compute_builder`` instead.
        """
        return OpeningBuilderService(
            self.repository,
            chess_core=self.chess_core,
            engine=engine or _InertEngine(),
            engine_config=self._engine_config(),
            maia=maia or _InertMaia(),
        )

    def _create_compute_builder(self) -> OpeningBuilderService:
        """Builder wired with the server-side engine + Maia for generation.

        Only for admin-enabled generate paths. Callers MUST gate on
        ``_require_server_engine()`` first so the public build never reaches the
        engine/model construction below. The engine honors ``prefer_real_engines``
        (real Stockfish vs ``MockEngine``) and the Maia comes from
        ``self._maia_factory`` (real Maia3 in production, an injected stub in tests).
        """
        return self._create_builder(
            engine=self._create_primary_engine(),
            maia=self._maia_factory(),
        )

    def _close_engine(self, engine) -> None:
        close = getattr(engine, "close", None)
        if callable(close):
            close()

    def dashboard_payload(self, owner_user_id: Optional[str] = None) -> Dict[str, Any]:
        games = self.repository.list_games(owner_user_id=owner_user_id)
        repertoires = self.repository.list_repertoires(owner_user_id=owner_user_id)
        # Training counters are owner-scoped through repertoire ownership (the reliable
        # owner link: training_sessions has no owner column, and training_progress's
        # user_profile_id is nullable). Unscoped (owner None) keeps the global totals.
        now_iso = datetime.now(timezone.utc).isoformat()
        with self.engine.connect() as conn:
            if owner_user_id is None:
                session_count = conn.execute(
                    text("SELECT COUNT(*) AS count FROM training_sessions")
                ).scalar_one()
                mistake_count = conn.execute(
                    text(
                        "SELECT COUNT(*) AS count FROM training_progress "
                        "WHERE attempts > correct_attempts"
                    )
                ).scalar_one()
                due_count = conn.execute(
                    text(
                        "SELECT COUNT(*) AS count FROM training_progress "
                        "WHERE due_at IS NOT NULL AND due_at <= :now"
                    ),
                    {"now": now_iso},
                ).scalar_one()
            else:
                session_count = conn.execute(
                    text(
                        "SELECT COUNT(*) AS count FROM training_sessions ts "
                        "JOIN repertoires r ON r.id = ts.repertoire_id "
                        "WHERE r.user_profile_id = :owner"
                    ),
                    {"owner": owner_user_id},
                ).scalar_one()
                mistake_count = conn.execute(
                    text(
                        "SELECT COUNT(*) AS count FROM training_progress tp "
                        "JOIN repertoires r ON r.id = tp.repertoire_id "
                        "WHERE tp.attempts > tp.correct_attempts AND r.user_profile_id = :owner"
                    ),
                    {"owner": owner_user_id},
                ).scalar_one()
                due_count = conn.execute(
                    text(
                        "SELECT COUNT(*) AS count FROM training_progress tp "
                        "JOIN repertoires r ON r.id = tp.repertoire_id "
                        "WHERE tp.due_at IS NOT NULL AND tp.due_at <= :now "
                        "AND r.user_profile_id = :owner"
                    ),
                    {"now": now_iso, "owner": owner_user_id},
                ).scalar_one()
        return {
            "games": len(games),
            "repertoires": len(repertoires),
            "training_sessions": session_count,
            "open_mistakes": mistake_count,
            "due_reviews": due_count,
            "recommendations": [
                "Next action: analyze a PGN and review classifications.",
                "Next action: generate or extend one repertoire branch in Build.",
                "Next action: start a trainer session from an imported repertoire package.",
            ],
        }

    def analyze_demo_payload(self) -> Dict[str, Any]:
        return self.analyze_pgn_payload(DEMO_PGN)

    def analyze_pgn_payload(
        self, pgn_text: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._require_server_engine()
        game_id = self._import_pgn_for_analysis(pgn_text, owner_user_id)
        self._claim_or_verify_game(game_id, owner_user_id)
        result = self._run_analysis_for_game_id(game_id)
        return self._analysis_payload(result)

    # ---- Browser analysis (Phase 2): server classifies, browser computes -----
    # These two endpoints run NO engine, so they are intentionally NOT gated by
    # _require_server_engine(): the browser computes every eval, the server only
    # imports the PGN, classifies the supplied evals, and persists.

    def prepare_analysis_payload(
        self, pgn_text: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Import a PGN and return the positions the browser must evaluate.

        ``positions`` is every distinct ``fen_before`` plus the final
        ``fen_after`` — the complete set the classifier needs, since
        ``fen_after(N) == fen_before(N+1)``.
        """
        # Import is owner-scoped: dedup looks only at this browser's own games and the
        # saved row is stamped with the owner, so importing a game another user already
        # has yields an independent copy instead of bouncing to their (foreign) game.
        game_id = self._import_pgn_for_analysis(pgn_text, owner_user_id)
        # Defensive: confirm the resulting game belongs to this owner.
        self._claim_or_verify_game(game_id, owner_user_id)
        game = self.repository.load_game(game_id)
        if game is None:
            raise ValueError("game not found after import: {0}".format(game_id))

        positions: List[str] = []
        seen = set()

        def _add(fen: str) -> None:
            if fen and fen not in seen:
                seen.add(fen)
                positions.append(fen)

        moves_skeleton: List[Dict[str, Any]] = []
        for move in game.moves:
            _add(move.fen_before)
            moves_skeleton.append(
                {
                    "ply": move.ply,
                    "move_number": move.move_number,
                    "side": move.side_to_move.value,
                    "san": move.san,
                    "uci": move.uci,
                    "fen_before": move.fen_before,
                    "fen_after": move.fen_after,
                }
            )
        if game.moves:
            _add(game.moves[-1].fen_after)

        return {
            "game_id": game_id,
            "engine": "stockfish (browser)",
            "depth": self.settings.get_stockfish_depth(),
            "positions": positions,
            "moves": moves_skeleton,
            # Phase 3d: the rating the browser must use for Brilliant move_assessment
            # so its (humanProbability, winChanceAfter) match what the server's
            # BrilliantAnalyzer expects (ReplayMaia ignores rating server-side, so the
            # client owns getting it right). Browser computes assessments iff its Maia
            # is available; otherwise it omits them and no move is flagged Brilliant.
            "brilliant": {
                "enabled": BrilliantConfig().enabled,
                "rating": BrilliantConfig().rating,
            },
        }

    def _brilliant_analyzer_from_client(
        self, maia_assessments: Optional[List[Dict[str, Any]]]
    ) -> Optional[BrilliantAnalyzer]:
        """Build a BrilliantAnalyzer over browser-supplied move assessments, or None.

        Validates the untrusted payload (this endpoint is ungated/public): each
        item needs a FEN + UCI string and finite ``human_probability`` /
        ``win_chance_after`` in [0, 1]. A malformed item raises ValueError → 400.
        Empty/omitted → None (no Brilliant detection, the Phase-2 behaviour).
        """
        if not maia_assessments:
            return None
        if not isinstance(maia_assessments, list):
            raise ValueError("maia_assessments must be a list")
        # Cap to bound the untrusted payload (one assessment per ply; a long game is
        # well under this — same spirit as MAX_PLAN_CHANGES on apply-plan).
        if len(maia_assessments) > 1000:
            raise ValueError("too many maia_assessments (max 1000)")
        cleaned: List[Dict[str, Any]] = []
        for item in maia_assessments:
            if not isinstance(item, dict):
                raise ValueError("each maia_assessment must be an object")
            fen = item.get("fen")
            uci = item.get("uci")
            if not fen or not isinstance(fen, str):
                raise ValueError("each maia_assessment requires a fen string")
            if not uci or not isinstance(uci, str):
                raise ValueError("each maia_assessment requires a uci string")
            for key in ("human_probability", "win_chance_after"):
                value = item.get(key)
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    raise ValueError("maia_assessment {0} must be a number".format(key))
                if not math.isfinite(value) or value < 0.0 or value > 1.0:
                    raise ValueError("maia_assessment {0} must be in [0, 1]".format(key))
            cleaned.append(item)
        replay_maia = ReplayMaia(cleaned, chess_core=self.chess_core)
        return BrilliantAnalyzer(maia=replay_maia)

    def classify_save_payload(
        self,
        *,
        game_id: str,
        engine: str = "stockfish (browser)",
        depth: Optional[int] = None,
        positions: Optional[List[Dict[str, Any]]] = None,
        maia_assessments: Optional[List[Dict[str, Any]]] = None,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Classify + persist a game from browser-computed per-position evals.

        Reuses the full AnalysisService pipeline via a ReplayEngine seeded with
        the client's evals, so classification/report/persistence stay identical
        to the server-engine path.

        Phase 3d: when the browser also sends ``maia_assessments`` (one
        ``move_assessment`` per played move it could evaluate), a ReplayMaia feeds
        them into the SAME validated BrilliantAnalyzer, so Brilliant detection runs
        with zero server compute. Omitted/empty → no Brilliant detection (the
        Phase-2 behaviour), e.g. when the browser has no Maia.
        """
        if not game_id:
            raise ValueError("game_id is required")
        # Persisting analysis is a write to the game; gate it on ownership so a browser
        # can't classify-save into another profile's game by passing its id.
        self._claim_or_verify_game(game_id, owner_user_id)
        if not isinstance(positions, list):
            raise ValueError("positions must be a list")
        position_map: Dict[str, Dict[str, Any]] = {}
        for item in positions:
            if not isinstance(item, dict):
                raise ValueError("each position must be an object")
            fen = item.get("fen")
            if not fen or not isinstance(fen, str):
                raise ValueError("each position requires a fen string")
            position_map[fen] = item
        if not position_map:
            raise ValueError("positions are required")

        engine_name = (engine or "stockfish (browser)").strip() or "stockfish (browser)"
        resolved_depth = int(depth) if depth is not None else self.settings.get_stockfish_depth()
        resolved_depth = max(1, min(resolved_depth, 60))

        brilliant_analyzer = self._brilliant_analyzer_from_client(maia_assessments)

        replay = ReplayEngine(position_map, name=engine_name, chess_core=self.chess_core)
        service = AnalysisService(
            self.repository,
            engine=replay,
            engine_name=engine_name,
            brilliant_analyzer=brilliant_analyzer,
        )
        try:
            result = service.analyze_game_id(
                game_id,
                config=AnalysisConfig(
                    engine=EngineAnalysisConfig(depth=resolved_depth, multipv=1),
                    max_workers=1,
                    persist=True,
                ),
            )
        except ReplayEngineError as exc:
            # Incomplete client payload (a position was never evaluated).
            raise ValueError(str(exc))
        return self._analysis_payload(result)

    def _try_acquire_heavy_job(self, kind: str, job_id: str) -> None:
        """Reserve the single heavy-job slot. Raises if another job is active."""
        if not self.heavy_job_lock.acquire(blocking=False):
            raise ValueError(
                "Another job ({0}) is already running; let it finish first.".format(
                    self.heavy_job_kind or "engine"
                )
            )
        self.heavy_job_kind = kind
        self.heavy_job_id = job_id

    def _release_heavy_job(self) -> None:
        self.heavy_job_kind = None
        self.heavy_job_id = None
        try:
            self.heavy_job_lock.release()
        except RuntimeError:
            pass

    def heavy_job_status(self) -> Dict[str, Any]:
        return {
            "active": self.heavy_job_id is not None,
            "kind": self.heavy_job_kind,
            "job_id": self.heavy_job_id,
        }

    def start_analysis_payload(
        self, pgn_text: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._require_server_engine()
        game_id = self._import_pgn_for_analysis(pgn_text, owner_user_id)
        self._claim_or_verify_game(game_id, owner_user_id)
        job = AnalysisJob(id=str(uuid.uuid4()), game_id=game_id)
        game = self.repository.load_game(game_id)
        if game is not None:
            job.total_plies = len(game.moves)
        self._try_acquire_heavy_job("analyze", job.id)
        with self.analysis_jobs_lock:
            self.analysis_jobs[job.id] = job

        thread = threading.Thread(
            target=self._run_analysis_job,
            args=(job.id,),
            name="prepforge-analysis-{0}".format(job.id[:8]),
            daemon=True,
        )
        thread.start()
        return job.snapshot()

    def start_build_generate_payload(
        self,
        *,
        repertoire_id: str,
        node_id: str,
        ply_depth: int = 8,
        detail_mode: str = "balanced",
        maia_rating: int = 2200,
        own_color: Optional[str] = None,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        # Engine gate first (uniform 403 on the no-compute deploy), then owner gate
        # before queuing the async job.
        self._require_server_engine()
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        mode = (detail_mode or "balanced").lower()
        if mode not in {"simple", "balanced", "deep"}:
            raise ValueError("detail_mode must be one of simple, balanced, deep")
        clamped_depth = max(1, min(int(ply_depth), 20))
        # Pessimistic estimate: assume a wide branching factor so the bar
        # spends most of its life under-promising. The job adjusts up on the
        # fly if reality exceeds the estimate.
        per_ply = {"simple": 3, "balanced": 8, "deep": 12}[mode]
        estimated_total = max(8, clamped_depth * per_ply)
        job = BuildJob(
            id=str(uuid.uuid4()),
            repertoire_id=repertoire_id,
            node_id=node_id,
            ply_depth=clamped_depth,
            detail_mode=mode,
            maia_rating=max(600, min(int(maia_rating), 2600)),
            own_color=_normalize_color(own_color),
            estimated_total=estimated_total,
        )
        self._try_acquire_heavy_job("build_generate", job.id)
        with self.build_jobs_lock:
            self.build_jobs[job.id] = job

        thread = threading.Thread(
            target=self._run_build_generate_job,
            args=(job.id,),
            name="prepforge-build-{0}".format(job.id[:8]),
            daemon=True,
        )
        thread.start()
        return job.snapshot()

    def build_generate_status_payload(self, job_id: str) -> Dict[str, Any]:
        with self.build_jobs_lock:
            job = self.build_jobs.get(job_id)
        if job is None:
            raise ValueError("build job not found: {0}".format(job_id))
        return job.snapshot()

    def cancel_analysis_payload(self, job_id: str) -> Dict[str, Any]:
        with self.analysis_jobs_lock:
            job = self.analysis_jobs.get(job_id)
        if job is None:
            raise ValueError("analysis job not found: {0}".format(job_id))
        job.cancel_token.cancel()
        with job.lock:
            if job.status in ("queued", "running", "finalizing"):
                job.message = "Stopping..."
        return {"ok": True, "job_id": job_id, "cancelling": True}

    def cancel_build_generate_payload(self, job_id: str) -> Dict[str, Any]:
        with self.build_jobs_lock:
            job = self.build_jobs.get(job_id)
        if job is None:
            raise ValueError("build job not found: {0}".format(job_id))
        with job.lock:
            job.cancel_requested = True
            if job.status in ("queued", "running"):
                job.message = "Stopping..."
        return {"ok": True, "job_id": job_id, "cancelling": True}

    # ---- Engine widget session --------------------------------------------

    def engine_session_open_payload(
        self,
        *,
        fen: str,
        multipv: int = 1,
        engine: str = "stockfish",
    ) -> Dict[str, Any]:
        self._require_server_engine()
        if not fen:
            raise ValueError("fen is required")
        max_depth = self.settings.get_stockfish_depth()
        with self.engine_session_lock:
            if self.engine_session is not None:
                self.engine_session.update(
                    fen=fen, multipv=multipv, max_depth=max_depth
                )
                return self.engine_session.snapshot()
            executable, engine_name, options = self._resolve_engine_executable(engine)
            session_id = str(uuid.uuid4())
            session = EngineSession(
                session_id, engine_name, executable, options=options
            )
            session.open()
            self.engine_session = session
        # Kick off the first analysis outside the session lock since update()
        # takes its own internal lock.
        self.engine_session.update(fen=fen, multipv=multipv, max_depth=max_depth)
        return self.engine_session.snapshot()

    def engine_session_update_payload(
        self, *, fen: str, multipv: int = 1
    ) -> Dict[str, Any]:
        self._require_server_engine()
        with self.engine_session_lock:
            session = self.engine_session
        if session is None:
            return self.engine_session_open_payload(fen=fen, multipv=multipv)
        max_depth = self.settings.get_stockfish_depth()
        session.update(fen=fen, multipv=multipv, max_depth=max_depth)
        return session.snapshot()

    def engine_session_snapshot_payload(self) -> Dict[str, Any]:
        with self.engine_session_lock:
            session = self.engine_session
        if session is None:
            return {"session_id": None, "running": False, "pvs": []}
        return session.snapshot()

    def engine_session_pause_payload(self) -> Dict[str, Any]:
        with self.engine_session_lock:
            session = self.engine_session
        if session is None:
            return {"session_id": None, "running": False, "pvs": []}
        session.pause()
        return session.snapshot()

    def engine_session_close_payload(self) -> Dict[str, Any]:
        with self.engine_session_lock:
            session = self.engine_session
            self.engine_session = None
        if session is None:
            return {"closed": True}
        session.close()
        return {"closed": True, "session_id": session.id}

    def _resolve_engine_executable(self, name: str):
        # Stockfish is the only selectable analysis engine.
        del name
        path = find_stockfish_executable()
        if not path:
            raise ValueError("Stockfish is not installed. Use Settings → Install Stockfish.")
        return path, "stockfish", {}

    def analysis_status_payload(self, job_id: str) -> Dict[str, Any]:
        with self.analysis_jobs_lock:
            job = self.analysis_jobs.get(job_id)
        if job is None:
            raise ValueError("analysis job not found: {0}".format(job_id))
        return job.snapshot()

    def _import_pgn_for_analysis(
        self, pgn_text: str, owner_user_id: Optional[str] = None
    ) -> str:
        if not pgn_text.strip():
            raise ValueError("PGN text is empty")
        import_result = PgnImportService(self.repository).import_text(
            pgn_text,
            PgnImportOptions(skip_duplicate_lichess_games=True),
            owner_user_id=owner_user_id,
        )
        if import_result.errors:
            raise ValueError("; ".join(import_result.errors))
        game_ids = import_result.imported_game_ids or import_result.skipped_game_ids
        if not game_ids:
            raise ValueError("No game imported.")
        game_id = game_ids[0]
        return game_id

    def _run_analysis_job(self, job_id: str) -> None:
        with self.analysis_jobs_lock:
            job = self.analysis_jobs[job_id]
        try:
            def progress_callback(progress: AnalysisProgress) -> None:
                with job.lock:
                    job.status = "running" if progress.phase != "completed" else "finalizing"
                    if progress.phase == "started":
                        job.current_ply = 0
                    elif progress.phase == "move_complete":
                        job.current_ply = max(job.current_ply, progress.current_ply)
                    elif progress.phase == "completed":
                        job.current_ply = progress.total_plies
                    job.total_plies = progress.total_plies
                    job.san = progress.san
                    job.message = progress.message or progress.phase

            result = self._run_analysis_for_game_id(
                job.game_id or "", progress_callback, cancel_token=job.cancel_token
            )
            payload = self._analysis_payload(result)
            with job.lock:
                job.status = "completed"
                job.current_ply = len(result.move_results)
                job.total_plies = len(result.move_results)
                job.message = "analysis completed"
                job.result = payload
        except AnalysisCancelled:
            with job.lock:
                job.status = "cancelled"
                job.message = "Analysis stopped"
        except Exception as exc:
            with job.lock:
                job.status = "failed"
                job.error = str(exc)
                job.message = str(exc)
        finally:
            self._release_heavy_job()

    def _run_build_generate_job(self, job_id: str) -> None:
        with self.build_jobs_lock:
            job = self.build_jobs[job_id]
        # Gated upstream by start_build_generate_payload -> _require_server_engine.
        builder = self._create_compute_builder()

        def progress_callback(event: str, *, added: int, total_hint: int) -> None:
            # Cooperative cancellation: the builder calls this after every node
            # it adds, so raising here unwinds the generation cleanly and the
            # finally-block below tears down the engine subprocess.
            if job.cancel_requested:
                raise BuildCancelled("Generation stopped")
            with job.lock:
                job.status = "running" if event != "completed" else job.status
                job.added_nodes = added
                if total_hint > job.estimated_total:
                    # Slide the goalpost so the bar never overshoots before
                    # the job finishes; we still finish at 100% on completion.
                    job.estimated_total = int(total_hint * 1.1)
                if event == "started":
                    job.message = "generating moves"
                elif event == "node_added":
                    job.message = "+{0} nodes".format(added)

        try:
            _repertoire, summary = builder.generate_from_node(
                job.repertoire_id,
                job.node_id,
                GenerateConfig(
                    ply_depth=job.ply_depth,
                    detail_mode=job.detail_mode,
                    maia_rating=job.maia_rating,
                    own_color=Color(job.own_color) if job.own_color else None,
                ),
                progress_callback=progress_callback,
            )
            workspace = self._build_workspace_payload(
                job.repertoire_id,
                selected_node_id=job.node_id,
                summary={
                    "added_nodes": summary.added_nodes,
                    "updated_nodes": summary.updated_nodes,
                    "high_probability_unprepared": summary.high_probability_unprepared,
                },
            )
            with job.lock:
                job.status = "completed"
                job.added_nodes = summary.added_nodes
                # Finalize the estimate so percent reads exactly 100%.
                job.estimated_total = max(job.estimated_total, summary.added_nodes, 1)
                job.message = "added {0} new nodes".format(summary.added_nodes)
                job.result = workspace
        except BuildCancelled:
            with job.lock:
                job.status = "cancelled"
                job.message = "Generation stopped (+{0} kept)".format(job.added_nodes)
        except Exception as exc:
            with job.lock:
                job.status = "failed"
                job.error = str(exc)
                job.message = str(exc)
        finally:
            self._close_engine(builder.engine)
            self._release_heavy_job()

    def _run_analysis_for_game_id(
        self,
        game_id: str,
        progress_callback=None,
        cancel_token: Optional[CancellationToken] = None,
    ):
        game = self.repository.load_game(game_id)
        total_plies = len(game.moves) if game is not None else 0
        stockfish_path = find_stockfish_executable() if self.prefer_real_engines else None
        maia = self._brilliant_maia()
        engine = None
        try:
            workers = self._analysis_worker_count(total_plies)
            # Brilliant detection uses Maia3 (human policy + value glance) plus
            # the Stockfish truth from the main analysis evals; without Maia3,
            # no brilliancies.
            brilliant_analyzer = (
                BrilliantAnalyzer(maia=maia) if maia is not None else None
            )
            if stockfish_path and workers > 1:
                service = AnalysisService(
                    self.repository,
                    engine_factory=lambda: StockfishEngine(stockfish_path),
                    engine_name="stockfish",
                    brilliant_analyzer=brilliant_analyzer,
                )
            else:
                engine = StockfishEngine(stockfish_path) if stockfish_path else self._create_primary_engine()
                service = AnalysisService(
                    self.repository,
                    engine=engine,
                    brilliant_analyzer=brilliant_analyzer,
                )

            return service.analyze_game_id(
                game_id,
                config=AnalysisConfig(
                    engine=self._engine_config(multipv=1),
                    max_workers=workers,
                    persist=True,
                ),
                progress_callback=progress_callback,
                cancel_token=cancel_token,
            )
        finally:
            self._close_engine(engine)
            # The shared Maia3 adapter is reused across jobs — do not close it.

    def _analysis_payload(self, result) -> Dict[str, Any]:
        report = AnalysisReportBuilder().build(result)
        return {
            "game_id": result.game_id,
            "engine": result.engine,
            "depth": result.depth,
            "summary": result.summary,
            "moves": [
                {
                    "ply": move.ply,
                    "move_number": move.move_number,
                    "side": move.side_to_move.value,
                    "san": move.san,
                    "uci": move.uci,
                    "fen_before": move.fen_before,
                    "fen_after": move.fen_after,
                    "classification": move.classification.value,
                    "best_move_uci": move.best_move_uci,
                    "score_cp": move.engine_eval_after.score_cp
                    if move.engine_eval_after is not None
                    else None,
                    "comment": move.comment,
                }
                for move in result.move_results
            ],
            "eval_graph": [
                {
                    "ply": point.ply,
                    "san": point.san,
                    "score_cp": point.score_cp,
                    "bounded_score_cp": point.bounded_score_cp,
                    "classification": point.classification.value,
                }
                for point in report.eval_graph
            ],
            "critical_moments": [
                {
                    "ply": moment.ply,
                    "san": moment.san,
                    "classification": moment.classification.value,
                    "best_move_uci": moment.best_move_uci,
                    "score_cp": moment.score_cp,
                    "comment": moment.comment,
                }
                for moment in report.critical_moments
            ],
        }

    def build_demo_payload(self) -> Dict[str, Any]:
        self._require_server_engine()
        builder = self._create_compute_builder()
        try:
            repertoire = builder.create_repertoire(
                CreateRepertoireRequest(
                    name="UI Demo Repertoire",
                    color=Color.WHITE,
                    notes="Generated from the local web UI.",
                )
            )
            repertoire, summary = builder.generate_from_node(
                repertoire.id,
                repertoire.root_node.id,
                GenerateConfig(depth_plies=3, max_new_nodes=12, own_side_candidate_count=1),
            )
        finally:
            self._close_engine(builder.engine)
        return self._build_workspace_payload(repertoire.id, selected_node_id=repertoire.root_node.id, summary={
            "added_nodes": summary.added_nodes,
            "updated_nodes": summary.updated_nodes,
            "high_probability_unprepared": summary.high_probability_unprepared,
        })

    def create_repertoire_payload(
        self, name: str, color: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        cleaned = (name or "").strip() or "Untitled repertoire"
        try:
            chosen_color = Color(color)
        except ValueError:
            raise ValueError("color must be 'white' or 'black'")
        builder = self._create_builder()
        repertoire = builder.create_repertoire(
            CreateRepertoireRequest(name=cleaned, color=chosen_color)
        )
        self._claim_repertoire(repertoire.id, owner_user_id)
        return self._build_workspace_payload(
            repertoire.id,
            selected_node_id=repertoire.root_node.id,
        )

    def delete_repertoire_payload(
        self, repertoire_id: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        # Owner gate: another user's repertoire is not-found to this caller.
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_builder()
        builder.remove_repertoire(repertoire_id)
        return {"deleted": repertoire_id}

    def set_repertoire_active_payload(
        self, repertoire_id: str, active: bool, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_builder()
        repertoire = builder.set_repertoire_active(repertoire_id, active)
        return {
            "id": repertoire.id,
            "name": repertoire.name,
            "is_active": repertoire.is_active,
        }

    def import_pgn_repertoire_payload(
        self,
        *,
        pgn_text: str,
        name: str,
        color: str,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            chosen_color = Color(color)
        except ValueError:
            raise ValueError("color must be 'white' or 'black'")
        repertoire = RepertoireExportService().import_tree_pgn(
            pgn_text, name=name, color=chosen_color
        )
        self.repository.save_repertoire(repertoire, owner_user_id=owner_user_id)
        return self._build_workspace_payload(
            repertoire.id,
            selected_node_id=repertoire.root_node.id,
        )

    def export_tree_pgn_payload(
        self, repertoire_id: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        repertoire = self._load_repertoire_or_raise(repertoire_id, owner_user_id=owner_user_id)
        content = RepertoireExportService().export_tree_pgn(repertoire)
        safe_name = "".join(
            char if char.isalnum() or char in {"-", "_"} else "-"
            for char in repertoire.name.lower()
        ).strip("-") or "repertoire"
        return {
            "filename": "{0}.tree.pgn".format(safe_name),
            "mime": "application/x-chess-pgn",
            "content": content,
        }

    def lichess_compare_payload(
        self,
        username: str,
        count: int,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            summaries = compare_recent_games(
                self.repository, username, count, owner_user_id=owner_user_id
            )
        except LichessFetchError as exc:
            raise ValueError(str(exc))
        return {
            "username": username,
            "count": len(summaries),
            "games": [
                {
                    "lichess_id": s.lichess_id,
                    "white": s.white,
                    "black": s.black,
                    "result": s.result,
                    "user_color": s.user_color,
                    "in_repertoire": s.in_repertoire,
                    "matched_plies": s.matched_plies,
                    "departure_ply": s.departure_ply,
                    "departure_move_uci": s.departure_move_uci,
                    "departure_reason": s.departure_reason,
                    "repertoire_id": s.repertoire_id,
                    "repertoire_name": s.repertoire_name,
                    "move_san_history": s.move_san_history,
                    "expected_move_uci": s.expected_move_uci,
                    "expected_move_san": s.expected_move_san,
                }
                for s in summaries
            ],
        }

    # ---- Lichess OAuth (PKCE) + new-game detection + analysis history ----

    def lichess_login_url(self, redirect_uri: str) -> str:
        verifier = generate_code_verifier()
        state = generate_state()
        challenge = code_challenge_for(verifier)
        pending = self.__dict__.setdefault("_oauth_pending", {})
        pending[state] = {"verifier": verifier, "redirect_uri": redirect_uri}
        return build_authorize_url(
            redirect_uri=redirect_uri, state=state, code_challenge=challenge
        )

    def lichess_handle_callback(
        self,
        *,
        code: str,
        state: str,
        owner_user_id: Optional[str] = None,
        session_token_hash: Optional[str] = None,
    ) -> str:
        pending = self.__dict__.setdefault("_oauth_pending", {})
        entry = pending.pop(state, None)
        if entry is None:
            raise ValueError("invalid or expired OAuth state")
        token = exchange_code(
            code=code,
            code_verifier=entry["verifier"],
            redirect_uri=entry["redirect_uri"],
        )
        username = fetch_username(token["access_token"])
        # Multi-tenancy: tie this browser's session to a Lichess-keyed profile, adopt
        # any data the guest created before logging in, and store the OAuth token ON
        # that profile so it is per-user (A logging in never marks B connected, and B
        # disconnecting never clears A's token).
        if session_token_hash is not None:
            account_profile = self.repository.ensure_lichess_profile(username)
            if owner_user_id is not None and owner_user_id != account_profile:
                # Data migration is ONLY for guest → account adoption. If the current
                # session profile is already a Lichess account (has a lichess_username),
                # this is an account switch (A → B on the same browser): NEVER drag A's
                # repertoires/games into B. Just rebind the session to B below.
                current_is_guest = (
                    self.repository.profile_lichess_username(owner_user_id) is None
                )
                if current_is_guest:
                    self.repository.reassign_owner(owner_user_id, account_profile)
            self.repository.rebind_session(session_token_hash, account_profile)
            self.repository.set_profile_setting(account_profile, "lichess.oauth", token)
        else:
            # No browser session (e.g. an out-of-band/test caller): there is no profile
            # to attach the token to, so fall back to the legacy global slot.
            self.settings.set("lichess.oauth", token)
            self.settings.set("lichess.username", username)
        return username

    def _lichess_oauth_for(self, owner_user_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """The OAuth token for this owner, or the legacy global one for unscoped callers."""
        if owner_user_id is None:
            return self.settings.get("lichess.oauth")
        return self.repository.get_profile_setting(owner_user_id, "lichess.oauth")

    def _lichess_username_for(self, owner_user_id: Optional[str]) -> Optional[str]:
        """The connected Lichess username for this owner (None when not connected)."""
        if owner_user_id is None:
            return self.settings.get("lichess.username")
        if not self._lichess_oauth_for(owner_user_id):
            return None
        return self.repository.profile_lichess_username(owner_user_id)

    def auth_status_payload(self, owner_user_id: Optional[str] = None) -> Dict[str, Any]:
        """Whether this browser's session is bound to a real (Lichess) account vs a
        guest. Deliberately decoupled from Lichess *token* connectivity: disconnecting
        the token leaves the profile signed in (still that account, still its data), so
        the Sign-out affordance must key off this, not off lichess_status."""
        username = (
            self.repository.profile_lichess_username(owner_user_id)
            if owner_user_id is not None
            else None
        )
        return {"signed_in": bool(username), "username": username}

    def lichess_status_payload(self, owner_user_id: Optional[str] = None) -> Dict[str, Any]:
        username = self._lichess_username_for(owner_user_id)
        return {"connected": bool(username), "username": username}

    def lichess_disconnect_payload(
        self, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        if owner_user_id is None:
            self.settings.set("lichess.oauth", None)
            self.settings.set("lichess.username", None)
        else:
            self.repository.set_profile_setting(owner_user_id, "lichess.oauth", None)
        return {"connected": False, "username": None}

    def lichess_latest_payload(
        self, *, include_moves: bool = True, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        username = self._lichess_username_for(owner_user_id)
        if not username:
            raise ValueError("Lichess is not connected")
        try:
            # Light watcher probe: NDJSON metadata only, so we get the true finish
            # time (lastMoveAt). Full path: PGN with move text for the importer.
            if include_moves:
                games = fetch_recent_pgns(username, 1, include_moves=True)
            else:
                games = fetch_latest_games_meta(username, 1)
        except LichessFetchError as exc:
            raise ValueError(str(exc))
        if not games:
            return {"has_game": False}
        game = games[0]
        last_seen = self._lichess_last_seen(owner_user_id)
        payload = {
            "has_game": True,
            "lichess_id": game.lichess_id,
            "white": game.white,
            "black": game.black,
            "result": game.result,
            "is_new": bool(game.lichess_id) and game.lichess_id != last_seen,
            # True finish time (ISO-8601 UTC, from lastMoveAt) so the client can gate
            # the auto-nudge to games that actually finished recently. Only the light
            # probe sets it; the full PGN path leaves it null (no consumer there).
            "finished_at": game.finished_at,
        }
        # The lightweight watcher path omits the (absent) move text; consumers
        # that actually load the game ask for the full PGN explicitly.
        if include_moves:
            payload["pgn"] = game.pgn
        return payload

    def _lichess_last_seen(self, owner_user_id: Optional[str]) -> Optional[str]:
        if owner_user_id is None:
            return self.settings.get("lichess.last_seen_game_id")
        return self.repository.get_profile_setting(owner_user_id, "lichess.last_seen_game_id")

    def lichess_mark_seen_payload(
        self, lichess_id: Optional[str], owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        if lichess_id:
            if owner_user_id is None:
                self.settings.set("lichess.last_seen_game_id", lichess_id)
            else:
                self.repository.set_profile_setting(
                    owner_user_id, "lichess.last_seen_game_id", lichess_id
                )
        return {"ok": True}

    def list_analyses_payload(self, owner_user_id: Optional[str] = None) -> Dict[str, Any]:
        return {"analyses": self.repository.list_analyzed_games(owner_user_id=owner_user_id)}

    def analysis_recall_payload(
        self, game_id: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        result = self.repository.load_latest_analysis_result(game_id, owner_user_id=owner_user_id)
        if result is None:
            raise ValueError("no saved analysis for that game")
        return self._analysis_payload(result)

    def rename_repertoire_payload(
        self, repertoire_id: str, name: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_builder()
        builder.rename_repertoire(repertoire_id, name)
        return self._build_workspace_payload(repertoire_id)

    def skip_training_line_payload(
        self, session_id: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._assert_session_owner(session_id, owner_user_id)
        service = TrainingService(self.repository)
        prompt = service.skip_current_line(session_id)
        return {"prompt": self._prompt_to_json(prompt) if prompt is not None else None}

    def train_hint_payload(
        self, session_id: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._assert_session_owner(session_id, owner_user_id)
        service = TrainingService(self.repository)
        prompt = service.current_prompt(session_id)
        if prompt is None:
            return {"expected_uci": None, "expected_san": None}
        uci = prompt.expected_move_uci
        san = prompt.expected_move_san

        piece_name: Optional[str] = None
        try:
            board = chess.Board(prompt.fen_before)
            piece = board.piece_at(chess.parse_square(uci[:2]))
            if piece is not None:
                piece_name = chess.piece_name(piece.piece_type)
        except Exception:
            pass

        strategy: Optional[str] = None
        repertoire = self.repository.load_repertoire(prompt.repertoire_id)
        if repertoire is not None:
            node = next(
                (
                    n
                    for n in self._walk_opening_nodes(repertoire.root_node)
                    if n.id == prompt.expected_node_id
                ),
                None,
            )
            if node is not None:
                strategy = (
                    node.strategic_idea or node.typical_plan or (node.comment or "")
                ).strip() or None
        if not strategy:
            strategy = self._heuristic_strategy(san, piece_name)

        return {
            "expected_uci": uci,
            "expected_san": san,
            "piece": "Move the {0}".format(piece_name) if piece_name else "Find the move",
            "strategy": strategy,
        }

    @staticmethod
    def _heuristic_strategy(san: Optional[str], piece_name: Optional[str]) -> str:
        text = san or ""
        if text.startswith("O-O"):
            return "King safety — get your king castled."
        low = text.lower()
        if piece_name == "pawn" and any(sq in low for sq in ("d4", "e4", "d5", "e5", "c4", "c5")):
            return "Fight for the centre."
        if piece_name in ("knight", "bishop"):
            return "Develop a piece toward the centre, with tempo if you can."
        if piece_name == "queen":
            return "Bring the queen into play — but don't expose her early."
        if piece_name == "rook":
            return "Activate a rook (open file / connect them)."
        if piece_name == "pawn":
            return "A pawn move to shape the structure to your plan."
        return "Follow your preparation for this position."

    def load_repertoire_payload(
        self, repertoire_id: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        repertoire = self._load_repertoire_or_raise(repertoire_id, owner_user_id=owner_user_id)
        return self._build_workspace_payload(
            repertoire.id,
            selected_node_id=repertoire.root_node.id,
            summary={
                "added_nodes": 0,
                "updated_nodes": 0,
                "high_probability_unprepared": 0,
            },
        )

    def list_repertoires_payload(self, owner_user_id: Optional[str] = None) -> Dict[str, Any]:
        return {
            "repertoires": [
                {
                    "id": repertoire.id,
                    "name": repertoire.name,
                    "color": repertoire.color.value,
                    "root_fen": repertoire.root_fen,
                    "notes": repertoire.notes,
                    "tags": repertoire.tags,
                    "is_active": getattr(repertoire, "is_active", True),
                    "health": compute_health(
                        repertoire.root_node,
                        repertoire.color,
                        {
                            p.node_id: p
                            for p in self.repository.list_training_progress(repertoire.id)
                        },
                    ).to_dict(),
                }
                for repertoire in self.repository.list_repertoires(owner_user_id=owner_user_id)
            ]
        }

    def build_add_move_payload(
        self,
        repertoire_id: str,
        parent_node_id: str,
        move_uci: str,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        parent = self._find_opening_node_or_raise(repertoire.root_node, parent_node_id)
        is_prepared = parent.side_to_move is repertoire.color
        is_mainline = not any(child.is_enabled for child in parent.children)
        node = self._create_builder().add_move(
            repertoire_id,
            parent_node_id,
            move_uci,
            source=MoveSource.MANUAL,
            is_mainline=is_mainline,
            is_user_prepared_move=is_prepared,
            tags=["prepared"] if is_prepared else [],
        )
        return self._build_workspace_payload(
            repertoire_id,
            selected_node_id=node.id,
            summary={
                "added_nodes": 1,
                "updated_nodes": 0,
                "high_probability_unprepared": 0,
            },
        )

    def build_generate_payload(
        self,
        repertoire_id: str,
        node_id: str,
        ply_depth: int = 8,
        detail_mode: str = "balanced",
        maia_rating: int = 2200,
        own_color: Optional[str] = None,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        # Engine gate first so the public/default deploy still 403s uniformly
        # (the hard "server never computes" product rule), then the owner gate.
        self._require_server_engine()
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_compute_builder()
        mode = (detail_mode or "balanced").lower()
        if mode not in {"simple", "balanced", "deep"}:
            raise ValueError("detail_mode must be one of simple, balanced, deep")
        normalized_own = _normalize_color(own_color)
        try:
            _repertoire, summary = builder.generate_from_node(
                repertoire_id,
                node_id,
                GenerateConfig(
                    ply_depth=max(1, min(int(ply_depth), 20)),
                    detail_mode=mode,
                    maia_rating=max(600, min(int(maia_rating), 2600)),
                    own_color=Color(normalized_own) if normalized_own else None,
                ),
            )
        finally:
            self._close_engine(builder.engine)
        return self._build_workspace_payload(
            repertoire_id,
            selected_node_id=node_id,
            summary={
                "added_nodes": summary.added_nodes,
                "updated_nodes": summary.updated_nodes,
                "high_probability_unprepared": summary.high_probability_unprepared,
            },
        )

    def build_apply_plan_payload(
        self,
        *,
        repertoire_id: str,
        root_node_id: str,
        plan: Optional[Dict[str, Any]] = None,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Apply a browser-built Build-Generate plan (Phase 3c).

        The browser ran both engines locally and submits a tree-mutation plan;
        this endpoint runs NO compute, so it is intentionally NOT gated by
        ``_require_server_engine()`` and uses the inert ``_create_builder()`` (no
        Stockfish/Maia construction — works on the Maia-free deploy image). The
        service re-validates legality + parentage and recomputes persisted flags
        itself; malformed input raises ValueError → 400.
        """
        if not repertoire_id:
            raise ValueError("repertoire_id is required")
        if not root_node_id:
            raise ValueError("root_node_id is required")
        if not isinstance(plan, dict):
            raise ValueError("plan must be an object")
        # Owner gate: the browser ran the compute, but the server still owns
        # persistence — don't let one user apply a plan onto another's repertoire.
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_builder()
        _repertoire, summary = builder.apply_generation_plan(
            repertoire_id, root_node_id, plan
        )
        return self._build_workspace_payload(
            repertoire_id,
            selected_node_id=root_node_id,
            summary={
                "added_nodes": summary.added_nodes,
                "updated_nodes": summary.updated_nodes,
                "high_probability_unprepared": summary.high_probability_unprepared,
            },
        )

    def build_node_action_payload(
        self,
        repertoire_id: str,
        node_id: str,
        action: str,
        value: Optional[str] = None,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_builder()
        if action == "set_mainline":
            builder.set_as_mainline(repertoire_id, node_id)
        elif action == "mark_prepared":
            repertoire = self._load_repertoire_or_raise(repertoire_id)
            node = self._find_opening_node_or_raise(repertoire.root_node, node_id)
            builder.mark_prepared(repertoire_id, node_id, not node.is_user_prepared_move)
        elif action == "disable_branch":
            repertoire = self._load_repertoire_or_raise(repertoire_id)
            node = self._find_opening_node_or_raise(repertoire.root_node, node_id)
            if node.is_enabled:
                builder.disable_branch(repertoire_id, node_id)
            else:
                builder.enable_branch(repertoire_id, node_id)
        elif action == "delete":
            new_selected = builder.delete_node(repertoire_id, node_id)
            return self._build_workspace_payload(repertoire_id, selected_node_id=new_selected)
        elif action == "add_comment":
            builder.add_comment(repertoire_id, node_id, value or "")
        elif action == "add_tag":
            if not value:
                raise ValueError("tag is required")
            builder.add_tag(repertoire_id, node_id, value)
        elif action == "add_training_queue":
            builder.add_tag(repertoire_id, node_id, "training-queue")
        elif action == "mark_critical":
            builder.add_tag(repertoire_id, node_id, "critical")
        else:
            raise ValueError("unsupported node action: {0}".format(action))
        return self._build_workspace_payload(repertoire_id, selected_node_id=node_id)

    def build_set_annotations_payload(
        self,
        repertoire_id: str,
        node_id: str,
        arrows: List[str],
        circles: List[str],
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        builder = self._create_builder()
        builder.set_annotations(repertoire_id, node_id, arrows, circles)
        return {"node_id": node_id, "arrows": list(arrows), "circles": list(circles)}

    def build_export_payload(
        self,
        repertoire_id: str,
        export_format: str,
        node_id: Optional[str] = None,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        exporter = RepertoireExportService()
        safe_name = "".join(
            char if char.isalnum() or char in {"-", "_"} else "-"
            for char in repertoire.name.lower()
        ).strip("-") or "repertoire"
        if export_format == "json":
            content = exporter.export_package_json(repertoire)
            filename = "{0}.prepforge.json".format(safe_name)
            mime = "application/json"
        elif export_format == "pgn":
            content = (
                exporter.export_node_path_pgn(repertoire, node_id)
                if node_id
                else exporter.export_mainline_pgn(repertoire)
            )
            filename = "{0}.pgn".format(safe_name)
            mime = "application/x-chess-pgn"
        else:
            raise ValueError("unsupported export format: {0}".format(export_format))
        return {"filename": filename, "mime": mime, "content": content}

    def import_repertoire_payload(
        self, package_json: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        if not package_json.strip():
            raise ValueError("repertoire package is empty")
        repertoire = RepertoireExportService().import_package_json(package_json)
        self.repository.save_repertoire(repertoire, owner_user_id=owner_user_id)
        return self._build_workspace_payload(
            repertoire.id,
            selected_node_id=repertoire.root_node.id,
            summary={
                "added_nodes": self._count_opening_nodes(repertoire.root_node),
                "updated_nodes": 0,
                "high_probability_unprepared": 0,
            },
        )

    def _build_workspace_payload(
        self,
        repertoire_id: str,
        *,
        selected_node_id: Optional[str] = None,
        summary: Optional[Dict[str, int]] = None,
    ) -> Dict[str, Any]:
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        builder = self._create_builder()
        report = builder.tree_report(repertoire.id, include_disabled=True)
        selected = (
            self._find_opening_node_or_raise(repertoire.root_node, selected_node_id)
            if selected_node_id
            else repertoire.root_node
        )
        nodes_by_id = {
            node.id: node
            for node in self._walk_opening_nodes(repertoire.root_node)
        }
        progress_by_id = {
            p.node_id: p for p in self.repository.list_training_progress(repertoire.id)
        }
        mastery = mastery_map(repertoire.root_node, repertoire.color, progress_by_id)
        health = compute_health(repertoire.root_node, repertoire.color, progress_by_id)
        return {
            "repertoire_id": repertoire.id,
            "name": repertoire.name,
            "color": repertoire.color.value,
            "selected_node_id": selected.id,
            "selected_fen": selected.fen,
            "summary": summary
            or {
                "added_nodes": 0,
                "updated_nodes": 0,
                "high_probability_unprepared": 0,
            },
            "nodes_total": report.total_nodes,
            "health": health.to_dict(),
            "nodes": [
                self._opening_item_to_json(
                    item, nodes_by_id[item.node_id], mastery.get(item.node_id)
                )
                for item in report.visible_nodes
            ],
        }

    def start_training_payload(
        self,
        repertoire_id: str,
        mode: TrainingMode = TrainingMode.ALL_LINES,
        seed: int = 13,
        owner_user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._assert_repertoire_owner(repertoire_id, owner_user_id)
        repertoire = self._load_repertoire_or_raise(repertoire_id)
        service = TrainingService(self.repository)
        session = service.start_or_resume_session(repertoire.id, mode=mode, seed=seed)
        prompt = service.current_prompt(session.id)
        if prompt is None:
            raise ValueError("training session has no prompt")
        return {
            "repertoire_id": repertoire.id,
            "repertoire_name": repertoire.name,
            "color": repertoire.color.value,
            "session_id": session.id,
            "seed": session.seed,
            "mode": mode.value,
            "line_order": session.line_order,
            "lines": [self._training_line_to_json(line) for line in service.training_lines(repertoire, mode)],
            "prompt": self._prompt_to_json(prompt),
        }

    def start_training_demo_payload(
        self,
        mode: TrainingMode = TrainingMode.ALL_LINES,
        seed: int = 13,
    ) -> Dict[str, Any]:
        repertoire = self._create_demo_training_repertoire()
        service = TrainingService(self.repository)
        session = service.start_or_resume_session(repertoire.id, mode=mode, seed=seed)
        prompt = service.current_prompt(session.id)
        if prompt is None:
            raise ValueError("demo training session has no prompt")
        return {
            "repertoire_id": repertoire.id,
            "color": repertoire.color.value,
            "session_id": session.id,
            "seed": session.seed,
            "mode": mode.value,
            "line_order": session.line_order,
            "lines": [self._training_line_to_json(line) for line in service.training_lines(repertoire, mode)],
            "prompt": self._prompt_to_json(prompt),
        }

    def submit_training_move_payload(
        self, session_id: str, played_uci: str, owner_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        self._assert_session_owner(session_id, owner_user_id)
        service = TrainingService(self.repository)
        result = service.submit_move(session_id, played_uci)
        return {
            "correct": result.correct,
            "played_uci": result.played_uci,
            "expected_uci": result.expected_uci,
            "expected_san": result.expected_san,
            "completed_line": result.completed_line,
            "mistakes": result.session.mistakes,
            "current_index": result.session.current_index,
            "progress": {
                "node_id": result.progress.node_id,
                "attempts": result.progress.attempts,
                "correct_attempts": result.progress.correct_attempts,
                "spaced_repetition_score": result.progress.spaced_repetition_score,
                "is_mastered": result.progress.is_mastered,
            },
            "prompt": self._prompt_to_json(result.next_prompt)
            if result.next_prompt is not None
            else None,
            "played_san": result.played_san,
            "fen_after_player": result.fen_after_player,
            "reply_uci": result.reply_uci,
            "reply_san": result.reply_san,
            "fen_after_reply": result.fen_after_reply,
        }

    def board_payload(self, fen: str) -> Dict[str, Any]:
        position = self.chess_core.position_from_fen(fen)
        return {
            "fen": position.fen,
            "side_to_move": position.side_to_move.value,
            "legal_moves": position.legal_moves,
            "status": {
                "is_check": self.chess_core.status(fen).is_check,
                "is_checkmate": self.chess_core.status(fen).is_checkmate,
                "is_stalemate": self.chess_core.status(fen).is_stalemate,
            },
        }

    def board_move_payload(self, fen: str, move_uci: str) -> Dict[str, Any]:
        move = self.chess_core.apply_uci(fen, move_uci, source=MoveSource.MANUAL)
        return {
            "move": {
                "uci": move.uci,
                "san": move.san,
                "fen_before": move.fen_before,
                "fen_after": move.fen_after,
                "move_number": move.move_number,
                "ply": move.ply,
                "side_to_move": move.side_to_move.value,
            },
            "board": self.board_payload(move.fen_after),
        }

    def _create_demo_training_repertoire(self):
        for existing in self.repository.list_repertoires():
            if existing.name == "UI Trainer Demo":
                loaded = self.repository.load_repertoire(existing.id)
                if loaded is not None:
                    return loaded
        builder = self._create_builder()
        repertoire = builder.create_repertoire(
            CreateRepertoireRequest(
                name="UI Trainer Demo",
                color=Color.WHITE,
                notes="Trainer demo for local web UI.",
            )
        )
        e4 = builder.add_move(
            repertoire.id,
            repertoire.root_node.id,
            "e2e4",
            is_mainline=True,
            is_user_prepared_move=True,
            tags=["prepared"],
        )
        e5 = builder.add_move(
            repertoire.id,
            e4.id,
            "e7e5",
            source=MoveSource.GENERATED_MAIA3,
            is_mainline=True,
        )
        builder.add_move(
            repertoire.id,
            e5.id,
            "g1f3",
            is_mainline=True,
            is_user_prepared_move=True,
            tags=["prepared"],
        )
        d4 = builder.add_move(
            repertoire.id,
            repertoire.root_node.id,
            "d2d4",
            is_user_prepared_move=True,
            tags=["prepared", "high-priority"],
        )
        d5 = builder.add_move(
            repertoire.id,
            d4.id,
            "d7d5",
            source=MoveSource.GENERATED_MAIA3,
        )
        builder.add_move(
            repertoire.id,
            d5.id,
            "c2c4",
            is_user_prepared_move=True,
            tags=["prepared"],
        )
        loaded = self.repository.load_repertoire(repertoire.id)
        if loaded is None:
            raise ValueError("failed to load demo training repertoire")
        return loaded

    def _prompt_to_json(self, prompt) -> Optional[Dict[str, Any]]:
        if prompt is None:
            return None
        return {
            "session_id": prompt.session_id,
            "repertoire_id": prompt.repertoire_id,
            "line_node_id": prompt.line_node_id,
            "current_index": prompt.current_index,
            "total_lines": prompt.total_lines,
            "fen_before": prompt.fen_before,
            "remaining_mistakes": prompt.remaining_mistakes,
            "legal_moves": self.chess_core.legal_moves(prompt.fen_before),
        }

    def _training_line_to_json(self, line) -> Dict[str, Any]:
        return {
            "line_node_id": line.line_node_id,
            "node_ids": line.node_ids,
            "own_move_node_ids": line.own_move_node_ids,
            "ply_count": len(line.node_ids),
            "own_move_count": len(line.own_move_node_ids),
        }

    def _load_repertoire_or_raise(self, repertoire_id: str, owner_user_id: Optional[str] = None):
        repertoire = self.repository.load_repertoire(repertoire_id, owner_user_id=owner_user_id)
        if repertoire is None:
            raise ValueError("repertoire not found: {0}".format(repertoire_id))
        return repertoire

    def _claim_or_verify_game(self, game_id: str, owner_user_id: Optional[str]) -> None:
        """Stamp ownership on an unowned game (first writer wins) and reject access to
        a game already owned by someone else. No-op when no owner is supplied (internal
        / unscoped callers). Pasted-PGN games get a fresh id per import so the common
        path simply claims a brand-new row; only globally-deduped lichess games can be
        pre-owned (per-owner game dedup is a documented follow-up)."""
        if owner_user_id is None:
            return
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE games SET owner_user_id = :owner "
                    "WHERE id = :id AND owner_user_id IS NULL"
                ),
                {"owner": owner_user_id, "id": game_id},
            )
            row = conn.execute(
                text("SELECT owner_user_id FROM games WHERE id = :id"),
                {"id": game_id},
            ).mappings().first()
        if row is not None and row["owner_user_id"] not in (None, owner_user_id):
            # Don't reveal another owner's game.
            raise ValueError("game not found: {0}".format(game_id))

    def _assert_repertoire_owner(
        self, repertoire_id: str, owner_user_id: Optional[str]
    ) -> None:
        """Owner gate for repertoire mutations. Rejects a repertoire owned by a
        *different* user (the IDOR fix); allows ownerless/shared rows (legacy backfill
        + the engine-disabled public flow, where data may not be claimed yet). No-op
        for unscoped/internal callers. Mirrors _claim_or_verify_game / _assert_session_owner."""
        if owner_user_id is None:
            return
        with self.engine.connect() as conn:
            row = conn.execute(
                text("SELECT user_profile_id FROM repertoires WHERE id = :id"),
                {"id": repertoire_id},
            ).mappings().first()
        if row is None:
            raise ValueError("repertoire not found: {0}".format(repertoire_id))
        if row["user_profile_id"] not in (None, owner_user_id):
            # Don't reveal another owner's repertoire.
            raise ValueError("repertoire not found: {0}".format(repertoire_id))

    def _claim_repertoire(self, repertoire_id: str, owner_user_id: Optional[str]) -> None:
        """Stamp ownership on a just-created repertoire (the builder saves it ownerless)."""
        if owner_user_id is None:
            return
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE repertoires SET user_profile_id = :owner "
                    "WHERE id = :id AND user_profile_id IS NULL"
                ),
                {"owner": owner_user_id, "id": repertoire_id},
            )

    def _assert_session_owner(
        self, session_id: str, owner_user_id: Optional[str]
    ) -> None:
        """Owner gate for session-keyed training endpoints. Resolves the session to
        its repertoire and rejects access when that repertoire belongs to a different
        user. Ownerless/shared repertoires (e.g. the trainer demo) are allowed so the
        unauthenticated demo flow keeps working. No-op for unscoped callers."""
        if owner_user_id is None:
            return
        session = self.repository.load_training_session(session_id)
        if session is None:
            raise ValueError("training session not found: {0}".format(session_id))
        with self.engine.connect() as conn:
            row = conn.execute(
                text("SELECT user_profile_id FROM repertoires WHERE id = :id"),
                {"id": session.repertoire_id},
            ).mappings().first()
        rep_owner = row["user_profile_id"] if row is not None else None
        if rep_owner is not None and rep_owner != owner_user_id:
            # Don't reveal another owner's training session.
            raise ValueError("training session not found: {0}".format(session_id))

    def _find_opening_node_or_raise(self, root, node_id: str):
        for node in self._walk_opening_nodes(root):
            if node.id == node_id:
                return node
        raise ValueError("opening node not found: {0}".format(node_id))

    def _walk_opening_nodes(self, root):
        yield root
        for child in root.children:
            for node in self._walk_opening_nodes(child):
                yield node

    def _count_opening_nodes(self, root) -> int:
        return sum(1 for _node in self._walk_opening_nodes(root))

    def _opening_item_to_json(self, item, node, mastery: Optional[str] = None) -> Dict[str, Any]:
        move = node.move
        return {
            "id": item.node_id,
            "parent_id": item.parent_id,
            "depth": item.depth,
            "san": item.san,
            "uci": item.uci,
            "fen": node.fen,
            "fen_before": move.fen_before if move is not None else None,
            "fen_after": move.fen_after if move is not None else node.fen,
            "move_number": move.move_number if move is not None else 1,
            "ply": move.ply if move is not None else 0,
            "move_side": move.side_to_move.value if move is not None else None,
            "side_to_move": node.side_to_move.value,
            "source": item.source.value,
            "is_mainline": item.is_mainline,
            "is_prepared": item.is_prepared,
            "is_enabled": item.is_enabled,
            "maia_probability": item.maia_probability,
            # Browser Build Generate (Phase 3c) needs to know whether an existing node
            # already carries an engine eval so it can merge fill-only-when-null (matching
            # the server _upsert_child) instead of re-proposing it on every pass.
            "engine_evaluation": _engine_eval_to_json(node.engine_evaluation),
            "tags": item.tags,
            "comment": item.comment,
            "arrows": list(node.arrows),
            "circles": list(node.circles),
            # Mastery state for the Build/Train heatmap; None for opponent moves.
            "mastery": mastery,
        }


def run_web_server(
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    db_path: Path = DEFAULT_DB_PATH,
) -> None:
    app = PrepForgeWebApp(db_path=db_path)
    handler = _handler_for_app(app)
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    print("ui: http://{0}:{1}".format(host, port), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def _handler_for_app(app: PrepForgeWebApp):
    request_lock = threading.Lock()

    class PrepForgeRequestHandler(BaseHTTPRequestHandler):
        # Per-request identity state (BaseHTTPRequestHandler makes a fresh instance per
        # request, so these are safely request-scoped).
        _owner_user_id: Optional[str] = None
        _session_token_hash: Optional[str] = None
        _set_session_cookie: Optional[str] = None

        def end_headers(self) -> None:
            # Cross-origin isolation lets the browser use SharedArrayBuffer, which
            # multi-threaded WASM engines (browser Stockfish) require. CORP keeps
            # our own same-origin assets loadable under COEP: require-corp.
            # (Lichess OAuth uses a popup + postMessage, but already falls back to
            # polling /api/lichess/status, so COOP severing the opener is benign.)
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            # When this request minted a new guest session, hand the browser its cookie.
            # HttpOnly (JS never needs it) + SameSite=Lax + Path=/. No Secure flag so it
            # works on local http; a TLS deploy should add Secure (behind a proxy flag).
            if self._set_session_cookie:
                self.send_header(
                    "Set-Cookie",
                    "{0}={1}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000".format(
                        SESSION_COOKIE_NAME, self._set_session_cookie
                    ),
                )
            super().end_headers()

        def _resolve_identity(self) -> str:
            """Map this browser to a user_profile_id via its session cookie, minting a
            guest session (and queuing a Set-Cookie) on first contact. Cached per request."""
            if self._owner_user_id is not None:
                return self._owner_user_id
            token = None
            raw_cookie = self.headers.get("Cookie")
            if raw_cookie:
                try:
                    jar = SimpleCookie()
                    jar.load(raw_cookie)
                    morsel = jar.get(SESSION_COOKIE_NAME)
                    token = morsel.value if morsel is not None else None
                except Exception:
                    token = None
            if token:
                token_hash = _hash_session_token(token)
                owner = app.repository.session_user(token_hash)
                if owner is not None:
                    self._session_token_hash = token_hash
                    self._owner_user_id = owner
                    return owner
            # No (valid) cookie: mint a fresh guest session and queue the Set-Cookie.
            new_token = secrets.token_urlsafe(32)
            token_hash = _hash_session_token(new_token)
            owner = app.repository.create_guest_session(token_hash)
            self._session_token_hash = token_hash
            self._owner_user_id = owner
            self._set_session_cookie = new_token
            return owner

        def _rotate_session_to_new_guest(self) -> str:
            """Sign out: kill the current session (so its cookie is dead) and mint a
            fresh guest, rotating the cookie. The signed-out profile keeps its data;
            this browser simply stops being authenticated as it. NOTE: disconnecting
            Lichess is a different action (drops only the OAuth token) and does NOT
            sign out — see lichess_disconnect_payload."""
            if self._session_token_hash is not None:
                app.repository.delete_session(self._session_token_hash)
            new_token = secrets.token_urlsafe(32)
            token_hash = _hash_session_token(new_token)
            owner = app.repository.create_guest_session(token_hash)
            self._session_token_hash = token_hash
            self._owner_user_id = owner
            self._set_session_cookie = new_token
            return owner

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            # Static assets touch only the filesystem, never shared app state, so
            # they are served WITHOUT the global request lock. This keeps a large
            # or slow asset download (e.g. the ~45 MB Maia ONNX) from blocking
            # concurrent API/static requests. Files are streamed in chunks (see
            # _send_file), so a download does not load the whole asset into RAM.
            # NOTE: this is still the stdlib handler -- no range requests / sendfile.
            # For public scale, large engine assets (.onnx/.wasm/.nnue) should be
            # offloaded to a CDN / object store rather than served from here.
            if parsed.path == "/" or parsed.path.startswith("/static/"):
                self._handle_static(parsed)
                return
            with request_lock:
                self._handle_get()

        def do_POST(self) -> None:
            with request_lock:
                self._handle_post()

        def _handle_static(self, parsed) -> None:
            try:
                if parsed.path == "/":
                    self._send_html_file(STATIC_DIR / "index.html")
                    return
                self._serve_static(parsed.path[len("/static/"):])
            except ConnectionError:
                # Client hung up mid-download (e.g. cancelled the ~45 MB Maia fetch).
                # The socket is dead — don't attempt _send_error on it.
                return
            except Exception as exc:  # noqa: BLE001
                self._send_error(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

        def _handle_get(self) -> None:
            parsed = urlparse(self.path)
            try:
                # Resolve (or mint) the browser's session/owner once per request so
                # owned-data endpoints can scope by it. Minting queues a Set-Cookie.
                owner = self._resolve_identity()
                # Static paths ("/" and "/static/*") are handled before the lock
                # in do_GET via _handle_static and never reach here.
                if parsed.path == "/api/dashboard":
                    self._send_json(app.dashboard_payload(owner_user_id=owner))
                    return
                if parsed.path == "/api/repertoires":
                    self._send_json(app.list_repertoires_payload(owner_user_id=owner))
                    return
                if parsed.path == "/api/build/load":
                    query = parse_qs(parsed.query)
                    repertoire_id = query.get("repertoire_id", [""])[0]
                    if not repertoire_id:
                        self._send_error("missing repertoire_id", HTTPStatus.BAD_REQUEST)
                        return
                    self._send_json(app.load_repertoire_payload(repertoire_id, owner_user_id=owner))
                    return
                if parsed.path == "/api/board":
                    query = parse_qs(parsed.query)
                    fen = query.get("fen", [""])[0]
                    if not fen:
                        self._send_error("missing fen", HTTPStatus.BAD_REQUEST)
                        return
                    self._send_json(app.board_payload(fen))
                    return
                if parsed.path == "/api/repertoires/export-pgn":
                    query = parse_qs(parsed.query)
                    repertoire_id = query.get("repertoire_id", [""])[0]
                    if not repertoire_id:
                        self._send_error("missing repertoire_id", HTTPStatus.BAD_REQUEST)
                        return
                    self._send_json(app.export_tree_pgn_payload(repertoire_id, owner_user_id=owner))
                    return
                if parsed.path == "/api/settings":
                    self._send_json(app.settings_payload())
                    return
                if parsed.path == "/api/analyze/status":
                    query = parse_qs(parsed.query)
                    job_id = query.get("job_id", [""])[0]
                    if not job_id:
                        self._send_error("missing job_id", HTTPStatus.BAD_REQUEST)
                        return
                    self._send_json(app.analysis_status_payload(job_id))
                    return
                if parsed.path == "/api/build/generate/status":
                    query = parse_qs(parsed.query)
                    job_id = query.get("job_id", [""])[0]
                    if not job_id:
                        self._send_error("missing job_id", HTTPStatus.BAD_REQUEST)
                        return
                    self._send_json(app.build_generate_status_payload(job_id))
                    return
                if parsed.path == "/api/jobs/active":
                    self._send_json(app.heavy_job_status())
                    return
                if parsed.path == "/api/engine/snapshot":
                    self._send_json(app.engine_session_snapshot_payload())
                    return
                if parsed.path == "/oauth/login":
                    redirect_uri = self._oauth_redirect_uri()
                    self._send_redirect(app.lichess_login_url(redirect_uri))
                    return
                if parsed.path == "/oauth/callback":
                    query = parse_qs(parsed.query)
                    self._handle_oauth_callback(query)
                    return
                if parsed.path == "/api/auth/status":
                    self._send_json(app.auth_status_payload(owner_user_id=owner))
                    return
                if parsed.path == "/api/lichess/status":
                    self._send_json(app.lichess_status_payload(owner_user_id=owner))
                    return
                if parsed.path == "/api/lichess/latest":
                    light = parse_qs(parsed.query).get("light", ["0"])[0] in ("1", "true")
                    self._send_json(
                        app.lichess_latest_payload(
                            include_moves=not light, owner_user_id=owner
                        )
                    )
                    return
                if parsed.path == "/api/analyses":
                    self._send_json(app.list_analyses_payload(owner_user_id=owner))
                    return
                if parsed.path.startswith("/api/analyses/"):
                    game_id = parsed.path[len("/api/analyses/"):]
                    if not game_id:
                        self._send_error("missing game id", HTTPStatus.BAD_REQUEST)
                        return
                    self._send_json(app.analysis_recall_payload(game_id, owner_user_id=owner))
                    return
                self._send_error("not found", HTTPStatus.NOT_FOUND)
            except ServerEngineDisabled as exc:
                self._send_error(str(exc), HTTPStatus.FORBIDDEN)
            except (ValueError, KeyError) as exc:
                self._send_error(str(exc), HTTPStatus.BAD_REQUEST)
            except ConnectionError:
                # Client hung up mid-response (closed tab / navigated away, or the
                # latest-game watcher poll was abandoned). The socket is dead, so
                # don't try to _send_error on it — that second write is what produced
                # the unhandled WinError 10053 traceback. Drop the request quietly.
                return
            except Exception as exc:
                self._send_error(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

        def _handle_post(self) -> None:
            parsed = urlparse(self.path)
            try:
                payload = self._read_json()
                # Resolve (or mint) the browser's session/owner once per request.
                owner = self._resolve_identity()
                if parsed.path == "/api/analyze/demo":
                    self._send_json(app.analyze_demo_payload())
                    return
                if parsed.path == "/api/analyze/pgn":
                    self._send_json(
                        app.analyze_pgn_payload(payload.get("pgn", ""), owner_user_id=owner)
                    )
                    return
                if parsed.path == "/api/analyze/pgn/start":
                    self._send_json(
                        app.start_analysis_payload(payload.get("pgn", ""), owner_user_id=owner)
                    )
                    return
                if parsed.path == "/api/analyze/prepare":
                    self._send_json(
                        app.prepare_analysis_payload(payload.get("pgn", ""), owner_user_id=owner)
                    )
                    return
                if parsed.path == "/api/analyze/classify-save":
                    self._send_json(
                        app.classify_save_payload(
                            game_id=payload.get("game_id", ""),
                            engine=str(payload.get("engine", "stockfish (browser)")),
                            depth=payload.get("depth"),
                            # Pass the raw values through; classify_save_payload
                            # validates their shape and raises ValueError (→ 400).
                            positions=payload.get("positions"),
                            maia_assessments=payload.get("maia_assessments"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/analyze/cancel":
                    self._send_json(app.cancel_analysis_payload(payload.get("job_id", "")))
                    return
                if parsed.path == "/api/build/demo":
                    self._send_json(app.build_demo_payload())
                    return
                if parsed.path == "/api/build/add-move":
                    self._send_json(
                        app.build_add_move_payload(
                            repertoire_id=payload["repertoire_id"],
                            parent_node_id=payload["parent_node_id"],
                            move_uci=payload["move_uci"],
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/build/generate":
                    self._send_json(
                        app.build_generate_payload(
                            repertoire_id=payload["repertoire_id"],
                            node_id=payload["node_id"],
                            ply_depth=int(payload.get("ply_depth", payload.get("depth_plies", 8))),
                            detail_mode=str(payload.get("detail_mode", "balanced")),
                            maia_rating=int(payload.get("maia_rating", 2200)),
                            own_color=payload.get("own_color"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/build/generate/start":
                    self._send_json(
                        app.start_build_generate_payload(
                            repertoire_id=payload["repertoire_id"],
                            node_id=payload["node_id"],
                            ply_depth=int(payload.get("ply_depth", payload.get("depth_plies", 8))),
                            detail_mode=str(payload.get("detail_mode", "balanced")),
                            maia_rating=int(payload.get("maia_rating", 2200)),
                            own_color=payload.get("own_color"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/build/generate/cancel":
                    self._send_json(app.cancel_build_generate_payload(payload.get("job_id", "")))
                    return
                if parsed.path == "/api/build/generate/apply-plan":
                    # No compute (the browser ran both engines and submits a plan the
                    # server only re-validates + persists), so it is not engine-gated —
                    # but it IS owner-gated so a user can't apply a plan onto another's tree.
                    self._send_json(
                        app.build_apply_plan_payload(
                            repertoire_id=payload["repertoire_id"],
                            root_node_id=payload["root_node_id"],
                            plan=payload.get("plan"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/engine/open":
                    self._send_json(
                        app.engine_session_open_payload(
                            fen=str(payload.get("fen", "")),
                            multipv=int(payload.get("multipv", 1)),
                            engine=str(payload.get("engine", "stockfish")),
                        )
                    )
                    return
                if parsed.path == "/api/engine/update":
                    self._send_json(
                        app.engine_session_update_payload(
                            fen=str(payload.get("fen", "")),
                            multipv=int(payload.get("multipv", 1)),
                        )
                    )
                    return
                if parsed.path == "/api/engine/pause":
                    self._send_json(app.engine_session_pause_payload())
                    return
                if parsed.path == "/api/engine/close":
                    self._send_json(app.engine_session_close_payload())
                    return
                if parsed.path == "/api/build/action":
                    self._send_json(
                        app.build_node_action_payload(
                            repertoire_id=payload["repertoire_id"],
                            node_id=payload["node_id"],
                            action=payload["action"],
                            value=payload.get("value"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/build/annotations":
                    self._send_json(
                        app.build_set_annotations_payload(
                            repertoire_id=payload["repertoire_id"],
                            node_id=payload["node_id"],
                            arrows=list(payload.get("arrows", [])),
                            circles=list(payload.get("circles", [])),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/build/export":
                    self._send_json(
                        app.build_export_payload(
                            repertoire_id=payload["repertoire_id"],
                            export_format=payload["format"],
                            node_id=payload.get("node_id"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/repertoires/import":
                    self._send_json(
                        app.import_repertoire_payload(
                            payload.get("package_json", ""), owner_user_id=owner
                        )
                    )
                    return
                if parsed.path == "/api/board/move":
                    self._send_json(
                        app.board_move_payload(
                            fen=payload["fen"],
                            move_uci=payload["move_uci"],
                        )
                    )
                    return
                if parsed.path == "/api/train/demo/start":
                    mode = TrainingMode(payload.get("mode", TrainingMode.ALL_LINES.value))
                    seed = int(payload.get("seed", 13))
                    self._send_json(app.start_training_demo_payload(mode=mode, seed=seed))
                    return
                if parsed.path == "/api/train/start":
                    mode = TrainingMode(payload.get("mode", TrainingMode.ALL_LINES.value))
                    seed = int(payload.get("seed", 13))
                    self._send_json(
                        app.start_training_payload(
                            repertoire_id=payload["repertoire_id"],
                            mode=mode,
                            seed=seed,
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/repertoires/create":
                    self._send_json(
                        app.create_repertoire_payload(
                            name=payload.get("name", ""),
                            color=payload.get("color", "white"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/repertoires/delete":
                    self._send_json(
                        app.delete_repertoire_payload(
                            payload["repertoire_id"], owner_user_id=owner
                        )
                    )
                    return
                if parsed.path == "/api/repertoires/set-active":
                    self._send_json(
                        app.set_repertoire_active_payload(
                            repertoire_id=payload["repertoire_id"],
                            active=bool(payload.get("active", True)),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/repertoires/import-pgn":
                    self._send_json(
                        app.import_pgn_repertoire_payload(
                            pgn_text=payload.get("pgn", ""),
                            name=payload.get("name", "Imported"),
                            color=payload.get("color", "white"),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/settings":
                    self._send_json(
                        app.update_settings_payload(
                            stockfish_depth=payload.get("stockfish_depth"),
                        )
                    )
                    return
                if parsed.path == "/api/stockfish/install":
                    self._send_json(app.install_stockfish_payload())
                    return
                if parsed.path == "/api/maia3/install":
                    self._send_json(app.install_maia3_payload())
                    return
                if parsed.path == "/api/lichess/compare":
                    self._send_json(
                        app.lichess_compare_payload(
                            username=payload.get("username", ""),
                            count=int(payload.get("count", 10)),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/lichess/disconnect":
                    # Disconnect Lichess ≠ sign out: drop only this profile's OAuth token
                    # (stops latest-game/replay). The PrepForge session/identity is
                    # untouched, so the user still sees their own repertoires/games.
                    self._send_json(app.lichess_disconnect_payload(owner_user_id=owner))
                    return
                if parsed.path == "/api/auth/signout":
                    # Sign out: rotate pf_session to a brand-new guest so this browser
                    # stops seeing the account's data. The account profile + its data
                    # survive; a later login re-binds to it.
                    self._rotate_session_to_new_guest()
                    self._send_json({"ok": True})
                    return
                if parsed.path == "/api/lichess/seen":
                    self._send_json(
                        app.lichess_mark_seen_payload(
                            payload.get("lichess_id"), owner_user_id=owner
                        )
                    )
                    return
                if parsed.path == "/api/build/rename":
                    self._send_json(
                        app.rename_repertoire_payload(
                            repertoire_id=payload["repertoire_id"],
                            name=payload.get("name", ""),
                            owner_user_id=owner,
                        )
                    )
                    return
                if parsed.path == "/api/train/skip":
                    self._send_json(
                        app.skip_training_line_payload(
                            payload["session_id"], owner_user_id=owner
                        )
                    )
                    return
                if parsed.path == "/api/train/hint":
                    self._send_json(
                        app.train_hint_payload(payload["session_id"], owner_user_id=owner)
                    )
                    return
                if parsed.path == "/api/train/move":
                    self._send_json(
                        app.submit_training_move_payload(
                            session_id=payload["session_id"],
                            played_uci=payload["played_uci"],
                            owner_user_id=owner,
                        )
                    )
                    return
                self._send_error("not found", HTTPStatus.NOT_FOUND)
            except ServerEngineDisabled as exc:
                self._send_error(str(exc), HTTPStatus.FORBIDDEN)
            except (ValueError, KeyError, json.JSONDecodeError) as exc:
                self._send_error(str(exc), HTTPStatus.BAD_REQUEST)
            except ConnectionError:
                # Client hung up mid-response. Socket is dead; don't re-write via
                # _send_error (the source of the unhandled WinError 10053 traceback).
                return
            except Exception as exc:
                self._send_error(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

        def log_message(self, format, *args) -> None:  # noqa: A002
            return

        def _read_json(self) -> Dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                return {}
            if length > MAX_REQUEST_BODY_BYTES:
                # Reject before reading the body into memory (→ 400 via the
                # _handle_post ValueError handler).
                raise ValueError(
                    "request body too large ({0} bytes > {1})".format(
                        length, MAX_REQUEST_BODY_BYTES
                    )
                )
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw) if raw else {}

        def _oauth_redirect_uri(self) -> str:
            host = self.headers.get("Host") or "127.0.0.1:8765"
            return "http://{0}/oauth/callback".format(host)

        def _handle_oauth_callback(self, query: Dict[str, list]) -> None:
            error = query.get("error", [None])[0]
            if error:
                self._send_oauth_result_page(False, error)
                return
            code = query.get("code", [""])[0]
            state = query.get("state", [""])[0]
            if not code or not state:
                self._send_oauth_result_page(False, "missing code or state")
                return
            try:
                # The popup is same-origin, so it carries the session cookie: resolve it
                # to migrate guest data into the Lichess account and rebind the session.
                owner = self._resolve_identity()
                username = app.lichess_handle_callback(
                    code=code,
                    state=state,
                    owner_user_id=owner,
                    session_token_hash=self._session_token_hash,
                )
            except (ValueError, LichessOAuthError) as exc:
                self._send_oauth_result_page(False, str(exc))
                return
            self._send_oauth_result_page(True, username)

        def _send_oauth_result_page(self, ok: bool, detail: str) -> None:
            # Minimal self-closing page; the opener polls /api/lichess/status.
            # Built by concatenation (not str.format) so the CSS/JS braces don't
            # collide with format placeholders.
            heading = "Lichess connected" if ok else "Lichess connection failed"
            message = ("Signed in as " + detail) if ok else ("Reason: " + detail)
            message_json = json.dumps(message)
            ok_json = "true" if ok else "false"
            css = (
                "body{font-family:system-ui,sans-serif;background:#f4f3f1;color:#1c1c1c;"
                "display:grid;place-items:center;height:100vh;margin:0}"
                ".box{text-align:center;padding:24px 32px;background:#fff;"
                "border:1px solid #d8d4ce;border-radius:8px}"
            )
            script = (
                "try{if(window.opener)window.opener.postMessage("
                "{type:'lichess-oauth',ok:" + ok_json + ",detail:" + message_json
                + "},'*');}catch(e){}setTimeout(function(){window.close();},1200);"
            )
            body = (
                "<!doctype html><html><head><meta charset='utf-8'>"
                "<title>PrepForge &middot; Lichess</title><style>" + css + "</style>"
                "</head><body><div class='box'><h2>" + html.escape(heading) + "</h2>"
                "<p>" + html.escape(message) + "</p>"
                "<p style='color:#5e5e5e'>You can close this tab and return to PrepForge.</p>"
                "</div><script>" + script + "</script></body></html>"
            )
            self._send_html(body)

        def _send_redirect(self, location: str) -> None:
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _send_html(self, html: str) -> None:
            body = html.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _serve_static(self, rel_path: str) -> None:
            base = STATIC_DIR.resolve()
            target = (base / rel_path).resolve()
            # Reject path traversal outside STATIC_DIR.
            if target != base and base not in target.parents:
                self._send_error("not found", HTTPStatus.NOT_FOUND)
                return
            if not target.is_file():
                # Dev fallback: a locally-built tree has no ONNX weights in static/maia3
                # (the build strips them — they're CDN-hosted in production). Serve them
                # from the developer's source copy so local Maia3 "just works".
                dev = _dev_maia3_fallback(rel_path)
                if dev is not None:
                    self._send_file(dev, _static_mime(dev))
                    return
                self._send_error("not found", HTTPStatus.NOT_FOUND)
                return
            # HTML documents (app shell + the maia3 smoke page) get the runtime
            # asset-base injection; everything else streams unchanged.
            if target.suffix.lower() == ".html":
                self._send_html_file(target)
                return
            self._send_file(target, _static_mime(target))

        def _send_html_file(self, path: Path) -> None:
            """Serve an HTML document, injecting the runtime Maia3 asset base.

            HTML is small, so it's read fully (not chunk-streamed like _send_file)
            because the injection rewrites the bytes before sending.
            """
            try:
                body = _inject_asset_base(path.read_bytes())
            except OSError:
                self._send_error("file not found", HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", _cache_control(path))
            self.end_headers()
            self.wfile.write(body)

        def _send_file(self, path: Path, content_type: str) -> None:
            try:
                size = path.stat().st_size
            except OSError:
                self._send_error("file not found", HTTPStatus.NOT_FOUND)
                return
            if not path.is_file():
                self._send_error("file not found", HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", _cache_control(path))
            self.end_headers()
            # Stream in chunks so a large asset (e.g. the ~45 MB Maia ONNX) is not
            # read fully into memory per concurrent download.
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        def _send_json(self, payload: Dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error(self, message: str, status: HTTPStatus) -> None:
            self._send_json({"error": message}, status=status)

    return PrepForgeRequestHandler
