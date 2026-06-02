from __future__ import annotations

import json
import os
import platform
import shutil
import tarfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional

from prepforge_chess.services.engine_paths import engine_search_dirs, project_root


STOCKFISH_RELEASE_API = "https://api.github.com/repos/official-stockfish/Stockfish/releases/latest"


@dataclass(frozen=True)
class StockfishAsset:
    release_tag: str
    release_name: str
    asset_name: str
    download_url: str


@dataclass(frozen=True)
class StockfishInstallResult:
    executable_path: str
    asset: Optional[StockfishAsset]
    already_present: bool = False


def default_engine_dir() -> Path:
    return project_root() / "engines" / "stockfish"


def find_stockfish_executable(search_dir: Optional[Path] = None) -> Optional[str]:
    configured_path = os.environ.get("STOCKFISH_PATH")
    if configured_path:
        candidate = Path(configured_path)
        if candidate.is_file() and _is_executable_candidate(candidate):
            return str(candidate)

    directories = []
    if search_dir is not None:
        directories.append(search_dir)
    directories.extend(engine_search_dirs("engines", "stockfish"))

    for directory in directories:
        if not directory.exists():
            continue
        patterns = ["stockfish*.exe"] if os.name == "nt" else ["stockfish*"]
        for pattern in patterns:
            for candidate in directory.rglob(pattern):
                if candidate.is_file() and _is_executable_candidate(candidate):
                    return str(candidate)
    return shutil.which("stockfish")


def install_stockfish(
    target_dir: Optional[Path] = None,
    *,
    asset_name: Optional[str] = None,
) -> StockfishInstallResult:
    install_dir = target_dir or default_engine_dir()
    existing = find_stockfish_executable(install_dir)
    if existing:
        return StockfishInstallResult(existing, asset=None, already_present=True)

    install_dir.mkdir(parents=True, exist_ok=True)
    release = _fetch_latest_release()
    asset = _select_asset(release, preferred_name=asset_name)
    archive_path = install_dir / asset.asset_name

    urllib.request.urlretrieve(asset.download_url, archive_path)
    if archive_path.suffix.lower() == ".zip":
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(install_dir)
    elif archive_path.suffix.lower() == ".tar":
        with tarfile.open(archive_path) as archive:
            _extract_tar_safely(archive, install_dir)
    else:
        raise ValueError("Unsupported Stockfish archive type: {0}".format(archive_path.name))

    _mark_extracted_binaries_executable(install_dir)
    executable = find_stockfish_executable(install_dir)
    if executable is None:
        raise FileNotFoundError("Stockfish executable not found after extracting {0}".format(asset.asset_name))
    archive_path.unlink(missing_ok=True)
    return StockfishInstallResult(executable, asset=asset, already_present=False)


def _fetch_latest_release() -> Dict:
    request = urllib.request.Request(
        STOCKFISH_RELEASE_API,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "PrepForge-Chess"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def _select_asset(release: Dict, *, preferred_name: Optional[str]) -> StockfishAsset:
    assets = release.get("assets", [])
    if not assets:
        raise ValueError("Latest Stockfish release has no downloadable assets.")

    if preferred_name:
        names = [preferred_name]
    else:
        names = _preferred_asset_names()

    for name in names:
        for asset in assets:
            if asset.get("name") == name:
                return StockfishAsset(
                    release_tag=release.get("tag_name", ""),
                    release_name=release.get("name", ""),
                    asset_name=asset["name"],
                    download_url=asset["browser_download_url"],
                )

    available = ", ".join(asset.get("name", "") for asset in assets)
    raise ValueError("No compatible Stockfish asset found. Available: {0}".format(available))


def _preferred_asset_names() -> Iterable[str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows" and "arm" in machine:
        return ["stockfish-windows-armv8-dotprod.zip", "stockfish-windows-armv8.zip"]
    if system == "windows":
        return [
            "stockfish-windows-x86-64-avx2.zip",
            "stockfish-windows-x86-64-bmi2.zip",
            "stockfish-windows-x86-64-sse41-popcnt.zip",
            "stockfish-windows-x86-64.zip",
        ]
    if system == "linux":
        return [
            "stockfish-ubuntu-x86-64-avx2.tar",
            "stockfish-ubuntu-x86-64-bmi2.tar",
            "stockfish-ubuntu-x86-64-sse41-popcnt.tar",
            "stockfish-ubuntu-x86-64.tar",
        ]
    raise ValueError("Automatic Stockfish install currently supports Windows and Linux in this project.")


def _is_executable_candidate(path: Path) -> bool:
    if os.name == "nt":
        return path.suffix.lower() == ".exe"
    return os.access(path, os.X_OK)


def _mark_extracted_binaries_executable(directory: Path) -> None:
    if os.name == "nt":
        return
    for candidate in directory.rglob("stockfish*"):
        if candidate.is_file():
            candidate.chmod(candidate.stat().st_mode | 0o755)


def _extract_tar_safely(archive: tarfile.TarFile, target_dir: Path) -> None:
    target_root = target_dir.resolve()
    for member in archive.getmembers():
        destination = (target_dir / member.name).resolve()
        try:
            destination.relative_to(target_root)
        except ValueError:
            raise ValueError("Unsafe path in Stockfish archive: {0}".format(member.name))
    archive.extractall(target_dir)
