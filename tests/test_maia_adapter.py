"""Lock in the no-silent-fallback contract.

After the MockMaia removal, production code must obtain the real Maia3 model or
fail loudly — never silently degrade to a fake (which previously hid real load
failures and made debugging far harder).
"""
import pytest

from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.maia import (
    Maia3Adapter,
    Maia3Unavailable,
    create_maia3_adapter,
)
from prepforge_chess.services.opening_builder import OpeningBuilderService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


def test_create_maia3_adapter_raises_when_unavailable(monkeypatch):
    # When the real model is not installed, callers get a loud error instead of
    # a silent mock standing in for it.
    monkeypatch.setattr(Maia3Adapter, "is_available", staticmethod(lambda: False))
    with pytest.raises(Maia3Unavailable):
        create_maia3_adapter()


def test_opening_builder_requires_a_maia_adapter():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    with pytest.raises(ValueError):
        OpeningBuilderService(repository, engine=MockEngine())  # no maia -> loud


def test_opening_builder_accepts_explicit_stub():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    assert builder.maia.name == "stub-maia"
