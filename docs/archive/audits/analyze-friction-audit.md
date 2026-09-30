# Analyze friction audit (free tier)

**Date:** 2026-06-19  
**Build:** `index-DBqBJsd1.js`, local `http://127.0.0.1:8000`  
**Method:** Playwright harness with `createSignedInContext()` (`scripts/analyze-friction-audit.mjs`)  
**Raw evidence:** [`analyze-friction-audit-evidence.json`](./analyze-friction-audit-evidence.json)

**Observability (signed-in baseline run)**

| Signal | Result |
|--------|--------|
| `POST /api/clientlog` beacons | **0** |
| Browser console | **7** messages — one `404` favicon + auth-modal DOM warnings |
| Required signed-in paths | **4 / 4** pass (`desktop-happy`, `mobile-375`, `long-task-stop-retry`, `handoff-no-repertoire`) |
| Guest + engine paths | **8 / 8** informational passes (12 total scenarios) |
| Harness exit | **0** when required paths pass; **1** on any required failure |

---

## Executive summary

**P0 fixed:** Guest auth gate + sign-in modal (see prior commit).

**Signed-in baseline (E2E evidence):** Fresh registered user can complete browser Stockfish analysis on desktop and 375px mobile; results show move tree + classification summary (`Analysis ready: 6 plies`). Long task shows job toast + **Stop**; cancel → `Analysis stopped` + retry succeeds. COI gating verified without clicking disabled Analyze.

**P1 result handoff — implemented:** `#analysis-handoff` + `create-repertoire-from-game` CTA; shared `importRepertoireFromPgnText()`; E2E gate clicks through modal → Build with repertoire name.

**Remaining P1 (separate commit):** Mobile touch target — Analyze button height **32px** on 375px.

---

## Path 1 — New user: valid PGN → Analyze → results

| | |
|--|--|
| **Expected** | Paste/load valid PGN → click Analyze → progress → eval chart + move list + summary |
| **Actual (guest, post-fix)** | Click Analyze → status **“Sign in (or create an account) to analyze and save games”** + auth modal; no API call; `#analysis-results` hidden; `#run-analysis` stays enabled |
| **Evidence** | `evidence.json` `1-happy-path/desktop-1280-guest`, `mobile-375-guest`, `keyboard-guest` |
| **Recovery** | Complete sign-in in modal, then Analyze again |
| **Desktop 1280** | **Pass** (auth gate + CTA) |
| **Mobile 375** | **Pass** (auth modal; touch target height 32px — P1 mobile polish) |
| **Keyboard** | **Pass:** Enter on focused `#run-analysis` opens auth modal. First Tab still lands on **`nav-build`** (P2 tab order) |
| **Priority** | **P3** — guest gate OK; signed-in happy path still needs manual smoke |

**Signed-in (E2E):** **Pass** — `1-signed-in/desktop-happy`: results visible, classification summary, status `Analysis ready: 6 plies`, `crossOriginIsolated: true`.

---

## Path 2 — Import failures

### 2a Empty PGN

| | |
|--|--|
| **Expected** | Client guard; no network; clear message |
| **Actual** | Status **“Paste PGN before analyzing”**; button stays enabled |
| **Recovery** | Open PGN drawer, paste text |
| **Priority** | **P3** — OK |

### 2b Invalid PGN (guest)

| | |
|--|--|
| **Expected** | Parse/import error (400) with fix hint |
| **Actual (post-fix)** | Same auth gate as valid PGN — sign-in modal before parse |
| **Recovery** | Sign in first, then fix PGN if still invalid |
| **Priority** | **P3** — no longer misleading |

### 2c Huge / interrupted input

| | |
|--|--|
| **Expected** | Graceful limit or fast failure |
| **Actual** | Playwright `fill()` **timeout 30s** on ~8000-line textarea paste |
| **Recovery** | Unknown — no client size guard in `runAnalysis()` |
| **Priority** | **P2** — perf/DoS-ish paste; defer until P0 fixed |

---

## Path 3 — Engine unavailable

### 3a Non-isolated environment (COOP/COEP missing)

| | |
|--|--|
| **Expected** | Clear gate + recovery (supported browser / host) |
| **Actual** | `#run-analysis` gets `is-coming-soon`, `disabled`, `aria-disabled`, title **`Browser engine unavailable — open in a cross-origin-isolated browser…`** (`applyServerEngineGating()`). Status bar does **not** mirror this until user attempts click |
| **Recovery** | Title attribute only; Settings engine panel lazy — not visible until Settings tab |
| **Priority** | **P2** — gating works; proactive status copy would help |

### 3b Stockfish / Maia load failure

| | |
|--|--|
| **Expected** | Toast progress → fail message → retry |
| **Actual (code)** | `runAnalysis` catch → `setStatus(error.message)` + `jobToast.failJob()`; Maia brilliant path **non-fatal** (swallows, continues without `!!`). Settings **Retry now / Reset cache** only in Settings chunk |
| **Recovery** | Re-run Analyze; Maia recovery buried in Settings |
| **Priority** | **P2** — needs signed-in long run to reproduce live |

---

## Path 4 — Long task: progress, Stop, cancel, retry

| | |
|--|--|
| **Expected** | Job toast with `evaluating N/M`, **Stop** (`job-toast-stop`), cancel → “Analysis stopped”, button re-enabled, retry works |
| **Actual (signed-in E2E)** | Toast `Analyzing game` + **Stop** visible; cancel → `Analysis stopped`; button re-enabled; DEMO PGN retry → results |
| **Evidence** | `4-signed-in/long-task-stop-retry` |
| **Recovery** | Stop then Analyze again |
| **Priority** | **P3** — controls OK |

---

## Path 5 — Result handoff → Build / Train

| | |
|--|--|
| **Expected** | After analysis, clear next step (bookline → Train / Add in Build) |
| **Actual (signed-in E2E, no repertoire)** | Results visible; `booklineHidden: true`; `repertoireCta: false`; `guidedNextStep: false` |
| **Evidence** | `5-signed-in/handoff-no-repertoire` |
| **Recovery** | Manual **Build** / **Train** tabs only today |
| **Priority** | **P1** — missing guided next step for new users |

---

## Accessibility & mobile (cross-cutting)

| Issue | Evidence | Priority |
|-------|----------|----------|
| Tab order starts at **nav-build**, not Analyze PGN/primary CTA | `keyboard` scenario `initialFocus: BUTTON nav-build` | **P2** |
| PGN in **collapsed** `<details>` — demo content not visible | `index.html` `#pgn-drawer`; `prefillDemoPgn()` on init | **P2** |
| Gated Analyze button: `aria-disabled="true"` when no COI | `3-engine-unavailable` click log | **P3** — OK pattern |
| Status-only errors (no `role="alert"` on failures) | `#app-status` text only | **P2** |

---

## Priority stack (UI/UX rubric order)

1. ~~**P0 — Auth gate UX on Analyze**~~ **Done** (`runAnalysis` pre-check + 401 catch)
2. ~~**P1 — Misleading errors** on invalid PGN for guests~~ **Resolved** by P0
3. **P1 — Result handoff** — E2E confirmed: no CTA after analysis for fresh user (**next product fix**)
4. **P1 — Mobile touch target** — Analyze button 32px tall on 375px
5. **P2 — Keyboard / discoverability** (tab order, open PGN drawer hint)
6. **P2 — Huge paste** guard (signed-in path not yet audited)
7. **P3 — Empty PGN** (already good)

---

## Next commit scope (one friction only)

**Mobile touch target** — raise Analyze primary button to ≥44px on 375px. Do not bundle with keyboard/discoverability work.

---

## Re-run harness

```powershell
# Terminal 1 — migrate once per dev DB
$env:DATABASE_URL="sqlite:///dev.sqlite3"
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m uvicorn prepforge_chess.api.main:app --host 127.0.0.1 --port 8000

# Terminal 2 — exits 1 if any required signed-in scenario fails
node scripts/analyze-friction-audit.mjs
```