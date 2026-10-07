"""Repository for workflows spanning tree, training, games and account data.

Domain classes own the implementation. One instance shares the request revision
fence and conn-scoped methods for transactions spanning those domains.
"""
from prepforge_chess.storage.repositories.games import GameRepository
from prepforge_chess.storage.repositories.lifecycle import LifecycleRepository
from prepforge_chess.storage.repositories.receipts import ReceiptRepository
from prepforge_chess.storage.repositories.repertoires import RepertoireRepository


class WorkspaceRepository(RepertoireRepository, GameRepository, ReceiptRepository, LifecycleRepository):
    pass
