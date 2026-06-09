"""Lock in the no-silent-fallback contract.

After the MockMaia removal, production code must obtain the real Maia3 model or
fail loudly — never silently degrade to a fake (which previously hid real load
failures and made debugging far harder).
"""
import pytest

from prepforge_chess.core.models import Color
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.maia import (
    Maia3Adapter,
    Maia3Unavailable,
    create_maia3_adapter,
)
from prepforge_chess.services.opening_builder import (
    CreateRepertoireRequest,
    OpeningBuilderService,
)
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


def test_create_maia3_adapter_raises_when_unavailable(monkeypatch):
    # When the real model is not installed, callers get a loud error instead of
    # a silent mock standing in for it.
    monkeypatch.setattr(Maia3Adapter, "is_available", staticmethod(lambda: False))
    with pytest.raises(Maia3Unavailable):
        create_maia3_adapter()


def test_opening_builder_defers_maia_requirement_to_generation():
    # Construction without a Maia is allowed (pure data/serialization paths — e.g. the
    # FastAPI server, which stores data and never computes chess — need no model). The
    # no-silent-fake contract is preserved: reaching for the human model fails LOUDLY.
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    builder = OpeningBuilderService(repository, engine=MockEngine())  # no maia -> OK
    # Data-only operation still works without a model.
    rep = builder.create_repertoire(CreateRepertoireRequest(name="R", color=Color.WHITE))
    assert builder.tree_report(rep.id).total_nodes == 1
    # But the generation path (which uses the model) raises instead of faking it.
    with pytest.raises(ValueError):
        _ = builder.maia


def test_opening_builder_accepts_explicit_stub():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    assert builder.maia.name == "stub-maia"
