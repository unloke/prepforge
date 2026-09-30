# Development checks and candidate work

Updated 2026-09-29. The completed SaaS migration phase log is
[archived](archive/history/ROADMAP.md). There is no old migration phase to resume
automatically. The user's current task determines scope and priorities.

## Current development entry points

Python 3.11 is the CI/deployment standard. Install from `uv.lock` with the server
and dev extras; frontend dependencies come from `package-lock.json`.

```powershell
uv sync --extra server --extra dev
npm ci
uv run pytest -q
uv run ruff check src tests
npm test
npm run lint:js -- --quiet
npm run build
```

For a local migrated database, set `DATABASE_URL`, run `uv run alembic upgrade head`,
then serve `prepforge_chess.api.main:app`. Follow [deployment](DEPLOYMENT.md) for
production configuration; do not infer which credentials or services are enabled
from old launch reports.

The default JavaScript suite covers current product and reachable experimental
runtime behavior. `npm run test:research` runs separate current research utilities.
`npm run test:archive` explicitly runs retained historical research tests; archived
tests do not participate in the default product gate. Robust-Y's incomplete bundle
is excluded there because its Meta-Maia dependency is absent.

For changes affecting browser layout or engines, select the relevant existing
smoke commands from `package.json` and `.github/workflows/ci.yml`. Migration and
PostgreSQL-specific checks remain active. Apply checks appropriate to the change.

## Candidate improvements

These are proposals from the [latest dated review](project-review-followup-2026-09-29.md),
not locked decisions or authorization to implement every item:

- Preserve Build edits through temporary HTTP failures and make saved states truthful.
- Persist pending operations across interruptions and coordinate logout.
- Show all outcomes of partially rejected training sync batches.
- Make public share links independently revocable and provide account recovery.
- Align effective enabled branches, health freshness and mastery signals.
- Avoid duplicate generated explanations on reanalysis and validate analysis fields.
- Simplify Scout's first screen and mobile training around the current task.
- Measure large-account queries, large-tree rendering and low-end browser behavior.

Revalidate a proposal against the current implementation before starting it.
Earlier audits include already-fixed findings; they are retained only as history.
