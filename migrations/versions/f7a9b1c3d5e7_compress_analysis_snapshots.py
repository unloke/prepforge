"""Compress current analysis snapshots; runtime reads only the new encoding."""
import base64
import json
import zlib

from alembic import op
import sqlalchemy as sa

revision = "f7a9b1c3d5e7"
down_revision = "e6f8a0b2c4d6"
branch_labels = None
depends_on = None


def convert(encode):
    table = sa.table("analysis_results", sa.column("id", sa.Text), sa.column("move_results_json", sa.Text))
    connection = op.get_bind()
    cursor = ""
    while True:
        rows = connection.execute(sa.select(table).where(table.c.id > cursor).order_by(table.c.id).limit(100)).mappings().all()
        if not rows:
            break
        for row in rows:
            raw = row["move_results_json"]
            if raw is None:
                continue
            if encode:
                raw = json.dumps({"codec": "zlib-base64-v1", "data": base64.b64encode(zlib.compress(raw.encode("utf-8"))).decode("ascii")}, separators=(",", ":"))
            else:
                raw = zlib.decompress(base64.b64decode(json.loads(raw)["data"])).decode("utf-8")
            connection.execute(table.update().where(table.c.id == row["id"]).values(move_results_json=raw))
        cursor = rows[-1]["id"]


def upgrade():
    convert(True)


def downgrade():
    convert(False)
