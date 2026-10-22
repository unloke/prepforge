"""Train schedules with FSRS: memory state per progress row, and a review log.

Revision ID: 528e704717a9
Revises: e9c1d3f5a7b9
Create Date: 2026-10-22 01:00:00.000000

``spaced_repetition_score`` (+1 per hit, halved per miss, interval = score
days) and the ``is_mastered`` flag give way to FSRS state: ``state``, ``step``,
``stability``, ``difficulty``, ``lapses``. Reviewed rows convert in place so
no progress is lost: the old interval was ``score`` days, which is what FSRS
stability means at 0.9 retention, so stability = score (at least FSRS's
first-miss stability); difficulty runs from FSRS's first-Good to first-Again
difficulty with the row's miss share; misses count as lapses; the row is in
review and keeps its due date. ``train_reviews`` logs every graded answer for
fitting FSRS parameters later.
"""
from alembic import op
import sqlalchemy as sa


revision = "528e704717a9"
down_revision = "e9c1d3f5a7b9"
branch_labels = None
depends_on = None

# FSRS-6 defaults: w0 (stability after a first Again), D0(Good), D0(Again).
FIRST_MISS_STABILITY = 0.212
GOOD_DIFFICULTY = 2.1181
AGAIN_DIFFICULTY = 6.4133


def upgrade() -> None:
    with op.batch_alter_table("training_progress") as batch:
        batch.add_column(sa.Column("state", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("step", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("stability", sa.Float(), nullable=True))
        batch.add_column(sa.Column("difficulty", sa.Float(), nullable=True))
        batch.add_column(sa.Column("lapses", sa.Integer(), nullable=False, server_default="0"))
    op.execute(
        "UPDATE training_progress SET state = 2, "
        f"stability = CASE WHEN spaced_repetition_score > {FIRST_MISS_STABILITY} "
        f"THEN spaced_repetition_score ELSE {FIRST_MISS_STABILITY} END, "
        f"difficulty = {GOOD_DIFFICULTY} + {AGAIN_DIFFICULTY - GOOD_DIFFICULTY} "
        "* (attempts - correct_attempts) / (1.0 * attempts), "
        "lapses = attempts - correct_attempts "
        "WHERE attempts > 0"
    )
    with op.batch_alter_table("training_progress") as batch:
        batch.drop_column("spaced_repetition_score")
        batch.drop_column("is_mastered")
    op.create_table(
        "train_reviews",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("owner_user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("node_id", sa.Text(), sa.ForeignKey("opening_nodes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("idx_train_reviews_node", "train_reviews", ["node_id"])
    op.create_index("idx_train_reviews_owner", "train_reviews", ["owner_user_id"])


def downgrade() -> None:
    op.drop_index("idx_train_reviews_owner", table_name="train_reviews")
    op.drop_index("idx_train_reviews_node", table_name="train_reviews")
    op.drop_table("train_reviews")
    with op.batch_alter_table("training_progress") as batch:
        batch.add_column(sa.Column("spaced_repetition_score", sa.Float(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("is_mastered", sa.Integer(), nullable=False, server_default="0"))
    op.execute(
        "UPDATE training_progress SET "
        "spaced_repetition_score = CASE WHEN stability > 10 THEN 10 ELSE stability END, "
        "is_mastered = CASE WHEN stability >= 7 AND correct_attempts >= 3 THEN 1 ELSE 0 END "
        "WHERE stability IS NOT NULL"
    )
    with op.batch_alter_table("training_progress") as batch:
        batch.drop_column("lapses")
        batch.drop_column("difficulty")
        batch.drop_column("stability")
        batch.drop_column("step")
        batch.drop_column("state")
