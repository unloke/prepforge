# Frontend architecture maintenance report — 2026-09-18

## Scope and baseline

- Base: `origin/main` at `48103126019bd46f5a54c5471520d7e0a2b941e4`.
- Branch: `goal/architecture-maintenance`.
- This round is a maintenance refactor only: no new product feature, UX redesign, chess algorithm, Docker, or static-ownership migration.
- The work was performed in a clean linked worktree; the user's separate dirty worktree was not changed.

The baseline was captured before source changes: 83 test files / 1,388 JS tests, JS lint green, production build and bundle gate green, 498 Python tests passed (1 skipped, 2 deselected), 92 research tests passed, and the lazy-chunk browser smoke passed.

## Source boundaries

### `app.js` and account controller

`web-src/app.js` is reduced from 10,954 to 10,659 lines by the committed diff (a 296-line net reduction). It remains the application composition/orchestration layer: boot, routing, view selection, shared app state, and cross-view callbacks.

`web-src/controllers/account.js` owns the account/session boundary and optional Lichess connection UI. Its single public factory is:

```js
createAccountController({
  appState,
  api,
  postJson,
  setStatus,
  escapeHtml,
  showConfirmModal,
  refreshAutoMaiaRating,
  onLichessConnected,
  onReload,
})
```

The controller exposes the existing account actions through the returned object: auth modal/provider/status, sign-in guard, account chip/menu, sign-out, replay-control synchronization, Lichess status, and OAuth polling. Dependencies are injected so the controller does not import the application singleton. Three focused controller tests cover the extracted boundary.

### Lichess profile API boundary

`web-src/lichess-profile.js` is the provider adapter. It keeps the provider response shape out of application code:

```text
raw Lichess JSON
  -> normalizeLichessProfile()
  -> { username, maiaRating, ratingGames, ratingPerf }
```

The adapter exports `lichessProfileUrl`, `selectLichessRating`, `normalizeLichessProfile`, and `fetchLichessProfile`. It URL-encodes usernames, ignores provisional ratings, selects the most-played supported performance, clamps the rating to 600–2600, and represents missing fields as `null`/`0`. HTTP failures preserve `error.status`; malformed JSON produces a normalized parse error for the caller.

`web-src/lichess-profile.test.js` covers normal data, missing fields, URL encoding/rating selection, HTTP 429, and malformed JSON. This is the only new external API adapter in this round; broader provider adapters remain explicit follow-ups.

## Dependency and ownership audit

- Production entry remains `web-src/index.html`; Maia3 diagnostics and Scout E2E hooks remain behind their existing build flags.
- The existing ESLint configuration already excludes generated static output, vendored engine assets, and generated research artifacts while linting authored Scout/research modules. No dependency or ownership change was needed there.
- Scout source, research scripts, and fixtures were not moved or deleted. The only Scout-related change is a browser-test harness fix: the refutation smoke now polls with `page.evaluate` because the repository CSP intentionally disallows `unsafe-eval`.
- The existing generated-static convention is retained. The final production build is refreshed into `src/prepforge_chess/web/static`; no Docker or deployment migration is included.

## Verification

Final production build and bundle gate:

```text
main app: 266.6 KiB raw / 85.0 KiB gzip (budget 283 / 93 KiB)
Maia3 worker: 156.9 KiB (budget 215 KiB)
main CSS: 117.6 KiB raw / 22.0 KiB gzip (budget 127 KiB)
```

The major lazy chunks stayed within their baseline sizes; the main entry increased only for the extracted controller/API wiring and remained within budget. Browser lazy-chunk smoke observed `analyze`, `build-view`, `dashboard`, `index`, `movetree`, `replay`, `settings`, and `train`.

The source and research verification completed with: 85 test files / 1,397 JS tests passed, JS lint passed, 92 research tests passed, `ruff check src tests` passed, 498 Python tests passed (1 skipped, 2 deselected), Alembic upgrade/check passed, and the authoritative Scout E2E run passed 2/2 using the clean worktree's `PYTHONPATH=src`. Existing Python deprecation/dtype warnings remain non-blocking follow-ups; ESLint reports only the repository's existing underscore-parameter advisory warnings and no errors.

## Follow-ups

- Consider extracting the remaining provider-facing Lichess games/explorer flows behind the same raw-to-normalized pattern when they need maintenance; that was intentionally outside this slice.
- Revisit the existing Python dependency deprecation warnings and ESLint underscore-parameter advisories in a separate hygiene change.
- Keep the explicit `PYTHONPATH=src` when launching Python E2E services from this linked worktree so the subprocess cannot resolve the similarly named package from the user's other worktree.
