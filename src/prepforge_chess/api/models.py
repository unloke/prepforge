"""ORM models for identity, teams, sharing, and sessions.

Design notes
------------
* ``User`` is the primary identity that owns the plan and (later) the Stripe
  customer. Email/password live here. Lichess is NOT an identity -- it is a
  ``LinkedAccount`` row, because Stripe needs an email Lichess does not provide
  and a paid account must survive the user un-linking Lichess.
* ``teams`` / ``team_members`` exist now so sharing/classroom features can land
  later without a schema break. Per product decision there is NO per-seat
  billing: a team is a feature, not a pricing tier. Plan gating ("Pro can create
  teams") is enforced in app logic, not by the schema.
* The legacy ``repertoires`` table (raw-SQL, ``prepforge_chess.storage``) will
  gain ``team_id`` / ``visibility`` columns when that table is ported to
  SQLAlchemy in the endpoint-migration phase; they are intentionally not here
  yet to avoid two layers writing the same table.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
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
        UniqueConstraint("user_id", "provider", name="uq_user_provider"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # e.g. "lichess"
    provider_user_id: Mapped[str] = mapped_column(String(120), nullable=False)
    # OAuth token, encrypted at rest (never plaintext -- see security.encrypt_token).
    encrypted_token: Mapped[str | None] = mapped_column(String(2048), nullable=True)
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
    DB leak does not hand out live sessions (same discipline as the legacy
    user_sessions table)."""

    __tablename__ = "auth_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    user: Mapped[User] = relationship(back_populates="sessions")
