import pytest

from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.core.models import Color, EngineEvaluation, MoveSource
from prepforge_chess.services.engine import (
    EngineAnalysisConfig,
    EngineCandidate,
    MockEngine,
    PositionAnalysis,
)
from prepforge_chess.services.opening_builder import (
    MAX_ADD_MOVES_BATCH,
    MAX_PLAN_CHANGES,
    MAX_PLAN_DEPTH,
    MAX_PLAN_PV_LENGTH,
    CreateRepertoireRequest,
    OpeningBuilderService,
)
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


# --- Phase 3c: apply_generation_plan (browser submits a plan, server applies) ---


def _white_repertoire(builder):
    return builder.create_repertoire(
        CreateRepertoireRequest(name="Plan", color=Color.WHITE)
    )


def _eval_payload(score_cp=30):
    return {
        "engine": "stockfish (browser)",
        "depth": 8,
        "score_cp": score_cp,
        "mate_in": None,
        "best_move_uci": "e2e4",
        "pv": ["e2e4", "e7e5"],
        "wdl": None,
    }


def test_apply_plan_adds_nodes_with_tempid_chaining_and_persists():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    plan = {
        "rootNodeId": root_id,
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": root_id,
                "moveUci": "e2e4",
                "source": "generated_stockfish",
                "intendedMainline": True,
                "engineEvaluation": _eval_payload(30),
                "maiaProbability": None,
            },
            {
                "action": "planned_add",
                "tempId": "tmp-2",
                "parentRef": "tmp-1",  # parents onto the sibling added above
                "moveUci": "e7e5",
                "source": "generated_maia3",
                "intendedMainline": True,
                "engineEvaluation": None,
                "maiaProbability": 0.42,
            },
        ],
    }

    _rep, summary = builder.apply_generation_plan(rep.id, root_id, plan)
    assert summary.added_nodes == 2
    assert summary.high_probability_unprepared == 1  # e7e5 prob 0.42 >= 0.10

    loaded = repository.load_repertoire(rep.id)
    assert loaded is not None
    e4 = loaded.root_node.children[0]
    assert e4.move.uci == "e2e4"
    assert e4.source is MoveSource.GENERATED_STOCKFISH
    assert e4.is_mainline is True
    assert e4.is_user_prepared_move is True  # root is White to move == repertoire color
    assert e4.engine_evaluation is not None
    assert e4.engine_evaluation.score_cp == 30
    assert e4.engine_evaluation.depth == 8
    e5 = e4.children[0]
    assert e5.move.uci == "e7e5"
    assert e5.source is MoveSource.GENERATED_MAIA3
    assert e5.is_user_prepared_move is False  # Black to move != White repertoire color
    assert e5.maia_probability == 0.42


def test_apply_plan_recomputes_is_mainline_ignoring_client_intent():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    # Two siblings, both claiming mainline. Only the first may keep it.
    plan = {
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": root_id,
                "moveUci": "e2e4",
                "source": "generated_stockfish",
                "intendedMainline": True,
            },
            {
                "action": "planned_add",
                "tempId": "tmp-2",
                "parentRef": root_id,
                "moveUci": "d2d4",
                "source": "generated_stockfish",
                "intendedMainline": True,
            },
        ]
    }
    builder.apply_generation_plan(rep.id, root_id, plan)
    loaded = repository.load_repertoire(rep.id)
    mainline_flags = {c.move.uci: c.is_mainline for c in loaded.root_node.children}
    assert mainline_flags == {"e2e4": True, "d2d4": False}


def test_apply_plan_rejects_illegal_move_without_persisting():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    plan = {
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": root_id,
                "moveUci": "e2e5",  # illegal from the start position
                "source": "generated_stockfish",
                "intendedMainline": True,
            }
        ]
    }
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, plan)
    # All-or-nothing: nothing was saved.
    loaded = repository.load_repertoire(rep.id)
    assert loaded.root_node.children == []


def test_apply_plan_rejects_non_generated_source():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    plan = {
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": root_id,
                "moveUci": "e2e4",
                "source": "manual",  # client can't inject manual authorship
                "intendedMainline": True,
            }
        ]
    }
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, plan)
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_rejects_unknown_parent():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    plan = {
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": "does-not-exist",
                "moveUci": "e2e4",
                "source": "generated_stockfish",
                "intendedMainline": True,
            }
        ]
    }
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, plan)


def test_apply_plan_merges_existing_manual_child_without_duplicate_or_relabel():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    manual = builder.add_move(
        rep.id, root_id, "e2e4", is_mainline=True, is_user_prepared_move=True
    )
    assert manual.engine_evaluation is None

    plan = {
        "changes": [
            {
                "action": "planned_add",
                "tempId": "tmp-1",
                "parentRef": root_id,
                "moveUci": "e2e4",  # same move the user already prepared
                "source": "generated_stockfish",
                "intendedMainline": True,
                "engineEvaluation": _eval_payload(15),
            }
        ]
    }
    _rep, summary = builder.apply_generation_plan(rep.id, root_id, plan)
    assert summary.added_nodes == 0
    assert summary.updated_nodes == 1

    loaded = repository.load_repertoire(rep.id)
    children = loaded.root_node.children
    assert len(children) == 1  # no duplicate
    child = children[0]
    assert child.source is MoveSource.MANUAL  # protected: not relabelled to generated
    assert child.is_user_prepared_move is True
    assert child.engine_evaluation is not None  # eval filled in (was null)
    assert child.engine_evaluation.score_cp == 15


def test_apply_plan_update_fills_only_when_null_and_protects_manual_source():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    manual = builder.add_move(rep.id, root_id, "e2e4", is_user_prepared_move=True)

    plan = {
        "changes": [
            {
                "action": "updated",
                "nodeId": manual.id,
                "engineEvaluation": _eval_payload(20),
                "maiaProbability": 0.25,
                "source": "generated_stockfish",
            }
        ]
    }
    _rep, summary = builder.apply_generation_plan(rep.id, root_id, plan)
    assert summary.updated_nodes == 1
    loaded = repository.load_repertoire(rep.id)
    child = loaded.root_node.children[0]
    assert child.engine_evaluation.score_cp == 20
    assert child.maia_probability == 0.25
    assert child.source is MoveSource.MANUAL  # source upgrade refused on a manual node

    # A second identical update is a no-op (fill-only-when-null already satisfied).
    _rep2, summary2 = builder.apply_generation_plan(rep.id, root_id, plan)
    assert summary2.updated_nodes == 0


# --- Phase 3c Stage 3 hardening: untrusted-payload bounds ---


def _planned_add(temp_id, parent_ref, move_uci, **extra):
    change = {
        "action": "planned_add",
        "tempId": temp_id,
        "parentRef": parent_ref,
        "moveUci": move_uci,
        "source": "generated_stockfish",
        "intendedMainline": True,
    }
    change.update(extra)
    return change


def _knight_shuffle_chain(root_id, length):
    # A legal, arbitrarily deep line: knights shuffle g1<->f3 / g8<->f6. Each link
    # parents onto the previous tempId, so it builds one deep chain from the root.
    white = ["g1f3", "f3g1"]
    black = ["g8f6", "f6g8"]
    changes = []
    parent = root_id
    for i in range(length):
        uci = white[(i // 2) % 2] if i % 2 == 0 else black[(i // 2) % 2]
        temp = "tmp-{0}".format(i + 1)
        changes.append(_planned_add(temp, parent, uci))
        parent = temp
    return changes


def test_apply_plan_rejects_root_id_mismatch():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    plan = {
        "rootNodeId": "some-other-anchor",
        "changes": [_planned_add("tmp-1", root_id, "e2e4")],
    }
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, plan)
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_rejects_too_many_changes_without_persisting():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    # Oversized but otherwise well-formed: the count cap fires before any apply.
    changes = [
        _planned_add("tmp-{0}".format(i), root_id, "e2e4")
        for i in range(MAX_PLAN_CHANGES + 1)
    ]
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, {"changes": changes})
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_rejects_too_deep_temp_chain_without_persisting():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    changes = _knight_shuffle_chain(root_id, MAX_PLAN_DEPTH + 1)
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, {"changes": changes})
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_accepts_chain_at_the_depth_limit():
    # A chain exactly at the cap must still apply (the cap is inclusive).
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    changes = _knight_shuffle_chain(root_id, MAX_PLAN_DEPTH)
    _rep, summary = builder.apply_generation_plan(rep.id, root_id, {"changes": changes})
    assert summary.added_nodes == MAX_PLAN_DEPTH


def test_apply_plan_requires_well_formed_temp_id():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    # Missing tempId.
    bad = {"action": "planned_add", "parentRef": root_id, "moveUci": "e2e4", "source": "generated_stockfish"}
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, {"changes": [bad]})

    # tempId without the 'tmp-' prefix.
    with pytest.raises(ValueError):
        builder.apply_generation_plan(
            rep.id, root_id, {"changes": [_planned_add("x-1", root_id, "e2e4")]}
        )

    # tempId colliding with a real node id.
    with pytest.raises(ValueError):
        builder.apply_generation_plan(
            rep.id, root_id, {"changes": [_planned_add(root_id, root_id, "e2e4")]}
        )

    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_rejects_duplicate_temp_id():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    changes = [
        _planned_add("tmp-1", root_id, "e2e4"),
        _planned_add("tmp-1", root_id, "d2d4"),  # reused id
    ]
    with pytest.raises(ValueError):
        builder.apply_generation_plan(rep.id, root_id, {"changes": changes})
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_rejects_out_of_range_probability():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    for bad_prob in (2.0, -0.5, float("inf"), float("nan")):
        with pytest.raises(ValueError):
            builder.apply_generation_plan(
                rep.id,
                root_id,
                {"changes": [_planned_add("tmp-1", root_id, "e7e5", maiaProbability=bad_prob)]},
            )
    assert repository.load_repertoire(rep.id).root_node.children == []


# --- Phase 1: add_moves_batch (local-first Build flush, MANUAL moves) ---


def _knight_chain_moves(root_id, length):
    # A legal, arbitrarily deep line of {tempId, parentRef, uci} dicts: knights
    # shuffle, each link parenting onto the previous tempId (one deep chain).
    white = ["g1f3", "f3g1"]
    black = ["g8f6", "f6g8"]
    moves = []
    parent = root_id
    for i in range(length):
        uci = white[(i // 2) % 2] if i % 2 == 0 else black[(i // 2) % 2]
        temp = "tmp-{0}".format(i + 1)
        moves.append({"tempId": temp, "parentRef": parent, "uci": uci})
        parent = temp
    return moves


def test_add_moves_batch_chains_tempids_and_returns_id_map():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    moves = [
        {"tempId": "tmp-1", "parentRef": root_id, "uci": "e2e4"},
        {"tempId": "tmp-2", "parentRef": "tmp-1", "uci": "e7e5"},  # parents on sibling
    ]
    _rep, summary, id_map = builder.add_moves_batch(rep.id, moves)
    assert summary.added_nodes == 2
    assert set(id_map) == {"tmp-1", "tmp-2"}
    assert not any(v.startswith("tmp-") for v in id_map.values())  # all real ids

    loaded = repository.load_repertoire(rep.id)
    e4 = loaded.root_node.children[0]
    assert e4.id == id_map["tmp-1"]
    assert e4.move.uci == "e2e4"
    assert e4.source is MoveSource.MANUAL
    assert e4.is_mainline is True
    assert e4.is_user_prepared_move is True  # White move in a White repertoire
    assert "prepared" in e4.tags
    e5 = e4.children[0]
    assert e5.id == id_map["tmp-2"]
    assert e5.move.uci == "e7e5"
    assert e5.source is MoveSource.MANUAL
    assert e5.is_user_prepared_move is False  # Black move != White repertoire color
    assert e5.tags == []


def test_add_moves_batch_recomputes_first_enabled_child_as_mainline():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    moves = [
        {"tempId": "tmp-1", "parentRef": root_id, "uci": "e2e4"},
        {"tempId": "tmp-2", "parentRef": root_id, "uci": "d2d4"},
    ]
    builder.add_moves_batch(rep.id, moves)
    loaded = repository.load_repertoire(rep.id)
    mainline = {c.move.uci: c.is_mainline for c in loaded.root_node.children}
    assert mainline == {"e2e4": True, "d2d4": False}


def test_add_moves_batch_dedupes_existing_child_without_duplicate():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    manual = builder.add_move(
        rep.id, root_id, "e2e4", is_mainline=True, is_user_prepared_move=True
    )

    _rep, summary, id_map = builder.add_moves_batch(
        rep.id, [{"tempId": "tmp-1", "parentRef": root_id, "uci": "e2e4"}]
    )
    assert summary.added_nodes == 0
    assert id_map == {"tmp-1": manual.id}  # tmp resolves to the existing node

    loaded = repository.load_repertoire(rep.id)
    assert len(loaded.root_node.children) == 1  # no duplicate


def test_add_moves_batch_rejects_illegal_move_without_persisting():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    moves = [
        {"tempId": "tmp-1", "parentRef": root_id, "uci": "e2e4"},
        {"tempId": "tmp-2", "parentRef": "tmp-1", "uci": "e2e5"},  # illegal
    ]
    with pytest.raises(ValueError):
        builder.add_moves_batch(rep.id, moves)
    # All-or-nothing: the legal first move never lands either.
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_add_moves_batch_rejects_unknown_parent():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    with pytest.raises(ValueError):
        builder.add_moves_batch(
            rep.id, [{"tempId": "tmp-1", "parentRef": "does-not-exist", "uci": "e2e4"}]
        )
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_add_moves_batch_rejects_too_many_without_persisting():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    moves = [
        {"tempId": "tmp-{0}".format(i), "parentRef": root_id, "uci": "e2e4"}
        for i in range(MAX_ADD_MOVES_BATCH + 1)
    ]
    with pytest.raises(ValueError):
        builder.add_moves_batch(rep.id, moves)
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_add_moves_batch_rejects_too_deep_chain_but_accepts_at_limit():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    over = _knight_chain_moves(root_id, MAX_PLAN_DEPTH + 1)
    with pytest.raises(ValueError):
        builder.add_moves_batch(rep.id, over)
    assert repository.load_repertoire(rep.id).root_node.children == []

    at_limit = _knight_chain_moves(root_id, MAX_PLAN_DEPTH)
    _rep, summary, _id_map = builder.add_moves_batch(rep.id, at_limit)
    assert summary.added_nodes == MAX_PLAN_DEPTH


def test_add_moves_batch_requires_well_formed_temp_id():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id
    # tempId without the 'tmp-' prefix is rejected (parity with apply-plan).
    with pytest.raises(ValueError):
        builder.add_moves_batch(
            rep.id, [{"tempId": "x-1", "parentRef": root_id, "uci": "e2e4"}]
        )
    # Duplicate tempId is rejected.
    with pytest.raises(ValueError):
        builder.add_moves_batch(
            rep.id,
            [
                {"tempId": "tmp-1", "parentRef": root_id, "uci": "e2e4"},
                {"tempId": "tmp-1", "parentRef": root_id, "uci": "d2d4"},
            ],
        )
    assert repository.load_repertoire(rep.id).root_node.children == []


def test_apply_plan_rejects_malformed_engine_eval():
    repository, builder = _builder()
    rep = _white_repertoire(builder)
    root_id = rep.root_node.id

    # pv too long.
    long_pv = {"engine": "x", "pv": ["e2e4"] * (MAX_PLAN_PV_LENGTH + 1)}
    with pytest.raises(ValueError):
        builder.apply_generation_plan(
            rep.id, root_id,
            {"changes": [_planned_add("tmp-1", root_id, "e2e4", engineEvaluation=long_pv)]},
        )

    # pv with a non-UCI entry.
    bad_pv = {"engine": "x", "pv": ["e2e4", "not-a-move"]}
    with pytest.raises(ValueError):
        builder.apply_generation_plan(
            rep.id, root_id,
            {"changes": [_planned_add("tmp-1", root_id, "e2e4", engineEvaluation=bad_pv)]},
        )

    # wdl present but not an object.
    bad_wdl = {"engine": "x", "pv": ["e2e4"], "wdl": [1, 2, 3]}
    with pytest.raises(ValueError):
        builder.apply_generation_plan(
            rep.id, root_id,
            {"changes": [_planned_add("tmp-1", root_id, "e2e4", engineEvaluation=bad_wdl)]},
        )

    # wdl with a non-finite value.
    nan_wdl = {"engine": "x", "pv": ["e2e4"], "wdl": {"win": float("inf")}}
    with pytest.raises(ValueError):
        builder.apply_generation_plan(
            rep.id, root_id,
            {"changes": [_planned_add("tmp-1", root_id, "e2e4", engineEvaluation=nan_wdl)]},
        )

    assert repository.load_repertoire(rep.id).root_node.children == []
