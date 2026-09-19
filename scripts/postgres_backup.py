"""Create, verify, upload, and retain encrypted-in-transit PostgreSQL backups.

The script intentionally uses the PostgreSQL and AWS CLIs already present on the
GitHub runner. Credentials stay in environment variables and are never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKUP_PREFIX = "postgres/daily"
LATEST_KEY = "postgres/latest.json"


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Required environment variable {name} is not set")
    return value


def postgres_url(value: str) -> str:
    """Convert an SQLAlchemy psycopg URL into a libpq-compatible URL."""
    return value.replace("postgresql+psycopg://", "postgresql://", 1)


def run(
    command: list[str],
    *,
    capture: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    # Never echo commands: database URLs and object-store credentials are secrets.
    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=capture,
        env=env,
    )


def aws(endpoint: str, region: str, *arguments: str, capture: bool = False):
    return run(
        ["aws", "--endpoint-url", endpoint, "--region", region, *arguments],
        capture=capture,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_restore(dump_path: Path, restore_url: str) -> None:
    run(
        [
            "pg_restore",
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            f"--dbname={postgres_url(restore_url)}",
            str(dump_path),
        ]
    )
    table_count = run(
        [
            "psql",
            postgres_url(restore_url),
            "--no-align",
            "--tuples-only",
            "--command",
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';",
        ],
        capture=True,
    ).stdout.strip()
    if not table_count.isdigit() or int(table_count) < 1:
        raise RuntimeError("restore smoke found no public tables")
    migration = run(
        [
            "psql",
            postgres_url(restore_url),
            "--no-align",
            "--tuples-only",
            "--command",
            "SELECT version_num FROM alembic_version LIMIT 1;",
        ],
        capture=True,
    ).stdout.strip()
    if not migration:
        raise RuntimeError("restore smoke found no Alembic migration version")
    print(f"Restore smoke passed: {table_count} public tables, Alembic {migration}")


def prune_old_backups(endpoint: str, region: str, bucket: str, retention_days: int) -> int:
    response = aws(
        endpoint,
        region,
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--prefix",
        f"{BACKUP_PREFIX}/",
        "--output",
        "json",
        capture=True,
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    deleted = 0
    for item in json.loads(response.stdout or "{}").get("Contents", []):
        modified = datetime.fromisoformat(item["LastModified"].replace("Z", "+00:00"))
        if modified >= cutoff:
            continue
        aws(
            endpoint,
            region,
            "s3api",
            "delete-object",
            "--bucket",
            bucket,
            "--key",
            item["Key"],
        )
        deleted += 1
    print(f"Retention complete: removed {deleted} backup(s) older than {retention_days} days")
    return deleted


def backup(*, retention_days: int, restore_url: str) -> dict[str, object]:
    database_url = postgres_url(required_env("BACKUP_DATABASE_URL"))
    endpoint = required_env("B2_ENDPOINT")
    region = required_env("B2_REGION")
    bucket = required_env("B2_BUCKET")
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    object_key = f"{BACKUP_PREFIX}/prepforge-{stamp}.dump"

    with tempfile.TemporaryDirectory(prefix="prepforge-backup-") as temp_dir:
        dump_path = Path(temp_dir) / "prepforge.dump"
        manifest_path = Path(temp_dir) / "latest.json"
        run(
            [
                "pg_dump",
                "--format=custom",
                "--compress=9",
                "--no-owner",
                "--no-privileges",
                f"--file={dump_path}",
            ],
            env={**os.environ, "PGDATABASE": database_url},
        )
        if not dump_path.is_file() or dump_path.stat().st_size == 0:
            raise RuntimeError("pg_dump produced an empty backup")
        run(["pg_restore", "--list", str(dump_path)], capture=True)
        print("Archive validation passed (pg_restore --list)")
        validate_restore(dump_path, restore_url)

        manifest = {
            "bucket": bucket,
            "key": object_key,
            "createdAt": now.isoformat().replace("+00:00", "Z"),
            "sha256": sha256(dump_path),
            "sizeBytes": dump_path.stat().st_size,
            "format": "pg_dump-custom",
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        destination = f"s3://{bucket}/{object_key}"
        aws(endpoint, region, "s3", "cp", str(dump_path), destination, "--only-show-errors")
        remote = aws(
            endpoint,
            region,
            "s3api",
            "head-object",
            "--bucket",
            bucket,
            "--key",
            object_key,
            capture=True,
        )
        remote_size = json.loads(remote.stdout or "{}").get("ContentLength")
        if remote_size != dump_path.stat().st_size:
            raise RuntimeError(
                f"uploaded object size mismatch: local={dump_path.stat().st_size}, remote={remote_size}"
            )
        aws(
            endpoint,
            region,
            "s3",
            "cp",
            str(manifest_path),
            f"s3://{bucket}/{LATEST_KEY}",
            "--content-type",
            "application/json",
            "--only-show-errors",
        )
        print(f"Uploaded and verified s3://{bucket}/{object_key}")

    prune_old_backups(endpoint, region, bucket, retention_days)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--retention-days", type=int, default=14)
    parser.add_argument("--restore-url", default=os.environ.get("RESTORE_DATABASE_URL", ""))
    args = parser.parse_args()
    if not 7 <= args.retention_days <= 365:
        parser.error("--retention-days must be between 7 and 365")
    if not args.restore_url:
        parser.error("--restore-url or RESTORE_DATABASE_URL is required")
    backup(retention_days=args.retention_days, restore_url=args.restore_url)


if __name__ == "__main__":
    main()
