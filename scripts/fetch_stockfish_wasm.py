"""Put the Stockfish wasm files the manifest names into a static engine tree.

The wasm files are not in git (the big net is 99 MB). The Docker image has no Node, so this
reads the npm tarball of the manifest's package version, keeps only the named wasm files and
checks each against the manifest's sha256.

    python fetch_stockfish_wasm.py <stockfish.manifest.json> <engine dir> [tarball url or path]
"""
from __future__ import annotations

import hashlib
import json
import sys
import tarfile
import urllib.request
from pathlib import Path


def fetch(manifest_path: Path, out_dir: Path, source: str | None = None) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    engines = manifest["engines"]
    versions = {e["packageVersion"] for e in engines.values()}
    if len(versions) != 1:
        raise SystemExit(f"engines come from different package versions: {sorted(versions)}")
    version = versions.pop()
    wanted = {f"package/bin/{e['files']['wasm']['source']}": e for e in engines.values()}
    source = source or f"https://registry.npmjs.org/{manifest['package']}/-/{manifest['package']}-{version}.tgz"
    stream = urllib.request.urlopen(source) if "://" in source else open(source, "rb")
    with stream, tarfile.open(fileobj=stream, mode="r|gz") as tar:
        for member in tar:
            engine = wanted.pop(member.name, None)
            if engine is None:
                continue
            data = tar.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != engine["files"]["wasm"]["sha256"]:
                raise SystemExit(f"{member.name} does not match the manifest sha256")
            target = out_dir / engine["files"]["wasm"]["bundled"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    if wanted:
        raise SystemExit(f"missing from the tarball: {sorted(wanted)}")


if __name__ == "__main__":
    fetch(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else None)
