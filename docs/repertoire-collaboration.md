# Repertoire activity and position discussions

Build uses the existing revision log for synchronization and its recent activity
list. It retains 500 operations, trimmed every 100 revisions; Activity is recent
history, not a permanent audit archive. A per-user repertoire cursor records the
last explicitly acknowledged revision. Only another user's operations mark moves
as unread. Mark read advances monotonically and never acknowledges future writes.

Mutations capture the touched node rows before and after their write in the same
transaction. Updates retain only changed fields; additions and deletions retain
complete rows. This costs two batched point reads, independent of tree size.
Measured SQLite route statement counts: load 8, mark prepared 12, annotations 9,
disable branch 12. SQL regression tests distinguish these point reads from a
complete tree hydration.

Owners can invert an operation with a recorded difference. Restoration checks
that the affected fields still equal the operation's result; unrelated later
fields survive. Removing an added node is refused if a later continuation would
be cascaded away. Deleted parents are restored before children, and a missing
parent blocks restoration. The inverse is itself logged. Training history is
not reconstructed. Events without a stored inverse have no Restore action.

`position_threads` is scoped by repertoire and canonical position, and has no
node foreign key. The key uses piece placement, side to move, castling rights
and legal en-passant; move counters are excluded. The original full FEN renders
the board even when its path is deleted. This identifies a board position for
conversation, not a game's repetition or fifty-move adjudication state.

Authenticated readers can participate, including members who have access through
a team. Thread authors and repertoire owners can resolve/reopen. Editors and
owners can reattach to a position in the current tree. A conflicting existing
discussion is reported rather than silently merged. Public-token views expose
neither discussion data nor activity. Message bodies are rendered as escaped text.

The message thread index was measured with 20,000 messages across 500 threads:
the repertoire query dropped from 3.09 ms with a message scan to 0.15 ms with
`ix_position_messages_thread_id` in an in-memory SQLite run. No cache or data cap
was added. Atlas renders the current in-memory tree; its six-board pages are UI
pagination and all forks remain reachable. A 2,000-node route uses combined SVG
paths rather than one element per edge.

Schema authority: Alembic revision `8e4a6c2d0f91`, following `7b3e5a9c1d2f`.
