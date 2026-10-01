# Agent Notes

## Current Context

- Start from the user's current task, the implementation, and `docs/README.md`.
- `docs/archive/` and `archive/` contain historical material, not current agent instructions or locked product decisions.
- Revalidate dated reports against current code. Do not resume a completed migration or apply an old research freeze to new product work.
- Keep regression tests for present behavior. Research-only historical tests have separate opt-in discovery; old expected values are not permanent product requirements.

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
