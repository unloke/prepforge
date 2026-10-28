# Usability and aesthetics sweep — 2026-10-27, round three

The owner explicitly selected a broad sweep: functionality, ease of use and visual details across all implemented pages. No additional scope selection is needed.

Driver: installed Playwright, real local API at http://127.0.0.1:8765 with isolated development SQLite. Always headless, isolated browser context and finally-close; no personal browser. Existing disposable accounts from the local prior run may be used. No production data or external messages.

Inventory: Library (create, import, filter, rename), repertoire editor (branches, notes, save, export), Train (queue, rehearsal, hints, retry, results), Analyze (PGN, engine, coach, chart, report, history), Games (list and review), Scout (search and plans), Teams (membership and shared study), Settings (account, board, theme, engines). External OAuth/invitations and audio judgments excluded.

Personas: intermediate desktop player seeking efficient study; less-experienced mobile player needing clear controls; experienced analyst reviewing statistics. Every Luna receives zero product context, one feature and viewport only. Discover controls through visible UI; no source or hidden APIs. First-person journey, exact reproduction, screenshots, severity, aesthetics critique and couldn't-test notes required. Agents write evidence only, never app files or Git.

Wave 1: desktop Game Report, mobile Games, desktop Library.
Wave 2: mobile Train, desktop Scout, mobile Settings.
Wave 3 as coverage permits: mobile repertoire editor, desktop Teams, mobile Analyze report retest.

Root: competitor research (Lichess, ChessTempo), validate findings before fixes; Game Report compact one-line collapse, statistics-first expansion and interactive error plot, accuracy algorithm investigation and player-relative history result. Capture before/after at 1440, 768 and 390, run tests/lint/build, design skill inspector and final HTML report. Close browsers and task server.
