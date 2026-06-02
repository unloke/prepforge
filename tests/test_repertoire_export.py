from prepforge_chess.core.models import Color, MoveSource
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.repertoire_export import (
    PACKAGE_SCHEMA_VERSION,
    RepertoireExportService,
)
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


def _sample_repertoire():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(
            name="Export Demo",
            color=Color.WHITE,
            notes="Used by export tests",
            tags=["demo"],
        )
    )

    e4 = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "e2e4",
        is_mainline=True,
        is_user_prepared_move=True,
        comment="Main move",
        tags=["prepared"],
    )
    e5 = builder.add_move(
        repertoire.id,
        e4.id,
        "e7e5",
        source=MoveSource.GENERATED_MAIA3,
        is_mainline=True,
    )
    builder.add_move(repertoire.id, e5.id, "g1f3", is_mainline=True)
    d4 = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "d2d4",
        tags=["branch"],
    )

    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    return loaded, d4.id


def test_export_package_contains_repertoire_and_node_metadata():
    repertoire, _ = _sample_repertoire()
    package = RepertoireExportService().export_package(repertoire)

    assert package["schema_version"] == PACKAGE_SCHEMA_VERSION
    assert package["repertoire"]["name"] == "Export Demo"
    assert package["repertoire"]["tags"] == ["demo"]
    assert len(package["nodes"]) == 5

    e4_node = next(node for node in package["nodes"] if node["move"] and node["move"]["uci"] == "e2e4")
    assert e4_node["is_mainline"]
    assert e4_node["is_user_prepared_move"]
    assert e4_node["comment"] == "Main move"
    assert e4_node["tags"] == ["prepared"]
    assert e4_node["move"]["san"] == "e4"
    assert e4_node["move"]["fen_before"] == repertoire.root_fen


def test_export_package_json_imports_back_to_equivalent_tree():
    repertoire, _ = _sample_repertoire()
    exporter = RepertoireExportService()
    imported = exporter.import_package_json(exporter.export_package_json(repertoire))

    assert imported.id == repertoire.id
    assert imported.name == repertoire.name
    assert imported.color is Color.WHITE
    assert imported.root_node.children
    e4 = next(child for child in imported.root_node.children if child.move and child.move.uci == "e2e4")
    assert e4.is_user_prepared_move
    assert e4.comment == "Main move"
    assert e4.children[0].move is not None
    assert e4.children[0].move.uci == "e7e5"
    assert e4.children[0].source is MoveSource.GENERATED_MAIA3


def test_export_mainline_pgn_uses_prepared_mainline():
    repertoire, _ = _sample_repertoire()
    pgn = RepertoireExportService().export_mainline_pgn(repertoire)

    assert '[Event "Export Demo"]' in pgn
    assert '[White "Repertoire"]' in pgn
    assert "1. e4 e5 2. Nf3 *" in pgn


def test_export_node_path_pgn_can_export_a_single_branch_path():
    repertoire, d4_node_id = _sample_repertoire()
    pgn = RepertoireExportService().export_node_path_pgn(repertoire, d4_node_id)

    assert '[Event "Export Demo"]' in pgn
    assert "1. d4 *" in pgn
