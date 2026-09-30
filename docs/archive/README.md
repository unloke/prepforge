# Historical documentation archive

Archived 2026-09-29 after checking the current source and test entry points.
These files preserve earlier evidence and decisions. They are not current agent
instructions, product constraints, deployment status, or a task queue to resume.

## Contents

| Directory | Historical material |
| --- | --- |
| `audits/` | Prior UI/fullstack/friction reports, measurements and JSON evidence |
| `design/` | Completed redesigns, concurrency/refactor write-ups and session checkpoints |
| `research/` | Earlier Scout selectors, benchmark protocols, sample results and v12/v13 design history |
| `history/` | Original architecture, SaaS roadmap, browser migration and sync plans |
| `memory/` | Obsolete local implementation notes with old migration/test references |

[manifest.json](manifest.json) records every original and archived path and the
reason for the move. Files retain historical wording, including instructions
such as “locked”, “frozen”, “stop”, or “must”; those statements describe the old
task or experiment and do not override the user's current request.

Start new work from [current documentation](../README.md), source, migrations and
current test entry points. Consult an archived study when reproducing its evidence,
not to impose its historical acceptance criteria on new product design.

Some relative paths and commands inside these original snapshots refer to their
original repository layout or historical revision. Use the manifest to locate
moved files; a linked historical artifact may no longer exist in the current tree.

Separately, [archived research tests](../../archive/README.md) are outside default
product test discovery and can be run explicitly when their dependencies exist.
