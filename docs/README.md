# Project documentation

Use these documents to navigate the current implementation:

- [Current user operations](user-operations.md): desktop/mobile entry points and end-to-end operating steps, checked against current source and the running UI on 2026-10-08.
- [Deployment](DEPLOYMENT.md): environment variables and operational setup.
- [Browser engines](browser-engine-migration.md): current engine lifecycle and assets.
- [Scout ranking](scout-production-ranking.md): the current production selector and experimental runtime boundaries.
- [v10 leaf nondeterminism](scout-v10-leaf-nondeterminism.md): open finding; plans differ between sessions on the same games.
- [Compare identity boundary](compare-identity-boundary.md): ownership of personal training evidence.
- [Persistence review](async-persistence-review.md): current async action fixes, recovery storage and measured costs.
- [Persistence follow-up](async-persistence-followup-results.md): validated follow-up fixes; IndexedDB-only recovery.
- [Backend consistency](backend-consistency.md): analysis snapshots, training transactions and sync versions.
- [User-reported issue discovery benchmark](benchmarks/user-review-20261001/README.md): frozen source version, blind inspection prompt, and manual scoring workflow.

The implementation, migrations, test configuration, and the user's current task
determine present behavior and intended changes.

History — archived plans, audits, research protocols and session checkpoints —
lives on the `history` branch.
