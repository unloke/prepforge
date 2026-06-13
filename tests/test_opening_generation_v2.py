"""Tests for the refactored Generate-from-position logic (per spec)."""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import pytest

import chess

from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MaiaMovePrediction,
    MoveSource,
)
from prepforge_chess.services.engine import (
    EngineAnalysisConfig,
    EngineCandidate,
    PositionAnalysis,
)
from prepforge_chess.services.opening_builder import (
    CreateRepertoireRequest,
    OpeningBuilderService,
)
from prepforge_chess.services.opening_generation import GenerateConfig
from prepforge_chess.storage.database import initialize_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _eval(cp: int) -> EngineEvaluation:
    return EngineEvaluation(engine="scripted", score_cp=cp)


class ScriptedEngine:
    """Engine adapter that returns scripted top moves per FEN, falling back to
    the first legal move so we never blow up on positions we didn't script."""

    name = "scripted-engine"

    def __init__(self, by_fen: Optional[Dict[str, str]] = None):
        self.by_fen = by_fen or {}
        self.calls: List[str] = []

    def analyze_position(self, fen, config: EngineAnalysisConfig = EngineAnalysisConfig()) -> PositionAnalysis:
        self.calls.append(fen)
        board = chess.Board(fen)
        scripted = self.by_fen.get(fen)
        move_uci = scripted if scripted else next(iter(m.uci() for m in board.legal_moves), None)
        candidates: List[EngineCandidate] = []
        if move_uci is not None:
            candidates.append(
                EngineCandidate(
                    move_uci=move_uci,
                    evaluation_after=_eval(20),
                    rank=0,
                    pv=[move_uci],
                )
            )
        return PositionAnalysis(fen=fen, evaluation=_eval(0), candidates=candidates)

    def evaluate_position(self, fen, config: EngineAnalysisConfig = EngineAnalysisConfig()) -> EngineEvaluation:
        return _eval(0)


class ScriptedMaia:
    """Maia adapter that returns scripted predictions per FEN, falling back to
    a single legal move so the pipeline never has to invent illegal moves."""

    name = "scripted-maia"

    def __init__(self, by_fen: Optional[Dict[str, List[Tuple[str, float]]]] = None):
        self.by_fen = by_fen or {}
        self.rating_calls: List[Optional[int]] = []
        self.fen_calls: List[str] = []

    def predictions(self, fen, *, rating=None):
        self.rating_calls.append(rating)
        self.fen_calls.append(fen)
        scripted = self.by_fen.get(fen)
        if scripted is not None:
            return [
                MaiaMovePrediction(
                    fen=fen,
                    move_uci=uci,
                    probability=prob,
                    model=self.name,
                    rank=index + 1,
                )
                for index, (uci, prob) in enumerate(scripted)
            ]
        board = chess.Board(fen)
        legal = next(iter(board.legal_moves), None)
        if legal is None:
            return []
        return [
            MaiaMovePrediction(
                fen=fen,
                move_uci=legal.uci(),
                probability=0.5,
                model=self.name,
                rank=1,
            )
        ]


@pytest.fixture
def fresh_repository(tmp_path):
    connection = initialize_database(tmp_path / "gen.sqlite3")
    return PrepForgeRepository(connection)


def _white_repertoire(repository, engine, maia=None):
    builder = OpeningBuilderService(repository, engine=engine, maia=maia or StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Test", color=Color.WHITE)
    )
    return builder, repertoire


# ---------- 1. user turn uses Stockfish top 1 -----------------------------------

def test_user_turn_uses_stockfish_top1(fresh_repository):
    engine = ScriptedEngine({START_FEN: "e2e4"})
    builder, rep = _white_repertoire(fresh_repository, engine, ScriptedMaia())
    _, summary = builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=1, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    children = reloaded.root_node.children
    assert len(children) == 1
    only_child = children[0]
    assert only_child.move.uci == "e2e4"
    assert only_child.source is MoveSource.GENERATED_STOCKFISH
    assert only_child.is_mainline is True
    assert summary.added_nodes == 1


# ---------- 2. opponent mainline keeps moves >= 10% ------------------------------

def test_opponent_mainline_keeps_moves_above_10_percent(fresh_repository):
    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    # Opponent mainline is Stockfish's best; here it coincides with Maia's top move.
    engine = ScriptedEngine({START_FEN: "e2e4", after_e4: "e7e5"})
    maia = ScriptedMaia({after_e4: [("e7e5", 0.5), ("c7c5", 0.2), ("d7d6", 0.05)]})
    builder, rep = _white_repertoire(fresh_repository, engine, maia)
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    white_first = reloaded.root_node.children[0]
    opponent_moves = {child.move.uci for child in white_first.children}
    assert "e7e5" in opponent_moves   # Stockfish mainline (also 50% in Maia)
    assert "c7c5" in opponent_moves   # 20% >= 10% Maia branch
    assert "d7d6" not in opponent_moves  # 5% below
    mainline_reply = next(c for c in white_first.children if c.move.uci == "e7e5")
    assert mainline_reply.is_mainline is True
    assert mainline_reply.source is MoveSource.GENERATED_STOCKFISH  # opponent mainline = Stockfish
    assert mainline_reply.maia_probability == 0.5  # Maia probability supplemented onto it


# ---------- 3. opponent branch uses 30% threshold --------------------------------

def test_opponent_branch_uses_30_percent_threshold(fresh_repository):
    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    after_c5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    after_c5_Nf3 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
    engine = ScriptedEngine({
        START_FEN: "e2e4",
        after_c5: "g1f3",  # white reply inside the c5 branch
    })
    maia = ScriptedMaia({
        # On mainline: e7e5 (60%, mainline), c7c5 (35%, branch).
        after_e4: [("e7e5", 0.6), ("c7c5", 0.35)],
        # On branch path (after 1...c5 2.Nf3): two replies — 35% kept, 25% dropped.
        after_c5_Nf3: [("g8f6", 0.35), ("b8c6", 0.25)],
    })
    builder, rep = _white_repertoire(fresh_repository, engine, maia)
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=4, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    white_first = reloaded.root_node.children[0]
    by_uci = {c.move.uci: c for c in white_first.children}
    branch = by_uci["c7c5"]
    assert branch.is_mainline is False
    white_reply = next(iter(branch.children), None)
    assert white_reply is not None and white_reply.move.uci == "g1f3"
    replies = {c.move.uci for c in white_reply.children}
    assert "g8f6" in replies      # 35% >= 30%
    assert "b8c6" not in replies  # 25% < 30%


# ---------- 4. no Maia move above threshold → keep highest -----------------------

def test_no_move_above_threshold_keeps_highest(fresh_repository):
    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    # Stockfish opponent mainline (a7a6) differs from every Maia move; none clear 10%, so the
    # single highest Maia move (e7e5) is kept as a fallback BRANCH alongside the SF mainline.
    engine = ScriptedEngine({START_FEN: "e2e4", after_e4: "a7a6"})
    maia = ScriptedMaia({after_e4: [("e7e5", 0.05), ("c7c5", 0.04), ("d7d6", 0.01)]})
    builder, rep = _white_repertoire(fresh_repository, engine, maia)
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    white_first = reloaded.root_node.children[0]
    opponent_moves = {child.move.uci for child in white_first.children}
    assert opponent_moves == {"a7a6", "e7e5"}
    mainline = next(c for c in white_first.children if c.move.uci == "a7a6")
    assert mainline.is_mainline is True
    assert mainline.source is MoveSource.GENERATED_STOCKFISH
    fallback = next(c for c in white_first.children if c.move.uci == "e7e5")
    assert fallback.is_mainline is False
    assert fallback.source is MoveSource.GENERATED_MAIA3  # highest Maia move, kept as fallback


# ---------- 5. ply_depth stops generation ---------------------------------------

def test_ply_depth_stops_generation(fresh_repository):
    engine = ScriptedEngine()  # falls back to first legal move
    builder, rep = _white_repertoire(fresh_repository, engine, ScriptedMaia())
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=3, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)

    def max_depth(node, current=0):
        if not node.children:
            return current
        return max(max_depth(child, current + 1) for child in node.children)

    assert max_depth(reloaded.root_node) <= 3


# ---------- 6. duplicate child is updated, not duplicated -----------------------

def test_duplicate_child_is_updated_not_duplicated(fresh_repository):
    engine = ScriptedEngine({START_FEN: "e2e4"})
    builder, rep = _white_repertoire(fresh_repository, engine, ScriptedMaia())
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    children_before = [c.id for c in reloaded.root_node.children]
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced"),
    )
    reloaded2 = fresh_repository.load_repertoire(rep.id)
    children_after = [c.id for c in reloaded2.root_node.children]
    assert children_before == children_after


# ---------- 7. manual flags preserved -------------------------------------------

def test_manual_flags_are_preserved(fresh_repository):
    engine = ScriptedEngine({START_FEN: "e2e4"})
    builder, rep = _white_repertoire(fresh_repository, engine, ScriptedMaia())
    manual = builder.add_move(
        rep.id,
        rep.root_node.id,
        "e2e4",
        source=MoveSource.MANUAL,
        is_mainline=True,
        is_user_prepared_move=True,
        tags=["manual-tag"],
    )
    builder.add_comment(rep.id, manual.id, "my note")
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    preserved = next(c for c in reloaded.root_node.children if c.move.uci == "e2e4")
    assert preserved.source is MoveSource.MANUAL
    assert preserved.is_mainline is True
    assert preserved.is_user_prepared_move is True
    assert "manual-tag" in preserved.tags
    assert preserved.comment == "my note"


# ---------- 8. simple mode does not recurse into branches ------------------------

def test_simple_mode_does_not_recurse_into_branches(fresh_repository):
    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    # Opponent mainline (Stockfish) coincides with Maia's e7e5; the mainline recurses, the
    # Maia branches (c7c5, d7d6) do not.
    engine = ScriptedEngine({START_FEN: "e2e4", after_e4: "e7e5"})
    maia = ScriptedMaia({after_e4: [("e7e5", 0.5), ("c7c5", 0.3), ("d7d6", 0.15)]})
    builder, rep = _white_repertoire(fresh_repository, engine, maia)
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=8, detail_mode="simple"),
    )
    reloaded = fresh_repository.load_repertoire(rep.id)
    white_first = reloaded.root_node.children[0]
    by_uci = {c.move.uci: c for c in white_first.children}
    # First-level opponent branches from the mainline are present.
    assert "e7e5" in by_uci
    assert "c7c5" in by_uci
    assert "d7d6" in by_uci
    # Branches should NOT recurse (no grandchildren under the branch nodes).
    for uci, child in by_uci.items():
        if uci != "e7e5":
            assert child.children == [], (
                "simple mode recursed into branch {0}".format(uci)
            )
    # Mainline opponent reply DOES recurse: at least one grandchild.
    mainline_reply = by_uci["e7e5"]
    assert mainline_reply.children, "mainline opponent reply should still recurse"


# ---------- bonus: maia rating is forwarded and clamped --------------------------

def test_maia_rating_is_passed_through(fresh_repository):
    engine = ScriptedEngine({START_FEN: "e2e4"})
    maia = ScriptedMaia()
    builder, rep = _white_repertoire(fresh_repository, engine, maia)
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced", maia_rating=1500),
    )
    assert maia.rating_calls
    assert all(call == 1500 for call in maia.rating_calls)


def test_maia_rating_is_clamped(fresh_repository):
    engine = ScriptedEngine({START_FEN: "e2e4"})
    maia = ScriptedMaia()
    builder, rep = _white_repertoire(fresh_repository, engine, maia)
    builder.generate_from_node(
        rep.id,
        rep.root_node.id,
        GenerateConfig(ply_depth=2, detail_mode="balanced", maia_rating=99999),
    )
    assert maia.rating_calls
    assert all(call == 2600 for call in maia.rating_calls)
