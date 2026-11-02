"""Regenerate the review's downloadable image archive."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    root = Path(__file__).resolve().parent
    with ZipFile(root / "screenshots.zip", "w", compression=ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix in {".html", ".json", ".md", ".png", ".jpg", ".py"}:
                archive.write(path, path.relative_to(root))


if __name__ == "__main__":
    main()
