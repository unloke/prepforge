# Detail playtest — 2026-10-27, round two

The owner requested a broad detail sweep, using zero-product-context Luna testers,
one feature and viewport per tester, plus a fix for evaluation-chart preview
colours. This explicitly selects the full-sweep scope. No further scope selection
is needed.

## Product and driver

PrepForge is a web chess study app: opening repertoires, spaced training, game
review and analysis, opponent scouting, and team sharing. Use Playwright against
the real local API and an isolated development SQLite database. All browsers must
be headless with isolated contexts; never use the owner's personal browser.

## Feature inventory

- Library: PGN import, repertoire creation, rename, search, side filters, actions.
- Repertoire: board editing, move tree, branches, notes, annotations, explorer,
  coverage, generation, automatic saving, export and sharing.
- Train: due queue, rehearse, hints, incorrect moves, retries, session history.
- Analyze: PGN/file import, move navigation, variations, coach, evaluation chart,
  hover previews, engine lines, full-game review, reports and history.
- Games: personal game list and review handoff.
- Scout: opponent search, opening plans and repertoire handoff.
- Teams: membership and shared repertoires; external invitation delivery is out of scope.
- Settings: account controls, theme, board, sound settings and engines. No audio
  quality judgment or sound changes are planned.

Current implementation and docs/README.md are authoritative. Test implemented UI
flows; do not use historical reports as requirements. Existing test accounts are
local-only; create unique accounts only when a flow requires it.

## Personas and assignments

Each tester receives no source/docs/history context, only their feature, viewport,
local URL and account. They must discover the actual controls and recover from
driver selector mistakes.

1. Intermediate desktop analyst, 1440×900: evaluation chart hover, previews,
   selected versus hovered move, engine toggles, preview dismissal.
2. Mobile repertoire editor, 390×844: notes, branch actions, long labels, menu
   positioning, orientation and navigation details.
3. Desktop trainee, 1440×900: wrong-move feedback, retry, hints, keyboard and
   progress/history consistency.
4. Further independent waves: mobile analysis, mobile Library, desktop Settings;
   prioritize untouched detail states and reproduce any reported defects.

## Evidence and completion

Keep one browser context throughout each journey. Record first-person journey
notes, exact steps, expected/actual, severity, screenshots, and incomplete checks.
Use visible UI, not hidden APIs or fixtures. Agents do not modify application or
Git files. Review each returned report, reproduce findings, consult competitor
behaviour, and implement small validated slices. Deliver an HTML report with
screenshots. Close browsers and owned servers after the run.
