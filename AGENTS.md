# Agent Notes

## File Encoding On Windows

- This repository contains UTF-8 Markdown files without a BOM, including Chinese text.
- In Windows PowerShell 5.1, plain `Get-Content` may decode BOM-less UTF-8 using the system ANSI code page (for example Big5/ACP), producing mojibake.
- When reading text files that may contain non-ASCII content, use an explicit UTF-8 read:

```powershell
Get-Content -Raw -Encoding UTF8 path\to\file.md
```

- `rg`, Node `fs.readFileSync(path, "utf8")`, and PowerShell `Get-Content -Encoding UTF8` are acceptable. Do not diagnose a document as corrupted until the raw bytes or an explicit UTF-8 read has been checked.
