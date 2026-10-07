"""Identity ORM mappings over the canonical Core tables.

Sessions and relationship cascades keep identity mutations in one unit of work.
Table definitions live exclusively in storage.sa_tables.
"""
from sqlalchemy.orm import registry, relationship

from prepforge_chess.storage import sa_tables as t

mapper_registry = registry(metadata=t.metadata)


@mapper_registry.mapped
class User:
    __table__ = t.users
    linked_accounts = relationship('LinkedAccount', back_populates='user', cascade='all, delete-orphan')
    sessions = relationship('AuthSession', back_populates='user', cascade='all, delete-orphan')


@mapper_registry.mapped
class LinkedAccount:
    __table__ = t.linked_accounts
    user = relationship('User', back_populates='linked_accounts')


@mapper_registry.mapped
class Team:
    __table__ = t.teams
    members = relationship('TeamMember', back_populates='team', cascade='all, delete-orphan')
    invite = relationship('TeamInvite', cascade='all, delete-orphan', uselist=False, passive_deletes=True)


@mapper_registry.mapped
class TeamMember:
    __table__ = t.team_members
    team = relationship('Team', back_populates='members')


@mapper_registry.mapped
class TeamInvite:
    __table__ = t.team_invites


@mapper_registry.mapped
class PasswordResetToken:
    __table__ = t.password_reset_tokens


@mapper_registry.mapped
class StripeEvent:
    __table__ = t.stripe_events


@mapper_registry.mapped
class AuthSession:
    __table__ = t.auth_sessions
    user = relationship('User', back_populates='sessions')
