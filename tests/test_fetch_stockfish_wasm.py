from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import tarfile
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "fetch_stockfish_wasm", Path(__file__).parents[1] / "scripts" / "fetch_stockfish_wasm.py"
)
fetch_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch_mod)
_engines = json.loads((
    Path(__file__).parents[1] / "web-src/public/engine/stockfish.manifest.json"
).read_text(encoding="utf-8"))["engines"]
_big = _engines["big"]["files"]["wasm"]["source"]
_lite = _engines["lite"]["files"]["wasm"]["source"]


def _setup(tmp_path: Path, files: dict[str, bytes], sha_override: str | None = None, packed: tuple[str, ...] | None = None):
    tarball = tmp_path / "stockfish.tgz"
    with tarfile.open(tarball, "w:gz") as tar:
        for name, data in files.items():
            if packed is not None and name not in packed:
                continue
            info = tarfile.TarInfo(f"package/bin/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    engines = {
        net: {
            "packageVersion": _engines[net]["packageVersion"],
            "files": {"wasm": {
                "source": source,
                "bundled": f"{folder}/stockfish.wasm",
                "sha256": sha_override or hashlib.sha256(files[source]).hexdigest(),
            }},
        }
        for net, source, folder in (("big", _big, "aaaa0000"), ("lite", _lite, "bbbb1111"))
    }
    manifest = tmp_path / "stockfish.manifest.json"
    manifest.write_text(json.dumps({"package": "stockfish", "engines": engines}), encoding="utf-8")
    return manifest, tarball


def test_fetch_writes_each_named_wasm(tmp_path):
    files = {_big: b"big", _lite: b"lite", "unrelated.wasm": b"other"}
    manifest, tarball = _setup(tmp_path, files)
    fetch_mod.fetch(manifest, tmp_path / "out", str(tarball))
    assert (tmp_path / "out" / "aaaa0000" / "stockfish.wasm").read_bytes() == b"big"
    assert (tmp_path / "out" / "bbbb1111" / "stockfish.wasm").read_bytes() == b"lite"
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["aaaa0000", "bbbb1111"]


def test_fetch_rejects_a_changed_file(tmp_path):
    manifest, tarball = _setup(tmp_path, {_big: b"big", _lite: b"lite"}, "0" * 64)
    with pytest.raises(SystemExit, match="sha256"):
        fetch_mod.fetch(manifest, tmp_path / "out", str(tarball))


def test_fetch_rejects_a_missing_file(tmp_path):
    files = {_big: b"big", _lite: b"lite"}
    manifest, tarball = _setup(tmp_path, files, packed=(_big,))
    with pytest.raises(SystemExit, match="missing"):
        fetch_mod.fetch(manifest, tmp_path / "out", str(tarball))
