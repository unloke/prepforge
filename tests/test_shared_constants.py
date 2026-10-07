"""The committed browser constants must match the current Python defaults."""
from pathlib import Path
import runpy


def test_generated_shared_constants_are_current():
    generator = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/gen_shared_constants.py"))
    assert generator["OUTPUT"].read_text(encoding="utf-8") == generator["render"](), (
        "Run scripts/gen_shared_constants.py to refresh browser constants"
    )
