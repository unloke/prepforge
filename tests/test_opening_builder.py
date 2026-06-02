from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.core.models import Color, EngineEvaluation, MoveSource
from prepforge_chess.services.engine import (
    EngineAnalysisConfig,
    EngineCandidate,
    MockEngine,
    PositionAnalysis,
)
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.opening_generation import GenerateConfig
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


def _builder():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    return repository, OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())


def test_create_repertoire_and_add_prepared_move_round_trip():
    repository, builder = _builder()
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(
            name="Queen Pawn",
            color=Color.WHITE,
            root_fen=STARTING_FEN,
        )
    )

    child = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "d2d4",
        is_mainline=True,
        is_user_prepared_move=True,
        comment="Main move",
        tags=["prepared"],
    )

    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    assert loaded.name == "Queen Pawn"
    assert loaded.root_node.children
    loaded_child = loaded.root_node.children[0]
    assert loaded_child.id == child.id
    assert loaded_child.move is not None
    assert loaded_child.move.uci == "d2d4"
    assert loaded_child.is_user_prepared_move
    assert loaded_child.comment == "Main move"
    assert loaded_child.tags == ["prepared"]


def test_generate_from_root_adds_nodes_and_persists_tree():
    repository, builder = _builder()
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Demo", color=Color.WHITE)
    )

    generated, summary = builder.generate_from_node(
        repertoire.id,
        repertoire.root_node.id,
        GenerateConfig(depth_plies=3, max_new_nodes=12, own_side_candidate_count=1),
    )

    assert summary.added_nodes > 0
    assert generated.root_node.children
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    assert loaded.root_node.children
    assert loaded.root_node.children[0].source is MoveSource.GENERATED_STOCKFISH


def test_generate_uses_configured_engine_depth():
    class RecordingEngine(MockEngine):
        def __init__(self):
            super().__init__()
            self.depths = []

        def analyze_position(self, fen, config=EngineAnalysisConfig()):
            self.depths.append(config.depth)
            return super().analyze_position(fen, config)

    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    engine = RecordingEngine()
    builder = OpeningBuilderService(
        repository,
        engine=engine,
        engine_config=EngineAnalysisConfig(depth=17),
        maia=StubMaia(),
    )
    repertoire = builder.create_repertoire(CreateRepertoireRequest(name="Depth", color=Color.WHITE))

    builder.generate_from_node(
        repertoire.id,
        repertoire.root_node.id,
        GenerateConfig(depth_plies=1, max_new_nodes=4),
    )

    assert engine.depths == [17]


def test_generate_preserves_manual_prepared_child_and_adds_branch():
    class BranchEngine(MockEngine):
        def analyze_position(self, fen, config=EngineAnalysisConfig()):
            if fen != STARTING_FEN:
                return super().analyze_position(fen, config)
            moves = ["e2e4", "d2d4"][: max(1, config.multipv)]
            candidates = [
                EngineCandidate(
                    move_uci=move,
                    evaluation_after=EngineEvaluation(engine="branch-engine", score_cp=20 - index),
                    rank=index,
                    pv=[move],
                )
                for index, move in enumerate(moves, start=1)
            ]
            return PositionAnalysis(
                fen=fen,
                evaluation=EngineEvaluation(engine="branch-engine", score_cp=0),
                candidates=candidates,
            )

    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    builder = OpeningBuilderService(repository, engine=BranchEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Prepared", color=Color.WHITE)
    )
    prepared = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "e2e4",
        is_mainline=True,
        is_user_prepared_move=True,
        source=MoveSource.MANUAL,
    )

    _, summary = builder.generate_from_node(
        repertoire.id,
        repertoire.root_node.id,
        GenerateConfig(depth_plies=2, max_new_nodes=8, preserve_manual_prepared_moves=True),
    )
    loaded = repository.load_repertoire(repertoire.id)

    assert summary.added_nodes > 0
    assert loaded is not None
    by_uci = {child.move.uci: child for child in loaded.root_node.children}
    assert by_uci["e2e4"].id == prepared.id
    assert by_uci["e2e4"].source is MoveSource.MANUAL
    assert by_uci["e2e4"].is_mainline is True
    assert by_uci["e2e4"].children == []
    assert by_uci["d2d4"].source is MoveSource.GENERATED_STOCKFISH
    assert by_uci["d2d4"].is_mainline is False
    assert by_uci["d2d4"].children


def test_node_operations_update_tree_metadata():
    repository, builder = _builder()
    repertoire = builder.create_repertoire(CreateRepertoireRequest(name="Ops", color=Color.WHITE))
    first = builder.add_move(repertoire.id, repertoire.root_node.id, "e2e4")
    second = builder.add_move(repertoire.id, repertoire.root_node.id, "d2d4")

    builder.set_as_mainline(repertoire.id, second.id)
    builder.mark_prepared(repertoire.id, second.id, True)
    builder.add_comment(repertoire.id, second.id, "Preferred line")
    builder.add_tag(repertoire.id, second.id, "demo")

    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    children = {child.id: child for child in loaded.root_node.children}
    assert not children[first.id].is_mainline
    assert children[second.id].is_mainline
    assert children[second.id].is_user_prepared_move
    assert children[second.id].comment == "Preferred line"
    assert children[second.id].tags == ["demo"]


def test_disable_branch_is_recursive_and_report_filters_nodes():
    repository, builder = _builder()
    repertoire = builder.create_repertoire(CreateRepertoireRequest(name="Filters", color=Color.WHITE))
    first = builder.add_move(repertoire.id, repertoire.root_node.id, "e2e4", is_mainline=True)
    reply = builder.add_move(repertoire.id, first.id, "e7e5")
    builder.add_move(repertoire.id, reply.id, "g1f3", tags=["trap"])

    builder.disable_branch(repertoire.id, reply.id)

    all_report = builder.tree_report(repertoire.id, include_disabled=True)
    visible_report = builder.tree_report(repertoire.id)
    mainline_report = builder.tree_report(repertoire.id, filter_mode="mainline", include_disabled=True)
    trap_report = builder.tree_report(repertoire.id, filter_mode="mistake-traps", include_disabled=True)

    assert all_report.total_nodes == 4
    assert len(visible_report.visible_nodes) == 2
    assert any(not item.is_enabled for item in all_report.visible_nodes)
    assert [item.san for item in mainline_report.visible_nodes] == ["root", "e4"]
    assert [item.san for item in trap_report.visible_nodes] == ["root", "e4", "e5", "Nf3"]
