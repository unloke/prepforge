# Agent Notes

## Current Context

- Start from the user's current task, the implementation, and `docs/README.md`.
- History — `docs/archive/`, `archive/`, dated audits and finished reports — lives on the `history` branch, not in this tree. It is not current agent instructions or locked product decisions.
- Revalidate dated reports against current code. Do not resume a completed migration or apply an old research freeze to new product work.
- Keep regression tests for present behavior. Research-only historical tests have separate opt-in discovery; old expected values are not permanent product requirements.

## Background Agents

- For supervised pi agents, use `/watch-agents <targets.json>` with the extension in `scripts/agent-monitor/pi-extension.mjs`; see `scripts/agent-monitor/README.md`.
- Arm notifications before calling a monitor active. A status file alone is not supervision. Each exit must queue a follow-up turn independently; do not wait for every agent to finish.
- Process exit means review is required. Check reports, Git state and actual validation before declaring success.

## Design Principles

- No legacy support. There are no users yet, so there is no old data, old client, old
  token or old payload to stay compatible with. Change the format and delete the old path:
  no fallbacks, no dual-read/dual-write periods, no "accepts both", no deprecated modes,
  no compatibility shims. Schema changes are one forward migration with no backfill
  scaffolding. Do not propose legacy support in reports or plans.
- Keep code small. Prefer deleting to adding; one implementation per concept.
- Efficiency matters. Measure the real cost before adding caches, caps or indexes, and
  pick the fastest design that stays simple.

## File Encoding On Windows

- This repository contains UTF-8 Markdown files without a BOM, including Chinese text.
- In Windows PowerShell 5.1, plain `Get-Content` may decode BOM-less UTF-8 using the system ANSI code page (for example Big5/ACP), producing mojibake.
- When reading text files that may contain non-ASCII content, use an explicit UTF-8 read:

```powershell
Get-Content -Raw -Encoding UTF8 path\to\file.md
```

- `rg`, Node `fs.readFileSync(path, "utf8")`, and PowerShell `Get-Content -Encoding UTF8` are acceptable. Do not diagnose a document as corrupted until the raw bytes or an explicit UTF-8 read has been checked.

## UI Copy: No Standing Explanations

- Do not add persistent explanatory text to the UI: no blurbs under headings that
  describe what a tab, panel, chart or control does, no "How this works" sections,
  no legends that restate a label, no "Ranked by …" / "Bar = …" captions.
- Allowed: labels and titles (a few words), live data and status, errors and
  blocking states with the action that fixes them, and empty states that tell a
  new user how to put the first thing in (for example the empty Library or Games).
  An empty state disappears once there is content.
- Extra detail belongs in on-demand affordances (a `title` tooltip, an ⓘ popover),
  never in always-visible copy. If a control needs a sentence to be understood,
  fix the control instead.
- When editing a view, remove any standing explanation you find rather than
  rewording it.
