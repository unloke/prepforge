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
It synchronously computes documentation ratios from the current in-memory tree.
Scope selects the repertoire root (Whole repertoire) or the selected Current
position; switching scope updates the score, routes and counts immediately.
Disabled subtrees are excluded. There is no Assess action or horizon setting.

`atlasClarity` in `web-src/atlas-quality.js` computes four ratios:

- **Decision notes:** own-side decision positions with prose on the position or
  its selected reply. Reply selection prefers an enabled prepared mainline,
  then the first prepared child, then an enabled mainline, then the first child.
  This selects note context; it does not establish author intent.
- **Fork signposts:** forks where every enabled alternative has local prose or
  a descriptive tag. A parent note alone does not distinguish the alternatives.
- **Endpoint notes:** ending positions with local prose.
- **Starting notes:** the selected starting position has local prose. Whole
  repertoire scope can also use repertoire notes; subtree scope uses its local
  starting-position notes.

Local prose can come from a comment, typical plan, strategic idea or tactical
warning. Bare URLs, drawing/evaluation tags and move notation alone do not
qualify. This checks note presence, not meaning, correctness or length. Each
ratio counts canonical positions once, with board, turn, castling and legal
en-passant state in the key. Repeated occurrences must all satisfy the relevant
condition. Copies and extra notes do not add weight to a position.

The Documentation score is the equal mean of applicable ratios. A ratio with no
eligible positions is excluded and displays a dash; a scope with no moves has
no score. Facet title tooltips expose definitions and numerator/denominator
counts. The fingerprint remains open when a facet is unavailable. Engines and
public likes do not enter the formula.

Tree PGN import/export preserves starting-position prose and drawings. Variation
introductions are retained with the corresponding branch's move note, using the
existing single annotation field, so structural evidence is not lost on import.

These are factual indicators of documented structure, not an automatic good/bad
classifier for overall content quality. Note presence does not establish semantic
clarity, chess strength, teaching quality or personal-reference usefulness. A
sparse move notebook is not automatically a poor repertoire. Content-quality
research uses direct manual reviews of organization, explanations and intended
audience, including whether mistakes are teaching examples. Those judgments
remain separate from the formula. High public likes provide external
positive-unlabeled evidence of reader reception; low likes remain unknown, not
negative labels. Neither these ratios nor that external evidence establish a
validated cross-study quality ranking.

Imprint separately reports the percentage of enabled own-side moves marked
mastered, with no score before training. Shared views omit Imprint. A 2,000-node
route uses combined SVG paths rather than one element per edge.

Schema authority: Alembic revision `8e4a6c2d0f91`, following `7b3e5a9c1d2f`.
