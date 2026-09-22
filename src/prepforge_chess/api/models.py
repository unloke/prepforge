"""ORM models for identity, teams, sharing, and sessions.

Design notes
------------
* ``User`` is the primary identity that owns the plan and (later) the Stripe
  customer. Email/password live here. Lichess is NOT an identity -- it is a
  ``LinkedAccount`` row, because Stripe needs an email Lichess does not provide
  and a paid account must survive the user un-linking Lichess.
* ``teams`` / ``team_members`` share repertoires read-only with a group.
   Per product decision there is NO per-seat billing: a team is a feature,
   not a pricing tier.
* Canonical ownership: ``users.id`` owns ALL SaaS/domain data (games,
   repertoires, training progress, settings). Domain tables key their owner
   columns directly off ``users.id``; there is no profile bridge.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from prepforge_chess.api.db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_text() -> str:
    return datetime.now(timezone.utc).isoformat()


class Plan(str, enum.Enum):
    free = "free"
    pro = "pro"


class TeamRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    member = "member"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    # Nullable: OAuth-only users (Google sign-in) have no password. Password login
    # rejects users whose hash is NULL (see routers.auth.login).
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    plan: Mapped[Plan] = mapped_column(
        SAEnum(Plan, native_enum=False, length=16), nullable=False, default=Plan.free
    )
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    linked_accounts: Mapped[list["LinkedAccount"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class LinkedAccount(Base):
    """An external identity (currently only Lichess) linked to a User."""

    __tablename__ = "linked_accounts"
    __table_args__ = (
        UniqueConstraint("provider", "provider_user_id", name="uq_provider_identity"),
        UniqueConstraint(
            "user_id", "provider", "provider_user_id", name="uq_user_provider_identity"
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # e.g. "lichess"
    provider_user_id: Mapped[str] = mapped_column(String(120), nullable=False)
    # OAuth token, encrypted at rest (never plaintext -- see security.encrypt_token).
    encrypted_token: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    # Exactly one linked identity per provider serves as the default source for
    # My-last-game / compare / explorer reads. Backfilled true for pre-existing rows.
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped[User] = relationship(back_populates="linked_accounts")


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # "team" | "classroom": classrooms get teacher/student affordances later.
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="team")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    members: Mapped[list["TeamMember"]] = relationship(
        back_populates="team", cascade="all, delete-orphan"
    )
    # One shareable join link per team (``team_invites.team_id`` is unique). The DB
    # FK is ON DELETE CASCADE; passive_deletes lets that fire instead of SQLAlchemy
    # loading + nulling the row on team delete.
    invite: Mapped["TeamInvite | None"] = relationship(
        cascade="all, delete-orphan", uselist=False, passive_deletes=True
    )


class TeamMember(Base):
    __tablename__ = "team_members"
    __table_args__ = (UniqueConstraint("team_id", "user_id", name="uq_team_member"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    team_id: Mapped[str] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[TeamRole] = mapped_column(
        SAEnum(TeamRole, native_enum=False, length=16), nullable=False, default=TeamRole.member
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    team: Mapped[Team] = relationship(back_populates="members")


class TeamInvite(Base):
    """A team's shareable join link.

    Only the SHA-256 of the code is stored (same discipline as ``AuthSession``):
    a DB leak never yields a working invite, and the raw code is shown exactly
    once -- at mint time. ``team_id`` is unique, so a team has at most one live
    invite; regenerating replaces the hash in place and revoking deletes the row.
    Joining via an invite always enrolls a plain ``member`` (promote afterwards).
    """

    __tablename__ = "team_invites"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    team_id: Mapped[str] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    # The minter; SET NULL (not CASCADE) so deleting the creator's account does not
    # silently drop a team's working invite.
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # NULL == never expires (v1 default); revocation is the primary control.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class UserSetting(Base):
    """Canonical per-user key/value store (1:1 logical settings, one row per key).

    Replaces the old ``user_profiles.settings_json`` blob: streak, recap
    snapshot, Lichess last-seen marker, departure-ingest list, and analysis
    preferences each live in their own row, so concurrent writers to different
    keys can no longer clobber each other. ``updated_at`` doubles as the weekly
    review timestamp for ``recap.weekly_snapshot``.
    """

    __tablename__ = "user_settings"

    # Plain owner id, no DB-level FK: ephemeral SQLite helpers create domain
    # tables without the identity tables, and ownership is enforced in
    # application code (current_owner gates every endpoint).
    user_id: Mapped[str] = mapped_column(String(32), primary_key=True, index=True)
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value_json: Mapped[str] = mapped_column(String(4000), nullable=False, default="null")
    updated_at: Mapped[str] = mapped_column(String(64), nullable=False, default=_now_text)


class TrainAttemptReceipt(Base):
    """Durable exactly-once receipt for a Smart Train graded attempt.

    ``(session_id, attempt_uuid)`` is unique: a client retry reusing the UUID
    is a no-op when the stored payload matches, and a 409 when a different
    payload reuses the UUID. Receipt insert, SR progress, and session update
    commit in one transaction, so the streak only advances on new attempts.
    """

    __tablename__ = "train_attempt_receipts"

    session_id: Mapped[str] = mapped_column(String(64), primary_key=True, index=True)
    attempt_uuid: Mapped[str] = mapped_column(String(64), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[str] = mapped_column(String(64), nullable=False, default=_now_text)


class StripeEvent(Base):
    """A processed Stripe webhook event, recorded for idempotency.

    Stripe may deliver the same event more than once (retries, at-least-once
    delivery). The webhook handler records each event id here inside the same
    transaction that applies its effect, so a redelivery is a no-op."""

    __tablename__ = "stripe_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # Stripe event id (evt_...)
    type: Mapped[str] = mapped_column(String(120), nullable=False)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuthSession(Base):
    """Server-side session. Only the SHA-256 of the cookie token is stored, so a
    DB leak does not hand out live sessions."""

    __tablename__ = "auth_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped[User] = relationship(back_populates="sessions")
