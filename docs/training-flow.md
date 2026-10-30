# Training flow and I/O

The Due queue still selects material using FSRS urgency and session quotas.
Selected cards are presented in repertoire/tree order, so related lines stay
together. The browser keeps the common opening prefix between adjacent lines,
uses bundled FENs for run-in moves, and advances after local grading while its
existing outbox saves attempts in batches. Correct answers no longer incur the
extra one-second pause at the end of a line. A live Move counter tracks the
current line.

## Product references

Reviewed on 2026-10-30:

- [Chessbook recommended moves](https://wiki.chessbook.com/recommended-moves)
  separates urgency-based selection from presentation in repertoire order.
  PrepForge follows that ordering principle while keeping its own scheduler.
- [ChessTempo opening training manual](https://chesstempo.com/manual/en/manual.html#openingtraining)
  documents automatic advancement, pause controls and candidate move arrows.
  PrepForge reduces pauses and makes candidate arrows solid with contrasting
  outlines; selected branches receive stronger emphasis.

Repertoire choices now overlay the tree with a border and dismiss button, without
resizing it. Local deletion rebuilds the tree immediately. The compact, fixed
Undo control restores the entire subtree immediately; hover or keyboard focus
pauses its countdown. Database deletion waits for the undo window or an explicit
flush of pending changes.

## Measured database work

A local SQLite/SQLAlchemy probe used six small real repertoires, three mixed
starts, and batches of 4, 8 and 12 correct attempts. SQL event hooks counted every
statement sent through SQLAlchemy's cursor hooks. These measurements describe
the small local fixture, not production latency or a network speed guarantee.

| Operation | Before SQL statements | After SQL statements | Before local time | After local time |
| --- | ---: | ---: | ---: | ---: |
| Mixed start, first run | 62 | 10 | 14.3 ms | 8.2 ms |
| Mixed start, second run | 65 | 13 | 12.5 ms | 5.5 ms |
| Mixed start, third run | 63 | 13 | 11.3 ms | 5.6 ms |
| Sync 4 attempts | 56 | 29 | 13.8 ms | 7.0 ms |
| Sync 8 attempts | 92 | 49 | 21.4 ms | 10.0 ms |
| Sync 12 attempts | 128 | 69 | 26.9 ms | 14.3 ms |

Queue creation batches tree and progress reads and avoids redundant health
writes. Sync fetches receipt IDs once and writes the session once per batch.
Each attempt retains its receipt, locked progress update and review record in
the same transaction. No schema changes or additional cache were needed.

## Regression checks

`tests/test_training_io.py` checks batched reads, read-only preview, one session
write per sync, preserved attempts and no tree hydration during saves.
`web-src/train-flow.test.js` checks shared-prefix and continuation playback.
`tests/e2e/train_repertoire_flow_smoke.mjs` uses the real API and built app to
check immediate deletion/Undo, overlay layout at 1440/768/390 pixels, and session
completion while sync responses are held. Run it against an isolated database:

```powershell
npm run build
$env:E2E_BASE_URL = 'http://127.0.0.1:9876'
node tests/e2e/train_repertoire_flow_smoke.mjs
```

Browser captures go to `out/train-repertoire-flow/`.
