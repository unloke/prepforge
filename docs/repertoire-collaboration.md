# Repertoire activity and position discussions

Build’s More menu groups Atlas and generation under Explore, and discussions,
Activity and owner sharing under Collaborate. Manage contains naming, export,
activation and deletion; move options and owner training stay at the first level.
Public links expose Atlas and export, while collaboration requires an authenticated
member. The same menu supports keyboard navigation and phone action sheets.

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
was added.

Atlas opens from the route map beside the repertoire color, or More → Explore.
It presents a branching route map, Preparation index, a four-facet radar and raw
move, route, fork and depth counts. Whole repertoire selects the repertoire root;
Current position selects the current subtree. Scope changes recalculate the profile.
Disabled subtrees are excluded; the current path is highlighted.

Preparation is computed locally from legal moves and canonical positions, merging
position-equivalent continuations only inside the selected scope. It ignores all
annotations and uses no engine, LLM or network. A dedicated worker keeps legal
replay off the UI thread; changing scope or closing Atlas cancels the worker.
Only move/position fields are sent to it. The horizon is 16 plies from the
selected root. At own decisions, the deterministic preference is enabled prepared
mainline, then prepared, then mainline, then lexicographic UCI. Multiple candidates
within a preference use the deterministic UCI order.

The facets are Replies (stored own-response availability), Reach (stored-route
survival to the horizon), Depth (survival accumulated across the horizon), and
Move orders (shared response availability across own-position occurrences with
at least two canonical incoming edges or distinct reply sets, including empty
sets). Identical copies add neither arrivals nor reply sets; Move orders displays
a dash when no groups qualify.
Checkmate/stalemate absorb survival regardless of winner. Repeated positions
stop traversal rather than adding artificial depth. Opponent
choices receive equal weight over unique stored moves: this is a reference over
the saved graph, not empirical encounter probability. Omitted alternatives are
not assessed. Preparation index is the equal mean of applicable facets, a product
convention rather than a validated holistic quality measure. Method and corpus
results live in [Atlas research](../research/atlas-quality/README.md).

Tree PGN import/export preserves starting-position prose and drawings. Variation
introductions are retained with the corresponding branch's move note, using the
existing single annotation field, so those annotations are retained on import.

The research also retains source PGNs, move-tree examples, direct instructional
reviews and observed likes. Earlier course-clarity labels are not repertoire
quality labels and cannot validate this move-only profile. High likes are
positive-unlabeled reception evidence; low or missing likes remain unknown.

Imprint separately reports the percentage of enabled own-side moves marked
mastered, with no score before training. Shared views omit Imprint. A 2,000-node
route uses combined SVG paths rather than one element per edge.

Schema authority: Alembic revision `8e4a6c2d0f91`, following `7b3e5a9c1d2f`.
