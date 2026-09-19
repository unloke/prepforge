from __future__ import annotations

import importlib.util
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "postgres_backup.py"
_SPEC = importlib.util.spec_from_file_location("postgres_backup", _SCRIPT_PATH)
assert _SPEC and _SPEC.loader
postgres_backup = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(postgres_backup)


def test_postgres_url_normalizes_sqlalchemy_driver():
    assert (
        postgres_backup.postgres_url("postgresql+psycopg://user:secret@host/db")
        == "postgresql://user:secret@host/db"
    )


def test_backup_validates_restores_uploads_and_prunes(monkeypatch, tmp_path):
    monkeypatch.setattr(postgres_backup.tempfile, "TemporaryDirectory", lambda **_: _Temp(tmp_path))
    for name, value in {
        "BACKUP_DATABASE_URL": "postgresql+psycopg://user:secret@db.example/prod",
        "B2_ENDPOINT": "https://s3.example.invalid",
        "B2_REGION": "us-test-001",
        "B2_BUCKET": "private-backups",
    }.items():
        monkeypatch.setenv(name, value)

    commands = []

    def fake_run(command, *, capture=False, env=None):
        commands.append(command)
        if command[0] == "pg_dump":
            output = next(part.removeprefix("--file=") for part in command if part.startswith("--file="))
            Path(output).write_bytes(b"valid custom-format dump")
        if command[0] == "psql" and "count(*)" in command[-1]:
            return subprocess.CompletedProcess(command, 0, "12\n", "")
        if command[0] == "psql":
            return subprocess.CompletedProcess(command, 0, "c7e8f9a0b1c2\n", "")
        if "head-object" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                json.dumps({"ContentLength": len(b"valid custom-format dump")}),
                "",
            )
        if "list-objects-v2" in command:
            old = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
            fresh = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
            payload = {
                "Contents": [
                    {"Key": "postgres/daily/old.dump", "LastModified": old},
                    {"Key": "postgres/daily/new.dump", "LastModified": fresh},
                ]
            }
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(postgres_backup, "run", fake_run)
    manifest = postgres_backup.backup(
        retention_days=14,
        restore_url="postgresql://restore:local@localhost/restore",
    )

    assert manifest["bucket"] == "private-backups"
    assert manifest["format"] == "pg_dump-custom"
    assert len(manifest["sha256"]) == 64
    flattened = [part for command in commands for part in command]
    assert "pg_restore" in [command[0] for command in commands]
    assert "head-object" in flattened
    assert "postgres/latest.json" in " ".join(flattened)
    deletes = [command for command in commands if "delete-object" in command]
    assert len(deletes) == 1
    assert "postgres/daily/old.dump" in deletes[0]
    assert not any("user:secret" in part for command in commands for part in command)


def test_backup_stops_before_upload_when_archive_is_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(postgres_backup.tempfile, "TemporaryDirectory", lambda **_: _Temp(tmp_path))
    for name in ("BACKUP_DATABASE_URL", "B2_ENDPOINT", "B2_REGION", "B2_BUCKET"):
        monkeypatch.setenv(name, "configured")
    monkeypatch.setattr(
        postgres_backup,
        "run",
        lambda command, **_: subprocess.CompletedProcess(command, 0, "", ""),
    )

    with pytest.raises(RuntimeError, match="empty backup"):
        postgres_backup.backup(retention_days=14, restore_url="postgresql://restore")


def test_remote_size_mismatch_fails_verification(monkeypatch, tmp_path):
    monkeypatch.setattr(postgres_backup.tempfile, "TemporaryDirectory", lambda **_: _Temp(tmp_path))
    for name, value in {
        "BACKUP_DATABASE_URL": "postgresql://prod",
        "B2_ENDPOINT": "https://s3.example.invalid",
        "B2_REGION": "us-test-001",
        "B2_BUCKET": "private-backups",
    }.items():
        monkeypatch.setenv(name, value)

    def fake_run(command, **_):
        if command[0] == "pg_dump":
            output = next(part.removeprefix("--file=") for part in command if part.startswith("--file="))
            Path(output).write_bytes(b"dump")
        if command[0] == "psql" and "count(*)" in command[-1]:
            return subprocess.CompletedProcess(command, 0, "1\n", "")
        if command[0] == "psql":
            return subprocess.CompletedProcess(command, 0, "head\n", "")
        if "head-object" in command:
            return subprocess.CompletedProcess(command, 0, '{"ContentLength": 3}', "")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(postgres_backup, "run", fake_run)
    with pytest.raises(RuntimeError, match="size mismatch"):
        postgres_backup.backup(
            retention_days=14,
            restore_url="postgresql://restore:local@localhost/restore",
        )


class _Temp:
    def __init__(self, path: Path):
        self.path = path

    def __enter__(self):
        return str(self.path)

    def __exit__(self, *_):
        return None
