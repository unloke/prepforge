import io

import chess.pgn
import pytest

from prepforge_chess.core.models import Color, MoveSource
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.repertoire_export import (
    PACKAGE_SCHEMA_VERSION,
    RepertoireExportService,
)
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def _sample_repertoire():
    connection = connect_database()
    apply_schema(connection)
    repository = WorkspaceRepository(connection)
    builder = OpeningBuilderService(repository)
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


@pytest.mark.parametrize("moves", ["*", "1. d4 d5 *"])
def test_import_tree_preserves_root_notes_and_drawings(moves):
    repertoire = RepertoireExportService().import_tree_pgn(
        '{ Develop the London bishop. [%cal Gc1f4] [%csl Yd4] } ' + moves,
        name="London",
        color=Color.WHITE,
    )

    root = repertoire.root_node
    assert root.comment == "Develop the London bishop."
    assert root.arrows == ["c1f4"]
    assert root.circles == ["d4"]
    assert all(child.comment is None for child in root.children)


def test_export_tree_writes_root_annotations_before_moves():
    repertoire, _ = _sample_repertoire()
    root = repertoire.root_node
    root.comment = "先出象，然後控制中心。"
    root.arrows = ["c1f4"]
    root.circles = ["d4"]

    parsed = chess.pgn.read_game(io.StringIO(
        RepertoireExportService().export_tree_pgn(repertoire)
    ))

    assert parsed is not None
    assert not parsed.errors
    assert root.comment in parsed.comment
    assert "[%cal Gc1f4]" in parsed.comment
    assert "[%csl Gd4]" in parsed.comment
    assert parsed.variations[0].comment == "Main move [prepared]"


def test_variation_intro_stays_on_its_branch_and_survives_roundtrip():
    service = RepertoireExportService()
    pgn = (
        '{ Root orientation. } 1. e4 { Main plan. } e5 '
        '( { Sicilian alternative. [%cal Gc7c5] } '
        '1... c5 { Pressure on d4. [%csl Rd4] } 2. Nf3 ) *'
    )
    imported = service.import_tree_pgn(pgn, name="Branches", color=Color.WHITE)

    for repertoire in [imported, service.import_tree_pgn(
        service.export_tree_pgn(imported), name="Roundtrip", color=Color.WHITE
    )]:
        root = repertoire.root_node
        e4 = root.children[0]
        e5, c5 = e4.children
        assert root.comment == "Root orientation."
        assert e4.comment == "Main plan."
        assert e5.comment is None
        assert c5.comment == "Sicilian alternative.\n\nPressure on d4."
        assert c5.arrows == ["c7c5"]
        assert c5.circles == ["d4"]
        assert c5.children[0].comment is None


def test_custom_fen_root_annotation_roundtrip():
    service = RepertoireExportService()
    fen = "8/8/8/8/8/8/4K3/7k b - - 0 12"
    pgn = (
        f'[SetUp "1"]\n[FEN "{fen}"]\n\n'
        '{ Opposition. [%cal Gh1g1] [%csl Ge2] } 12... Kg1 *'
    )
    imported = service.import_tree_pgn(pgn, name="Ending", color=Color.BLACK)
    restored = service.import_tree_pgn(
        service.export_tree_pgn(imported), name="Restored", color=Color.BLACK
    )

    assert restored.root_fen == fen
    assert restored.root_node.comment == "Opposition."
    assert restored.root_node.arrows == ["h1g1"]
    assert restored.root_node.circles == ["e2"]
    assert restored.root_node.children[0].comment is None
