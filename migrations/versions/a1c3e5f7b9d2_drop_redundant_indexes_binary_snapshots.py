"""Drop indexes their table's primary or unique key already covers; store analysis snapshots as raw zlib bytes."""
import base64
import json

from alembic import op
import sqlalchemy as sa

revision = "a1c3e5f7b9d2"
down_revision = "8e4a6c2d0f91"
branch_labels = None
depends_on = None

_REDUNDANT = (
    ("linked_accounts", "ix_linked_accounts_user_id", ["user_id"]),
    ("team_members", "ix_team_members_team_id", ["team_id"]),
    ("user_settings", "ix_user_settings_user_id", ["user_id"]),
    ("train_attempt_receipts", "ix_train_attempt_receipts_session_id", ["session_id"]),
    ("games", "idx_games_owner", ["owner_user_id"]),
    ("moves", "idx_moves_game_ply", ["game_id", "ply"]),
)
_CODEC = "analysis-zlib-base64-v2"
_BATCH = 200


def _envelope_to_bytes(text):
    try:
        envelope = json.loads(text)
        if isinstance(envelope, dict) and envelope.get("codec") == _CODEC:
            return base64.b64decode(envelope["data"], validate=True)
    except (ValueError, KeyError, TypeError):
        pass
    return None


def _bytes_to_envelope(data):
    return json.dumps({"codec": _CODEC, "data": base64.b64encode(data).decode("ascii")}, separators=(",", ":"))


def _convert(source, target, transform):
    rows = sa.table("analysis_results", sa.column("id", sa.Text), sa.column(source), sa.column(target))
    conn = op.get_bind()
    last = ""
    while True:
        batch = conn.execute(
            sa.select(rows.c.id, rows.c[source])
            .where(rows.c.id > last, rows.c[source].is_not(None))
            .order_by(rows.c.id)
            .limit(_BATCH)
        ).all()
        if not batch:
            return
        for row_id, value in batch:
            conn.execute(sa.update(rows).where(rows.c.id == row_id).values({target: transform(value)}))
        last = batch[-1][0]


def upgrade():
    for table, name, _columns in _REDUNDANT:
        op.drop_index(name, table_name=table)
    op.add_column("analysis_results", sa.Column("move_results", sa.LargeBinary()))
    _convert("move_results_json", "move_results", _envelope_to_bytes)
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("move_results_json")


def downgrade():
    op.add_column("analysis_results", sa.Column("move_results_json", sa.Text()))
    _convert("move_results", "move_results_json", _bytes_to_envelope)
    with op.batch_alter_table("analysis_results") as batch_op:
        batch_op.drop_column("move_results")
    for table, name, columns in _REDUNDANT:
        op.create_index(name, table, columns)
