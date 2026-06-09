"""Runtime configuration for the SaaS API.

All knobs come from the environment (12-factor) so the same image runs locally
on SQLite and in production on Postgres. Nothing here imports app code, so it is
safe to import from anywhere (Alembic env, tests, the FastAPI app).
"""
from __future__ import annotations

import functools
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Local default DB lives next to the existing SQLite data dir so dev work shares
# one place. Production overrides this with a Postgres URL via DATABASE_URL.
_DEFAULT_SQLITE = (Path("data") / "prepforge_api.sqlite3").as_posix()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PREPFORGE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # "development" | "production". Controls cookie Secure flag, error verbosity,
    # and whether HSTS is emitted.
    env: str = Field(default="development")

    # SQLAlchemy URL. SQLite for dev/test, postgresql+psycopg://... in prod.
    # Read from DATABASE_URL (no prefix) to match the Render/Heroku convention, with
    # the prefixed PREPFORGE_DATABASE_URL as an explicit override. A bare
    # validation_alias replaces (not augments) the env_prefix, so both names must be
    # listed explicitly -- otherwise only DATABASE_URL would be read.
    database_url: str = Field(
        default=f"sqlite:///{_DEFAULT_SQLITE}",
        validation_alias=AliasChoices("DATABASE_URL", "PREPFORGE_DATABASE_URL"),
    )

    @field_validator("database_url")
    @classmethod
    def _normalize_pg_driver(cls, url: str) -> str:
        """Pin Postgres URLs to the psycopg (v3) driver.

        Render/Heroku hand back a bare ``postgres://`` or ``postgresql://`` scheme.
        SQLAlchemy maps both to the psycopg2 dialect by default, but ``.[server]``
        ships psycopg **3** (``psycopg[binary]``), so an un-pinned URL fails at boot
        with "No module named 'psycopg2'". Rewrite the scheme to
        ``postgresql+psycopg://`` so the right driver is selected. URLs that already
        name a driver (``postgresql+asyncpg``, etc.) or non-Postgres URLs (sqlite)
        are left untouched.
        """
        if url.startswith("postgres://"):
            return "postgresql+psycopg://" + url[len("postgres://"):]
        if url.startswith("postgresql://"):
            return "postgresql+psycopg://" + url[len("postgresql://"):]
        return url

    # Signing/secret material. MUST be overridden in production. A random default
    # would invalidate all sessions on every restart, so we fail loudly instead
    # (see require_production_secret).
    secret_key: str = Field(default="dev-insecure-change-me")

    # Session cookie.
    session_cookie_name: str = Field(default="pf_session")
    session_ttl_days: int = Field(default=30)
    # Cap concurrent sessions per user (oldest pruned on new login). 0 disables.
    session_max_per_user: int = Field(default=10)

    # Allowed browser origins for CORS / CSRF origin checks. Comma-separated.
    allowed_origins: str = Field(default="http://localhost:5173,http://localhost:8765")

    # Google OAuth (primary sign-in). Empty until configured; the Google login
    # routes 503 when unset. Read with the env_prefix (PREPFORGE_GOOGLE_CLIENT_ID)
    # OR the bare GOOGLE_CLIENT_ID, matching how most Google libs document it.
    google_client_id: str = Field(
        default="",
        validation_alias=AliasChoices("GOOGLE_CLIENT_ID", "PREPFORGE_GOOGLE_CLIENT_ID"),
    )
    google_client_secret: str = Field(
        default="",
        validation_alias=AliasChoices("GOOGLE_CLIENT_SECRET", "PREPFORGE_GOOGLE_CLIENT_SECRET"),
    )

    # Stripe (billing phase). Empty until configured; billing routes guard on this.
    stripe_secret_key: str = Field(default="")
    stripe_webhook_secret: str = Field(default="")
    stripe_price_pro: str = Field(default="")

    # Free-plan quota: max repertoires a Free user may own. Pro is unlimited.
    free_repertoire_limit: int = Field(default=5)

    # Observability. Sentry stays dark until a DSN is set (no-op otherwise).
    sentry_dsn: str = Field(default="")
    log_level: str = Field(default="INFO")

    @property
    def billing_enabled(self) -> bool:
        """True once a Stripe secret key is configured (Checkout/portal need it)."""
        return bool(self.stripe_secret_key)

    @property
    def google_oauth_enabled(self) -> bool:
        """True once both Google OAuth credentials are configured."""
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def is_production(self) -> bool:
        return self.env.lower() == "production"

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    def require_production_secret(self) -> None:
        """Refuse to run in production with the insecure default secret."""
        if self.is_production and self.secret_key == "dev-insecure-change-me":
            raise RuntimeError(
                "PREPFORGE_SECRET_KEY must be set to a strong random value in production"
            )


@functools.lru_cache
def get_settings() -> Settings:
    return Settings()
