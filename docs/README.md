# Project documentation

Use these documents to navigate the current implementation:

- [Architecture snapshot](archive/history/2026-09-29/ARCHITECTURE.md): historical runtime map; verify against source.
- [Roadmap snapshot](archive/history/2026-09-29/ROADMAP.md): historical checks and candidate improvements.
- [Deployment](DEPLOYMENT.md): environment variables and operational setup.
- [Browser engines](browser-engine-migration.md): current engine lifecycle and assets.
- [Local editing and sync snapshot](archive/history/2026-09-29/local-first-sync-plan.md): historical persistence plan.
- [Scout ranking](scout-production-ranking.md): the current production selector and experimental runtime boundaries.
- [Compare identity boundary](compare-identity-boundary.md): ownership of personal training evidence.
- [Persistence review](async-persistence-review.md): current async action fixes, recovery storage and measured costs.
- [Persistence follow-up](async-persistence-followup-results.md): validated follow-up fixes; IndexedDB-only recovery.
- [Backend consistency](backend-consistency.md): analysis snapshots, training transactions and sync versions.
- [User-reported issue discovery benchmark](benchmarks/user-review-20261001/README.md): frozen source version, blind inspection prompt, and manual scoring workflow.
- [Review follow-up](archive/audits/project-review-followup-2026-09-29.md): dated observations and improvement proposals, not implementation instructions.

The implementation, migrations, test configuration, and the user's current task
determine present behavior and intended changes. A dated report is evidence for
its stated revision, not a permanent product requirement. Recheck it against the
code before using its conclusions.

[Archive](archive/README.md) contains superseded plans, audits, research protocols,
and session checkpoints. Read it when historical context is relevant; it is not
the default starting point for new work.
