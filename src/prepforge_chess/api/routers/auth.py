"""Email/password authentication.

Register / login mint a server-side session and set an HttpOnly cookie. The
cookie carries an opaque token; the DB stores only its hash. In production the
cookie is Secure + SameSite=Lax (set in main.set_session_cookie).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

# F-02: password recovery lives here next to login/logout so the auth contract
# (hashing, session lifetime, enumeration safety) stays in one file.

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_user
from prepforge_chess.api.middleware import CSRF_COOKIE
from prepforge_chess.api.models import AuthSession, PasswordResetToken, Plan, User
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.api.security import (
    hash_password,
    hash_session_token,
    new_session_token,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    display_name: str | None = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: str
    email: str
    plan: Plan
    display_name: str | None
    # Whether the account has a password (email sign-up) or signs in with an
    # OAuth provider only. The Account settings offer "Change password" only
    # when there is one to change. The hash itself never leaves the server.
    has_password: bool = False

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def _derive_has_password(cls, data):
        if isinstance(data, User):
            return {
                "id": data.id,
                "email": data.email,
                "plan": data.plan,
                "display_name": data.display_name,
                "has_password": data.password_hash is not None,
            }
        return data


def _set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )


def _purge_expired(db: Session, settings: Settings) -> int:
    """Delete sessions idle longer than ``session_ttl_days``. Does NOT commit — the
    caller owns the transaction (called inside ``_open_session``)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.session_ttl_days)
    rows = db.scalars(select(AuthSession).where(AuthSession.last_seen_at < cutoff)).all()
    for row in rows:
        db.delete(row)
    return len(rows)


def _enforce_session_cap(db: Session, settings: Settings, user_id: str) -> None:
    """Keep at most ``session_max_per_user`` live sessions per user — prune the oldest
    so a stolen-then-rotated cookie or an unbounded device list can't accumulate
    forever. ``0`` disables the cap."""
    cap = settings.session_max_per_user
    if cap <= 0:
        return
    sessions = db.scalars(
        select(AuthSession)
        .where(AuthSession.user_id == user_id)
        .order_by(AuthSession.created_at.desc())
    ).all()
    for stale in sessions[cap:]:
        db.delete(stale)


def _open_session(db: Session, response: Response, settings: Settings, user: User) -> None:
    token = new_session_token()
    db.add(AuthSession(token_hash=hash_session_token(token), user_id=user.id))
    db.flush()
    _enforce_session_cap(db, settings, user.id)
    # Opportunistic global cleanup of long-idle sessions (no scheduler needed).
    _purge_expired(db, settings)
    db.commit()
    _set_session_cookie(response, settings, token)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/hour")
def register(
    request: Request,
    body: RegisterRequest,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered")
    user = User(
        email=email,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
        plan=Plan.free,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    _open_session(db, response, settings, user)
    return user


@router.post("/login", response_model=UserOut)
@limiter.limit("10/minute")
def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    # One bcrypt verify on every path (unknown user and OAuth-only NULL hash go
    # through the dummy hash inside verify_password); the message never leaks
    # which half failed.
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password"
        )
    _open_session(db, response, settings, user)
    return user


def _close_session(request: Request, db: Session, settings: Settings) -> None:
    """Delete the current session row (if any). The caller clears the cookie."""
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        session = db.get(AuthSession, hash_session_token(token))
        if session is not None:
            db.delete(session)
            db.commit()


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    _close_session(request, db, settings)
    response.delete_cookie(settings.session_cookie_name, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    # Returning the injected `response` (rather than a fresh Response) is required
    # for the delete_cookie headers above to actually reach the client — FastAPI
    # discards the injected response's headers if the handler returns a new object.
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)) -> User:
    return user


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)

    @field_validator("display_name")
    @classmethod
    def _reject_control_chars(cls, value: str | None) -> str | None:
        # PostgreSQL text columns cannot store NUL: the insert fails at the
        # driver and surfaces as a 500. SQLite accepts it, so a SQLite-only
        # suite never caught this. Reject NUL outright and drop the other C0
        # controls, which are never intentional in a displayed name.
        if value is None:
            return None
        if "\x00" in value:
            raise ValueError("display_name cannot contain NUL characters")
        return "".join(ch for ch in value if ch >= " " or ch == "\t")


@router.patch("/me", response_model=UserOut)
def update_me(
    body: ProfileUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> User:
    """Edit the profile fields the account owns (the display name). Blank clears
    it, so the app falls back to the email.

    A PATCH that omits `display_name` entirely must not clear it: an absent
    field means leave-as-is, while an explicit blank string still clears it.
    """
    if "display_name" not in body.model_fields_set:
        return user
    name = (body.display_name or "").strip()
    user.display_name = name or None
    db.commit()
    db.refresh(user)
    return user


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/password/change", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("10/hour")
def change_password(
    request: Request,
    body: ChangePasswordRequest,
    response: Response,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Change the password of a signed-in email/password account.

    Requires the current password (a borrowed session alone cannot take the
    account over). Every OTHER session of the account ends and outstanding
    reset links are consumed; this browser stays signed in. OAuth-only
    accounts have no password to change."""
    if user.password_hash is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="this account signs in with Google and has no password",
        )
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="current password is incorrect"
        )
    now = datetime.now(timezone.utc)
    user.password_hash = hash_password(body.new_password)
    token = request.cookies.get(settings.session_cookie_name)
    keep = hash_session_token(token) if token else None
    for session in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)):
        if session.token_hash != keep:
            db.delete(session)
    for pending in db.scalars(
        select(PasswordResetToken).where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        )
    ):
        pending.used_at = now
    db.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


class AuthProviders(BaseModel):
    google: bool
    password: bool = True


@router.get("/providers", response_model=AuthProviders)
def providers(settings: Settings = Depends(get_settings)) -> AuthProviders:
    """Public: which sign-in methods the deployment offers, so the SPA can show the
    right buttons (Google when configured; email/password always available)."""
    return AuthProviders(google=settings.google_oauth_enabled, password=True)


# ---- Password recovery (F-02) ----------------------------------------------
# Email/password accounts get a self-service recovery path: a single-use,
# expiring token delivered to the account's own email. OAuth-only accounts
# (password_hash NULL) receive "you sign in with Google" instead of a reset
# link, so nobody is sent down a path that cannot work for them.


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=16, max_length=400)
    password: str = Field(min_length=8, max_length=200)


def _deliver_mail(user: User, subject: str, body: str, settings: Settings) -> None:
    """Delivery seam for recovery mail. The deployment has no bundled SMTP
    client, so the message is logged (ops can wire a real mailer over this one
    function); in non-production, ``password_reset_dev_link`` additionally
    returns the link in the API response so dev/test flows work end to end."""
    print(
        "[mail] to={0} subject={1!r}: {2}".format(user.email, subject, body)
    )


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@router.post("/password/forgot")
@limiter.limit("5/hour")
def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Start password recovery. Always 200 with the same body — whether or not
    the address has an account — so the endpoint cannot be used to enumerate
    users. What the account OWNER receives differs honestly: a reset link for
    email/password accounts, a "you use Google sign-in" note for OAuth-only
    accounts."""
    now = datetime.now(timezone.utc)
    email = body.email.lower()
    user = db.scalar(select(User).where(User.email == email))
    response: dict = {"status": "sent"}
    if user is not None:
        if user.password_hash is None:
            _deliver_mail(
                user,
                "How you sign in",
                "This account signs in with Google — no password to reset. "
                "Use the Google button on the login page.",
                settings,
            )
            if settings.password_reset_dev_link and not settings.is_production:
                response["dev_delivery"] = "oauth_only"
        else:
            raw = new_session_token()
            db.add(
                PasswordResetToken(
                    user_id=user.id,
                    token_hash=hash_session_token(raw),
                    expires_at=now + timedelta(minutes=settings.password_reset_ttl_minutes),
                )
            )
            db.commit()
            link = "/?reset_password={0}".format(raw)
            _deliver_mail(
                user,
                "Reset your PrepForge password",
                "Open {0} within {1} minutes to choose a new password. "
                "The link works once.".format(link, settings.password_reset_ttl_minutes),
                settings,
            )
            if settings.password_reset_dev_link and not settings.is_production:
                # Dev/test convenience only (never in production): the SPA can
                # complete the flow without a mail inbox.
                response["dev_delivery"] = "reset_link"
                response["dev_reset_token"] = raw
    return response


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("10/hour")
def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Consume a reset token and set the new password.

    The token is single-use and expiring; one message covers bad/used/expired.
    A successful reset invalidates EVERY session of the account (a password
    change is a session-invalidation event) and consumes any other outstanding
    reset tokens, so recovery ends with a clean, explicit re-login."""
    now = datetime.now(timezone.utc)
    row = db.scalar(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == hash_session_token(body.token)
        )
    )
    if row is None or row.used_at is not None or _aware(row.expires_at) <= now:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="this reset link is invalid or has expired",
        )
    user = db.get(User, row.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="this reset link is invalid or has expired",
        )
    user.password_hash = hash_password(body.password)
    row.used_at = now
    for other in db.scalars(
        select(PasswordResetToken).where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        )
    ):
        other.used_at = now
    for session in db.scalars(
        select(AuthSession).where(AuthSession.user_id == user.id)
    ):
        db.delete(session)
    db.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
