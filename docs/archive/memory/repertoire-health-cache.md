---
name: repertoire-health-cache
description: Dashboard repertoire-list health badge is a denormalized health_json cache column, not a per-row tree walk
metadata:
  type: project
---

The `/api/repertoires` list (dashboard rep rows) shows the coverage/health badge from a **denormalized `repertoires.health_json` column**, NOT a per-request tree walk.

Background: commit 9cdc074 made the list lightweight (`list_owner_repertoire_listings`, metadata-only) to kill the old N+1 + per-row `compute_health` full-tree walk — but that dropped the dashboard health badge entirely. 2026-06-21 restored the badge cheaply via a cache:

- New nullable `health_json` column (migration `a1b2c3d4e5f6`, head; also in sa_tables.py + schema.sql drift-guard fixture).
- `repo.set_repertoire_health(rep_id, health_dict)` writes it.
- Refreshed at the two spots that **already compute health off a loaded tree** (zero new walk): `workspace_view.build_workspace_payload` (the common exit of all 12 Build mutations → self-healing on every add/delete/generate/load) and train's `_smart_summary_payload` (post-session mastery).
- List surfaces `health` (None until first opened/trained); `dashboard.js healthBadgeHtml` already handles `!health → ""`.

Deploy needs `alembic upgrade head` (Render runs it via Dockerfile CMD). 477 py + 485 js tests green. See [[smart-start-perf]], [[optimization-pass-2026-06]].
