"""Narrow store ports: what each router, service and workflow may touch.

There is still ONE database and ONE unit-of-work implementation,
``storage.repositories.workspace.WorkspaceRepository``; ``api.deps.get_repository``
hands each request a single instance, so its revision fence and transactions span
domains exactly as before. These ``Protocol`` classes only narrow the view: a
caller annotates its repository parameter with the port it needs and may use
nothing else. They cost nothing at runtime (no wrapper object, no extra call).

``tests/test_store_ports.py`` keeps them honest: every port member must exist on
``WorkspaceRepository`` with the same parameters, and every function or class
whose repository is annotated with a port may only use that port's members.

Base ports are per domain. Consumer ports combine them for one service or
workflow, and router ports for one router's endpoints. A tree delete and the
training cleanup it needs meet only in ``services.workflows``; the test checks
that no other router or service calls either side.
"""
from __future__ import annotations

from datetime import datetime
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    ContextManager,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Protocol,
    Sequence,
    Tuple,
)

from sqlalchemy.engine import Connection, Engine

if TYPE_CHECKING:
    from prepforge_chess.core.models import (
        AnalysisResult,
        Game,
        OpeningNode,
        Repertoire,
        TrainingMode,
        TrainingProgress,
        TrainingSession,
    )


# ------------------------------------------------------------------ base ports


class UnitOfWork(Protocol):
    """The shared database. ``engine.begin()`` opens the one transaction that
    every conn-scoped method of every port joins."""
    engine: Engine


class SettingsStore(Protocol):
    """Per-user key/value settings (``user_settings``)."""
    def get_user_setting(self, user_id: str, key: str, default: Any = None) -> Any: ...
    def set_user_setting(self, user_id: str, key: str, value: Any) -> None: ...
    def mutate_user_setting(
        self, user_id: str, key: str, mutator: 'Callable[[Any], Any]',
    ) -> Any: ...
    def lock_user_setting(
        self, conn: Connection, user_id: str, key: str, default: Any = None,
    ) -> Any: ...
    def write_user_setting(self, conn: Connection, user_id: str, key: str, value: Any) -> None: ...


class GameStore(Protocol):
    """Imported games and their analysis snapshots."""
    def save_game(
        self,
        game: Game,
        result: Optional[AnalysisResult] = None,
        owner_user_id: Optional[str] = None,
    ) -> None: ...
    def load_game(
        self, game_id: str, owner_user_id: Optional[str] = None, *, render_pgn: bool = False,
    ) -> Optional[Game]: ...
    def find_game_id_by_lichess_id(
        self, lichess_id: str, owner_user_id: Optional[str] = None,
    ) -> Optional[str]: ...
    def existing_move_signature_ids(
        self, owner_user_id: Optional[str], signatures: Iterable[str],
    ) -> Dict[str, str]: ...
    def claim_or_verify_game(self, game_id: str, owner_user_id: str) -> bool: ...
    def load_analysis_pgn(self, game_id: str, owner_user_id: str) -> Optional[str]: ...
    def save_analysis_pgn(self, game_id: str, pgn: str, owner_user_id: str) -> bool: ...
    def list_analyzed_games(
        self,
        owner_user_id: Optional[str] = None,
        *,
        limit: int = 50,
        cursor: Optional[tuple[datetime, str]] = None,
        lichess_id: Optional[str] = None,
    ) -> tuple[List[Dict[str, Any]], Optional[tuple]]: ...
    def load_latest_analysis_result(
        self, game_id: str, owner_user_id: Optional[str] = None,
    ) -> Optional[AnalysisResult]: ...
    def latest_analysis_meta(self, game_id: str, owner_user_id: str) -> Optional[Dict[str, Any]]: ...
    def analyzed_mainline(self, game_id: str, owner_user_id: str) -> Optional[tuple[str, List[str]]]: ...
    def load_analysis_save(self, game_id: str, save_id: str) -> Optional[AnalysisResult]: ...
    def has_analysis_save(self, game_id: str, save_id: str, owner_user_id: str) -> bool: ...
    def delete_analysis_results(self, game_id: str, owner_user_id: Optional[str] = None) -> int: ...


class RepertoireReader(Protocol):
    """Reads of repertoire trees and their metadata, plus the cached health badge."""
    def load_repertoire(
        self,
        repertoire_id: str,
        owner_user_id: Optional[str] = None,
        *,
        conn: Optional[Connection] = None,
        hydrate: bool = True,
    ) -> Optional[Repertoire]: ...
    def list_repertoires(
        self,
        owner_user_id: Optional[str] = None,
        *,
        repertoire_ids: Optional[List[str]] = None,
        hydrate: bool = True,
    ) -> List[Repertoire]: ...
    def list_repertoire_metas(
        self, owner_user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]: ...
    def repertoire_meta(
        self, repertoire_id: str, *, conn: Optional[Connection] = None,
    ) -> Optional[Dict[str, Any]]: ...
    def list_owner_repertoire_listings(self, owner_user_id: str) -> List[Dict[str, Any]]: ...
    def repertoire_reply_revision(self, repertoire_id: str) -> Optional[int]: ...
    def repertoire_ops_since(self, repertoire_id: str, since: int) -> List[Dict[str, Any]]: ...
    def node_repertoire_ids(
        self, conn: Connection, repertoire_ids: Iterable[str], node_ids: Iterable[Optional[str]],
    ) -> Dict[str, str]: ...
    def set_repertoire_health(
        self,
        repertoire_id: str,
        health: Optional[Dict[str, Any]],
        *,
        expected_cache: Optional[Dict[str, Any]] = None,
        cache_snapshot: bool = False,
    ) -> None: ...


class EditAttribution(Protocol):
    """Who makes the next logged edit, and what kind it is."""
    op_actor: Optional[str]
    op_kind: str


class RepertoireWriter(UnitOfWork, RepertoireReader, EditAttribution, Protocol):
    """Tree and metadata writes. Each bumps the revision and logs its op, tagged
    with ``op_actor``/``op_kind``."""
    def repertoire_edit(self, repertoire_id: str) -> ContextManager[Connection]: ...
    def edit_transaction(self) -> ContextManager[Connection]: ...
    def bump_revision(
        self,
        conn: Connection,
        repertoire_id: str,
        *,
        nodes: Iterable[str] = (),
        removed: Iterable[str] = (),
        meta: bool = False,
        reset: bool = False,
        before: Optional[dict] = None,
        after_rows: Optional[Dict[str, Dict[str, Any]]] = None,
        metadata_before: Optional[dict] = None,
        discussion_id: Optional[str] = None,
        reverted_revision: Optional[int] = None,
    ) -> int: ...
    def save_repertoire(
        self,
        repertoire: Repertoire,
        owner_user_id: Optional[str] = None,
        *,
        max_owned: Optional[int] = None,
    ) -> None: ...
    def update_repertoire_fields(self, repertoire_id: str, **fields: Any) -> None: ...
    def save_changed_nodes(
        self, repertoire_id: str, nodes: List[OpeningNode], *, receipt: Optional[tuple] = None,
    ) -> None: ...
    def update_opening_nodes(self, repertoire_id: str, changes: List[Dict[str, Any]]) -> None: ...
    def set_node_annotations(
        self, repertoire_id: str, node_id: str, arrows: List[str], circles: List[str],
    ) -> None: ...
    def set_repertoire_active(self, repertoire_id: str, active: bool) -> None: ...
    def claim_repertoire(self, repertoire_id: str, owner_user_id: str) -> None: ...
    def remove_opening_nodes(
        self, conn: Connection, repertoire_id: str, node_ids: List[str],
    ) -> None: ...
    def remove_repertoire(self, conn: Connection, repertoire_id: str) -> None: ...


class AccessStore(Protocol):
    """Who may see a repertoire, and what they may do with it."""
    def access_role(
        self, repertoire_id: str, user_id: str,
    ) -> tuple[Optional[Dict[str, Any]], Optional[str]]: ...
    def list_shared_with(self, user_id: str) -> List[Dict[str, Any]]: ...


class EditGate(AccessStore, EditAttribution, Protocol):
    """The access check before an edit, which also stamps who makes it."""


class SharingStore(AccessStore, Protocol):
    """Grants and share links."""
    def repertoire_grants(self, repertoire_id: str) -> List[Dict[str, Any]]: ...
    def set_grant(
        self,
        repertoire_id: str,
        *,
        role: str,
        created_by: str,
        team_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> None: ...
    def delete_grant(
        self, repertoire_id: str, *, team_id: Optional[str] = None, user_id: Optional[str] = None,
    ) -> bool: ...
    def set_share_state(
        self,
        repertoire_id: str,
        *,
        enabled: Optional[bool] = None,
        rotate: bool = False,
        expires_at: Optional[datetime] = None,
        clear_expiry: bool = False,
        role: Optional[str] = None,
    ) -> Dict[str, Any]: ...
    def list_repertoires_shared_to_team(self, team_id: str) -> List[Dict[str, Any]]: ...


class TrainingProgressReader(Protocol):
    """Read-only views of training progress."""
    def due_counts_by_repertoire(
        self, owner_user_id: str, *, now: Optional[datetime] = None,
    ) -> Dict[str, int]: ...
    def due_windows_by_repertoire(
        self, owner_user_id: str, *, now: datetime, until: datetime,
    ) -> Dict[str, Dict[str, int]]: ...
    def list_training_progress(
        self, repertoire_id: str, *, owner_user_id: str,
    ) -> List[TrainingProgress]: ...
    def list_training_progress_for_repertoires(
        self, repertoire_ids: List[str], *, owner_user_id: str,
    ) -> Dict[str, List[TrainingProgress]]: ...


class TrainingStore(UnitOfWork, TrainingProgressReader, Protocol):
    """Training sessions, progress and reviews."""
    def load_training_session(self, session_id: str) -> Optional[TrainingSession]: ...
    def load_latest_training_session(
        self,
        repertoire_id: str,
        owner_user_id: str,
        mode: Optional[TrainingMode] = None,
        scope: Optional[str] = None,
    ) -> Optional[TrainingSession]: ...
    def lock_training_session(
        self, conn: Connection, *, session_id: str,
    ) -> Optional[TrainingSession]: ...
    def save_training_session(self, session: TrainingSession) -> None: ...
    def write_training_session(self, conn: Connection, session: TrainingSession) -> None: ...
    def restart_training_session(self, session: TrainingSession, owner: str | None) -> None: ...
    def lock_training_progress(
        self, conn: Connection, *, repertoire_id: str, node_id: str, owner_user_id: str,
    ) -> TrainingProgress: ...
    def write_training_progress(
        self,
        conn: Connection,
        *,
        repertoire_id: str,
        progress: TrainingProgress,
        owner_user_id: str,
    ) -> None: ...
    def write_review(
        self,
        conn: Connection,
        *,
        owner_user_id: str,
        node_id: str,
        rating: int,
        reviewed_at: datetime,
    ) -> None: ...


class TrainingCleanupStore(Protocol):
    """What a tree delete must do to training state first. Only the workflows in
    ``services.workflows`` use it."""
    def recent_reviews_on_nodes(
        self,
        conn: Connection,
        node_ids: List[str],
        *,
        since: datetime,
        repertoire_id: Optional[str] = None,
    ) -> List[Any]: ...
    def release_session_cursors(self, conn: Connection, node_ids: List[str]) -> None: ...
    def archive_reviews(self, conn: Connection, reviewed, week_ago: datetime) -> None: ...
    def archive_repertoire_training(
        self, conn: Connection, repertoire_id: str, week_ago: datetime,
    ) -> None: ...


class ReceiptStore(Protocol):
    """Idempotency receipts for trainer attempts."""
    def record_attempt_receipt(
        self, conn: Connection, *, session_id: str, attempt_uuid: str, node_id: str, correct: bool,
    ) -> bool: ...
    def attempt_receipts(
        self, conn: Connection, session_id: str, attempt_uuids: List[Optional[str]],
    ) -> Dict[Optional[str], Tuple[str, int]]: ...
    def claimed_attempt(self, conn: Connection, session_id: str, attempt_uuid: str) -> Any: ...


class CollaborationStore(Protocol):
    """The activity feed, inverse edits and position discussions."""
    def activity_rows(self, repertoire_id: str) -> Sequence[Mapping[str, Any]]: ...
    def revert_op(
        self,
        conn: Connection,
        rid: str,
        revision: int,
        *,
        before_delete: Callable[[Connection, List[str]], None],
    ) -> List[str]: ...
    def discussions(
        self, repertoire_id: str,
    ) -> Tuple[Sequence[Mapping[str, Any]], Sequence[Mapping[str, Any]]]: ...
    def discussion_thread(
        self, conn: Connection, repertoire_id: str, thread_id: str,
    ) -> Optional[Mapping[str, Any]]: ...
    def discussion_thread_at(
        self, conn: Connection, repertoire_id: str, position_key: str,
    ) -> Optional[str]: ...
    def start_discussion_thread(self, conn: Connection, **values: Any) -> None: ...
    def add_discussion_message(self, conn: Connection, **values: Any) -> None: ...
    def update_discussion_thread(
        self, conn: Connection, thread_id: str, values: Dict[str, Any],
    ) -> None: ...


class DashboardStore(Protocol):
    """The home screen's cross-domain counters."""
    def owner_activity_counts(self, owner_user_id: str, *, now: datetime) -> Dict[str, Any]: ...


class AccountDataStore(Protocol):
    """Everything one owner has, for the account export and deletion."""
    def iter_games(
        self,
        owner_user_id: Optional[str] = None,
        *,
        batch_size: int = 100,
        render_pgn: bool = False,
    ): ...
    def iter_owner_training_progress(self, owner_user_id: str): ...
    def iter_owner_train_reviews(self, owner_user_id: str): ...
    def iter_owner_training_sessions(self, owner_user_id: str): ...
    def list_owner_settings(self, owner_user_id: str) -> Dict[str, Any]: ...
    def list_repertoire_metas(
        self, owner_user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]: ...
    def load_repertoire(
        self,
        repertoire_id: str,
        owner_user_id: Optional[str] = None,
        *,
        conn: Optional[Connection] = None,
        hydrate: bool = True,
    ) -> Optional[Repertoire]: ...
    def delete_owner_data(
        self, owner_user_id: str, *, conn: Optional[Connection] = None,
    ) -> Dict[str, int]: ...


class MaintenanceStore(Protocol):
    """Data-lifecycle reclaim counts and deletes."""
    def count_orphan_evaluations(self) -> int: ...
    def delete_orphan_evaluations(self) -> int: ...
    def count_orphan_positions(self) -> int: ...
    def delete_orphan_positions(self) -> int: ...
    def count_analysis_snapshots(self) -> int: ...
    def count_trimable_analyses(self, keep_per_game: int) -> int: ...
    def delete_trimable_analyses(self, keep_per_game: int) -> int: ...
    def count_receipts_before(self, cutoff: datetime) -> int: ...


# -------------------------------------------------------------- consumer ports


class BuildPayloadStore(RepertoireReader, TrainingProgressReader, Protocol):
    """The Build payload: the tree plus the owner's progress and health badge."""


class BuildStore(RepertoireWriter, TrainingCleanupStore, SettingsStore, Protocol):
    """Build edits, including the deletes that must release training state."""


class RevertStore(RepertoireWriter, CollaborationStore, TrainingCleanupStore, Protocol):
    """Inverse edits from the activity feed, which may delete nodes."""


class MissStore(TrainingStore, SettingsStore, Protocol):
    """Recall misses recorded from outside Train (real games, Analyze)."""


class TrainerStore(RepertoireReader, TrainingStore, Protocol):
    """The line trainer."""


class SmartTrainerStore(TrainerStore, AccessStore, ReceiptStore, Protocol):
    """The smart queue, which also trains shared repertoires and dedupes attempts."""


# ---------------------------------------------------------------- router ports
# The widest view a router's endpoints need. Helpers and simple endpoints in the
# same router annotate a narrower port where one covers them.


class AnalyzeRoutes(GameStore, SettingsStore, Protocol):
    """Analyze: games and analyses, plus the owner's engine settings."""


class ActivityRoutes(RevertStore, TrainingProgressReader, AccessStore, SettingsStore, Protocol):
    """The activity feed, its seen marker and reverts."""


class DiscussionRoutes(RepertoireWriter, CollaborationStore, AccessStore, Protocol):
    """Position discussions, which log as repertoire edits."""


class CompareRoutes(MissStore, RepertoireReader, Protocol):
    """Lichess compare, which records the user's departures as recall misses."""


class TrainRoutes(SmartTrainerStore, MissStore, EditAttribution, Protocol):
    """Both trainers, streaks and explicit misses."""


class WorkspaceRoutes(BuildStore, TrainingProgressReader, SharingStore, DashboardStore, Protocol):
    """Build, the dashboard, sharing and repertoire lifecycle."""
