"""Legal pages (Phase 6 launch requirement): Terms of Service + Privacy Policy.

These ship as **honest placeholders** — real terms must be reviewed by counsel before
public launch. They exist so the routes/links are wired now and the deploy checklist
item is structurally satisfied; the copy is clearly marked as a template, not legal
advice. Served as plain documents (not under the SPA's cross-origin-isolation headers).
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["legal"])

_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — PrepForge Chess</title>
<style>body{{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#222}}
.notice{{background:#fff7e6;border:1px solid #f0c36d;padding:.75rem 1rem;border-radius:6px}}
a{{color:#1a5fb4}}</style></head>
<body>
<p><a href="/">&larr; PrepForge Chess</a></p>
<h1>{title}</h1>
<p class="notice"><strong>Template — not yet legal advice.</strong> This is placeholder
text wired in for launch plumbing. Replace it with a version reviewed by counsel before
onboarding paying users.</p>
{body}
<p><a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a></p>
</body></html>
"""

_TERMS = """
<p>By using PrepForge Chess you agree to use the service lawfully and not to abuse,
disrupt, or attempt to gain unauthorized access to other users' data.</p>
<p>The software is open source under GPL-3.0-or-later; the hosted service is provided
"as is", without warranty. Paid plans are billed via Stripe; you may cancel at any time
through the customer portal.</p>
"""

_PRIVACY = """
<p>We store the data you create (account email, repertoires, analyses, training
progress) to provide the service. Passwords are stored hashed; linked third-party
tokens (e.g. Lichess) are encrypted at rest.</p>
<p>Payment processing is handled by Stripe; we do not store card details. You may request
export or deletion of your account data. We do not sell personal data.</p>
"""


@router.get("/terms", response_class=HTMLResponse, include_in_schema=False)
def terms() -> HTMLResponse:
    return HTMLResponse(_PAGE.format(title="Terms of Service", body=_TERMS))


@router.get("/privacy", response_class=HTMLResponse, include_in_schema=False)
def privacy() -> HTMLResponse:
    return HTMLResponse(_PAGE.format(title="Privacy Policy", body=_PRIVACY))
