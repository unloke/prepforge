"""Garbage-collect stale Maia3 ONNX artifacts — standalone, Maia-free.

Phase 3a of docs/browser-engine-migration.md. The export pipeline
(export_maia3_onnx.py) publishes content-addressed artifacts and NEVER deletes:
the manifest swap makes new artifacts live for new readers, but a client still
holding the previous manifest may not have started downloading its model yet, so
deleting that artifact would 404 the fetch. This script is the separate, delayed
reaper run once the deploy grace period has elapsed.

It imports ONLY the stdlib (plus onnx, lazily, to resolve external-data refs), so
it runs in a deploy environment WITHOUT the Maia/torch export toolchain:

    python scripts/gc_maia3_artifacts.py --out web-src/public/maia3 --grace-hours 72

Concurrency: GC and publish share one exclusive lock (`publish_lock`), so a
publish can never swap the manifest in the middle of a GC pass — closing the
stat()/os.replace()/unlink() interleaving race. Without the lock, GC could read
the old manifest, publish could then promote a new one, and GC could still delete
a file the new manifest references.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import time
from pathlib import Path

LOCK_NAME = ".maia3.publish.lock"
# A lock older than this is treated as abandoned (process crashed mid-publish/GC)
# and broken, so a crash can't deadlock every future publish/GC. O_EXCL keeps the
# steal itself race-free: only one contender re-creates the lock.
STALE_LOCK_SECONDS = 30 * 60


@contextlib.contextmanager
def publish_lock(out_dir: Path, timeout_s: float = 60.0, poll_s: float = 0.2):
    """Exclusive advisory lock shared by publish and GC over `out_dir`.

    Acquired via an O_CREAT|O_EXCL lockfile (atomic on Win/POSIX). Blocks up to
    `timeout_s`, breaks a lock older than STALE_LOCK_SECONDS, then raises.
    """
    lock = out_dir / LOCK_NAME
    deadline = time.time() + timeout_s
    while True:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, f"{os.getpid()} {time.time()}".encode())
            finally:
                os.close(fd)
            break
        except FileExistsError:
            # Break a clearly-abandoned lock; O_EXCL makes the re-create the
            # single winner, so a concurrent steal can't double-acquire.
            try:
                if time.time() - lock.stat().st_mtime > STALE_LOCK_SECONDS:
                    print(f"      breaking stale lock {lock} (age > {STALE_LOCK_SECONDS}s)", file=sys.stderr)
                    with contextlib.suppress(FileNotFoundError):
                        lock.unlink()
                    continue
            except FileNotFoundError:
                continue  # released between open() and stat(); retry immediately
            if time.time() > deadline:
                raise TimeoutError(
                    f"could not acquire {lock} within {timeout_s}s; another "
                    f"export/GC is running (or remove the lockfile if stale)."
                )
            time.sleep(poll_s)
    try:
        yield
    finally:
        with contextlib.suppress(FileNotFoundError):
            lock.unlink()


def external_data_files(model_path: Path) -> tuple[set[str], bool]:
    """Relative filenames referenced as ONNX external data by `model_path`.

    Returns (locations, ok). `ok` is False if the model could not be parsed (or
    onnx is unavailable) — the caller must then treat external-data resolution as
    incomplete and decline to delete any `.onnx.data` blob, rather than risk
    deleting a live model's weights.
    """
    try:
        import onnx

        model = onnx.load(str(model_path), load_external_data=False)
    except Exception as exc:
        print(
            f"      WARN: could not parse {model_path.name} for external-data refs: {exc}",
            file=sys.stderr,
        )
        return set(), False
    locations: set[str] = set()
    for init in model.graph.initializer:
        if init.data_location == onnx.TensorProto.EXTERNAL:
            for kv in init.external_data:
                if kv.key == "location":
                    locations.add(kv.value)
    return locations, True


def gc_unreferenced_artifacts(out_dir: Path, grace_hours: float, dry_run: bool) -> int:
    """Reap content-addressed artifacts the current manifest no longer references.

    Holds `publish_lock` for the whole pass (mutually exclusive with publish), and
    reads the manifest INSIDE the lock so it can't act on a manifest publish then
    replaces. Deletes only unreferenced artifacts older than `grace_hours`.
    External-data (.onnx.data) blobs referenced by a kept model are preserved; if
    any kept model fails to parse, no `.onnx.data` is touched that pass.
    """
    manifest_path = out_dir / "maia3.manifest.json"
    with publish_lock(out_dir):
        if not manifest_path.exists():
            print(
                f"gc: no manifest at {manifest_path}; refusing to delete anything "
                f"(without a manifest every artifact looks unreferenced).",
                file=sys.stderr,
            )
            return 1
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        keep: set[str] = set()
        data_resolution_ok = True
        for entry in (manifest.get("artifacts") or {}).values():
            fname = entry.get("file")
            if not fname:
                continue
            keep.add(fname)
            model_path = out_dir / fname
            if model_path.exists():
                refs, ok = external_data_files(model_path)
                keep.update(refs)
                data_resolution_ok = data_resolution_ok and ok

        candidates = list(out_dir.glob("maia3-*.onnx"))
        if data_resolution_ok:
            candidates += list(out_dir.glob("*.onnx.data"))
        else:
            print(
                "      WARN: external-data resolution incomplete; leaving all "
                "*.onnx.data untouched this pass.",
                file=sys.stderr,
            )

        now = time.time()
        cutoff = now - grace_hours * 3600.0
        deleted = within_grace = 0
        for path in candidates:
            if path.name in keep:
                continue
            mtime = path.stat().st_mtime
            age_h = (now - mtime) / 3600.0
            if mtime > cutoff:
                print(f"      keep (age {age_h:.1f}h < {grace_hours}h grace): {path.name}")
                within_grace += 1
                continue
            if dry_run:
                print(f"      would delete (age {age_h:.1f}h): {path.name}")
            else:
                path.unlink()
                print(f"      deleted (age {age_h:.1f}h): {path.name}")
            deleted += 1
        verb = "would delete" if dry_run else "deleted"
        print(
            f"gc: {verb} {deleted} unreferenced artifact(s); kept {within_grace} "
            f"still within the {grace_hours}h grace window."
        )
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="web-src/public/maia3", help="artifact directory")
    parser.add_argument(
        "--grace-hours",
        type=float,
        default=72.0,
        help="only delete unreferenced artifacts older than this many hours "
        "(age = file mtime). Default 72h.",
    )
    parser.add_argument("--dry-run", action="store_true", help="print what would be deleted without deleting")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    if not out_dir.is_dir():
        print(f"gc: {out_dir} is not a directory.", file=sys.stderr)
        return 1
    return gc_unreferenced_artifacts(out_dir, args.grace_hours, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
